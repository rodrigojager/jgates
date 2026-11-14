// Waivers: same format as the sidecar's waiver files (rule, fingerprint or id,
// path, reason, expires), plus the occurrence waiver made from one finding (tool, rule, path, fingerprint, anchor when
// the finding has one, occurrences, line for display, reason, created, expires). A waiver only ever changes findings: it
// never touches the state of a stage, so a scanner that failed (error, timeout, blocked) stays failed and the run never
// passes because of a waiver.
//
// Matching:
//   - occurrence waiver with an anchor: the finding whose anchor is equal. When no finding has it but the tool, rule and
//     file still have findings, the flagged line changed: the waiver is stale and does not apply.
//   - occurrence waiver without an anchor (a finding of the secrets or personal-data categories, or one whose line could
//     not be read): the fingerprint must match and the tool, rule and file must still have exactly `occurrences`
//     findings; otherwise the waiver is stale and does not apply.
//   - hand-written waivers, from the file or from --waiver: `fingerprint` matches that fingerprint (own or native) and
//     nothing else; otherwise `rule` (and `path` when given); otherwise `path` alone.
// The order of the list is the order of precedence (the project's file, then --waiver): the first live waiver that
// matches a finding waives it. An expired waiver never applies.
import fs from "node:fs";
import { contentHash } from "../ids/index.js";
import type { ResultFinding, ResultStage, RunResult } from "../run/types.js";
import { normalizeFindingPath } from "./fingerprint.js";

/** Where a waiver came from: the project's .jgates/waivers.json, a `jgates run --waiver`, or the pinned CI policy. */
export type WaiverSource = "project" | "flag" | "policy";

export interface Waiver {
  /** Occurrence waivers: the tool of the finding. */
  tool?: string;
  rule?: string;
  fingerprint?: string;
  /** Occurrence waivers: the jga1 anchor of the finding, when it had one. */
  anchor?: string;
  /** Occurrence waivers: how many findings of that tool, rule and file the run had (the guard of a waiver without anchor). */
  occurrences?: number;
  path?: string;
  /** Occurrence waivers: the line as it was seen, for display only (never used to match). */
  line?: number;
  reason?: string;
  /** Occurrence waivers: when the entry was created (YYYY-MM-DD). */
  created?: string;
  /** ISO date (YYYY-MM-DD); the waiver stops applying the day after. A date that cannot be read counts as expired. */
  expires?: string;
  /** Set by the run, never read from a file. Absent: the project's file. */
  source?: WaiverSource;
}

export const WAIVERS_FILE = ".jgates/waivers.json";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const positiveInt = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : undefined);

export function parseWaivers(payload: unknown): { waivers: Waiver[]; problem?: string } {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { waivers?: unknown }).waivers)
      ? (payload as { waivers: unknown[] }).waivers
      : null;
  if (!list) return { waivers: [], problem: "the waiver file must hold a list or a waivers object" };
  const waivers: Waiver[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const w: Waiver = {};
    const tool = str(r.tool);
    const rule = str(r.rule);
    const fingerprint = str(r.fingerprint) ?? str(r.id);
    const anchor = str(r.anchor);
    const occurrences = positiveInt(r.occurrences);
    const p = str(r.path);
    const line = positiveInt(r.line);
    const reason = str(r.reason);
    const created = str(r.created);
    const expires = str(r.expires) ?? str(r.expiresAt);
    if (tool) w.tool = tool;
    if (rule) w.rule = rule;
    if (fingerprint) w.fingerprint = fingerprint;
    if (anchor) w.anchor = anchor;
    if (occurrences !== undefined) w.occurrences = occurrences;
    if (p) w.path = p;
    if (line !== undefined) w.line = line;
    if (reason) w.reason = reason;
    if (created) w.created = created;
    if (expires) w.expires = expires;
    waivers.push(w);
  }
  return { waivers };
}

/**
 * One waiver given on the command line: `key=value` pairs separated by `;` (keys rule, fingerprint, path, expires,
 * reason). It needs something to match (rule, fingerprint or path) and a reason, and the expiry must be a real date.
 */
export function parseWaiverFlag(spec: string): { waiver: Waiver } | { problem: string } {
  const waiver: Waiver = {};
  for (const part of spec.split(";")) {
    if (part.trim() === "") continue;
    const eq = part.indexOf("=");
    if (eq <= 0) return { problem: `"${part.trim()}" is not key=value` };
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!["rule", "fingerprint", "path", "expires", "reason"].includes(key)) return { problem: `unknown key "${key}"` };
    if (value === "") return { problem: `"${key}" is empty` };
    waiver[key as "rule" | "fingerprint" | "path" | "expires" | "reason"] = value;
  }
  if (!waiver.rule && !waiver.fingerprint && !waiver.path) return { problem: "give rule, fingerprint or path" };
  if (!waiver.reason) return { problem: "reason is required" };
  if (waiver.expires) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(waiver.expires);
    const ok = m && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDate() === Number(m[3]);
    if (!ok) return { problem: "expires must be a date YYYY-MM-DD" };
  }
  waiver.source = "flag";
  return { waiver };
}

/** Reads a waiver file; absent is an empty list, unreadable is a problem (the findings then stay active). */
export function loadWaiverFile(file: string): { waivers: Waiver[]; problem?: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    // Absent is no waiver at all; present but unreadable (a folder, no permission) is a problem.
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { waivers: [] };
    return { waivers: [], problem: error instanceof Error ? error.message : String(error) };
  }
  try {
    return parseWaivers(JSON.parse(text));
  } catch (error) {
    return { waivers: [], problem: error instanceof Error ? error.message : String(error) };
  }
}

/** The waivers of a local run in their order of precedence: the project's file first, then every --waiver. */
export function combineWaivers(fileWaivers: Waiver[], flagWaivers: Waiver[]): Waiver[] {
  return [...fileWaivers.map((w) => ({ ...w, source: w.source ?? ("project" as const) })), ...flagWaivers.map((w) => ({ ...w, source: w.source ?? ("flag" as const) }))];
}

/** sha256 of the waivers in force for a run (entries and sources, in order): the provenance records it. */
export function waiversHash(waivers: Waiver[]): string {
  return contentHash(waivers.map((w) => ({ ...w, source: w.source ?? "project" })));
}

export function isExpired(waiver: Waiver, now: Date): boolean {
  if (!waiver.expires) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(waiver.expires);
  if (!m) return true;
  const end = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  return Number.isNaN(end) || end < now.getTime();
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (const ch of glob) re += ch === "*" ? ".*" : ch === "?" ? "." : /[.+^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch;
  return new RegExp("^" + re + "$", "s");
}

/** An entry made from one finding (it carries an anchor or the count guard), as opposed to a hand-written one. */
export function isOccurrenceWaiver(waiver: Waiver): boolean {
  return waiver.anchor !== undefined || waiver.occurrences !== undefined;
}

/**
 * Whether a live waiver matches one finding, looking at that finding alone. Occurrence waivers without an anchor also
 * need the count of their tool, rule and file, which only classifyWaivers sees; here they match by fingerprint.
 */
export function waiverMatches(waiver: Waiver, finding: ResultFinding, now: Date): boolean {
  if (isExpired(waiver, now)) return false;
  const p = (finding.location?.path ?? "").replace(/\\/g, "/");
  if (waiver.anchor) return waiver.anchor === finding.anchor;
  if (waiver.fingerprint) return waiver.fingerprint === finding.fingerprint || waiver.fingerprint === finding.nativeFingerprint;
  if (waiver.rule) return waiver.rule === finding.ruleId && (!waiver.path || globToRegExp(waiver.path).test(p));
  if (waiver.path) return globToRegExp(waiver.path).test(p);
  return false;
}

/** Why a waiver is stale: the flagged line changed (anchored), or the number of findings of its file changed (guard). */
export type StaleCause = "line-changed" | "count-changed";

/** One entry of a waiver list classified against the findings of a result. */
export interface WaiverStatus {
  /** Position of the entry in the list given. */
  index: number;
  waiver: Waiver;
  /** live: in force (it may still match nothing); expired: its date passed; stale: it cannot be matched safely. */
  state: "live" | "expired" | "stale";
  cause?: StaleCause;
  /** Indexes of the findings the entry matches (live entries only), before precedence between entries. */
  matches: number[];
  /** How many findings it matches. */
  matched: number;
}

const groupKeyOf = (tool: string | undefined, rule: string | undefined, p: string): string => JSON.stringify([tool ?? null, rule ?? null, normalizeFindingPath(p)]);

/**
 * Classifies the entries of a waiver list against the findings of a result: live (with the findings each one matches),
 * expired or stale. Pure: it neither reads nor writes anything, and it does not look at whether a finding is waived.
 */
export function classifyWaivers(result: Pick<RunResult, "findings">, waivers: Waiver[], now: Date): WaiverStatus[] {
  const findings = result.findings ?? [];
  // Findings per tool, rule and file, and per rule and file (an entry without a tool).
  const byGroup = new Map<string, number[]>();
  const add = (key: string, index: number): void => {
    const list = byGroup.get(key);
    if (list) list.push(index);
    else byGroup.set(key, [index]);
  };
  findings.forEach((f, index) => {
    const p = f.location?.path ?? "";
    add(groupKeyOf(f.tool, f.ruleId, p), index);
    add(groupKeyOf(undefined, f.ruleId, p), index);
  });
  return waivers.map((waiver, index): WaiverStatus => {
    const status = (state: WaiverStatus["state"], matches: number[] = [], cause?: StaleCause): WaiverStatus => ({ index, waiver, state, ...(cause ? { cause } : {}), matches, matched: matches.length });
    if (isExpired(waiver, now)) return status("expired");
    if (!isOccurrenceWaiver(waiver)) return status("live", findings.flatMap((f, i) => (waiverMatches(waiver, f, now) ? [i] : [])));
    const group = byGroup.get(groupKeyOf(waiver.tool, waiver.rule, waiver.path ?? "")) ?? [];
    if (waiver.anchor) {
      const hits = group.filter((i) => findings[i]!.anchor === waiver.anchor);
      if (hits.length > 0) return status("live", hits);
      // The tool, rule and file still have findings, none on the line that was waived: that line changed.
      return group.length > 0 ? status("stale", [], "line-changed") : status("live");
    }
    if (group.length === 0) return status("live");
    if (group.length !== waiver.occurrences) return status("stale", [], "count-changed");
    const hits = group.filter((i) => {
      const f = findings[i]!;
      return waiver.fingerprint !== undefined && (waiver.fingerprint === f.fingerprint || waiver.fingerprint === f.nativeFingerprint);
    });
    return status("live", hits);
  });
}

/** One waiver as the result records it ($.waivers). */
export interface WaiverRecordEntry {
  source: WaiverSource;
  /** The id the waived findings carry in waiverId. */
  id: string;
  tool?: string;
  rule?: string;
  /** The file (or the path pattern of a hand-written waiver). */
  path?: string;
  /** The line of the finding it waived (one finding), or the line recorded in the entry. */
  line?: number;
  fingerprint?: string;
  anchor?: string;
  reason?: string;
  created?: string;
  expires?: string;
  /** How many findings of this run it waived (0 for the entries that did not apply). */
  findings: number;
  /** Stale entries: why. */
  cause?: StaleCause;
}

/** $.waivers of a result: what the waivers did in this run. */
export interface ResultWaivers {
  /** How many waivers applied to at least one finding. */
  count: number;
  /** How many findings they waived. */
  findings: number;
  applied: WaiverRecordEntry[];
  /** Live waivers that waived nothing (nothing matched, or an earlier waiver took the findings). */
  unmatched: WaiverRecordEntry[];
  stale: WaiverRecordEntry[];
  expired: WaiverRecordEntry[];
  /** With --no-waivers: the waivers that would have applied. */
  refused: WaiverRecordEntry[];
  /** The project's waiver file could not be read: no waiver of it applied and the findings stayed active. */
  problem?: { file: string; message: string };
}

export function emptyWaiverRecord(): ResultWaivers {
  return { count: 0, findings: 0, applied: [], unmatched: [], stale: [], expired: [], refused: [] };
}

function waiverIdOf(waiver: Waiver): string | undefined {
  return waiver.fingerprint ?? waiver.anchor ?? (waiver.rule ? waiver.rule + (waiver.path ? `@${waiver.path}` : "") : waiver.path);
}

function recordEntry(waiver: Waiver, waived: ResultFinding[], cause?: StaleCause): WaiverRecordEntry {
  const only = waived.length === 1 ? waived[0] : undefined;
  const p = waiver.path ?? only?.location?.path;
  const line = only?.location?.line ?? waiver.line;
  const tool = waiver.tool ?? only?.tool;
  return {
    source: waiver.source ?? "project",
    id: waiverIdOf(waiver) ?? "",
    ...(tool ? { tool } : {}),
    ...(waiver.rule ? { rule: waiver.rule } : only ? { rule: only.ruleId } : {}),
    ...(p ? { path: p } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(waiver.fingerprint ? { fingerprint: waiver.fingerprint } : {}),
    ...(waiver.anchor ? { anchor: waiver.anchor } : {}),
    ...(waiver.reason ? { reason: waiver.reason } : {}),
    ...(waiver.created ? { created: waiver.created } : {}),
    ...(waiver.expires ? { expires: waiver.expires } : {}),
    findings: waived.length,
    ...(cause ? { cause } : {}),
  };
}

/**
 * Marks the findings a live waiver covers and records what every waiver did. A waived blocking finding stops blocking
 * and leaves the count of its stage, but only for a stage that completed: a stage in any other state is returned
 * untouched. A finding the tool already reported as waived is left as it is.
 */
export function applyWaivers(
  findings: ResultFinding[],
  stages: ResultStage[],
  waivers: Waiver[],
  now: Date,
): { findings: ResultFinding[]; stages: ResultStage[]; record: ResultWaivers } {
  const record = emptyWaiverRecord();
  if (waivers.length === 0) return { findings, stages, record };
  const statuses = classifyWaivers({ findings }, waivers, now);
  // First live waiver (in list order) that matches each finding.
  const owner = new Map<number, number>();
  for (const s of statuses) {
    if (s.state !== "live") continue;
    for (const i of s.matches) if (!owner.has(i) && !findings[i]!.waived) owner.set(i, s.index);
  }
  const released = new Map<string, number>();
  const waivedBy = new Map<number, ResultFinding[]>();
  const out = findings.map((f, i) => {
    const at = owner.get(i);
    if (at === undefined) return f;
    const waiver = waivers[at]!;
    const next: ResultFinding = { ...f, waived: true, waiverReason: waiver.reason ?? "Allowed by waiver file", waiverSource: waiver.source ?? "project" };
    const id = waiverIdOf(waiver);
    if (id) next.waiverId = id;
    if (waiver.expires) next.waiverExpires = waiver.expires;
    if (f.blocking) {
      next.blocking = false;
      delete next.blockingReason;
      released.set(f.stageId, (released.get(f.stageId) ?? 0) + 1);
    }
    const list = waivedBy.get(at);
    if (list) list.push(f);
    else waivedBy.set(at, [f]);
    return next;
  });
  const outStages = stages.map((s) => {
    const n = released.get(s.id);
    if (!n || s.state !== "completed" || !s.blockingViolations) return s;
    return { ...s, blockingViolations: Math.max(0, s.blockingViolations - n) };
  });
  for (const s of statuses) {
    if (s.state === "expired") record.expired.push(recordEntry(s.waiver, []));
    else if (s.state === "stale") record.stale.push(recordEntry(s.waiver, [], s.cause));
    else {
      const waived = waivedBy.get(s.index) ?? [];
      if (waived.length > 0) record.applied.push(recordEntry(s.waiver, waived));
      else record.unmatched.push(recordEntry(s.waiver, []));
    }
  }
  record.count = record.applied.length;
  record.findings = record.applied.reduce((n, e) => n + e.findings, 0);
  return { findings: out, stages: outStages, record };
}

/** The entry a waiver file gets for one finding of a result (the screens and `jgates waivers add` write it). */
export interface OccurrenceWaiverEntry {
  tool: string;
  rule: string;
  path: string;
  fingerprint: string;
  anchor?: string;
  occurrences: number;
  line?: number;
  reason: string;
  created: string;
  expires: string;
}

/**
 * Makes the occurrence waiver of one finding of a result: tool, rule, path, fingerprint, the anchor when the finding has
 * one, how many findings of that tool, rule and file the result had, the line as seen (display only), the reason and the
 * dates. Throws when the finding has no fingerprint or no file (a result stored by an old version).
 */
export function occurrenceWaiver(
  result: Pick<RunResult, "findings">,
  finding: ResultFinding,
  input: { reason: string; expires: string; created: string },
): OccurrenceWaiverEntry {
  const p = finding.location?.path;
  if (!finding.fingerprint || !p) throw new Error("the finding has no fingerprint or no file: it cannot be waived by occurrence");
  const path = normalizeFindingPath(p);
  const occurrences = (result.findings ?? []).filter((f) => f.tool === finding.tool && f.ruleId === finding.ruleId && normalizeFindingPath(f.location?.path ?? "") === path).length;
  return {
    tool: finding.tool,
    rule: finding.ruleId,
    path,
    fingerprint: finding.fingerprint,
    ...(finding.anchor ? { anchor: finding.anchor } : {}),
    occurrences: Math.max(1, occurrences),
    ...(finding.location?.line !== undefined ? { line: finding.location.line } : {}),
    reason: input.reason,
    created: input.created,
    expires: input.expires,
  };
}
