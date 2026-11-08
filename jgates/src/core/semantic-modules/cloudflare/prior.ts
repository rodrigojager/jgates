// Prior-run input of the security audit (upstream RECONNAISSANCE.md "Prior-run input" and SKILL.md "Coverage and
// prior runs"). The prior ledger and records come only from the baseline the scope names (--baseline): a Git reference
// is a comparison anchor, never evidence of a previous review. Every prior unit and record is compared with the current
// source by content fingerprints; prior states are priority input and never suppress current work.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ModuleRunFacts } from "../../semantic-executor/index.js";
import { coverageId, refProblems, type CanonicalRefs, type LedgerUnit } from "./ledger.js";

export const AUDIT_DIR = "evidence/security-audit";
export const LEDGER_FILE = `${AUDIT_DIR}/coverage-ledger.json`;
export const FINDINGS_FILE = `${AUDIT_DIR}/findings.json`;

export type SourceState = "same" | "changed";

export interface PriorAnalysis {
  baselineRunId: string | null;
  /** none: no baseline; missing: the baseline has no security-audit ledger; read: compared with the current source. */
  state: "none" | "missing" | "read";
  message: string;
  units: Array<{ unit: LedgerUnit; source: SourceState }>;
  records: Array<{ record: Record<string, unknown>; source: SourceState; readable: boolean }>;
}

/** Content fingerprint of a file as the host reads it (line endings normalized). */
export const contentSha = (text: string): string => crypto.createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

/** Fingerprints of the files a unit or record relies on (null for a file that cannot be read now). */
export function fingerprintsOf(paths: readonly string[], readFile: (p: string) => string | null): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const p of [...new Set(paths)].sort()) {
    const t = readFile(p);
    out[p] = t === null ? null : contentSha(t);
  }
  return out;
}

function compare(prior: unknown, readFile: (p: string) => string | null): SourceState {
  if (!prior || typeof prior !== "object") return "changed";
  const entries = Object.entries(prior as Record<string, unknown>);
  if (entries.length === 0) return "changed";
  for (const [p, sha] of entries) {
    const t = readFile(p);
    if (t === null || typeof sha !== "string" || contentSha(t) !== sha) return "changed";
  }
  return "same";
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** Reads the baseline's ledger and records and compares them with the current source. */
export function analyzePrior(run: ModuleRunFacts): PriorAnalysis {
  const baselineRunId = run.scope.resolution.reuse?.baselineRunId ?? null;
  if (!baselineRunId) {
    return { baselineRunId: null, state: "none", message: "No prior security-audit ledger: the run names no baseline, so it inherits no coverage and no prior records.", units: [], records: [] };
  }
  if (!/^sem_[A-Za-z0-9_-]+$/.test(baselineRunId)) return { baselineRunId, state: "missing", message: `The baseline ${baselineRunId} is not a Semantic run.`, units: [], records: [] };
  const dir = path.join(path.dirname(run.runDir), baselineRunId);
  const ledger = readJson(path.join(dir, ...LEDGER_FILE.split("/")));
  const findings = readJson(path.join(dir, ...FINDINGS_FILE.split("/")));
  if (!Array.isArray(ledger) || !Array.isArray(findings)) {
    return { baselineRunId, state: "missing", message: `The baseline ${baselineRunId} has no compatible security-audit ledger and records; nothing of it is inherited (recorded, not treated as empty coverage).`, units: [], records: [] };
  }
  const units: PriorAnalysis["units"] = [];
  for (const raw of ledger) {
    if (!raw || typeof raw !== "object") continue;
    const u = raw as LedgerUnit & { source_fingerprints?: unknown };
    const refs = u.canonical_refs as CanonicalRefs | undefined;
    if (!refs || [refs.surface, refs.boundary, refs.subsystem, refs.attack_class].some((r) => refProblems(r) !== null) || coverageId(refs) !== u.coverage_id) continue;
    units.push({ unit: u, source: compare(u.source_fingerprints, run.readFile) });
  }
  const records: PriorAnalysis["records"] = [];
  for (const raw of findings) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.fingerprint !== "string" || !["confirmed", "needs_validation", "rejected"].includes(String(r.verdict))) continue;
    const files = Object.keys((r.source_fingerprints as Record<string, unknown> | undefined) ?? {});
    records.push({ record: r, source: compare(r.source_fingerprints, run.readFile), readable: files.length > 0 && files.every((f) => run.readFile(f) !== null) });
  }
  return { baselineRunId, state: "read", message: `Prior ledger of ${baselineRunId}: ${units.length} unit(s) and ${records.length} record(s) compared with the current source.`, units, records };
}
