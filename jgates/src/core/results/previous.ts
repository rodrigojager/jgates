// What differs between a result and the validation before it (the "criteria changed" note of the result screen): the
// hashes of the analysis (configuration, policy, templates, tools, native files, inventory) and the waivers in force.
// A result written before the waivers entered the provenance has no record of them: the waivers are then not compared.
import type { RunResult } from "../run/types.js";

export interface PreviousComparison {
  /** Both results carry the hashes of their analysis. */
  comparable: boolean;
  /** The parts that differ: keys of analyzed.hashes (never "plan") and "waivers". */
  changed: string[];
  policyChanged: boolean;
  /** The waivers in force differ (both results recorded them). */
  waiversChanged: boolean;
}

export function compareWithPrevious(current: Pick<RunResult, "analyzed" | "provenance">, previous: Pick<RunResult, "analyzed" | "provenance">): PreviousComparison {
  const now = current.analyzed?.hashes ?? null;
  const then = previous.analyzed?.hashes ?? null;
  const comparable = now !== null && then !== null;
  const changed = comparable ? (Object.keys(now) as Array<keyof typeof now>).filter((k) => k !== "plan" && now[k] !== then[k]).map(String) : [];
  const wNow = current.provenance?.waivers?.sha256;
  const wThen = previous.provenance?.waivers?.sha256;
  const waiversChanged = typeof wNow === "string" && typeof wThen === "string" && wNow !== wThen;
  if (waiversChanged) changed.push("waivers");
  return { comparable, changed, policyChanged: changed.includes("policy"), waiversChanged };
}
