// Reads the SARIF, JUnit or Checkstyle report a generic command wrote and turns it into result findings plus a verdict.
// The report is the evidence: a missing or unreadable one is a problem (never a pass), and a tool's own findings are
// marked with the origin "own-tool" so results, baselines, waivers and the SARIF export can say "ferramenta própria".
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { OWN_TOOL_ORIGIN, readCheckstyle, readJunit, readSarif } from "../../core/evidence/index.js";
import { contentHash } from "../../core/ids/index.js";
import type { NormalizedSeverity, ResultFinding } from "../../core/run/types.js";

export type ReportKind = "sarif" | "junit" | "checkstyle";
export interface ReportEvidence {
  kind: ReportKind;
  file: string;
  failOn?: "error" | "warning" | "note" | "failure";
}

export const REPORT_KINDS: readonly string[] = ["sarif", "junit", "checkstyle"];
export const isReportEvidence = (e: { kind: string } | null | undefined): e is ReportEvidence => e != null && REPORT_KINDS.includes(e.kind);

/** The threshold a report is judged by, defaulting per format. */
export function failOnOf(e: ReportEvidence): string {
  return e.failOn ?? (e.kind === "junit" ? "failure" : "error");
}

/** Whether `failOn` makes sense for the format (junit: failure|error; sarif and checkstyle: error|warning|note). */
export function failOnApplies(e: ReportEvidence): boolean {
  if (e.failOn === undefined) return true;
  return e.kind === "junit" ? e.failOn === "failure" || e.failOn === "error" : e.failOn !== "failure";
}

const THRESHOLD: Record<string, number> = { note: 1, warning: 2, error: 3 };
/** error: critical, high and unknown (an unqualified severity is never favorable); warning: medium; note: low and info. */
const RANK: Record<NormalizedSeverity, number> = { critical: 3, high: 3, unknown: 3, medium: 2, low: 1, info: 1 };

export type ReportRead =
  | { ok: false; reason: string }
  | { ok: true; findings: ResultFinding[]; blocking: number; version: string | null };

export interface ReportContext {
  tool: string;
  stageId: string;
  outDir: string;
  workspacePath: string;
  /** Working directory of the command, absolute (host view). */
  cwd: string;
}

function toWorkspacePath(raw: string, ctx: ReportContext): string {
  let p = raw.replace(/\\/g, "/");
  const ws = ctx.workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const prefix of [`${ws}/`, "/workspace/"]) {
    if (p.startsWith(prefix)) return p.slice(prefix.length);
  }
  if (/^([A-Za-z]:)?\//.test(p)) return p;
  p = p.replace(/^\.\//, "");
  const cwd = ctx.cwd.replace(/\\/g, "/");
  const rel = path.posix.relative(ws, cwd);
  return rel !== "" && rel !== "." && !rel.startsWith("..") ? `${rel}/${p}` : p;
}

export function readReport(evidence: ReportEvidence, ctx: ReportContext): ReportRead {
  const t = translator("generic-command");
  const file = path.join(ctx.outDir, evidence.file);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { ok: false, reason: t("generic_report_missing", { format: evidence.kind, file: evidence.file, detail: (error as Error).message }) };
  }
  const invalid = (detail: string): ReportRead => ({ ok: false, reason: t("generic_report_invalid", { format: evidence.kind, file: evidence.file, detail }) });
  const failOn = failOnOf(evidence);
  const threshold = THRESHOLD[failOn] ?? 3;
  const base = { tool: ctx.tool, origin: OWN_TOOL_ORIGIN, waived: false, stageId: ctx.stageId } as const;
  const findings: ResultFinding[] = [];
  let version: string | null = null;

  if (evidence.kind === "sarif") {
    const read = readSarif(text, { requireLocation: false });
    if (!read.ok) return invalid(read.problem ?? "unreadable");
    version = read.driverVersion;
    for (const f of read.findings) {
      const filePath = f.path === null ? null : toWorkspacePath(f.path, ctx);
      const blocking = RANK[f.normalizedSeverity] >= threshold || !f.known;
      findings.push({
        ...base,
        ruleId: f.ruleId,
        category: "custom",
        severity: f.securitySeverity !== undefined ? `${f.level} (security-severity ${f.securitySeverity})` : f.level,
        normalizedSeverity: f.normalizedSeverity,
        message: f.message,
        ...(filePath ? { location: { path: filePath, ...(f.line !== undefined ? { line: f.line } : {}), ...(f.column !== undefined ? { column: f.column } : {}) } } : {}),
        fingerprint: contentHash({ tool: ctx.tool, rule: f.ruleId, file: filePath, line: f.line ?? null, message: f.message, native: f.nativeFingerprint }),
        ...(f.nativeFingerprint ? { nativeFingerprint: f.nativeFingerprint } : {}),
        blocking,
        ...(blocking ? { blockingReason: "blocking-tool" as const } : {}),
        ...(f.help ? { remediation: f.help.slice(0, 500) } : {}),
      });
    }
  } else if (evidence.kind === "checkstyle") {
    const read = readCheckstyle(text);
    if (!read.ok) return invalid(read.problem ?? "unreadable");
    const bySeverity: Record<string, NormalizedSeverity> = { error: "high", warning: "medium", info: "low", ignore: "info" };
    for (const f of read.findings) {
      const normalized = bySeverity[f.severity] ?? "unknown";
      const filePath = toWorkspacePath(f.file, ctx);
      const blocking = RANK[normalized] >= threshold;
      findings.push({
        ...base,
        ruleId: f.source,
        category: "custom",
        severity: f.severity,
        normalizedSeverity: normalized,
        message: f.message,
        location: { path: filePath, ...(f.line !== undefined ? { line: f.line } : {}), ...(f.column !== undefined ? { column: f.column } : {}) },
        fingerprint: contentHash({ tool: ctx.tool, rule: f.source, file: filePath, line: f.line ?? null, message: f.message }),
        blocking,
        ...(blocking ? { blockingReason: "blocking-tool" as const } : {}),
      });
    }
  } else {
    const read = readJunit(text);
    if (!read.ok) return invalid(read.problem ?? "unreadable");
    for (const c of read.cases) {
      if (c.outcome !== "failed" && c.outcome !== "error") continue;
      const test = c.classname ? `${c.classname}::${c.name}` : c.name;
      const filePath = c.file ? toWorkspacePath(c.file, ctx) : null;
      const blocking = c.outcome === "error" || failOn !== "error";
      const ruleId = c.outcome === "failed" ? "test-failed" : "test-error";
      findings.push({
        ...base,
        ruleId,
        category: "tests",
        severity: c.outcome === "failed" ? "failure" : "error",
        normalizedSeverity: "high",
        message: t(c.outcome === "failed" ? "generic_finding_test_failed" : "generic_finding_test_error", { test, message: c.message || "-" }),
        ...(filePath ? { location: { path: filePath, ...(c.line !== undefined ? { line: c.line } : {}) } } : {}),
        fingerprint: contentHash({ tool: ctx.tool, rule: ruleId, test }),
        blocking,
        ...(blocking ? { blockingReason: "blocking-tool" as const } : {}),
      });
    }
  }
  return { ok: true, findings, blocking: findings.filter((f) => f.blocking).length, version };
}
