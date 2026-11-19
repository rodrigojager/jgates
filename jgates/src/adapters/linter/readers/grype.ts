// The reader of `grype dir:. -o sarif`: standard SARIF, except that each location is the package file as seen from
// the scanned folder with a leading slash ("/package-lock.json"), which is the folder's root, not the filesystem's.
// The slash is removed so the path is relative to the workspace. Written against tests/fixtures/linters/grype/recorded/.
// Fail-closed: a report that is not SARIF is a problem.
import { readSarif } from "../../../core/evidence/index.js";
import type { Reader } from "../readers.js";

export const read: Reader = (input, output) => {
  const parsed = readSarif(input.text, { requireLocation: output.locationOptional !== true });
  if (!parsed.ok) return { ok: false, findings: [], problem: parsed.problem ?? "the SARIF cannot be read" };
  return {
    ok: true,
    findings: parsed.findings.map((f) => ({
      file: f.path === null || f.path === undefined ? null : f.path.replace(/^\/+/, ""),
      ...(f.line !== undefined ? { line: f.line } : {}),
      ...(f.column !== undefined ? { column: f.column } : {}),
      rule: f.ruleId,
      level: f.level,
      message: f.message,
    })),
  };
};
