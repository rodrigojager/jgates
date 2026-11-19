// The reader of `protolint lint -reporter sarif`: findings are ordinary SARIF, but a clean run writes a run with no
// `results` key at all (the built-in SARIF reader treats that as a broken report). Written against the recordings in
// tests/fixtures/linters/protolint/recorded/. Fail-closed: anything that is not a SARIF document is a problem.
import { builtinReader, type Reader } from "../readers.js";

export const read: Reader = (input, output) => {
  let doc: unknown;
  try {
    doc = JSON.parse(input.text);
  } catch {
    return { ok: false, findings: [], problem: "the report is not JSON" };
  }
  const runs = (doc as { runs?: unknown } | null)?.runs;
  if (!Array.isArray(runs)) return { ok: false, findings: [], problem: "the report has no runs list" };
  const withResults = runs.filter((run) => (run as { results?: unknown } | null)?.results !== undefined);
  if (withResults.length === 0) return { ok: true, findings: [] };
  return builtinReader("sarif")(input, output);
};
