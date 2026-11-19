// The reader of `snakemake --lint`: the lints are blocks of text on stderr, one header per rule (or per workflow file)
// and one bullet per lint, followed by an explanation that is not a finding:
//   Lints for rule make (line 1, /workspace/Snakefile):
//       * No log directive defined:
//         Without a log directive, all output will be printed to the terminal. ...
//   Lints for snakefile /workspace/Snakefile:
//       * Path composition with '+' in line 7:
// Written against the recording in tests/fixtures/linters/snakemake/recorded/. A failure to parse the workflow is one
// error finding on the file; a failed run with nothing recognised is a problem, never a pass.
import type { RawFinding, Reader } from "../readers.js";

const HEADER = /^Lints for (?:rule (?<name>\S+) \(line (?<line>\d+), (?<file>.+)\)|snakefile (?<only>.+)):\s*$/;
const BULLET = /^\s{2,}\* (?<title>.+?):?\s*$/;

const slug = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "lint";

export const read: Reader = (input, output) => {
  const text = input.text.trim();
  if (text === "") return input.exitCode === 0 ? { ok: true, findings: [] } : { ok: false, findings: [], problem: "snakemake exited with findings but printed nothing" };
  const level = output.level ?? "warning";
  const findings: RawFinding[] = [];
  let current: { name: string | null; line: number | null; file: string | null } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header?.groups) {
      current = { name: header.groups.name ?? null, line: header.groups.line ? Number(header.groups.line) : null, file: input.file ?? header.groups.file ?? header.groups.only ?? null };
      continue;
    }
    const bullet = BULLET.exec(line);
    if (current && bullet?.groups) {
      const title = bullet.groups.title ?? "";
      const message = current.name ? `${title} (rule ${current.name})` : title;
      findings.push(current.line === null ? { file: current.file, rule: slug(title), level, message } : { file: current.file, line: current.line, rule: slug(title), level, message });
    }
  }
  if (findings.length === 0) {
    if (input.exitCode === 0) return { ok: true, findings: [] };
    const tail = text.split(/\r?\n/).filter((line) => line.trim() !== "").slice(-3).join(" ").slice(0, 300);
    findings.push({ file: input.file ?? null, rule: "parse-error", level: "error", message: tail });
  }
  return { ok: true, findings };
};
