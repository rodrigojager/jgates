// Where independent Semantic runs live and how their history is read. A Semantic run has its own folder under
// <home>/workspaces/<id>/semantic-runs/<sem_...>, apart from the Quality runs (runs/<run_...>), so the Quality history,
// its retention, its baselines and its mascots never see a Semantic run and the reverse. The files of a run follow the
// Quality conventions: result.json (rewritten with partial: true while the run goes), events.jsonl (ordered events),
// heartbeat.json (alive while it beats), plan.json, outputs/ and the run identity run.json (schemas/gates).
import fs from "node:fs";
import path from "node:path";
import { readEvents } from "../events/index.js";
import { workspaceDir, workspaceLineage } from "../home/index.js";
import { readLiveness } from "../run/heartbeat.js";
import { loadGateRecord } from "../gates/read.js";
import type { GateRunIdentity } from "../gates/types.js";
import type { RunResult } from "../run/types.js";

export const SEMANTIC_RUNS_DIR = "semantic-runs";
/** Pattern of a Semantic run ID (the server routes validate their parameter with it). */
export const SEMANTIC_RUN_ID_PATTERN = "^sem_[0-9]{8}T[0-9]{6}Z_[0-9a-f]{8}$";
export const SEMANTIC_RESULT_FILE = "result.json";
export const SEMANTIC_PLAN_FILE = "plan.json";
export const SEMANTIC_EVENTS_FILE = "events.jsonl";
/** The run identity (schemas/gates/run-identity): gate, ID, configuration, source identity, plan, stages, outcome. */
export const RUN_IDENTITY_FILE = "run.json";
/** Written by a cancel request (CLI, server or another process); the running process watches for it. */
export const CANCEL_REQUEST_FILE = "cancel-request.json";
/** The outcome of the review, kept even when the run is cancelled or fails (partial evidence). */
export const REVIEW_OUTPUT = "outputs/review.json";

const RUN_ID = new RegExp(SEMANTIC_RUN_ID_PATTERN);

export function isSemanticRunId(runId: string): boolean {
  return RUN_ID.test(runId);
}

export function semanticRunsDir(home: string, workspaceId: string): string {
  return path.join(workspaceDir(home, workspaceId), SEMANTIC_RUNS_DIR);
}

/** The folder of one Semantic run; throws for an ID that is not a Semantic run ID (no path can be smuggled in). */
export function semanticRunDir(home: string, workspaceId: string, runId: string): string {
  if (!isSemanticRunId(runId)) throw new Error(`not a Semantic run ID: ${runId}`);
  return path.join(semanticRunsDir(home, workspaceId), runId);
}

/**
 * running: the result is partial and the process still beats. settled: the run finished (its result is final), so a
 * screen shows it at rest, with nothing animated. interrupted: partial and no longer beating (the process died).
 */
export type SemanticLifecycle = "running" | "settled" | "interrupted";

export interface SemanticRunInfo {
  runId: string;
  gate: "semantic";
  /** The workspace id whose folder holds the run (an older id when the workspace was relinked). */
  workspaceId: string;
  dir: string;
  startedAt: string | null;
  finishedAt: string | null;
  decision: string | null;
  exitCode: number | null;
  complete: boolean;
  partial: boolean;
  lifecycle: SemanticLifecycle;
  /** true only while the run executes: a reopened finished run is never live. */
  live: boolean;
  cancelRequested: boolean;
  provider: string | null;
  model: string | null;
  /** The review state of the outcome (completed, invalid, timeout...), when the run got that far. */
  reviewState: string | null;
  /** Milliseconds since epoch, for ordering: startedAt, else the folder's modification time. */
  time: number;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function infoOf(workspaceId: string, runId: string, dir: string, mtimeMs: number): SemanticRunInfo {
  const result = readJson(path.join(dir, SEMANTIC_RESULT_FILE)) as Partial<RunResult> | null;
  const partial = result === null || result.partial === true;
  const alive = partial && readLiveness(dir).alive;
  const lifecycle: SemanticLifecycle = !partial ? "settled" : alive ? "running" : "interrupted";
  const startedAt = typeof result?.startedAt === "string" ? result.startedAt : null;
  const parsed = startedAt ? Date.parse(startedAt) : NaN;
  const outcome = result?.semanticRun?.outcome ?? null;
  return {
    runId,
    gate: "semantic",
    workspaceId,
    dir,
    startedAt,
    finishedAt: !partial && typeof result?.finishedAt === "string" ? result.finishedAt : null,
    decision: typeof result?.decision === "string" ? result.decision : null,
    exitCode: !partial && typeof result?.exitCode === "number" ? result.exitCode : null,
    complete: result?.complete === true,
    partial,
    lifecycle,
    live: lifecycle === "running",
    cancelRequested: fs.existsSync(path.join(dir, CANCEL_REQUEST_FILE)),
    provider: typeof outcome?.provider === "string" ? outcome.provider : null,
    model: typeof outcome?.model === "string" ? outcome.model : null,
    reviewState: typeof outcome?.state === "string" ? outcome.state : null,
    time: Number.isFinite(parsed) ? parsed : mtimeMs,
  };
}

/** The Semantic runs stored in one workspace folder (no relinked ones), newest first. */
export function readSemanticRunsOf(home: string, workspaceId: string): SemanticRunInfo[] {
  const root = semanticRunsDir(home, workspaceId);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: SemanticRunInfo[] = [];
  for (const name of names) {
    if (!isSemanticRunId(name)) continue;
    const dir = path.join(root, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    out.push(infoOf(workspaceId, name, dir, st.mtimeMs));
  }
  return out.sort((a, b) => b.time - a.time || (a.runId < b.runId ? 1 : -1));
}

/** The Semantic history of a workspace: its own runs and those of the ids relinked into it, newest first. */
export function listSemanticRuns(home: string, workspaceId: string): SemanticRunInfo[] {
  const all = workspaceLineage(home, workspaceId).flatMap((id) => readSemanticRunsOf(home, id));
  return all.sort((a, b) => b.time - a.time || (a.runId < b.runId ? 1 : -1));
}

/** One Semantic run of the workspace (or of a workspace relinked into it); null when there is none with that ID. */
export function findSemanticRun(home: string, workspaceId: string, runId: string): SemanticRunInfo | null {
  if (!isSemanticRunId(runId)) return null;
  for (const id of workspaceLineage(home, workspaceId)) {
    const dir = semanticRunDir(home, id, runId);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (st.isDirectory()) return infoOf(id, runId, dir, st.mtimeMs);
  }
  return null;
}

export interface SemanticRunView extends SemanticRunInfo {
  result: RunResult | null;
  identity: GateRunIdentity | null;
  plan: Record<string, unknown> | null;
  /** Events written so far and the sequence of the last one. */
  events: { count: number; cursor: number };
}

/** A Semantic run as a screen or `jgates semantic status` shows it: its state, result, identity and plan. */
export function readSemanticRun(home: string, workspaceId: string, runId: string): SemanticRunView | null {
  const info = findSemanticRun(home, workspaceId, runId);
  if (!info) return null;
  let identity: GateRunIdentity | null = null;
  try {
    identity = loadGateRecord("run-identity", path.join(info.dir, RUN_IDENTITY_FILE));
  } catch {
    identity = null;
  }
  const read = readEvents(path.join(info.dir, SEMANTIC_EVENTS_FILE));
  return {
    ...info,
    result: readJson(path.join(info.dir, SEMANTIC_RESULT_FILE)) as RunResult | null,
    identity,
    plan: readJson(path.join(info.dir, SEMANTIC_PLAN_FILE)),
    events: { count: read.events.length, cursor: read.cursor },
  };
}
