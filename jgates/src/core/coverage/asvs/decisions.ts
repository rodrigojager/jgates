// The project's ASVS decisions (.jgates/asvs.json): the ASVS version, the chosen level (level 1 while the file does not
// say otherwise) and the list of "not applicable" entries (a requirement, a section or a chapter, a reason of 3 to 300
// characters and the date it was recorded; no end date: applicability does not expire). It lives in the project, like the
// waiver file, and is written by the same rules (core/waiver-file): one change at a time, prepared first (a preview that
// writes nothing), written atomically, refused when the file changed since it was read, never rewritten when it cannot be
// parsed, and undone with the bytes the caller holds. The edits splice the original text, so a hand-written file keeps
// every other key, entry, indentation and line break; the diff of a write is the entry and nothing else. Nothing here
// writes outside the project, and the callers refuse every write in governed (read-only) mode.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AtomicWriteError, writeBytesAtomic } from "../../documents/atomic.js";
import { unifiedDiff } from "../../documents/diff.js";
import { insideBySegments } from "../../documents/paths.js";
import { appendEntries, eolOf, removeElement, type ArrayLayout, type Span } from "../../waiver-file/layout.js";
import { reasonProblem } from "../../waiver-file/index.js";
import type { AsvsData, AsvsLevel } from "./index.js";

export const ASVS_DECISIONS_FILE = ".jgates/asvs.json";
export const DEFAULT_ASVS_VERSION = "5.0.0";
export const DEFAULT_ASVS_LEVEL: AsvsLevel = 1;
const ABSENT = "absent";

export type AsvsDecisionCode =
  | "ASVS_REASON_INVALID"
  | "ASVS_TARGET_REQUIRED"
  | "ASVS_TARGET_UNKNOWN"
  | "ASVS_ALREADY_NOT_APPLICABLE"
  | "ASVS_DECISION_NOT_FOUND"
  | "ASVS_LEVEL_INVALID"
  | "ASVS_LEVEL_UNCHANGED"
  | "ASVS_FILE_INVALID"
  | "ASVS_FILE_CHANGED"
  | "ASVS_FILE_UNSAFE"
  | "ASVS_WRITE_FAILED"
  | "ASVS_UNDO_INVALID";

/** A refusal: nothing was written. */
export interface AsvsDecisionRefusal {
  ok: false;
  code: AsvsDecisionCode;
  message: string;
  details: Record<string, unknown>;
}

const refuse = (code: AsvsDecisionCode, message: string, details: Record<string, unknown> = {}): AsvsDecisionRefusal => ({ ok: false, code, message, details });

class DecisionFileError extends Error {
  constructor(readonly refusal: AsvsDecisionRefusal) {
    super(refusal.message);
  }
}

// ---- the text of the file ---------------------------------------------------------------------------------------

const isSpace = (ch: string | undefined): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

function skipSpace(text: string, i: number): number {
  while (i < text.length && isSpace(text[i])) i++;
  return i;
}

function skipString(text: string, i: number): number {
  i++;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === '"') return i + 1;
    else i++;
  }
  return i;
}

/** The index after the JSON value that starts at `i` (the text is valid JSON: the caller parsed it). */
function skipValue(text: string, i: number): number {
  const ch = text[i];
  if (ch === '"') return skipString(text, i);
  if (ch === "[" || ch === "{") {
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i = skipString(text, i);
        continue;
      }
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return i;
  }
  while (i < text.length && !isSpace(text[i]) && text[i] !== "," && text[i] !== "]" && text[i] !== "}") i++;
  return i;
}

function arrayAt(text: string, open: number): ArrayLayout {
  const elements: Span[] = [];
  let i = skipSpace(text, open + 1);
  while (i < text.length && text[i] !== "]") {
    const end = skipValue(text, i);
    elements.push({ start: i, end });
    i = skipSpace(text, end);
    if (text[i] === ",") i = skipSpace(text, i + 1);
  }
  return { open, close: i, elements };
}

interface Member {
  key: string;
  start: number;
  value: Span;
}

/** The members of the top-level object (the last one wins when a key repeats, as JSON.parse reads it); null when it is not an object. */
function topMembers(text: string): { open: number; close: number; members: Member[] } | null {
  const open = skipSpace(text, 0);
  if (text[open] !== "{") return null;
  const members: Member[] = [];
  let i = skipSpace(text, open + 1);
  while (i < text.length && text[i] !== "}") {
    const keyEnd = skipValue(text, i);
    let key: string;
    try {
      key = JSON.parse(text.slice(i, keyEnd)) as string;
    } catch {
      return null;
    }
    const start = i;
    i = skipSpace(text, keyEnd);
    if (text[i] !== ":") return null;
    i = skipSpace(text, i + 1);
    const end = skipValue(text, i);
    members.push({ key, start, value: { start: i, end } });
    i = skipSpace(text, end);
    if (text[i] === ",") i = skipSpace(text, i + 1);
  }
  return { open, close: i, members };
}

const lastMember = (members: Member[], key: string): Member | undefined => [...members].reverse().find((m) => m.key === key);

function lineIndent(text: string, pos: number): string {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(lineStart, pos));
  return m ? m[0] : "";
}

function startsLine(text: string, pos: number): boolean {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*$/.test(text.slice(lineStart, pos));
}

function formatValue(value: unknown, indent: string, eol: string): string {
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((line, n) => (n === 0 ? line : indent + line))
    .join(eol);
}

/** The text after adding a member at the end of the top-level object; nothing else moves. */
function insertMember(text: string, obj: { open: number; close: number; members: Member[] }, key: string, value: unknown): string {
  const eol = eolOf(text);
  const last = obj.members[obj.members.length - 1];
  if (last) {
    const first = obj.members[0]!;
    const indent = startsLine(text, first.start) ? lineIndent(text, first.start) : `${lineIndent(text, obj.open)}  `;
    const insert = `,${eol}${indent}${JSON.stringify(key)}: ${formatValue(value, indent, eol)}`;
    return text.slice(0, last.value.end) + insert + text.slice(last.value.end);
  }
  const closeIndent = lineIndent(text, obj.open);
  const indent = `${closeIndent}  `;
  return `${text.slice(0, obj.open + 1)}${eol}${indent}${JSON.stringify(key)}: ${formatValue(value, indent, eol)}${eol}${closeIndent}${text.slice(obj.close)}`;
}

/** The text of a file that does not exist yet: two-space indentation and a final newline. */
function newFileText(doc: Record<string, unknown>): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// ---- reading ----------------------------------------------------------------------------------------------------

/** One "not applicable" decision: a requirement (`V5.1.1`), a section (`V5.1`) or a chapter (`V5`). */
export interface NotApplicableEntry {
  id: string;
  reason: string;
  /** YYYY-MM-DD. */
  recorded: string;
}

export interface AsvsDecisionsProblem {
  message: string;
  line?: number;
  column?: number;
}

export interface AsvsDecisionsRead {
  file: string;
  target: string;
  exists: boolean;
  /** sha256 (hex) of the bytes read, or "absent": what a write must still find. */
  revision: string;
  text: string;
  bom: boolean;
  /** The version the decisions are for (the default version while the file does not say). */
  version: string;
  /** The recorded level, or null while the file does not record one (the map then uses level 1). */
  level: AsvsLevel | null;
  notApplicable: NotApplicableEntry[];
  /** The file exists and cannot be used: it is reported and never rewritten. */
  problem?: AsvsDecisionsProblem;
}

const hashOf = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");

function locate(text: string, error: unknown): AsvsDecisionsProblem {
  const message = error instanceof Error ? error.message : String(error);
  const m = /position (\d+)/.exec(message);
  if (!m) return { message };
  const pos = Math.min(Number(m[1]), text.length);
  const before = text.slice(0, pos);
  return { message, line: before.split("\n").length, column: pos - (before.lastIndexOf("\n") + 1) + 1 };
}

function resolveTarget(projectDir: string): { ok: true; target: string } | AsvsDecisionRefusal {
  let projectReal: string;
  try {
    projectReal = fs.realpathSync(projectDir);
  } catch (error) {
    return refuse("ASVS_FILE_UNSAFE", `the project folder cannot be read: ${(error as Error).message}`);
  }
  const dir = path.join(projectReal, ".jgates");
  const target = path.join(dir, "asvs.json");
  for (const p of [dir, target]) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) return refuse("ASVS_FILE_UNSAFE", `${path.relative(projectReal, p).replace(/\\/g, "/")} is a link: it is not followed`, { path: p });
    if (p === dir && !st.isDirectory()) return refuse("ASVS_FILE_UNSAFE", ".jgates is not a folder");
  }
  if (!insideBySegments(projectReal, target)) return refuse("ASVS_FILE_UNSAFE", "the decisions file is outside the project");
  return { ok: true, target };
}

const isLevel = (v: unknown): v is AsvsLevel => v === 1 || v === 2 || v === 3;

/** Reads the project's decisions. Never writes; never throws for a file that is missing or cannot be parsed. */
export function readAsvsDecisions(projectDir: string): AsvsDecisionsRead | AsvsDecisionRefusal {
  const where = resolveTarget(projectDir);
  if (!where.ok) return where;
  const base = { file: ASVS_DECISIONS_FILE, target: where.target, version: DEFAULT_ASVS_VERSION, level: null, notApplicable: [] as NotApplicableEntry[] };
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(where.target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ...base, exists: false, revision: ABSENT, text: "", bom: false };
    return { ...base, exists: true, revision: ABSENT, text: "", bom: false, problem: { message: error instanceof Error ? error.message : String(error) } };
  }
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const text = bytes.subarray(bom ? 3 : 0).toString("utf8");
  const revision = hashOf(bytes);
  const invalid = (problem: AsvsDecisionsProblem): AsvsDecisionsRead => ({ ...base, exists: true, revision, text, bom, problem });
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return invalid(locate(text, error));
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !topMembers(text)) return invalid({ message: "the decisions file must hold an object" });
  const o = doc as Record<string, unknown>;
  if (o.version !== undefined && typeof o.version !== "string") return invalid({ message: '"version" must be a text such as "5.0.0"' });
  if (o.level !== undefined && !isLevel(o.level)) return invalid({ message: '"level" must be 1, 2 or 3' });
  if (o.notApplicable !== undefined && !Array.isArray(o.notApplicable)) return invalid({ message: '"notApplicable" must be a list' });
  const notApplicable: NotApplicableEntry[] = [];
  for (const raw of (o.notApplicable as unknown[] | undefined) ?? []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id.trim() === "") continue;
    notApplicable.push({ id: normalizeTarget(e.id), reason: typeof e.reason === "string" ? e.reason : "", recorded: typeof e.recorded === "string" ? e.recorded : "" });
  }
  return { ...base, exists: true, revision, text, bom, version: typeof o.version === "string" ? o.version : DEFAULT_ASVS_VERSION, level: isLevel(o.level) ? o.level : null, notApplicable };
}

/** The decision that makes a requirement not applicable: its own entry, else its section's, else its chapter's. */
export function notApplicableFor(entries: readonly NotApplicableEntry[], requirement: { id: string; section: string; chapter: string }): NotApplicableEntry | null {
  for (const id of [requirement.id, requirement.section, requirement.chapter]) {
    const hit = entries.find((e) => e.id === id);
    if (hit) return hit;
  }
  return null;
}

// ---- preparing a change (nothing is written) ----------------------------------------------------------------------

export type AsvsDecisionChangeKind = "not-applicable" | "remove" | "level";

export interface PreparedDecision {
  ok: true;
  kind: AsvsDecisionChangeKind;
  file: string;
  target: string;
  revision: string;
  existed: boolean;
  before: string | null;
  after: string;
  bom: boolean;
  /** Unified diff of the file: the entry (or the level) and nothing else. */
  diff: string;
  /** not-applicable: the entry added; remove: the entry taken out. */
  entry: NotApplicableEntry | null;
  /** level: the level recorded. */
  level: AsvsLevel | null;
}

/** What kind of id a target is in the data: a requirement, a section or a chapter; null when the version has no such id. */
export function targetKind(data: AsvsData, id: string): "requirement" | "section" | "chapter" | null {
  if (data.requirements.some((r) => r.id === id)) return "requirement";
  if (data.chapters.some((c) => c.sections.some((s) => s.id === id))) return "section";
  if (data.chapters.some((c) => c.id === id)) return "chapter";
  return null;
}

const normalizeTarget = (id: string): string => id.trim().replace(/^v/, "V");

function usable(read: AsvsDecisionsRead, expected: string | undefined): AsvsDecisionRefusal | null {
  if (read.problem) {
    const at = read.problem.line !== undefined ? ` (line ${read.problem.line}, column ${read.problem.column})` : "";
    return refuse("ASVS_FILE_INVALID", `${read.file} cannot be read${at}: ${read.problem.message}. It is not rewritten`, { file: read.file, problem: read.problem });
  }
  if (expected !== undefined && expected !== read.revision) return refuse("ASVS_FILE_CHANGED", "the decisions file changed since it was read; read it again", { expected, current: read.revision });
  return null;
}

function prepared(read: AsvsDecisionsRead, kind: AsvsDecisionChangeKind, after: string, entry: NotApplicableEntry | null, level: AsvsLevel | null): PreparedDecision {
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
    entry,
    level,
  };
}

export interface NotApplicableRequest {
  data: AsvsData;
  /** A requirement, section or chapter id of the data's version. */
  id: string | undefined;
  reason: string | undefined;
  now: Date;
  expectedRevision?: string;
}

/** Prepares recording that a requirement, section or chapter does not apply: validates everything, writes nothing. */
export function prepareNotApplicable(projectDir: string, request: NotApplicableRequest): PreparedDecision | AsvsDecisionRefusal {
  if (request.id === undefined || request.id.trim() === "") return refuse("ASVS_TARGET_REQUIRED", "name the requirement, section or chapter (for example V5.1.1, V5.1 or V5)");
  const id = normalizeTarget(request.id);
  if (!targetKind(request.data, id)) return refuse("ASVS_TARGET_UNKNOWN", `ASVS ${request.data.version} has no requirement, section or chapter ${id}`, { id, version: request.data.version });
  const problem = reasonProblem(request.reason);
  if (problem) return refuse("ASVS_REASON_INVALID", problem);
  const read = readAsvsDecisions(projectDir);
  if ("code" in read) return read;
  const r = read;
  const blocked = usable(r, request.expectedRevision);
  if (blocked) return blocked;
  const dup = r.notApplicable.find((e) => e.id === id);
  if (dup) return refuse("ASVS_ALREADY_NOT_APPLICABLE", `${id} is already recorded as not applicable`, { id, reason: dup.reason });
  const entry: NotApplicableEntry = { id, reason: request.reason!.trim(), recorded: request.now.toISOString().slice(0, 10) };
  let after: string;
  if (!r.exists) after = newFileText({ version: request.data.version, notApplicable: [entry] });
  else {
    const obj = topMembers(r.text)!;
    const list = lastMember(obj.members, "notApplicable");
    if (!list) after = insertMember(r.text, obj, "notApplicable", [entry]);
    else after = appendEntries(r.text, arrayAt(r.text, list.value.start), [entry]);
  }
  return prepared(r, "not-applicable", after, entry, null);
}

/** Prepares removing the "not applicable" decision of an id: nothing is written. */
export function prepareRemoveNotApplicable(projectDir: string, request: { id: string | undefined; expectedRevision?: string }): PreparedDecision | AsvsDecisionRefusal {
  if (request.id === undefined || request.id.trim() === "") return refuse("ASVS_TARGET_REQUIRED", "name the requirement, section or chapter whose decision is removed");
  const id = normalizeTarget(request.id);
  const read = readAsvsDecisions(projectDir);
  if ("code" in read) return read;
  const r = read;
  const blocked = usable(r, request.expectedRevision);
  if (blocked) return blocked;
  const entry = r.notApplicable.find((e) => e.id === id);
  const obj = r.exists ? topMembers(r.text) : null;
  const list = obj ? lastMember(obj.members, "notApplicable") : undefined;
  if (!entry || !list) return refuse("ASVS_DECISION_NOT_FOUND", `${id} has no "not applicable" decision`, { id });
  const array = arrayAt(r.text, list.value.start);
  const at = array.elements.findIndex((span) => {
    try {
      const raw = JSON.parse(r.text.slice(span.start, span.end)) as unknown;
      const own = raw && typeof raw === "object" ? (raw as Record<string, unknown>).id : undefined;
      return typeof own === "string" && normalizeTarget(own) === id;
    } catch {
      return false;
    }
  });
  if (at < 0) return refuse("ASVS_DECISION_NOT_FOUND", `${id} has no "not applicable" decision`, { id });
  return prepared(r, "remove", removeElement(r.text, array, at), entry, null);
}

/** Prepares recording the project's level: nothing is written. */
export function prepareLevel(projectDir: string, request: { level: unknown; version?: string; expectedRevision?: string }): PreparedDecision | AsvsDecisionRefusal {
  const level = typeof request.level === "string" && /^[123]$/.test(request.level.trim()) ? (Number(request.level) as AsvsLevel) : request.level;
  if (!isLevel(level)) return refuse("ASVS_LEVEL_INVALID", `the level must be 1, 2 or 3`, { level: String(request.level ?? "") });
  const read = readAsvsDecisions(projectDir);
  if ("code" in read) return read;
  const r = read;
  const blocked = usable(r, request.expectedRevision);
  if (blocked) return blocked;
  if (r.level === level) return refuse("ASVS_LEVEL_UNCHANGED", `the project's level is already ${level}`, { level });
  let after: string;
  if (!r.exists) after = newFileText({ version: request.version ?? DEFAULT_ASVS_VERSION, level, notApplicable: [] });
  else {
    const obj = topMembers(r.text)!;
    const member = lastMember(obj.members, "level");
    after = member ? r.text.slice(0, member.value.start) + String(level) + r.text.slice(member.value.end) : insertMember(r.text, obj, "level", level);
  }
  return prepared(r, "level", after, null, level);
}

// ---- writing --------------------------------------------------------------------------------------------------------

/** What undoing a write needs; nothing about it is kept outside the project: the caller holds it. */
export interface AsvsUndoData {
  file: string;
  /** The revision the file has right after the write: undo refuses when it is no longer this. */
  expectedRevision: string;
  /** The bytes the file had, base64; null when the file did not exist. */
  previous: string | null;
}

export type AsvsWriteOutcome = { ok: true; revision: string; undo: AsvsUndoData } | AsvsDecisionRefusal;

const revisionOfDisk = (target: string): string => {
  try {
    return hashOf(fs.readFileSync(target));
  } catch {
    return ABSENT;
  }
};

function modeOfFile(target: string): number | undefined {
  try {
    return fs.statSync(target).mode & 0o777;
  } catch {
    return undefined;
  }
}

function writeChecked(target: string, bytes: Buffer, expectedRevision: string, mode: number | undefined): AsvsDecisionRefusal | null {
  const dir = path.dirname(target);
  const madeDir = !fs.existsSync(dir);
  try {
    if (madeDir) fs.mkdirSync(dir, { recursive: true });
    writeBytesAtomic(target, bytes, {
      ...(mode !== undefined ? { mode } : {}),
      verify: () => {
        if (revisionOfDisk(target) !== expectedRevision) throw new DecisionFileError(refuse("ASVS_FILE_CHANGED", "the decisions file changed while it was being written; nothing was written", { expected: expectedRevision, current: revisionOfDisk(target) }));
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
    if (error instanceof DecisionFileError) return error.refusal;
    const message = error instanceof AtomicWriteError || error instanceof Error ? error.message : String(error);
    return refuse("ASVS_WRITE_FAILED", `the decisions file could not be written: ${message}`);
  }
}

/** Writes a prepared change atomically, refusing when the file is not the one the change was prepared against. */
export function commitDecision(change: PreparedDecision): AsvsWriteOutcome {
  const prefix = change.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0);
  const bytes = Buffer.concat([prefix, Buffer.from(change.after, "utf8")]);
  const failed = writeChecked(change.target, bytes, change.revision, change.existed ? modeOfFile(change.target) : undefined);
  if (failed) return failed;
  const previous = change.before === null ? null : Buffer.concat([prefix, Buffer.from(change.before, "utf8")]).toString("base64");
  return { ok: true, revision: hashOf(bytes), undo: { file: change.file, expectedRevision: hashOf(bytes), previous } };
}

/** Puts the file back as it was before a write, when nothing changed it since. */
export function undoDecision(projectDir: string, undo: AsvsUndoData): { ok: true; revision: string } | AsvsDecisionRefusal {
  if (!undo || typeof undo.expectedRevision !== "string" || (undo.previous !== null && typeof undo.previous !== "string")) return refuse("ASVS_UNDO_INVALID", "the undo data is not valid");
  const where = resolveTarget(projectDir);
  if (!where.ok) return where;
  const current = revisionOfDisk(where.target);
  if (current !== undo.expectedRevision) return refuse("ASVS_FILE_CHANGED", "the decisions file changed since the write; it is not put back", { expected: undo.expectedRevision, current });
  if (undo.previous === null) {
    try {
      fs.rmSync(where.target, { force: true });
    } catch (error) {
      return refuse("ASVS_WRITE_FAILED", `the decisions file could not be removed: ${(error as Error).message}`);
    }
    return { ok: true, revision: ABSENT };
  }
  const bytes = Buffer.from(undo.previous, "base64");
  const failed = writeChecked(where.target, bytes, undo.expectedRevision, modeOfFile(where.target));
  if (failed) return failed;
  return { ok: true, revision: hashOf(bytes) };
}

/** The undo data as one token a terminal user can paste back (base64url of its JSON). */
export function undoToken(undo: AsvsUndoData): string {
  return Buffer.from(JSON.stringify(undo), "utf8").toString("base64url");
}

/** The undo data of a token, or null when it is not one. */
export function parseUndoToken(token: string): AsvsUndoData | null {
  try {
    const value = JSON.parse(Buffer.from(token.trim(), "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object") return null;
    const v = value as Record<string, unknown>;
    if (typeof v.file !== "string" || typeof v.expectedRevision !== "string" || (v.previous !== null && typeof v.previous !== "string")) return null;
    return { file: v.file, expectedRevision: v.expectedRevision, previous: v.previous as string | null };
  } catch {
    return null;
  }
}
