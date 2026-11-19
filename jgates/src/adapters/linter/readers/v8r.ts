import { stripVTControlCharacters } from "node:util";
import { builtinReader, type Reader } from "../readers.js";

export const read: Reader = (input, output) => {
  // v8r 6.1.0 uses 98 both for missing input patterns and when every
  // matched file is excluded by its ignore rules. Only the latter is clean.
  if (input.exitCode === 98) {
    const finalLine = stripVTControlCharacters(input.other).trimEnd().split(/\r?\n/).at(-1);
    if (input.text.trim() === "" && finalLine === "✖ Could not find any files to validate") {
      return { ok: true, findings: [] };
    }
    return { ok: false, findings: [], problem: "v8r did not accept the input files" };
  }
  return builtinReader("json")(input, output);
};
