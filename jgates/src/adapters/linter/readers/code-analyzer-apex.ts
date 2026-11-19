// The reader of the Salesforce Code Analyzer's SARIF report (`sf code-analyzer run --output-file x.sarif`): findings are
// ordinary SARIF, but a clean run writes `"runs": []` (the built-in SARIF reader treats that as a broken report). Written
// against the recordings in tests/fixtures/linters/code-analyzer-*/recorded/. The Aura and LWC descriptors reuse it
// (readers/code-analyzer-aura.ts and readers/code-analyzer-lwc.ts re-export it). Fail-closed: anything that is not a
// SARIF document is a problem.
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
  if (runs.every((run) => (run as { results?: unknown } | null)?.results === undefined)) return { ok: true, findings: [] };
  return builtinReader("sarif")(input, output);
};
