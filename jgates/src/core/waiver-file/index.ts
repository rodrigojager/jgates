// The project's waiver file (.jgates/waivers.json): reading it, listing its entries with their state, adding entries made
// from findings of a stored run (with a preview that writes nothing), removing entries, and undoing either write. The
// CLI (`jgates waivers`) and the server routes call these same functions, so both give the same answer for the same
// request.
//
// What the file looks like after a write: the shape it had (a list, or an object with `waivers`) with every other entry
// and unknown key untouched; new entries at the end with a stable key order, two-space indentation and the line break
// the file uses; a file that does not exist is created as an object with `waivers` and a final newline. Only the entry
// changes: the edits splice the original text. The write is atomic and refuses a file that changed since it was read. A
// file that cannot be parsed is never rewritten. Nothing here writes outside the project folder, and nothing is kept
// anywhere else.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AtomicWriteError, writeBytesAtomic } from "../documents/atomic.js";
import { unifiedDiff } from "../documents/diff.js";
import { insideBySegments } from "../documents/paths.js";
import { listRuns } from "../artifacts/index.js";
import { classifyWaivers, isExpired, occurrenceWaiver, parseWaivers, WAIVERS_FILE, type OccurrenceWaiverEntry, type StaleCause, type Waiver } from "../results/index.js";
import type { ResultFinding, RunResult } from "../run/types.js";
import { appendEntries, locateEntries, newFileText, removeElement, type Span } from "./layout.js";

export const WAIVER_FILE = WAIVERS_FILE;
export const REASON_MIN = 3;
export const REASON_MAX = 300;
/** The first characters of a fingerprint (after `jgf1:`) shown in the terminal and accepted by `--finding`. */
export const SHORT_FINGERPRINT = 12;
/** The file never has an entry id shorter than this; any unique prefix of at least MIN_ID_PREFIX characters works. */
export const ID_LENGTH = 8;
export const MIN_ID_PREFIX = 4;
const MIN_FINGERPRINT_PREFIX = 4;

export type WaiverFileCode =
  | "WAIVER_UNTIL_REQUIRED"
  | "WAIVER_UNTIL_INVALID"
  | "WAIVER_UNTIL_PAST"
  | "WAIVER_REASON_INVALID"
  | "WAIVER_FINDING_REQUIRED"
  | "WAIVER_FINDING_NOT_FOUND"
  | "WAIVER_FINDING_AMBIGUOUS"
  | "WAIVER_FINDING_NOT_WAIVABLE"
  | "WAIVER_ALREADY_EXISTS"
  | "WAIVER_ID_REQUIRED"
  | "WAIVER_NOT_FOUND"
  | "WAIVER_ID_AMBIGUOUS"
  | "WAIVER_FILE_INVALID"
  | "WAIVER_FILE_CHANGED"
  | "WAIVER_FILE_UNSAFE"
  | "WAIVER_WRITE_FAILED"
  | "WAIVER_RUN_NOT_FOUND"
  | "WAIVER_NO_RUN";

/** A refusal: nothing was written. `details` carries what the message names (the candidates, the place of the problem). */
export interface WaiverFileRefusal {
  ok: false;
  code: WaiverFileCode;
  message: string;
  details: Record<string, unknown>;
}

const refuse = (code: WaiverFileCode, message: string, details: Record<string, unknown> = {}): WaiverFileRefusal => ({ ok: false, code, message, details });

class WaiverFileError extends Error {
  constructor(readonly refusal: WaiverFileRefusal) {
    super(refusal.message);
  }
}

// ---- reading ------------------------------------------------------------------------------------------------

export interface WaiverFileProblem {
  message: string;
  /** 1-based place of the problem in the file, when the parser said where. */
  line?: number;
  column?: number;
}

/** One entry of the file with where it sits in the text. */
export interface WaiverFileEntry {
  /** Short id derived from the entry's content (never its position): stable across calls. */
  id: string;
  /** Position among the entries of the file (for display only). */
  index: number;
  raw: Record<string, unknown>;
  waiver: Waiver;
  span: Span;
}

export interface WaiverFileRead {
  file: string;
  target: string;
  exists: boolean;
  /** sha256 (hex) of the bytes read, or "absent": what a write must still find. */
  revision: string;
  /** The text without its byte order mark. */
  text: string;
  bom: boolean;
  shape: "list" | "object" | "missing";
  entries: WaiverFileEntry[];
  /** The file exists and cannot be used: it is reported and never rewritten. */
  problem?: WaiverFileProblem;
}

export const ABSENT = "absent";

const hashOf = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** The short id of an entry: the first hex digits of the hash of its content with the keys sorted. */
export function entryId(raw: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(raw))).digest("hex").slice(0, ID_LENGTH);
}

function locate(text: string, error: unknown): WaiverFileProblem {
  const message = error instanceof Error ? error.message : String(error);
  const m = /position (\d+)/.exec(message);
  if (!m) return { message };
  const pos = Math.min(Number(m[1]), text.length);
  const before = text.slice(0, pos);
  const line = before.split("\n").length;
  const column = pos - (before.lastIndexOf("\n") + 1) + 1;
  return { message, line, column };
}

/** Where the project's waiver file lives, refusing a path that leaves the project (a link to elsewhere). */
function resolveTarget(projectDir: string): { ok: true; target: string; projectReal: string } | WaiverFileRefusal {
  let projectReal: string;
  try {
    projectReal = fs.realpathSync(projectDir);
  } catch (error) {
    return refuse("WAIVER_FILE_UNSAFE", `the project folder cannot be read: ${(error as Error).message}`);
  }
  const dir = path.join(projectReal, ".jgates");
  const target = path.join(dir, "waivers.json");
  for (const p of [dir, target]) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) return refuse("WAIVER_FILE_UNSAFE", `${path.relative(projectReal, p).replace(/\\/g, "/")} is a link: it is not followed`, { path: p });
    if (p === dir && !st.isDirectory()) return refuse("WAIVER_FILE_UNSAFE", ".jgates is not a folder");
  }
  if (!insideBySegments(projectReal, target)) return refuse("WAIVER_FILE_UNSAFE", "the waiver file is outside the project");
  return { ok: true, target, projectReal };
}

/** Reads the project's waiver file. Never writes; never throws for a file that is missing or cannot be parsed. */
export function readWaiverFile(projectDir: string): WaiverFileRead | WaiverFileRefusal {
  const where = resolveTarget(projectDir);
  if (!("target" in where)) return where;
  const base = { file: WAIVER_FILE, target: where.target };
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(where.target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ...base, exists: false, revision: ABSENT, text: "", bom: false, shape: "missing", entries: [] };
    return { ...base, exists: true, revision: ABSENT, text: "", bom: false, shape: "missing", entries: [], problem: { message: error instanceof Error ? error.message : String(error) } };
  }
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const text = bytes.subarray(bom ? 3 : 0).toString("utf8");
  const revision = hashOf(bytes);
  const invalid = (problem: WaiverFileProblem): WaiverFileRead => ({ ...base, exists: true, revision, text, bom, shape: "missing", entries: [], problem });
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    return invalid(locate(text, error));
  }
  const found = locateEntries(text);
  const parsed = parseWaivers(payload);
  if (!found || parsed.problem) return invalid({ message: parsed.problem ?? "the waiver file must hold a list or a waivers object" });
  const entries: WaiverFileEntry[] = [];
  found.array.elements.forEach((span, index) => {
    const raw = JSON.parse(text.slice(span.start, span.end)) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const waiver = parseWaivers([raw]).waivers[0] ?? {};
    entries.push({ id: entryId(raw as Record<string, unknown>), index, raw: raw as Record<string, unknown>, waiver, span });
  });
  return { ...base, exists: true, revision, text, bom, shape: found.shape, entries };
}

// ---- listing ------------------------------------------------------------------------------------------------

/** One entry as `jgates waivers list` and `GET /api/waivers` show it. */
export interface WaiverView {
  id: string;
  /** Made from a finding (anchor or count guard) or written by hand (a rule and path, or a fingerprint). */
  kind: "occurrence" | "handwritten";
  tool?: string;
  rule?: string;
  /** The file, or the path pattern of a hand-written entry. */
  path?: string;
  /** The line as last seen (display only). */
  line?: number;
  reason?: string;
  created?: string;
  expires?: string;
  /** live: in force; expired: its date passed; stale: the code it pointed at changed and it cannot be matched safely. */
  state: "live" | "expired" | "stale";
  cause?: StaleCause;
  /** Whether it matched something in the last validation (null: there is no validation to look at). */
  matched: boolean | null;
  /** How many findings of the last validation it matched. */
  matchedFindings: number;
}

export interface WaiverListing {
  file: string;
  exists: boolean;
  revision: string;
  problem?: WaiverFileProblem;
  /** The run the entries were compared with, when there is one. */
  runId: string | null;
  waivers: WaiverView[];
}

/** The entries of the file with their state against `result` (the last validation of the workspace), or alone. */
export function listWaivers(read: WaiverFileRead, result: Pick<RunResult, "findings"> | null, runId: string | null, now: Date): WaiverListing {
  const statuses = classifyWaivers(result ?? { findings: [] }, read.entries.map((e) => e.waiver), now);
  const waivers = read.entries.map((entry, i): WaiverView => {
    const w = entry.waiver;
    const s = statuses[i]!;
    const occurrence = w.anchor !== undefined || w.occurrences !== undefined;
    return {
      id: entry.id,
      kind: occurrence ? "occurrence" : "handwritten",
      ...(w.tool ? { tool: w.tool } : {}),
      ...(w.rule ? { rule: w.rule } : {}),
      ...(w.path ? { path: w.path } : {}),
      ...(w.line !== undefined ? { line: w.line } : {}),
      ...(w.reason ? { reason: w.reason } : {}),
      ...(w.created ? { created: w.created } : {}),
      ...(w.expires ? { expires: w.expires } : {}),
      state: s.state,
      ...(s.cause ? { cause: s.cause } : {}),
      matched: result ? s.matched > 0 : null,
      matchedFindings: s.matched,
    };
  });
  return { file: read.file, exists: read.exists, revision: read.revision, ...(read.problem ? { problem: read.problem } : {}), runId, waivers };
}

// ---- the run the entries are made from ------------------------------------------------------------------------

/** The result of one run of the workspace: the given id, or the newest finished validation. */
export function findRunResult(home: string, workspaceId: string, runId?: string): { ok: true; runId: string; result: RunResult } | WaiverFileRefusal {
  const runs = listRuns(home, workspaceId);
  const run = runId ? runs.find((r) => r.runId === runId) : runs.find((r) => !r.partial && r.decision !== null);
  if (!run) return runId ? refuse("WAIVER_RUN_NOT_FOUND", `run ${runId} was not found in this workspace`, { runId }) : refuse("WAIVER_NO_RUN", "this workspace has no finished validation");
  try {
    const result = JSON.parse(fs.readFileSync(path.join(run.dir, "result.json"), "utf8")) as RunResult;
    return { ok: true, runId: run.runId, result };
  } catch {
    return refuse("WAIVER_RUN_NOT_FOUND", `the result of run ${run.runId} cannot be read`, { runId: run.runId });
  }
}

/** The last validation of the workspace, for listing: absent when there is none or it cannot be read. */
export function lastResult(home: string, workspaceId: string): { runId: string; result: RunResult } | null {
  const found = findRunResult(home, workspaceId);
  return found.ok ? { runId: found.runId, result: found.result } : null;
}

// ---- preparing a change (nothing is written) -------------------------------------------------------------------

export interface PreparedChange {
  ok: true;
  kind: "add" | "remove";
  file: string;
  target: string;
  /** The revision the change was prepared against: the write refuses when the file is no longer this. */
  revision: string;
  existed: boolean;
  /** Bytes to write, and the bytes the file has now (null: it does not exist). */
  after: string;
  before: string | null;
  bom: boolean;
  /** Unified diff of the file: the entries and nothing else. */
  diff: string;
  /** What `add` adds (in the order written). */
  entries: OccurrenceWaiverEntry[];
  /** What `remove` takes out. */
  removed: WaiverView[];
}

export interface AddRequest {
  /** The stored result the entries are made from. */
  result: Pick<RunResult, "findings">;
  /** Fingerprints, short ones (12 hex digits after `jgf1:`) or any unique prefix, with or without `jgf1:`. */
  findings: string[];
  /** YYYY-MM-DD: required, today or later. */
  until: string | undefined;
  reason: string | undefined;
  now: Date;
  /** The revision the caller read; the change is refused when the file moved on. */
  expectedRevision?: string;
}

const REAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The problem with a reason, or null when it is a text of 3 to 300 characters without control characters. */
export function reasonProblem(reason: string | undefined): string | null {
  if (reason === undefined) return "a reason is required";
  if (/[\u0000-\u001f\u007f-\u009f]/.test(reason) || reason.includes(String.fromCharCode(0x2028)) || reason.includes(String.fromCharCode(0x2029))) return "the reason has control characters";
  const n = [...reason.trim()].length;
  if (n < REASON_MIN) return `the reason has ${n} characters; it needs at least ${REASON_MIN}`;
  if (n > REASON_MAX) return `the reason has ${n} characters; it takes at most ${REASON_MAX}`;
  return null;
}

/** The short form of a fingerprint shown in the terminal. */
export const shortFingerprint = (fingerprint: string): string => fingerprint.replace(/^jgf1:/, "").slice(0, SHORT_FINGERPRINT);

const normalizeFingerprint = (given: string): string => given.trim().replace(/^jgf1:/i, "").toLowerCase();

function resolveFinding(findings: ResultFinding[], given: string): { finding: ResultFinding } | WaiverFileRefusal {
  const wanted = normalizeFingerprint(given);
  if (!/^[0-9a-f]+$/.test(wanted) || wanted.length < MIN_FINGERPRINT_PREFIX) return refuse("WAIVER_FINDING_NOT_FOUND", `"${given}" is not a fingerprint or the start of one (at least ${MIN_FINGERPRINT_PREFIX} hexadecimal digits)`, { finding: given });
  const hits = findings.filter((f) => f.fingerprint !== undefined && f.fingerprint.replace(/^jgf1:/, "").startsWith(wanted));
  const distinct = new Map(hits.map((f) => [f.fingerprint!, f] as const));
  if (distinct.size === 0) return refuse("WAIVER_FINDING_NOT_FOUND", `no finding of the run has the fingerprint ${given}`, { finding: given });
  if (distinct.size > 1) {
    const candidates = [...distinct.values()].slice(0, 20).map((f) => ({ fingerprint: shortFingerprint(f.fingerprint!), tool: f.tool, rule: f.ruleId, path: f.location?.path ?? null, line: f.location?.line ?? null }));
    return refuse("WAIVER_FINDING_AMBIGUOUS", `${given} starts ${distinct.size} fingerprints of the run: ${candidates.map((c) => c.fingerprint).join(", ")}`, { finding: given, candidates, count: distinct.size });
  }
  return { finding: [...distinct.values()][0]! };
}

function sameTarget(existing: Waiver, entry: OccurrenceWaiverEntry): boolean {
  if (existing.anchor !== undefined || entry.anchor !== undefined) return existing.anchor === entry.anchor && existing.tool === entry.tool && existing.rule === entry.rule && existing.path === entry.path;
  return existing.fingerprint === entry.fingerprint && existing.tool === entry.tool && existing.rule === entry.rule && existing.path === entry.path;
}

/** The entry with its keys in the order the file keeps them. */
function orderedEntry(entry: OccurrenceWaiverEntry): OccurrenceWaiverEntry {
  return {
    tool: entry.tool,
    rule: entry.rule,
    path: entry.path,
    fingerprint: entry.fingerprint,
    ...(entry.anchor !== undefined ? { anchor: entry.anchor } : {}),
    occurrences: entry.occurrences,
    ...(entry.line !== undefined ? { line: entry.line } : {}),
    reason: entry.reason,
    created: entry.created,
    expires: entry.expires,
  };
}

function checkRevision(read: WaiverFileRead, expected: string | undefined): WaiverFileRefusal | null {
  if (expected !== undefined && expected !== read.revision) return refuse("WAIVER_FILE_CHANGED", "the waiver file changed since it was read; read it again", { expected, current: read.revision });
  return null;
}

function usable(read: WaiverFileRead): WaiverFileRefusal | null {
  if (!read.problem) return null;
  const at = read.problem.line !== undefined ? ` (line ${read.problem.line}, column ${read.problem.column})` : "";
  return refuse("WAIVER_FILE_INVALID", `${read.file} cannot be read${at}: ${read.problem.message}. It is not rewritten`, { file: read.file, problem: read.problem });
}

function change(read: WaiverFileRead, kind: "add" | "remove", after: string, extra: Pick<PreparedChange, "entries" | "removed">): PreparedChange {
  return {
    ok: true,
    kind,
    file: read.file,
    target: read.target,
    revision: read.revision,
    existed: read.exists,
    before: read.exists ? read.text : null,
    after,
    bom: read.bom,
    diff: unifiedDiff(read.exists ? read.text : "", after, { oldLabel: `a/${read.file}`, newLabel: `b/${read.file}` }),
    ...extra,
  };
}

/** Prepares adding one occurrence waiver per finding named: validates everything, writes nothing. */
export function prepareAdd(projectDir: string, request: AddRequest): PreparedChange | WaiverFileRefusal {
  const until = request.until?.trim();
  if (!until) return refuse("WAIVER_UNTIL_REQUIRED", "an end date is required (YYYY-MM-DD)");
  const m = REAL_DATE.exec(until);
  if (!m || new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDate() !== Number(m[3])) return refuse("WAIVER_UNTIL_INVALID", `"${until}" is not a date (YYYY-MM-DD)`, { until });
  if (isExpired({ expires: until }, request.now)) return refuse("WAIVER_UNTIL_PAST", `${until} is in the past`, { until });
  const problem = reasonProblem(request.reason);
  if (problem) return refuse("WAIVER_REASON_INVALID", problem);
  const reason = request.reason!.trim();
  if (request.findings.length === 0) return refuse("WAIVER_FINDING_REQUIRED", "name the finding to waive (its fingerprint)");

  const findings = request.result.findings ?? [];
  const chosen: ResultFinding[] = [];
  for (const given of request.findings) {
    const r = resolveFinding(findings, given);
    if (!("finding" in r)) return r;
    if (!chosen.some((f) => f.fingerprint === r.finding.fingerprint)) chosen.push(r.finding);
  }
  const created = request.now.toISOString().slice(0, 10);
  const entries: OccurrenceWaiverEntry[] = [];
  for (const finding of chosen) {
    try {
      entries.push(orderedEntry(occurrenceWaiver(request.result, finding, { reason, expires: until, created })));
    } catch (error) {
      return refuse("WAIVER_FINDING_NOT_WAIVABLE", (error as Error).message, { fingerprint: finding.fingerprint ?? null });
    }
  }

  const read = readWaiverFile(projectDir);
  if (!("target" in read)) return read;
  const blocked = usable(read) ?? checkRevision(read, request.expectedRevision);
  if (blocked) return blocked;
  for (const entry of entries) {
    const dup = read.entries.find((e) => !isExpired(e.waiver, request.now) && sameTarget(e.waiver, entry));
    if (dup) return refuse("WAIVER_ALREADY_EXISTS", `the finding ${shortFingerprint(entry.fingerprint)} already has the waiver ${dup.id}`, { id: dup.id, fingerprint: shortFingerprint(entry.fingerprint) });
  }

  let after: string;
  if (!read.exists) after = newFileText(entries);
  else {
    const found = locateEntries(read.text);
    if (!found) return refuse("WAIVER_FILE_INVALID", `${read.file} has no list of waivers. It is not rewritten`, { file: read.file, problem: { message: "no list of waivers" } });
    after = appendEntries(read.text, found.array, entries);
  }
  return change(read, "add", after, { entries, removed: [] });
}

/** Prepares removing the entries with these ids (or unique prefixes): nothing is written. */
export function prepareRemove(projectDir: string, request: { ids: string[]; now: Date; expectedRevision?: string }): PreparedChange | WaiverFileRefusal {
  if (request.ids.length === 0) return refuse("WAIVER_ID_REQUIRED", "name the waiver to remove (its id; `jgates waivers list` shows it)");
  const read = readWaiverFile(projectDir);
  if (!("target" in read)) return read;
  const blocked = usable(read) ?? checkRevision(read, request.expectedRevision);
  if (blocked) return blocked;
  const ids: string[] = [];
  for (const given of request.ids) {
    const wanted = given.trim().toLowerCase();
    const hits = [...new Set(read.entries.filter((e) => wanted.length >= MIN_ID_PREFIX && e.id.startsWith(wanted)).map((e) => e.id))];
    if (hits.length === 0) return refuse("WAIVER_NOT_FOUND", `no waiver has the id ${given}`, { id: given });
    if (hits.length > 1) return refuse("WAIVER_ID_AMBIGUOUS", `${given} starts ${hits.length} ids: ${hits.join(", ")}`, { id: given, candidates: hits });
    if (!ids.includes(hits[0]!)) ids.push(hits[0]!);
  }
  const listing = listWaivers(read, null, null, request.now);
  const removed = ids.map((id) => listing.waivers.find((w) => w.id === id)!);
  // One entry at a time, looking at the text again each time (the first entry with that id; identical entries share one).
  let text = read.text;
  for (const id of ids) {
    const found = locateEntries(text);
    if (!found) break;
    const at = found.array.elements.findIndex((span) => {
      try {
        const raw = JSON.parse(text.slice(span.start, span.end)) as unknown;
        return !!raw && typeof raw === "object" && !Array.isArray(raw) && entryId(raw as Record<string, unknown>) === id;
      } catch {
        return false;
      }
    });
    if (at < 0) break;
    text = removeElement(text, found.array, at);
  }
  return change(read, "remove", text, { entries: [], removed });
}

// ---- writing --------------------------------------------------------------------------------------------------

/** What undoing a write needs: nothing about it is kept outside the project; the caller holds it (the screen, the CLI). */
export interface UndoData {
  file: string;
  /** The revision the file has right after the write: undo refuses when it is no longer this. */
  expectedRevision: string;
  /** The bytes the file had, base64; null when the file did not exist. */
  previous: string | null;
}

export type WriteOutcome = { ok: true; revision: string; undo: UndoData } | WaiverFileRefusal;

const revisionOfDisk = (target: string): string => {
  try {
    return hashOf(fs.readFileSync(target));
  } catch {
    return ABSENT;
  }
};

function writeChecked(target: string, bytes: Buffer, expectedRevision: string, mode: number | undefined): WaiverFileRefusal | null {
  const dir = path.dirname(target);
  const madeDir = !fs.existsSync(dir);
  try {
    if (madeDir) fs.mkdirSync(dir, { recursive: true });
    writeBytesAtomic(target, bytes, {
      ...(mode !== undefined ? { mode } : {}),
      verify: () => {
        if (revisionOfDisk(target) !== expectedRevision) throw new WaiverFileError(refuse("WAIVER_FILE_CHANGED", "the waiver file changed while it was being written; nothing was written", { expected: expectedRevision, current: revisionOfDisk(target) }));
      },
    });
    return null;
  } catch (error) {
    if (madeDir) {
      try {
        fs.rmdirSync(dir);
      } catch {
        // not empty or already gone: leave it
      }
    }
    if (error instanceof WaiverFileError) return error.refusal;
    if (error instanceof AtomicWriteError) return refuse("WAIVER_WRITE_FAILED", `the waiver file could not be written: ${error.message}`);
    return refuse("WAIVER_WRITE_FAILED", `the waiver file could not be written: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function modeOfFile(target: string): number | undefined {
  try {
    return fs.statSync(target).mode & 0o777;
  } catch {
    return undefined;
  }
}

/** Writes a prepared change atomically, refusing when the file is not the one the change was prepared against. */
export function commitChange(prepared: PreparedChange): WriteOutcome {
  const prefix = prepared.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0);
  const bytes = Buffer.concat([prefix, Buffer.from(prepared.after, "utf8")]);
  const failed = writeChecked(prepared.target, bytes, prepared.revision, prepared.existed ? modeOfFile(prepared.target) : undefined);
  if (failed) return failed;
  const previous = prepared.before === null ? null : Buffer.concat([prefix, Buffer.from(prepared.before, "utf8")]).toString("base64");
  return { ok: true, revision: hashOf(bytes), undo: { file: prepared.file, expectedRevision: hashOf(bytes), previous } };
}

/** Puts the file back as it was before a write, when nothing changed it since. */
export function undoChange(projectDir: string, undo: UndoData): { ok: true; revision: string } | WaiverFileRefusal {
  const where = resolveTarget(projectDir);
  if (!("target" in where)) return where;
  const current = revisionOfDisk(where.target);
  if (current !== undo.expectedRevision) return refuse("WAIVER_FILE_CHANGED", "the waiver file changed since the write; it is not put back", { expected: undo.expectedRevision, current });
  if (undo.previous === null) {
    try {
      fs.rmSync(where.target, { force: true });
    } catch (error) {
      return refuse("WAIVER_WRITE_FAILED", `the waiver file could not be removed: ${(error as Error).message}`);
    }
    return { ok: true, revision: ABSENT };
  }
  const bytes = Buffer.from(undo.previous, "base64");
  const failed = writeChecked(where.target, bytes, undo.expectedRevision, modeOfFile(where.target));
  if (failed) return failed;
  return { ok: true, revision: hashOf(bytes) };
}
