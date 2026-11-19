// The reader of `raku -c`: a compile failure is a short block on stderr, not one line:
//   ===SORRY!=== Error while compiling /workspace/greet.raku
//   Variable '$cunt' is not declared.  Did you mean '$count'?
//   at /workspace/greet.raku:4
//   ------> say ⏏$cunt;
// Written against the recording in tests/fixtures/linters/raku/recorded/. Fail-closed: an empty output is a problem.
import type { RawFinding, Reader } from "../readers.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const SORRY = /^===SORRY!===\s*(.*)$/;
const AT = /^at\s+(?<file>.+?):(?<line>\d+)\s*$/;

export const read: Reader = (input, output) => {
  const text = input.text.replace(ANSI, "").trim();
  if (text === "" && input.exitCode === 0) return { ok: true, findings: [] };
  if (text === "") return { ok: false, findings: [], problem: "raku printed nothing on stderr for a failed compile" };
  const lines = text.split(/\r?\n/);
  const rule = output.rule ?? "compile-error";
  const level = output.level ?? "error";
  const findings: RawFinding[] = [];
  let message: string[] = [];
  let header = "";
  for (const line of lines) {
    const sorry = SORRY.exec(line);
    if (sorry) {
      header = sorry[1] ?? "";
      message = [];
      continue;
    }
    const at = AT.exec(line);
    if (at?.groups) {
      findings.push({ file: input.file ?? at.groups.file ?? null, line: Number(at.groups.line), rule, level, message: (message.join(" ").replace(/\s+/g, " ").trim() || header) });
      message = [];
      continue;
    }
    if (line.startsWith("------>") || line.startsWith("    expecting")) continue;
    if (line.trim() !== "") message.push(line.trim());
  }
  if (findings.length === 0) findings.push({ file: input.file ?? null, rule, level, message: lines.slice(0, 3).join(" ").slice(0, 300) });
  return { ok: true, findings };
};
