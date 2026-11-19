// The reader of `npm-groovy-lint --output <file>` (SARIF): some CodeNarc rules (UnnecessaryGroovyImport) report an
// empty message text, which the built-in SARIF reader refuses. An empty text gets the rule id as its message; everything
// else is plain SARIF, read by the built-in reader (see tests/fixtures/linters/npm-groovy-lint/recorded/bad.json).
import { builtinReader, type Reader } from "../readers.js";

export const read: Reader = (input, output) => {
  let text = input.text;
  try {
    const doc: unknown = JSON.parse(text);
    if (typeof doc === "object" && doc !== null && Array.isArray((doc as { runs?: unknown }).runs)) {
      for (const run of (doc as { runs: unknown[] }).runs) {
        const results = typeof run === "object" && run !== null ? (run as { results?: unknown }).results : undefined;
        if (!Array.isArray(results)) continue;
        for (const result of results) {
          if (typeof result !== "object" || result === null) continue;
          const r = result as { ruleId?: unknown; message?: { text?: unknown } };
          if (typeof r.ruleId === "string" && r.message && typeof r.message === "object" && r.message.text === "") r.message.text = r.ruleId;
        }
      }
      text = JSON.stringify(doc);
    }
  } catch {
    /* the built-in reader reports the problem */
  }
  return builtinReader("sarif")({ ...input, text }, output);
};
