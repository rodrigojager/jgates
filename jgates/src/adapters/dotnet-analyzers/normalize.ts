// Parser of the MSBuild diagnostics of `dotnet build`: `Program.cs(2,1): warning CA1806: message [project]`. Fail-closed:
// a failed build whose errors are not analyzer rules (compiler, restore or MSBuild errors) is a problem, never a clean result.
import { num, type LintDiagnostic, type LintParse } from "../lint-common/index.js";

/** Diagnostics of the build itself (restore, MSBuild, SDK), not of the code. */
const INFRASTRUCTURE = /^(?:MSB|NU|NETSDK)\d/;
/** Errors of the compiler: the code does not build, so the analysis is not a lint result. */
const COMPILER = /^(?:CS|BC|FS|VBC)\d/;

const LINE = /^\s*(.+?)\((\d+),(\d+)(?:,\d+,\d+)?\): (error|warning) ([A-Za-z][A-Za-z0-9]*): (.*?)(?: \(https?:\/\/[^)\s]*\))?(?: \[[^\]]*\])?\s*$/;

export function parseDotnetAnalyzers(output: string, exitCode: number | null): LintParse {
  const diagnostics: LintDiagnostic[] = [];
  const blockers: string[] = [];
  const seen = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    const m = LINE.exec(raw);
    if (!m) {
      // Errors without a position (restore, MSBuild) do not fit the pattern: any of them means the build did not run.
      const bare = /\berror ((?:MSB|NU|NETSDK)\d+)\b/.exec(raw);
      if (bare) blockers.push(bare[1] as string);
      continue;
    }
    const code = m[5] as string;
    const level = m[4] as "error" | "warning";
    if (INFRASTRUCTURE.test(code)) {
      if (level === "error") blockers.push(code);
      continue;
    }
    if (level === "error" && COMPILER.test(code)) blockers.push(code);
    // MSBuild prints each warning twice (as it happens, then in its closing list): one finding per place and rule.
    const key = `${m[1]}:${m[2]}:${m[3]}:${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push({ file: m[1] as string, line: num(m[2]), column: num(m[3]), ruleId: code, level, message: (m[6] as string).trim() });
  }
  if (exitCode !== 0 && exitCode !== 1) return { ok: false, diagnostics: [], problem: `unexpected exit ${exitCode ?? "-"}` };
  if (blockers.length > 0) return { ok: false, diagnostics: [], problem: `the build did not complete (${[...new Set(blockers)].slice(0, 5).join(", ")})` };
  // Exit 1 means the build failed; without a compiler or build error it must be an analyzer rule the project made an error.
  if (exitCode === 1 && !diagnostics.some((d) => d.level === "error")) return { ok: false, diagnostics: [], problem: "the build failed without an error the adapter can read" };
  return { ok: true, diagnostics };
}
