import { builtinReader, type Reader } from "../readers.js";

const readLines = builtinReader("lines");
const gitMetadata = /^"?(?:\.\/)?\.git(?:\/|"?$)/;

export const read: Reader = (input, output) => {
  const result = readLines(input, output);
  if (!result.ok) return result;
  // Git's exit 3 means it found whitespace errors. Require a recognizable
  // diagnostic before dropping any findings from repository metadata.
  if (input.exitCode === 3 && result.findings.length === 0) {
    return { ok: false, findings: [], problem: "Git reported whitespace errors without a recognized diagnostic" };
  }
  return {
    ok: true,
    findings: result.findings.filter(({ file }) => file === null || !gitMetadata.test(file)),
  };
};
