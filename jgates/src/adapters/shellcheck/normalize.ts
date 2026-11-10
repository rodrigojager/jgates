// Parser of `shellcheck --format json1`: `{"comments":[{"file","line","column","level","code","message"}]}`. Fail-closed:
// an exit code or an output that does not explain itself is a problem, never a clean result.
import { conclude, isRec, type LintDiagnostic, type LintLevel, type LintParse } from "../lint-common/index.js";

const LEVELS: Record<string, LintLevel> = { error: "error", warning: "warning", info: "info", style: "style" };

/** Exit 0 clean, 1 findings; 2 and above are failures (a script that cannot be read or parsed, a bad invocation). */
export function parseShellcheck(stdout: string, exitCode: number | null): LintParse {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return { ok: false, diagnostics: [], problem: "the report is not JSON" };
  }
  if (!isRec(doc) || !Array.isArray(doc.comments)) return { ok: false, diagnostics: [], problem: "the report has no comments list" };
  const diagnostics: LintDiagnostic[] = [];
  for (const raw of doc.comments as unknown[]) {
    if (!isRec(raw) || typeof raw.file !== "string" || typeof raw.code !== "number") return { ok: false, diagnostics: [], problem: "a comment of the report has no file or code" };
    diagnostics.push({
      file: raw.file,
      line: typeof raw.line === "number" ? raw.line : undefined,
      column: typeof raw.column === "number" ? raw.column : undefined,
      ruleId: `SC${raw.code}`,
      level: LEVELS[typeof raw.level === "string" ? raw.level : ""] ?? "warning",
      message: typeof raw.message === "string" ? raw.message : `SC${raw.code}`,
    });
  }
  return conclude(diagnostics, exitCode, [0], [1]);
}
