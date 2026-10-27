import type { AdapterOutput, ResultFinding, ResultStage } from "../run/types.js";
import { assignFingerprints } from "./fingerprint.js";
import { applyWaivers, type Waiver } from "./waivers.js";

export * from "./fingerprint.js";
export * from "./waivers.js";
export * from "./baseline.js";
export * from "./sarif.js";
export * from "./metrics.js";

/** Fingerprints (v1) and waivers over the findings and stages of a run. Stage states are never changed by waivers. */
export function finalizeFindings(
  output: Pick<AdapterOutput, "findings" | "stages">,
  waivers: Waiver[],
  now: Date,
): { findings: ResultFinding[]; stages: ResultStage[] } {
  return applyWaivers(assignFingerprints(output.findings), output.stages, waivers, now);
}
