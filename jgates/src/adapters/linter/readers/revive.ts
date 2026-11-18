// The reader of `revive -formatter sarif`: Go drops the empty `results` list, so a clean run has a run
// with a tool and no `results` key (see tests/fixtures/linters/revive/recorded/clean.json). Everything
// else is plain SARIF, read by the built-in reader; an unreadable document stays a problem.
import { builtinReader, type Reader } from "../readers.js";

export const read: Reader = (input, output) => {
  let text = input.text;
  try {
    const doc: unknown = JSON.parse(text);
    if (typeof doc === "object" && doc !== null && Array.isArray((doc as { runs?: unknown }).runs)) {
      for (const run of (doc as { runs: unknown[] }).runs) {
        if (typeof run === "object" && run !== null && !("results" in run)) (run as { results: unknown[] }).results = [];
      }
      text = JSON.stringify(doc);
    }
  } catch {
    /* the built-in reader reports the problem */
  }
  return builtinReader("sarif")({ ...input, text }, output);
};
