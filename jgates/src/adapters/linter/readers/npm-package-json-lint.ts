// The reader of `npmPkgJsonLint .`: it prints nothing when every package.json passes, else a block per file:
//
//   ./package.json
//   ERROR name-format - node: name - name can no longer contain capital letters
//   WARN require-description - node: description - description is required
//   2 errors
//   0 warnings
//
// Written against the recording in tests/fixtures/linters/npm-package-json-lint/recorded/. Fail-closed: a failing
// exit code with no finding line is a problem. The tool names no line (a package.json key is not a line).
import type { RawFinding, Reader } from "../readers.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const FINDING = /^(?<level>ERROR|WARN(?:ING)?)\s+(?<rule>[A-Za-z0-9_.-]+)\s+-\s+(?<message>.+)$/;
const SUMMARY = /^\d+\s+(?:errors?|warnings?)$/;

export const read: Reader = (input) => {
  const lines = input.text.replace(ANSI, "").split(/\r?\n/).map((l) => l.trim());
  const findings: RawFinding[] = [];
  let file: string | null = null;
  for (const line of lines) {
    if (line === "" || SUMMARY.test(line)) continue;
    const m = FINDING.exec(line);
    if (m?.groups) {
      findings.push({ file, rule: m.groups.rule ?? "package-json", level: (m.groups.level ?? "error").toLowerCase().replace("warning", "warn"), message: m.groups.message ?? "" });
    } else {
      file = line.replace(/^\.\//, "");
    }
  }
  if (findings.length === 0 && input.exitCode !== 0 && input.exitCode !== null) {
    return { ok: false, findings: [], problem: `npmPkgJsonLint exited ${input.exitCode} with no finding line: ${input.text.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300)}` };
  }
  return { ok: true, findings };
};
