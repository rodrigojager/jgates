// Normalizes the JSON of `eslint --format json` into result findings. Fail-closed: an entry that cannot be read makes the
// whole output uninterpreted.
import path from "node:path";
import { contentHash } from "../../core/ids/index.js";
import type { ResultFinding } from "../../core/run/types.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

export interface EslintParse {
  ok: boolean;
  findings: ResultFinding[];
  filesLinted: number;
  problem?: string;
}

function relativeTo(workspace: string, file: string): string {
  const abs = path.resolve(file);
  const rel = path.relative(workspace, abs);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : file.split(path.sep).join("/");
}

export function parseEslintOutput(text: string, opts: { stageId: string; version: string | null; workspace: string }): EslintParse {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { ok: false, findings: [], filesLinted: 0, problem: error instanceof Error ? error.message : String(error) };
  }
  if (!Array.isArray(doc)) return { ok: false, findings: [], filesLinted: 0, problem: "the document is not a list of files" };
  const findings: ResultFinding[] = [];
  for (const [index, entry] of doc.entries()) {
    if (!isRec(entry) || typeof entry.filePath !== "string" || !Array.isArray(entry.messages)) return { ok: false, findings: [], filesLinted: 0, problem: `entry ${index} has no filePath or messages` };
    const file = relativeTo(opts.workspace, entry.filePath);
    for (const [at, m] of entry.messages.entries()) {
      if (!isRec(m) || typeof m.message !== "string") return { ok: false, findings: [], filesLinted: 0, problem: `message ${at} of ${file} has no text` };
      const severity = m.severity === 2 ? "error" : "warning";
      const line = typeof m.line === "number" && m.line >= 1 ? m.line : undefined;
      const column = typeof m.column === "number" && m.column >= 1 ? m.column : undefined;
      // No rule id: a parse error or another fatal message of the file.
      const ruleId = typeof m.ruleId === "string" && m.ruleId !== "" ? m.ruleId : "eslint.fatal";
      const blocking = severity === "error";
      findings.push({
        stageId: opts.stageId,
        tool: "eslint",
        ...(opts.version ? { toolVersion: opts.version } : {}),
        ruleId,
        category: "lint",
        severity,
        normalizedSeverity: blocking ? "high" : "low",
        message: m.message,
        location: { path: file, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) },
        fingerprint: contentHash({ tool: "eslint", rule: ruleId, file, line: line ?? null, column: column ?? null, message: m.message }),
        origin: "eslint",
        blocking,
        ...(blocking ? { blockingReason: "blocking-tool" as const } : {}),
        waived: false,
      });
    }
  }
  return { ok: true, findings, filesLinted: doc.length };
}
