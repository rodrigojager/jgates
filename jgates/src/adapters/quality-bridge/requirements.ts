import type { DisableOrigin } from "../../core/contract/index.js";

export type BridgeMode = "quick" | "offline" | "full";
export const BRIDGE_MODES: readonly BridgeMode[] = ["quick", "offline", "full"];

/** What one run of the bridge asks for. Defaults follow the legacy local mode (no secrets, tests or coverage). */
export interface BridgeSelection {
  mode: BridgeMode;
  pii: boolean;
  secrets: boolean;
  iac: boolean;
  projectTests: boolean;
  coverage: boolean;
  /** Subchecks the bridge runs (a reviewed plan); absent: every subcheck the mode and flags turn on (legacy). */
  subchecks?: string[];
  /** Local mode only: the project configuration file per configurable scanner (workspace-relative). */
  toolConfigs?: Record<string, string>;
}

export const DEFAULT_SELECTION: BridgeSelection = {
  mode: "full",
  pii: false,
  secrets: false,
  iac: true,
  projectTests: false,
  coverage: false,
};

export const ADAPTER_ID = "quality-bridge";
export const COMPOSITE_STAGE_ID = ADAPTER_ID;
export const stageIdOf = (subcheckId: string): string => `${ADAPTER_ID}.${subcheckId}`;

export interface SubcheckPlan {
  subcheckId: string;
  stageId: string;
  /** Required for this selection; false only when it is disabled. */
  required: boolean;
  /** Why it is required, or why it is off. */
  reason: string;
  disabled?: { origin: DisableOrigin; reason: string };
  /** What a "skipped" answer of the sidecar means while the subcheck is required. */
  skipMeans: "not_applicable" | "blocked";
  /**
   * Set by a reviewed plan: the plan put this subcheck off, so it is disabled even when the sidecar ran it
   * (its evidence and findings are dropped, the decision follows the plan).
   */
  forced?: boolean;
  /** Pairs of this subcheck (<stage>#<capability>) the plan turned off while others stay on. */
  extraDisabled?: Array<{ id: string; origin: DisableOrigin; reason: string }>;
}

const EXTERNAL_ALWAYS = ["megalinter", "semgrep", "trivy", "osv-scanner", "jscpd"];
const IAC = ["checkov"];

/**
 * Requirement table of the bridge (fail-closed: a required subcheck that did not run never passes).
 *
 * | subcheck                               | full                                   | quick / offline            |
 * | -------------------------------------- | -------------------------------------- | -------------------------- |
 * | file-size                              | required                               | required                   |
 * | megalinter, semgrep, trivy, osv, jscpd | required                               | disabled (run): mode skip  |
 * | checkov                                | required (skip = no IaC files: n/a);   | disabled (run): mode skip  |
 * |                                        | disabled (run) with --disable-iac      |                            |
 * | gitleaks                               | required with --enable-secrets;        | disabled (run): mode skip  |
 * |                                        | otherwise disabled (profile)           |                            |
 * | project-tests                          | required with --run-project-tests;     | same as full               |
 * |                                        | otherwise disabled (profile)           |                            |
 * | coverage                               | required with --enable-coverage;       | same as full               |
 * |                                        | otherwise disabled (profile)           |                            |
 *
 * "disabled (run)" makes the run reduced; "disabled (profile)" is the default selection of the bridge,
 * not part of the requirements. A required subcheck that is skipped, missing, in timeout or in error never passes.
 */
export function planSubchecks(selection: BridgeSelection, subcheckIds: string[]): SubcheckPlan[] {
  const { mode } = selection;
  const modeSkip = { origin: "run" as const, reason: `mode ${mode} runs no external tool` };
  return subcheckIds.map((id) => {
    const stageId = stageIdOf(id);
    const on = (reason: string, skipMeans: SubcheckPlan["skipMeans"] = "blocked"): SubcheckPlan => ({
      subcheckId: id,
      stageId,
      required: true,
      reason,
      skipMeans,
    });
    const off = (origin: DisableOrigin, reason: string): SubcheckPlan => ({
      subcheckId: id,
      stageId,
      required: false,
      reason,
      disabled: { origin, reason },
      skipMeans: "blocked",
    });
    // A subcheck the request leaves out is not run by the bridge at all.
    if (selection.subchecks && !selection.subchecks.includes(id)) return off("profile", "not selected by the plan");
    if (id === "file-size") return on("built-in budget, runs in every mode");
    if (EXTERNAL_ALWAYS.includes(id)) return mode === "full" ? on("external tool required in mode full") : off(modeSkip.origin, modeSkip.reason);
    if (IAC.includes(id)) {
      if (mode !== "full") return off(modeSkip.origin, modeSkip.reason);
      if (!selection.iac) return off("run", "IaC analysis turned off for this run (--disable-iac)");
      return on("IaC tool required in mode full; not applicable when the tool reports no IaC files", "not_applicable");
    }
    if (id === "gitleaks") {
      if (!selection.secrets) return off("profile", "secrets scanning is off in the default selection (--enable-secrets turns it on)");
      if (mode !== "full") return off(modeSkip.origin, modeSkip.reason);
      return on("secrets scanning requested (--enable-secrets)");
    }
    if (id === "project-tests") {
      return selection.projectTests
        ? on("project tests requested (--run-project-tests)")
        : off("profile", "project tests are off in the default selection (--run-project-tests turns them on)");
    }
    if (id === "coverage") {
      return selection.coverage
        ? on("coverage requested (--enable-coverage)")
        : off("profile", "coverage is off in the default selection (--enable-coverage turns it on)");
    }
    // A subcheck this table does not know is required: unknown never passes silently.
    return on("subcheck not described by the bridge requirement table");
  });
}
