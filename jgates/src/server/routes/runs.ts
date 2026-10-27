// Runs: start the run of a reviewed plan (by hash, never a command), read it, follow its events and cancel it.
import fs from "node:fs";
import path from "node:path";
import { readEvents, type RunEvent as StepEvent } from "../../core/events/index.js";
import { workspaceDir } from "../../core/home/index.js";
import { RESULT_FILE } from "../../core/run/index.js";
import { translator } from "../../i18n/index.js";
import { refuse } from "../http.js";
import { JOB_ID_PATTERN, RUN_ID_PATTERN, jobView } from "../runs.js";
import type { RouteDefinition, ServerContext } from "../types.js";
import { PLAN_HASH_PATTERN, findPlan } from "./plans.js";

const t = translator("server");
const MAX_WAIT_MS = 25_000;

const idParams = {
  type: "object",
  properties: { id: { type: "string", pattern: `${JOB_ID_PATTERN}|${RUN_ID_PATTERN}` } },
  required: ["id"],
  additionalProperties: false,
};

/** result.json of a finished run of this workspace, found by id under its runs folder (no symlink followed). */
function readStoredRun(server: ServerContext, runId: string): unknown {
  const runsDir = path.join(workspaceDir(server.home, server.workspace.id), "runs");
  const file = path.join(runsDir, runId, RESULT_FILE);
  try {
    const dirStat = fs.lstatSync(path.join(runsDir, runId));
    const fileStat = fs.lstatSync(file);
    if (!dirStat.isDirectory() || !fileStat.isFile()) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Steps of the plan of a job (one per invocation), so the screen can list the pending ones before they start. */
function planSteps(server: ServerContext, planHash: string): Array<{ id: string; label: string }> {
  const plan = server.plans.get(planHash);
  if (!plan) return [];
  return plan.invocations.map((inv) => {
    const item = plan.groups.willRun.find((i) => i.tool === inv.id) ?? plan.groups.willRun.find((i) => i.adapter === inv.adapter);
    return { id: inv.id, label: item?.label ?? inv.id };
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function jobOf(server: ServerContext, id: string) {
  const job = server.runs.get(id);
  if (!job) throw refuse(404, "RUN_NOT_FOUND");
  return job;
}

export const routes: RouteDefinition[] = [
  {
    method: "POST",
    path: "/api/runs",
    body: { type: "object", properties: { planHash: { type: "string", pattern: PLAN_HASH_PATTERN } }, required: ["planHash"], additionalProperties: false },
    handler({ body, server }) {
      const { planHash } = body as { planHash: string };
      const plan = findPlan(server, planHash);
      if (!plan) throw refuse(404, "PLAN_NOT_FOUND");
      if (plan.blocked || !plan.approvable) {
        const blockers = plan.blocked ? [plan.blocked, ...plan.blockers] : plan.blockers;
        throw refuse(422, "PLAN_NOT_APPROVABLE", { detail: blockers.map((b) => b.message).join(" ") }, { blockers });
      }
      const active = server.runs.active;
      if (active) throw refuse(409, "RUN_ACTIVE", {}, { run: jobView(active, false) });
      const job = server.runs.start(plan);
      return { status: 202, json: { schemaVersion: 1, status: "OK", run: jobView(job) } };
    },
  },
  {
    method: "GET",
    path: "/api/runs/:id",
    params: idParams,
    handler({ params, server }) {
      const id = params.id as string;
      if (id.startsWith("job_")) return { status: 200, json: { schemaVersion: 1, status: "OK", run: jobView(jobOf(server, id)) } };
      const result = readStoredRun(server, id);
      if (!result) throw refuse(404, "RUN_NOT_FOUND");
      return { status: 200, json: { schemaVersion: 1, status: "OK", result } };
    },
  },
  {
    method: "GET",
    path: "/api/runs/:id/events",
    params: idParams,
    query: {
      type: "object",
      properties: { cursor: { type: "string", pattern: "^[0-9]{1,9}$" }, wait: { type: "string", pattern: "^[0-9]{1,6}$" } },
      additionalProperties: false,
    },
    timeoutMs: MAX_WAIT_MS + 5_000,
    async handler({ params, query, server }) {
      const job = jobOf(server, params.id as string);
      const cursor = Number(query.cursor ?? "0");
      const wait = Math.min(Number(query.wait ?? "0"), MAX_WAIT_MS);
      await server.runs.wait(job, cursor, wait);
      const events = job.events.slice(cursor, cursor + 500);
      return {
        status: 200,
        json: { schemaVersion: 1, status: "OK", run: jobView(job, false), events, cursor: cursor + events.length, done: job.state !== "running" && cursor + events.length >= job.events.length },
      };
    },
  },
  {
    // Steps and stages of a run as the runner emitted them (events.jsonl), read by cursor (the sequence of the last event
    // the caller has). A reload asks again from 0 or from its own cursor and gets each event once, in order. `id` is a
    // job of this server or a stored run; for a stored run whose result is still partial, the process died (orphan).
    method: "GET",
    path: "/api/runs/:id/progress",
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
      const job = id.startsWith("job_") ? jobOf(server, id) : null;
      const runsDir = path.join(workspaceDir(server.home, server.workspace.id), "runs");
      const eventsFileOf = (runId: string | null) => (job ? job.eventsFile : runId ? path.join(runsDir, runId, "events.jsonl") : "");
      let runId: string | null = job ? null : id;
      let read: { events: StepEvent[]; cursor: number } = { events: [], cursor };
      for (;;) {
        read = readEvents(eventsFileOf(runId), { after: cursor });
        if (!runId && job) {
          const first = readEvents(job.eventsFile, { after: 0 }).events[0];
          runId = first?.runId ?? null;
        }
        const running = job ? job.state === "running" : false;
        if (read.events.length > 0 || !running || Date.now() >= deadline) break;
        await sleep(150);
      }
      const events = read.events.slice(0, 500);
      const nextCursor = events.length > 0 ? (events[events.length - 1] as StepEvent).sequence : cursor;
      const more = read.events.length > events.length;
      const stored = runId ? readStoredRun(server, runId) : null;
      const partial = (stored as { partial?: boolean } | null)?.partial === true;
      const running = job ? job.state === "running" : false;
      const orphan = !job && partial && server.runs.active === null;
      const done = !more && !running && (job !== null || !partial || orphan);
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          runId,
          run: job ? jobView(job, false) : null,
          steps: job ? planSteps(server, job.planHash) : [],
          events,
          cursor: nextCursor,
          done,
          orphan,
          result: done || orphan ? stored : null,
        },
      };
    },
  },
  {
    method: "POST",
    path: "/api/runs/:id/cancel",
    params: idParams,
    handler({ params, server }) {
      const job = jobOf(server, params.id as string);
      if (!server.runs.cancel(job)) throw refuse(409, "RUN_NOT_ACTIVE", { state: job.state }, { run: jobView(job, false) });
      server.log(`run ${job.id} cancel requested`);
      return { status: 202, json: { schemaVersion: 1, status: "OK", message: t("server_run_cancelling"), run: jobView(job, false) } };
    },
  },
];
