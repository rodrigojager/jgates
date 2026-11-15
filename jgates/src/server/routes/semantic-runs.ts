// Independent Semantic runs through the API: the plan, the history, one run (state, result, identity), its ordered
// events by cursor, starting one and cancelling it. They drive the same service as `jgates semantic` (core/semantic):
// a run started here is the CLI (`jgates semantic run --run-id <sem_...> --json`) in a child process, as the Quality
// runs are, and a cancel is the same cancel request the CLI writes (the running process stops its own children and
// keeps its partial evidence). The Quality routes (/api/runs) never list, start or cancel a Semantic run.
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readEvents } from "../../core/events/index.js";
import { newGateRunId } from "../../core/gates/ids.js";
import {
  MAX_SELECTED_METHODS,
  METHOD_ID_PATTERN,
  SEMANTIC_EVENTS_FILE,
  SEMANTIC_RUN_ID_PATTERN,
  buildSemanticPlan,
  findSemanticRun,
  listSemanticRuns,
  readSemanticRun,
  reproductionOf,
  requestSemanticCancel,
  withReproduction,
  FINDING_ID_PATTERN,
} from "../../core/semantic/index.js";
import { semanticChoiceArgs, type ScopeRequest, type SemanticPurpose, type SemanticRigor } from "../../core/semantic-scope/index.js";
import { getLocale, translator } from "../../i18n/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";
import { choiceProperties } from "./semantic-scope.js";

const t = translator("semantic");
const MAX_WAIT_MS = 25_000;
/** After a cancel request, the child gets this long to stop by itself before it is killed. */
const CANCEL_GRACE_MS = 15_000;
const QUALITY_REF = "^(latest|run_[0-9]{8}T[0-9]{6}Z_[0-9a-f]{8})$";
/** A comma-separated list of method IDs (METHOD_ID_PATTERN each). */
const METHOD_LIST = `^${METHOD_ID_PATTERN.slice(1, -1)}(,${METHOD_ID_PATTERN.slice(1, -1)}){0,${MAX_SELECTED_METHODS - 1}}$`;

const fail = (status: number, code: string, params: Record<string, string> = {}, details: Record<string, unknown> = {}): HttpError => {
  const key = `semantic_api_${code.toLowerCase()}`;
  const fix = t(`${key}_fix`, params);
  return new HttpError(status, code, t(key, params), fix === `${key}_fix` ? null : fix, details);
};

const idParams = {
  type: "object",
  properties: { id: { type: "string", pattern: SEMANTIC_RUN_ID_PATTERN } },
  required: ["id"],
  additionalProperties: false,
};

/** The children of this server that run Semantic runs, by run ID (kept per server, released when they exit). */
const children = new WeakMap<ServerContext, Map<string, ChildProcess>>();

function childrenOf(server: ServerContext): Map<string, ChildProcess> {
  let map = children.get(server);
  if (!map) {
    map = new Map();
    children.set(server, map);
  }
  return map;
}

function cliMain(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli", "main.js");
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The history entry without the internal ordering field. */
function publicRun<T extends { time: number }>(run: T): Omit<T, "time"> {
  const { time: _time, ...rest } = run;
  return rest;
}

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/semantic/plan",
    query: {
      type: "object",
      // methods: comma-separated method IDs (the purpose's methods when absent).
      // from, finding: the earlier run (and one finding) confirm-by-reproduction would start from: the plan then carries what it would cost.
      properties: {
        quality: { type: "string", pattern: QUALITY_REF },
        methods: { type: "string", pattern: METHOD_LIST },
        from: { type: "string", pattern: SEMANTIC_RUN_ID_PATTERN },
        finding: { type: "string", pattern: FINDING_ID_PATTERN },
      },
      additionalProperties: false,
    },
    handler({ query, server }) {
      const methods = typeof query.methods === "string" ? query.methods.split(",") : [];
      const from = typeof query.from === "string" ? query.from : null;
      const finding = typeof query.finding === "string" ? query.finding : null;
      const plan = buildSemanticPlan({
        workspacePath: server.workspace.path,
        home: server.home,
        quality: query.quality ?? null,
        methods,
        ...(from || finding ? { reproduction: { from, findings: finding ? [finding] : [] } } : {}),
      });
      return { status: 200, json: { schemaVersion: 1, status: "OK", gate: "semantic", plan } };
    },
  },
  {
    method: "GET",
    path: "/api/semantic/runs",
    query: { type: "object", properties: { limit: { type: "string", pattern: "^[1-9][0-9]{0,3}$" } }, additionalProperties: false },
    handler({ query, server }) {
      const limit = Number(query.limit ?? "50");
      // Each run with the reproduction state of its findings (read from the reproduction runs that name it).
      const runs = withReproduction(server.home, server.workspace.id, listSemanticRuns(server.home, server.workspace.id).slice(0, limit)).map(publicRun);
      return { status: 200, json: { schemaVersion: 1, status: "OK", gate: "semantic", runs } };
    },
  },
  {
    method: "POST",
    path: "/api/semantic/runs",
    // The same choices as `jgates semantic run`: the Quality evidence, the purpose, rigor and budget, and the scope.
    // reproduction: the earlier run (and one finding) confirm-by-reproduction starts from, as --from and --finding.
    body: {
      type: "object",
      properties: {
        quality: { type: "string", pattern: QUALITY_REF },
        ...choiceProperties,
        reproduction: { type: "object", properties: { from: { type: "string", pattern: SEMANTIC_RUN_ID_PATTERN }, finding: { type: "string", pattern: FINDING_ID_PATTERN } }, additionalProperties: false },
      },
      additionalProperties: false,
    },
    handler({ body, server }) {
      const choices = (body ?? {}) as { quality?: string; purpose?: SemanticPurpose; methods?: string[]; rigor?: SemanticRigor; budget?: { maxCalls?: number; maxTokens?: number }; scope?: ScopeRequest; reproduction?: { from?: string; finding?: string } };
      const { quality } = choices;
      const asked = choices.reproduction && (choices.reproduction.from || choices.reproduction.finding) ? choices.reproduction : null;
      // A policy folder being edited is not a project: there is nothing to review.
      if (server.policyMode) throw fail(409, "SEMANTIC_POLICY_MODE");
      const active = [...childrenOf(server).keys()][0];
      if (active) throw fail(409, "SEMANTIC_RUN_ACTIVE", { runId: active }, { runId: active });
      const plan = buildSemanticPlan({
        workspacePath: server.workspace.path,
        home: server.home,
        quality: quality ?? null,
        ...(choices.purpose ? { purpose: choices.purpose } : {}),
        ...(choices.rigor ? { rigor: choices.rigor } : {}),
        ...(choices.budget ? { budget: choices.budget } : {}),
        ...(choices.methods ? { methods: choices.methods } : {}),
        ...(asked ? { reproduction: { from: asked.from ?? null, findings: asked.finding ? [asked.finding] : [] } } : {}),
        scope: choices.scope ?? null,
      });
      if (!plan.ready) throw fail(422, "SEMANTIC_NOT_READY", { detail: plan.blockers.map((b) => b.message).join(" ") }, { blockers: plan.blockers, plan });
      const runId = newGateRunId("semantic");
      const args = [
        cliMain(),
        "semantic",
        "run",
        "--cwd",
        server.workspace.path,
        "--run-id",
        runId,
        "--json",
        "--no-interactive",
        "--locale",
        getLocale(),
        ...(quality ? ["--quality", quality] : []),
        ...semanticChoiceArgs(choices),
        // Several methods: the child runs them in order, one Semantic run each; runId names the first one.
        ...(plan.methodSelection === "explicit" ? [`--method=${plan.methods.map((m) => m.id).join(",")}`] : []),
        ...(asked?.from ? ["--from", asked.from] : []),
        ...(asked?.finding ? ["--finding", asked.finding] : []),
      ];
      const child = spawn(process.execPath, args, {
        cwd: server.workspace.path,
        env: process.env,
        stdio: ["ignore", "ignore", "ignore"],
        // Own process group on POSIX, so a forced stop reaches the tools the run started too (by pid, never by name).
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      const map = childrenOf(server);
      map.set(runId, child);
      const release = (): void => void map.delete(runId);
      child.once("exit", release);
      child.once("error", release);
      server.log(`semantic run ${runId} started`);
      return {
        status: 202,
        json: {
          schemaVersion: 1,
          status: "OK",
          gate: "semantic",
          run: { runId, lifecycle: "running", planHash: plan.planHash, scopeHash: plan.scope.resolution.scopeHash },
          // The methods in the order they run; only the first run's ID is known now (the others get theirs when they start).
          methods: plan.methods.map((m) => ({ id: m.id, applicability: m.applicability })),
        },
      };
    },
  },
  {
    method: "GET",
    path: "/api/semantic/runs/:id",
    params: idParams,
    handler({ params, server }) {
      const id = params.id as string;
      const view = readSemanticRun(server.home, server.workspace.id, id);
      if (!view) {
        // Started here a moment ago: the child has not written its folder yet.
        if (childrenOf(server).has(id)) return { status: 200, json: { schemaVersion: 1, status: "OK", gate: "semantic", run: { runId: id, lifecycle: "running", live: true, result: null } } };
        throw fail(404, "RUN_NOT_FOUND", { runId: id });
      }
      return { status: 200, json: { schemaVersion: 1, status: "OK", gate: "semantic", run: { ...publicRun(view), reproduction: reproductionOf(server.home, server.workspace.id, view) } } };
    },
  },
  {
    // The events of a run (events.jsonl) after the cursor the caller has; with `wait`, holds the request until a new
    // event arrives or the run settles. A reload asks again from 0 or from its own cursor and gets each event once.
    method: "GET",
    path: "/api/semantic/runs/:id/events",
    params: idParams,
    query: {
      type: "object",
      properties: { cursor: { type: "string", pattern: "^[0-9]{1,9}$" }, wait: { type: "string", pattern: "^[0-9]{1,6}$" } },
      additionalProperties: false,
    },
    timeoutMs: MAX_WAIT_MS + 5_000,
    async handler({ params, query, server }) {
      const id = params.id as string;
      const cursor = Number(query.cursor ?? "0");
      const deadline = Date.now() + Math.min(Number(query.wait ?? "0"), MAX_WAIT_MS);
      for (;;) {
        const run = findSemanticRun(server.home, server.workspace.id, id);
        const starting = !run && childrenOf(server).has(id);
        if (!run && !starting) throw fail(404, "RUN_NOT_FOUND", { runId: id });
        const read = run ? readEvents(path.join(run.dir, SEMANTIC_EVENTS_FILE), { after: cursor, runId: id }) : { events: [], cursor };
        const live = starting || run?.lifecycle === "running";
        if (read.events.length > 0 || !live || Date.now() >= deadline) {
          const events = read.events.slice(0, 500);
          const next = events.length > 0 ? (events[events.length - 1]?.sequence ?? cursor) : cursor;
          const more = read.events.length > events.length;
          return {
            status: 200,
            json: { schemaVersion: 1, status: "OK", gate: "semantic", runId: id, lifecycle: run?.lifecycle ?? "running", live, events, cursor: next, done: !more && !live },
          };
        }
        await sleep(150);
      }
    },
  },
  {
    method: "POST",
    path: "/api/semantic/runs/:id/cancel",
    params: idParams,
    handler({ params, server }) {
      const id = params.id as string;
      const child = childrenOf(server).get(id);
      const outcome = requestSemanticCancel(server.home, server.workspace.id, id, { reason: "cancel requested (local server)" });
      if (outcome.status === "not-found" && !child) throw fail(404, "RUN_NOT_FOUND", { runId: id });
      if (outcome.status === "not-active") throw fail(409, "RUN_NOT_ACTIVE", { runId: id });
      if (child) {
        // The run stops by itself on the request; a child that does not is stopped (only that child: it is ours).
        const hard = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
              else child.kill("SIGKILL");
            } catch {
              // Already gone.
            }
          }
        }, outcome.status === "not-found" ? 0 : CANCEL_GRACE_MS);
        hard.unref();
      }
      server.log(`semantic run ${id} cancel requested`);
      return { status: 202, json: { schemaVersion: 1, status: "OK", gate: "semantic", runId: id, cancel: outcome.status === "not-found" ? "requested" : outcome.status, message: t("semantic_cancel_requested", { runId: id }) } };
    },
  },
];
