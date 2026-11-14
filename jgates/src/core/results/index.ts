import type { AdapterOutput, ResultFinding, ResultStage } from "../run/types.js";
import { assignAnchors, type LineOf } from "./anchor.js";
import { assignFingerprints } from "./fingerprint.js";
import { applyWaivers, WAIVERS_FILE, type ResultWaivers, type Waiver } from "./waivers.js";

export * from "./fingerprint.js";
export * from "./anchor.js";
export * from "./waivers.js";
export * from "./baseline.js";
export * from "./sarif.js";
export * from "./metrics.js";
export * from "./previous.js";

export interface FinalizeOptions {
  /** Reads the flagged line from the analyzed tree; without it no finding gets an anchor. */
  lineOf?: LineOf;
  /** The project's waiver file could not be read (recorded in waivers.problem; its waivers are not in the list). */
  problem?: string;
}

/**
 * Fingerprints (v1), anchors (jga1) and waivers over the findings and stages of a run, with the record of what the
 * waivers did. Stage states are never changed by waivers.
 */
export function finalizeFindings(
  output: Pick<AdapterOutput, "findings" | "stages">,
  waivers: Waiver[],
  now: Date,
  options: FinalizeOptions = {},
): { findings: ResultFinding[]; stages: ResultStage[]; waivers: ResultWaivers } {
  const identified = assignAnchors(assignFingerprints(output.findings), options.lineOf);
  const applied = applyWaivers(identified, output.stages, waivers, now);
  const record = options.problem ? { ...applied.record, problem: { file: WAIVERS_FILE, message: options.problem } } : applied.record;
  return { findings: applied.findings, stages: applied.stages, waivers: record };
}
