// Gate selection and combined sequences through the API. The plan of a selection is built by the same core function as
// `jgates run --gates ... --dry-run` (core/sequence buildGatePlan), so the same request gives the same plan here and in
// the CLI. A sequence started here is the CLI (`jgates run --gates quality,semantic --sequence-id <seq_...> --json`) in a
// child process, as Quality and Semantic runs are; cancel writes the same cancel request the core reads (the running gate
// stops its own processes and keeps its partial evidence); advance continues a sequence waiting after its Quality
// approval (`jgates run --advance <seq_...>`). The Quality and Semantic routes keep listing their own runs only.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { workspaceDir } from "../../core/home/index.js";
import { approvalWording, approvalWordingParams } from "../../core/results/index.js";
import { RESULT_FILE } from "../../core/run/index.js";
import type { RunResult } from "../../core/run/types.js";
import { fileURLToPath } from "node:url";
import { newSequenceId } from "../../core/gates/ids.js";
import { PLAN_SCOPES, type PlanScopeKind } from "../../core/plan/types.js";
import { semanticChoiceArgs, SEMANTIC_PURPOSES, SEMANTIC_RIGORS, type SemanticPurpose, type SemanticRigor } from "../../core/semantic-scope/index.js";
import { SEQUENCE_ID_PATTERN, buildGatePlan, listSequences, readSequence, requestSequenceCancel, type GatePlan, type SequenceView } from "../../core/sequence/index.js";
import type { GateKind } from "../../core/gates/types.js";
import { getLocale, translator } from "../../i18n/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";

const t = translator("sequence");
/** After a cancel request, the child gets this long to stop by itself before it is killed. */
const CANCEL_GRACE_MS = 15_000;

const fail = (status: number, code: string, params: Record<string, string> = {}, details: Record<string, unknown> = {}): HttpError => {
  const key = `sequence_api_${code.toLowerCase()}`;
  const fix = t(`${key}_fix`, params);
  return new HttpError(status, code, t(key, params), fix === `${key}_fix` ? null : fix, details);
};

const text = { type: "string", minLength: 1, maxLength: 4096 };
const list = { type: "array", items: text, maxItems: 200 };
const gatesSchema = { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: ["quality", "semantic"] } };

/** The request of a gate selection: the gates (run-only), the Quality plan flags and the Semantic choices. */
const selectionProperties = {
  gates: gatesSchema,
  profile: text,
  scope: { enum: [...PLAN_SCOPES] },
  paths: list,
  base: text,
  head: text,
  skip: list,
  only: list,
  templates: list,
  purpose: { enum: [...SEMANTIC_PURPOSES] },
  rigor: { enum: [...SEMANTIC_RIGORS] },
  quality: { type: "string", pattern: "^(latest|run_[0-9]{8}T[0-9]{6}Z_[0-9a-f]{8})$" },
};

interface SelectionBody {
  gates?: GateKind[];
  profile?: string;
  scope?: PlanScopeKind;
  paths?: string[];
  base?: string;
  head?: string;
  skip?: string[];
  only?: string[];
  templates?: string[];
  purpose?: SemanticPurpose;
  rigor?: SemanticRigor;
  quality?: string;
  manualAdvance?: boolean;
  reuseQuality?: boolean;
}

const idParams = {
  type: "object",
  properties: { id: { type: "string", pattern: SEQUENCE_ID_PATTERN } },
  required: ["id"],
  additionalProperties: false,
};

/** The plan of a selection, exactly as the CLI builds it for the same request. */
export function gatePlanOf(server: ServerContext, body: SelectionBody): GatePlan {
  return buildGatePlan({
    workspacePath: server.workspace.path,
    home: server.home,
    version: server.version,
    ...(body.gates ? { gates: body.gates } : {}),
    ...(body.profile !== undefined ? { profile: body.profile } : {}),
    quality: {
      ...(body.scope !== undefined ? { scope: body.scope } : {}),
      ...(body.base !== undefined ? { base: body.base } : {}),
      ...(body.head !== undefined ? { head: body.head } : {}),
      paths: body.paths ?? [],
      skip: body.skip ?? [],
      only: body.only ?? [],
      templates: body.templates ?? [],
    },
    semantic: { ...(body.purpose ? { purpose: body.purpose } : {}), ...(body.rigor ? { rigor: body.rigor } : {}) },
    attachQuality: body.quality ?? null,
  });
}

/** The children of this server that drive sequences, by sequence ID (released when they exit). */
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

/** The CLI arguments of the same selection (always --name=value, so a value never reads as another flag). */
function selectionArgs(body: SelectionBody): string[] {
  const args: string[] = [];
  const flag = (name: string, value: string): void => void args.push(`--${name}=${value}`);
  if (body.gates) flag("gates", body.gates.join(","));
  if (body.profile !== undefined) flag("profile", body.profile);
  if (body.scope !== undefined) flag("scope", body.scope);
  for (const p of body.paths ?? []) flag("path", p);
  if (body.base !== undefined) flag("base", body.base);
  if (body.head !== undefined) flag("head", body.head);
  for (const s of body.skip ?? []) flag("skip", s);
  for (const o of body.only ?? []) flag("only", o);
  for (const tpl of body.templates ?? []) flag("template", tpl);
  args.push(...semanticChoiceArgs({ ...(body.purpose ? { purpose: body.purpose } : {}), ...(body.rigor ? { rigor: body.rigor } : {}) }));
  if (body.manualAdvance === true) args.push("--manual-advance");
  if (body.reuseQuality === true) args.push("--reuse-quality");
  return args;
}

function spawnCli(server: ServerContext, id: string, args: string[]): void {
  const child = spawn(process.execPath, [cliMain(), "run", "--cwd", server.workspace.path, ...args, "--json", "--no-interactive", "--locale", getLocale()], {
    cwd: server.workspace.path,
    env: process.env,
    stdio: ["ignore", "ignore", "ignore"],
    // Own process group on POSIX, so a forced stop reaches the tools the runs started too (by pid, never by name).
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const map = childrenOf(server);
  map.set(id, child);
  const release = (): void => void map.delete(id);
  child.once("exit", release);
  child.once("error", release);
}

/** A sequence as the API shows it (without the internal ordering field). */
function publicView(view: SequenceView, server?: ServerContext): Omit<SequenceView, "time"> {
  const { time: _time, ...rest } = view;
  const quality = rest.details?.quality;
  if (!server || !quality || quality.decision !== "passed") return rest;
  // The Quality step reads "approved with N waivers" when its stored result passed with waivers (the wording comes from
  // the core function every surface uses; an unreadable result stays a plain approval).
  try {
    const file = path.join(workspaceDir(server.home, server.workspace.id), "runs", quality.runId, RESULT_FILE);
    const result = JSON.parse(fs.readFileSync(file, "utf8")) as RunResult;
    const wording = approvalWording(result);
    return { ...rest, details: { ...rest.details, quality: { ...quality, approval: { kind: wording.kind, ...approvalWordingParams(wording) } } } } as Omit<SequenceView, "time">;
  } catch {
    return rest;
  }
}

export const routes: RouteDefinition[] = [
  {
    // The plan of a gate selection: the same document as `jgates run --gates ... --dry-run --json` (its `plan`).
    method: "POST",
    path: "/api/sequence/plan",
    body: { type: "object", properties: selectionProperties, additionalProperties: false },
    timeoutMs: 120_000,
    handler({ body, server }) {
      const plan = gatePlanOf(server, (body ?? {}) as SelectionBody);
      return { status: 200, json: { schemaVersion: 1, status: plan.ready ? "OK" : "BLOCKED", plan } };
    },
  },
  {
    method: "GET",
    path: "/api/sequences",
    query: { type: "object", properties: { limit: { type: "string", pattern: "^[1-9][0-9]{0,3}$" } }, additionalProperties: false },
    handler({ query, server }) {
      const limit = Number(query.limit ?? "50");
      const sequences = listSequences(server.home, server.workspace.id).slice(0, limit).map((v) => publicView(v, server));
      return { status: 200, json: { schemaVersion: 1, status: "OK", sequences } };
    },
  },
  {
    // Starts a combined sequence (both gates): answered at once with its ID; the CLI child drives it.
    method: "POST",
    path: "/api/sequences",
    body: { type: "object", properties: { ...selectionProperties, manualAdvance: { type: "boolean" }, reuseQuality: { type: "boolean" } }, additionalProperties: false },
    timeoutMs: 120_000,
    handler({ body, server }) {
      const b = { ...((body ?? {}) as SelectionBody), gates: ((body as SelectionBody | undefined)?.gates ?? ["quality", "semantic"]) as GateKind[] };
      if (server.policyMode) throw fail(409, "POLICY_MODE");
      const active = [...childrenOf(server).keys()][0];
      if (active) throw fail(409, "SEQUENCE_ACTIVE", { id: active }, { sequenceId: active });
      const plan = gatePlanOf(server, b);
      if (plan.advancement.condition !== "quality-approved" || !plan.ready) {
        throw fail(422, "NOT_READY", { detail: plan.blockers.map((x) => x.message).join(" ") || plan.selection.gates.join(",") }, { blockers: plan.blockers, plan });
      }
      const sequenceId = newSequenceId();
      spawnCli(server, sequenceId, [...selectionArgs(b), `--sequence-id=${sequenceId}`]);
      server.log(`sequence ${sequenceId} started`);
      return { status: 202, json: { schemaVersion: 1, status: "OK", sequence: { sequenceId, lifecycle: "running", qualityPlanHash: plan.quality?.planHash ?? null, semanticPlanHash: plan.semantic?.planHash ?? null } } };
    },
  },
  {
    method: "GET",
    path: "/api/sequences/:id",
    params: idParams,
    handler({ params, server }) {
      const id = params.id as string;
      const view = readSequence(server.home, server.workspace.id, id);
      if (!view) {
        if (childrenOf(server).has(id)) return { status: 200, json: { schemaVersion: 1, status: "OK", sequence: { sequenceId: id, lifecycle: "running", live: true, record: null, details: null } } };
        throw fail(404, "SEQUENCE_NOT_FOUND", { id });
      }
      return { status: 200, json: { schemaVersion: 1, status: "OK", sequence: publicView(view, server) } };
    },
  },
  {
    method: "POST",
    path: "/api/sequences/:id/cancel",
    params: idParams,
    handler({ params, server }) {
      const id = params.id as string;
      const child = childrenOf(server).get(id);
      const outcome = requestSequenceCancel(server.home, server.workspace.id, id, { reason: "cancel requested (local server)" });
      if (outcome.status === "not-found" && !child) throw fail(404, "SEQUENCE_NOT_FOUND", { id });
      if (outcome.status === "not-active") throw fail(409, "SEQUENCE_NOT_ACTIVE", { id });
      if (child) {
        // The sequence stops by itself on the request; a child that does not is stopped (only that child: it is ours).
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
      server.log(`sequence ${id} cancel requested`);
      return { status: 202, json: { schemaVersion: 1, status: "OK", sequenceId: id, cancel: outcome.status === "not-found" ? "requested" : outcome.status, message: t("sequence_api_cancel_requested", { id }) } };
    },
  },
  {
    // Continues a sequence waiting after its Quality approval; the prerequisite is checked again by the CLI child.
    method: "POST",
    path: "/api/sequences/:id/advance",
    params: idParams,
    handler({ params, server }) {
      const id = params.id as string;
      if (server.policyMode) throw fail(409, "POLICY_MODE");
      const view = readSequence(server.home, server.workspace.id, id);
      if (!view) throw fail(404, "SEQUENCE_NOT_FOUND", { id });
      if (view.record.status !== "awaiting-advancement") throw fail(409, "NOT_AWAITING", { id, status: view.record.status });
      const active = [...childrenOf(server).keys()][0];
      if (active) throw fail(409, "SEQUENCE_ACTIVE", { id: active }, { sequenceId: active });
      spawnCli(server, id, [`--advance=${id}`]);
      server.log(`sequence ${id} advance requested`);
      return { status: 202, json: { schemaVersion: 1, status: "OK", sequence: { sequenceId: id, lifecycle: "running" } } };
    },
  },
];
