// Parser of `hadolint --format json`: a JSON array of `{"code","column","file","level","line","message"}`. Fail-closed: an
// exit code or an output that does not explain itself is a problem, never a clean result.
import { conclude, isRec, type LintDiagnostic, type LintLevel, type LintParse } from "../lint-common/index.js";

const LEVELS: Record<string, LintLevel> = { error: "error", warning: "warning", info: "info", style: "style" };

/** Exit 0 clean, 1 findings (the command sets --failure-threshold style, so any rule that fires ends with 1). */
export function parseHadolint(stdout: string, exitCode: number | null): LintParse {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return { ok: false, diagnostics: [], problem: "the report is not JSON" };
  }
  if (!Array.isArray(doc)) return { ok: false, diagnostics: [], problem: "the report is not a list" };
  const diagnostics: LintDiagnostic[] = [];
  for (const raw of doc as unknown[]) {
    if (!isRec(raw) || typeof raw.file !== "string" || typeof raw.code !== "string") return { ok: false, diagnostics: [], problem: "an entry of the report has no file or code" };
    diagnostics.push({
      file: raw.file,
      line: typeof raw.line === "number" ? raw.line : undefined,
      column: typeof raw.column === "number" ? raw.column : undefined,
      ruleId: raw.code,
      level: LEVELS[typeof raw.level === "string" ? raw.level : ""] ?? "warning",
      message: typeof raw.message === "string" ? raw.message : raw.code,
    });
  }
  return conclude(diagnostics, exitCode, [0], [1]);
}
