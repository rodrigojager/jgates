// Waivers: same format as the sidecar's waiver files (rule, fingerprint or id,
// path, reason, expires). A waiver only ever changes findings: it never touches the state of a stage, so a scanner
// that failed (error, timeout, blocked) stays failed and the run never passes because of a waiver.
import fs from "node:fs";
import type { ResultFinding, ResultStage } from "../run/types.js";

export interface Waiver {
  rule?: string;
  fingerprint?: string;
  path?: string;
  reason?: string;
  /** ISO date (YYYY-MM-DD); the waiver stops applying the day after. A date that cannot be read counts as expired. */
  expires?: string;
}

export const WAIVERS_FILE = ".jgates/waivers.json";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

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
    const rule = str(r.rule);
    const fingerprint = str(r.fingerprint) ?? str(r.id);
    const p = str(r.path);
    const reason = str(r.reason);
    const expires = str(r.expires) ?? str(r.expiresAt);
    if (rule) w.rule = rule;
    if (fingerprint) w.fingerprint = fingerprint;
    if (p) w.path = p;
    if (reason) w.reason = reason;
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
  return { waiver };
}

/** Reads a waiver file; absent is an empty list, unreadable is a problem (the findings then stay active). */
export function loadWaiverFile(file: string): { waivers: Waiver[]; problem?: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { waivers: [] };
  }
  try {
    return parseWaivers(JSON.parse(text));
  } catch (error) {
    return { waivers: [], problem: error instanceof Error ? error.message : String(error) };
  }
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

export function waiverMatches(waiver: Waiver, finding: ResultFinding, now: Date): boolean {
  if (isExpired(waiver, now)) return false;
  const p = (finding.location?.path ?? "").replace(/\\/g, "/");
  if (waiver.fingerprint) return waiver.fingerprint === finding.fingerprint || waiver.fingerprint === finding.nativeFingerprint;
  if (waiver.rule) return waiver.rule === finding.ruleId && (!waiver.path || globToRegExp(waiver.path).test(p));
  if (waiver.path) return globToRegExp(waiver.path).test(p);
  return false;
}

/**
 * Marks the findings a live waiver covers. A waived blocking finding stops blocking and leaves the count of its stage,
 * but only for a stage that completed: a stage in any other state is returned untouched.
 */
export function applyWaivers(
  findings: ResultFinding[],
  stages: ResultStage[],
  waivers: Waiver[],
  now: Date,
): { findings: ResultFinding[]; stages: ResultStage[] } {
  if (waivers.length === 0) return { findings, stages };
  const released = new Map<string, number>();
  const out = findings.map((f) => {
    if (f.waived) return f;
    const waiver = waivers.find((w) => waiverMatches(w, f, now));
    if (!waiver) return f;
    const next: ResultFinding = { ...f, waived: true, waiverReason: waiver.reason ?? "Allowed by waiver file" };
    const id = waiver.fingerprint ?? (waiver.rule ? waiver.rule + (waiver.path ? `@${waiver.path}` : "") : waiver.path);
    if (id) next.waiverId = id;
    if (f.blocking) {
      next.blocking = false;
      delete next.blockingReason;
      released.set(f.stageId, (released.get(f.stageId) ?? 0) + 1);
    }
    return next;
  });
  const outStages = stages.map((s) => {
    const n = released.get(s.id);
    if (!n || s.state !== "completed" || !s.blockingViolations) return s;
    return { ...s, blockingViolations: Math.max(0, s.blockingViolations - n) };
  });
  return { findings: out, stages: outStages };
}
