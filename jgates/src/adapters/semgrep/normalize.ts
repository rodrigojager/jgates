// Normalizes the JSON of `semgrep scan --json` into result findings. Fail-closed: an entry that cannot be read, or a
// scanner error that is not a mere partial parse, makes the whole output uninterpreted.
import fs from "node:fs";
import path from "node:path";
import { contentHash } from "../../core/ids/index.js";
import type { NormalizedSeverity, ResultFinding } from "../../core/run/types.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

export interface SemgrepParse {
  ok: boolean;
  findings: ResultFinding[];
  /** Non-fatal scanner notices (a target file that did not parse, for instance). */
  warnings: string[];
  /** Why the output could not be interpreted. */
  problem?: string;
}

const SEVERITY: Record<string, { normalized: NormalizedSeverity; blocking: boolean }> = {
  CRITICAL: { normalized: "critical", blocking: true },
  HIGH: { normalized: "high", blocking: true },
  ERROR: { normalized: "high", blocking: true },
  MEDIUM: { normalized: "medium", blocking: true },
  WARNING: { normalized: "medium", blocking: true },
  LOW: { normalized: "low", blocking: false },
  INFO: { normalized: "low", blocking: false },
  INVENTORY: { normalized: "info", blocking: false },
  EXPERIMENT: { normalized: "info", blocking: false },
};

function relativeTo(roots: string[], cwd: string, filename: string): string {
  const abs = path.isAbsolute(filename) ? filename : path.resolve(cwd, filename);
  for (const root of roots) {
    const rel = path.relative(root, abs);
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
  }
  return filename.split(path.sep).join("/");
}

export function parseSemgrepOutput(text: string, opts: { stageId: string; version: string | null; workspace: string; cwd: string }): SemgrepParse {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { ok: false, findings: [], warnings: [], problem: error instanceof Error ? error.message : String(error) };
  }
  if (!isRec(doc) || !Array.isArray(doc.results)) return { ok: false, findings: [], warnings: [], problem: "the document has no results list" };
  const warnings: string[] = [];
  if (Array.isArray(doc.errors)) {
    for (const [index, e] of doc.errors.entries()) {
      if (!isRec(e)) return { ok: false, findings: [], warnings, problem: `error ${index} is not an object` };
      const level = String(e.level ?? "error").toLowerCase();
      const message = String(e.message ?? e.type ?? "error");
      // A target file Semgrep could not parse is a warning (the rest was scanned); anything else proves nothing.
      if (level === "warn" || level === "warning") warnings.push(message);
      else return { ok: false, findings: [], warnings, problem: message };
    }
  }
  const roots = [opts.workspace];
  for (const r of [opts.workspace, opts.cwd]) {
    try {
      roots.push(fs.realpathSync(r));
    } catch {
      // keep the lexical root only
    }
  }
  const findings: ResultFinding[] = [];
  for (const [index, entry] of doc.results.entries()) {
    if (!isRec(entry) || typeof entry.check_id !== "string" || typeof entry.path !== "string" || !isRec(entry.extra) || typeof entry.extra.message !== "string") {
      return { ok: false, findings: [], warnings, problem: `result ${index} has no check_id, path or message` };
    }
    const start = isRec(entry.start) ? entry.start : {};
    const line = typeof start.line === "number" && start.line >= 1 ? start.line : undefined;
    const column = typeof start.col === "number" && start.col >= 1 ? start.col : undefined;
    const file = relativeTo(roots, opts.cwd, entry.path);
    const native = typeof entry.extra.severity === "string" ? entry.extra.severity.toUpperCase() : "WARNING";
    const level = SEVERITY[native] ?? { normalized: "medium" as const, blocking: true };
    findings.push({
      stageId: opts.stageId,
      tool: "semgrep",
      ...(opts.version ? { toolVersion: opts.version } : {}),
      ruleId: entry.check_id,
      category: "sast",
      severity: native,
      normalizedSeverity: level.normalized,
      message: entry.extra.message,
      location: { path: file, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) },
      fingerprint: contentHash({ tool: "semgrep", rule: entry.check_id, file, line: line ?? null, column: column ?? null, message: entry.extra.message }),
      origin: "semgrep",
      blocking: level.blocking,
      ...(level.blocking ? { blockingReason: "blocking-tool" as const } : {}),
      waived: false,
    });
  }
  return { ok: true, findings, warnings };
}
