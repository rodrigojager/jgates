// Reads what the mutation engines write into one common reading: the mutants that were detected (killed by a test or
// timed out), the ones that survived, the ones no test reached, and the score. Pure functions: no process, no file
// access. Fail-closed: a document that is not the expected report is "not interpreted", never a score of 0 or 100.
//
// Score = detected / (detected + survived + not covered): the mutation-testing-elements definition. Mutants that did
// not compile, crashed the runtime, were ignored or never ran are outside the denominator.

export interface SurvivingMutant {
  /** Workspace-relative file with forward slashes (a Python module path for mutmut until the adapter resolves it). */
  file: string;
  line: number | null;
  column: number | null;
  /** Stryker mutator name, or the mutmut mutant id. */
  mutator: string;
  /** What the code was replaced with (Stryker) or the mutated function (mutmut). */
  replacement: string;
  /** Survived: tests ran and none failed. Not covered: no test reaches the mutant. */
  kind: "survived" | "not-covered";
}

export interface MutationReading {
  ok: boolean;
  problem?: string;
  engine: "stryker" | "mutmut";
  killed: number;
  timedOut: number;
  survived: number;
  notCovered: number;
  /** Compile errors, runtime errors, ignored and pending mutants: not part of the score. */
  excluded: number;
  detected: number;
  /** The denominator of the score. */
  valid: number;
  /** Percent with two decimals; null when nothing was valid (no mutant to judge). */
  score: number | null;
  survivors: SurvivingMutant[];
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const slash = (p: string): string => p.split("\\").join("/").replace(/^\.\//, "");

const MAX_REPLACEMENT = 120;
const clip = (text: string): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > MAX_REPLACEMENT ? `${one.slice(0, MAX_REPLACEMENT - 1)}…` : one;
};

export function mutationScore(detected: number, valid: number): number | null {
  return valid === 0 ? null : Math.round((detected / valid) * 10000) / 100;
}

const empty = (engine: MutationReading["engine"], problem: string): MutationReading => ({ ok: false, problem, engine, killed: 0, timedOut: 0, survived: 0, notCovered: 0, excluded: 0, detected: 0, valid: 0, score: null, survivors: [] });

/** Stryker's `json` reporter file (mutation-testing-elements report schema, schemaVersion 1). */
export function parseStrykerReport(text: string): MutationReading {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return empty("stryker", `not JSON: ${(error as Error).message}`);
  }
  if (!isRec(doc) || !isRec(doc.files)) return empty("stryker", "no files map in the mutation report");
  const out = empty("stryker", "");
  out.ok = true;
  delete out.problem;
  for (const [file, body] of Object.entries(doc.files)) {
    if (!isRec(body) || !Array.isArray(body.mutants)) return empty("stryker", `the entry ${file} has no mutants list`);
    for (const m of body.mutants) {
      if (!isRec(m) || typeof m.status !== "string") return empty("stryker", `a mutant of ${file} has no status`);
      switch (m.status) {
        case "Killed":
          out.killed++;
          break;
        case "Timeout":
          out.timedOut++;
          break;
        case "Survived":
        case "NoCoverage": {
          const kind = m.status === "Survived" ? "survived" : "not-covered";
          if (kind === "survived") out.survived++;
          else out.notCovered++;
          const start = isRec(m.location) && isRec(m.location.start) ? m.location.start : {};
          out.survivors.push({
            file: slash(file),
            line: typeof start.line === "number" ? start.line : null,
            column: typeof start.column === "number" ? start.column : null,
            mutator: typeof m.mutatorName === "string" ? m.mutatorName : "?",
            replacement: clip(typeof m.replacement === "string" ? m.replacement : ""),
            kind,
          });
          break;
        }
        default:
          // CompileError, RuntimeError, Ignored, Pending: outside the score.
          out.excluded++;
      }
    }
  }
  return finish(out);
}

function finish(r: MutationReading): MutationReading {
  r.detected = r.killed + r.timedOut;
  r.valid = r.detected + r.survived + r.notCovered;
  r.score = mutationScore(r.detected, r.valid);
  r.survivors.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0) || (a.mutator < b.mutator ? -1 : 1)));
  return r;
}

/**
 * mutmut: the counts come from `mutmut export-cicd-stats` (mutants/mutmut-cicd-stats.json) and the mutants that
 * were not killed from `mutmut results` (lines `    <module>.<function>__mutmut_<n>: <status>`).
 */
export function parseMutmutOutput(statsText: string, resultsText: string): MutationReading {
  let stats: unknown;
  try {
    stats = JSON.parse(statsText);
  } catch (error) {
    return empty("mutmut", `the statistics are not JSON: ${(error as Error).message}`);
  }
  if (!isRec(stats) || typeof stats.total !== "number" || typeof stats.killed !== "number" || typeof stats.survived !== "number") {
    return empty("mutmut", "the statistics have no killed, survived and total counts");
  }
  const out = empty("mutmut", "");
  out.ok = true;
  delete out.problem;
  out.killed = num(stats.killed) + num(stats.segfault);
  out.timedOut = num(stats.timeout);
  out.survived = num(stats.survived);
  // A mutant no test selected ("no tests") is a coverage gap; a suspicious one (slow or unstable) proves nothing.
  out.notCovered = num(stats.no_tests) + num(stats.suspicious);
  out.excluded = num(stats.skipped);
  for (const line of resultsText.split(/\r?\n/)) {
    const m = /^\s+([A-Za-z_][\w.]*?)\.([^.\s]+)__mutmut_(\d+):\s*(survived|no tests|suspicious)\s*$/.exec(line);
    if (!m) continue;
    out.survivors.push({
      file: (m[1] as string).split(".").join("/"),
      line: null,
      column: null,
      mutator: `mutmut_${m[3]}`,
      replacement: (m[2] as string).replace(/^x(?:ǁ.*ǁ)?_?/u, "") || (m[2] as string),
      kind: m[4] === "survived" ? "survived" : "not-covered",
    });
  }
  return finish(out);
}
