// Parser of the JSON report of golangci-lint v2 (--output.json.path=stdout). Fail-closed: an exit code or an output that
// does not explain itself is a problem (the stage is an error and proves nothing), never a clean result.
import { conclude, isRec, type LintDiagnostic, type LintLevel, type LintParse } from "../lint-common/index.js";

const LEVELS: Record<string, LintLevel> = { error: "error", warning: "warning", info: "info" };

/** `{"Issues":[{"FromLinter":"errcheck","Text":"...","Severity":"","Pos":{"Filename":"main.go","Line":6,"Column":11}}],"Report":{...}}`. Exit 0 clean, 1 issues. */
export function parseGolangci(stdout: string, exitCode: number | null): LintParse {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return { ok: false, diagnostics: [], problem: "the report is not JSON" };
  }
  if (!isRec(doc) || !("Issues" in doc) || !(doc.Issues === null || Array.isArray(doc.Issues))) return { ok: false, diagnostics: [], problem: "the report has no Issues list" };
  const diagnostics: LintDiagnostic[] = [];
  for (const raw of (doc.Issues ?? []) as unknown[]) {
    if (!isRec(raw) || !isRec(raw.Pos) || typeof raw.Pos.Filename !== "string" || typeof raw.FromLinter !== "string") return { ok: false, diagnostics: [], problem: "an issue of the report has no linter or position" };
    const line = typeof raw.Pos.Line === "number" && raw.Pos.Line > 0 ? raw.Pos.Line : undefined;
    const column = typeof raw.Pos.Column === "number" && raw.Pos.Column > 0 ? raw.Pos.Column : undefined;
    diagnostics.push({
      file: raw.Pos.Filename,
      line,
      column,
      ruleId: raw.FromLinter,
      level: LEVELS[typeof raw.Severity === "string" ? raw.Severity.toLowerCase() : ""] ?? "error",
      message: typeof raw.Text === "string" ? raw.Text : raw.FromLinter,
    });
  }
  return conclude(diagnostics, exitCode, [0], [1]);
}
