// Where gate sequences live: <home>/workspaces/<id>/sequences/<seq_...>/, apart from both gates' runs. A sequence
// folder holds the coordination record (sequence.json, schemas/gates/sequence: selected gates, ordered run references,
// advancement condition, status and reason; it never carries a run's decision), the details of the transition
// (details.json: the selection and its origins, the request, the Quality assessment that allowed or refused the
// advancement, reuse provenance, coverage and a timeline), a heartbeat while a process drives it and the cancel
// request another process may write. The runs themselves stay in runs/<run_...> and semantic-runs/<sem_...>.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { workspaceDir, workspaceLineage } from "../home/index.js";
import { loadGateRecord, writeGateRecord } from "../gates/read.js";
import type { SequenceRecord, SequenceStatus } from "../gates/types.js";
import { readLiveness } from "../run/heartbeat.js";
import type { ScopeRequest, SemanticPurpose, SemanticRigor } from "../semantic-scope/index.js";
import type { GateSelection } from "./selection.js";
import type { QualityAssessment, SequenceCoverage } from "./approval.js";
import type { ReuseOutcome } from "./reuse.js";
import { renameWithRetry } from "../fs-retry/index.js";

export const SEQUENCES_DIR = "sequences";
export const SEQUENCE_FILE = "sequence.json";
export const SEQUENCE_DETAILS_FILE = "details.json";
export const SEQUENCE_CANCEL_FILE = "cancel-request.json";
/** Pattern of a sequence ID (the server routes validate their parameter with it). */
export const SEQUENCE_ID_PATTERN = "^seq_[0-9]{8}T[0-9]{6}Z_[0-9a-f]{8}$";
const SEQUENCE_ID = new RegExp(SEQUENCE_ID_PATTERN);

export function isSequenceId(id: string): boolean {
  return SEQUENCE_ID.test(id);
}

export function sequencesDir(home: string, workspaceId: string): string {
  return path.join(workspaceDir(home, workspaceId), SEQUENCES_DIR);
}

/** The folder of one sequence; throws for an ID that is not a sequence ID (no path can be smuggled in). */
export function sequenceDir(home: string, workspaceId: string, sequenceId: string): string {
  if (!isSequenceId(sequenceId)) throw new Error(`not a sequence ID: ${sequenceId}`);
  return path.join(sequencesDir(home, workspaceId), sequenceId);
}

/** What the run asked for, kept so a later advancement rebuilds the same Semantic plan and checks nothing changed. */
export interface SequenceRequest {
  /** The Quality side as the plan was asked for (the flags, or the plan file). */
  quality: { source: "built" | "file"; profile: string | null; scope: string | null; paths: string[]; base: string | null; head: string | null; skip: string[]; only: string[]; templates: string[] };
  semantic: { purpose: SemanticPurpose | null; rigor: SemanticRigor | null; scope: ScopeRequest | null };
  /** Stop after the Quality approval and wait for an explicit advance. */
  manualAdvance: boolean;
  /** Use an equivalent finished Quality run instead of running Quality again, when every input matches. */
  reuseQuality: boolean;
}

export interface SequenceTimelineEntry {
  at: string;
  status: SequenceStatus;
  /** created, quality-started, quality-reused, quality-finished, transition, semantic-started, semantic-finished, cancel... */
  event: string;
  code?: string;
  runId?: string;
}

export interface SequenceRunSummary {
  runId: string;
  decision: string | null;
  complete: boolean;
  reduced: boolean;
  exitCode: number | null;
  runDir: string | null;
}

/** The details of a sequence next to its coordination record. Never the decision of a run: those stay in the runs. */
export interface SequenceDetails {
  schemaVersion: 1;
  sequenceId: string;
  workspace: { id: string; path: string };
  selection: GateSelection;
  request: SequenceRequest;
  plans: {
    quality: { planHash: string; source: "built" | "file" } | null;
    /** The Semantic plan as built before Quality (settingsHash ignores the attached Quality report). */
    semantic: { planHash: string; settingsHash: string } | null;
  };
  quality: (SequenceRunSummary & { reuse: ReuseOutcome | null }) | null;
  /** Why the sequence advanced or not, from the Quality run's own decision fields, its source and the policy. */
  assessment: QualityAssessment | null;
  semantic: (SequenceRunSummary & { planHash: string; qualityEvidence: { freshness: string; currentApproval: boolean } | null }) | null;
  coverage: SequenceCoverage | null;
  /** Problems found before any run started (an invalid Quality configuration, a Semantic plan that is not ready). */
  preflight: Array<{ gate: "quality" | "semantic"; code: string; message: string; details?: unknown }>;
  timeline: SequenceTimelineEntry[];
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameWithRetry(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Writes the coordination record (validated against its schema) and the details, in that order. */
export function writeSequence(dir: string, record: SequenceRecord, details: SequenceDetails): void {
  writeGateRecord("sequence", path.join(dir, SEQUENCE_FILE), record);
  writeJsonAtomic(path.join(dir, SEQUENCE_DETAILS_FILE), details);
}

/** running: a process drives it and still beats; idle: nobody drives it (settled, waiting or interrupted). */
export type SequenceLifecycle = "running" | "waiting" | "settled" | "interrupted";

export interface SequenceView {
  sequenceId: string;
  workspaceId: string;
  dir: string;
  record: SequenceRecord;
  details: SequenceDetails | null;
  lifecycle: SequenceLifecycle;
  live: boolean;
  cancelRequested: boolean;
  time: number;
}

const ACTIVE: ReadonlySet<SequenceStatus> = new Set(["pending", "running", "advanced"]);

function viewOf(workspaceId: string, sequenceId: string, dir: string): SequenceView | null {
  let record: SequenceRecord;
  try {
    record = loadGateRecord("sequence", path.join(dir, SEQUENCE_FILE));
  } catch {
    return null;
  }
  const details = readJson<SequenceDetails>(path.join(dir, SEQUENCE_DETAILS_FILE));
  const alive = readLiveness(dir).alive;
  const lifecycle: SequenceLifecycle = ACTIVE.has(record.status) ? (alive ? "running" : "interrupted") : record.status === "awaiting-advancement" ? "waiting" : "settled";
  const parsed = Date.parse(record.createdAt);
  return {
    sequenceId,
    workspaceId,
    dir,
    record,
    details,
    lifecycle,
    live: lifecycle === "running",
    cancelRequested: fs.existsSync(path.join(dir, SEQUENCE_CANCEL_FILE)),
    time: Number.isFinite(parsed) ? parsed : 0,
  };
}

/** One sequence of the workspace (or of a workspace relinked into it); null when there is none with that ID. */
export function readSequence(home: string, workspaceId: string, sequenceId: string): SequenceView | null {
  if (!isSequenceId(sequenceId)) return null;
  for (const id of workspaceLineage(home, workspaceId)) {
    const dir = sequenceDir(home, id, sequenceId);
    if (fs.existsSync(path.join(dir, SEQUENCE_FILE))) return viewOf(id, sequenceId, dir);
  }
  return null;
}

/** The sequences of a workspace, newest first. */
export function listSequences(home: string, workspaceId: string): SequenceView[] {
  const out: SequenceView[] = [];
  for (const id of workspaceLineage(home, workspaceId)) {
    let names: string[];
    try {
      names = fs.readdirSync(sequencesDir(home, id));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!isSequenceId(name)) continue;
      const view = viewOf(id, name, path.join(sequencesDir(home, id), name));
      if (view) out.push(view);
    }
  }
  return out.sort((a, b) => b.time - a.time || (a.sequenceId < b.sequenceId ? 1 : -1));
}

export function writeCancelRequest(dir: string, reason: string, now: Date): void {
  writeJsonAtomic(path.join(dir, SEQUENCE_CANCEL_FILE), { schemaVersion: 1, requestedAt: now.toISOString(), reason, pid: process.pid });
}

export function readCancelRequest(dir: string): { reason: string } | null {
  const file = path.join(dir, SEQUENCE_CANCEL_FILE);
  if (!fs.existsSync(file)) return null;
  const doc = readJson<{ reason?: unknown }>(file);
  return { reason: typeof doc?.reason === "string" && doc.reason !== "" ? doc.reason : "cancel requested" };
}

export function clearCancelRequest(dir: string): void {
  fs.rmSync(path.join(dir, SEQUENCE_CANCEL_FILE), { force: true });
}
