// Parser of the JSON message stream of `cargo clippy --message-format json` (one JSON document per line). Fail-closed: a
// stream without the closing build-finished message, a failed build, or an exit code that contradicts the stream is a
// problem (the stage is an error and proves nothing), never a clean result.
import { isRec, type LintDiagnostic, type LintLevel, type LintParse } from "../lint-common/index.js";

/** Cargo's cargo-level notes ("N warnings emitted", "aborting due to...") carry no code and are not findings. */
export function parseClippy(stdout: string, exitCode: number | null): LintParse {
  const diagnostics: LintDiagnostic[] = [];
  let finished: boolean | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    let doc: unknown;
    try {
      doc = JSON.parse(line);
    } catch {
      return { ok: false, diagnostics: [], problem: "a line of the message stream is not JSON" };
    }
    if (!isRec(doc) || typeof doc.reason !== "string") continue;
    if (doc.reason === "build-finished") {
      finished = doc.success === true;
      continue;
    }
    if (doc.reason !== "compiler-message" || !isRec(doc.message)) continue;
    const message = doc.message;
    const code = isRec(message.code) && typeof message.code.code === "string" ? message.code.code : null;
    const level = message.level === "error" || message.level === "warning" ? (message.level as LintLevel) : null;
    if (code === null || level === null) continue;
    const spans = Array.isArray(message.spans) ? message.spans.filter(isRec) : [];
    const span = spans.find((s) => s.is_primary === true) ?? spans[0];
    if (!span || typeof span.file_name !== "string") continue;
    diagnostics.push({
      file: span.file_name,
      line: typeof span.line_start === "number" ? span.line_start : undefined,
      column: typeof span.column_start === "number" ? span.column_start : undefined,
      ruleId: code,
      level,
      message: typeof message.message === "string" ? message.message : code,
    });
  }
  if (finished === null) return { ok: false, diagnostics: [], problem: "the message stream has no build-finished message" };
  if (!finished) return { ok: false, diagnostics: [], problem: "the crate did not compile" };
  if (exitCode !== 0) return { ok: false, diagnostics: [], problem: `unexpected exit ${exitCode ?? "-"} after a finished build` };
  return { ok: true, diagnostics };
}
