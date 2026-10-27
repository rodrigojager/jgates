// Normalizes the JSON of `ruff check --output-format json` into result findings. Fail-closed: an entry that cannot be
// read makes the whole output uninterpreted, never a silent drop.
import fs from "node:fs";
import path from "node:path";
import { contentHash } from "../../core/ids/index.js";
import type { ResultFinding } from "../../core/run/types.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

export interface RuffParse {
  ok: boolean;
  findings: ResultFinding[];
  /** Why the output could not be interpreted. */
  problem?: string;
}

function relativeTo(roots: string[], filename: string): string {
  for (const root of roots) {
    const rel = path.relative(root, filename);
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
  }
  return filename.split(path.sep).join("/");
}

export function parseRuffOutput(stdout: string, opts: { stageId: string; version: string | null; workspace: string; cwd: string }): RuffParse {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch (error) {
    return { ok: false, findings: [], problem: error instanceof Error ? error.message : String(error) };
  }
  if (!Array.isArray(doc)) return { ok: false, findings: [], problem: "the document is not a list" };
  const roots = [opts.workspace];
  for (const r of [opts.workspace, opts.cwd]) {
    try {
      roots.push(fs.realpathSync(r));
    } catch {
      // keep the lexical root only
    }
  }
  const findings: ResultFinding[] = [];
  for (const [index, entry] of doc.entries()) {
    if (!isRec(entry) || typeof entry.code !== "string" || typeof entry.message !== "string" || typeof entry.filename !== "string") {
      return { ok: false, findings: [], problem: `entry ${index} has no code, message or filename` };
    }
    const where = isRec(entry.location) ? entry.location : {};
    const line = typeof where.row === "number" && where.row >= 1 ? where.row : undefined;
    const column = typeof where.column === "number" && where.column >= 1 ? where.column : undefined;
    const file = relativeTo(roots, entry.filename);
    findings.push({
      stageId: opts.stageId,
      tool: "ruff",
      ...(opts.version ? { toolVersion: opts.version } : {}),
      ruleId: entry.code,
      category: "lint",
      severity: typeof entry.severity === "string" ? entry.severity : "error",
      // Ruff reports violations of the project's own rule set: each one is a defect to fix.
      normalizedSeverity: "medium",
      message: entry.message,
      location: { path: file, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) },
      fingerprint: contentHash({ tool: "ruff", rule: entry.code, file, line: line ?? null, column: column ?? null, message: entry.message }),
      origin: "ruff",
      blocking: true,
      blockingReason: "blocking-tool",
      waived: false,
    });
  }
  return { ok: true, findings };
}
