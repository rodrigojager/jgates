// Bridge subchecks that an individual adapter replaces (the same tool never runs twice). When an instance of the
// adapter runs a capability in the plan, the bridge's pair of that subcheck and that capability is off, with the
// reason and the item that replaces it; the bridge then does not run the subcheck at all once none of its pairs is on.
// A subcheck left with another capability still on (Trivy's iac while the trivy adapter runs only dependencies) keeps
// running in the bridge, and the plan says the tool runs twice.
import { translator } from "../../i18n/index.js";

/**
 * Subcheck id -> the adapters that replace it. The project's tests are one more case: the bridge's project-tests
 * (`npm test` or `python -m unittest discover`) and its coverage (a report the project left in the folder) are the
 * weaker copy of what a test adapter does with the project's own runner, so they stay out when one runs.
 */
export const SUPERSEDING_ADAPTERS: Readonly<Record<string, readonly string[]>> = {
  gitleaks: ["gitleaks"],
  trivy: ["trivy"],
  "osv-scanner": ["osv-scanner"],
  checkov: ["checkov"],
  jscpd: ["jscpd"],
  "project-tests": ["pytest", "vitest"],
  coverage: ["pytest", "vitest"],
};

/** Subchecks replaced by a test adapter (a different tool doing the same job), with their own reason. */
const TEST_SUBCHECKS = new Set(["project-tests", "coverage"]);

export interface ActivePair {
  /** Tool instance id. */
  tool: string;
  adapter: string | null;
  capability: string;
}

export interface SupersededPair {
  subcheck: string;
  capability: string;
  /** Plan item ids (<instance>#<capability>) that run the tool instead. */
  by: string[];
  reason: { code: "SUPERSEDED"; message: string };
}

/** Which pairs of the bridge are replaced by the active pairs of the individual adapters (key: <subcheck>#<capability>). */
export function supersededPairs(bridgePairs: Array<{ subcheck: string; capability: string }>, active: ActivePair[]): Map<string, SupersededPair> {
  const t = translator("security");
  const out = new Map<string, SupersededPair>();
  for (const pair of bridgePairs) {
    const adapters = SUPERSEDING_ADAPTERS[pair.subcheck];
    if (!adapters) continue;
    const by = active.filter((a) => a.adapter !== null && adapters.includes(a.adapter) && a.capability === pair.capability).map((a) => `${a.tool}#${a.capability}`);
    if (by.length === 0) continue;
    const key = TEST_SUBCHECKS.has(pair.subcheck) ? "bridge_superseded_tests" : "bridge_superseded";
    out.set(`${pair.subcheck}#${pair.capability}`, {
      subcheck: pair.subcheck,
      capability: pair.capability,
      by,
      reason: { code: "SUPERSEDED", message: t(key, { subcheck: pair.subcheck, capability: pair.capability, by: by.join(", ") }) },
    });
  }
  return out;
}

/** Subchecks still run by the bridge although an adapter runs the same tool for another of their capabilities. */
export function duplicateScanners(superseded: Map<string, SupersededPair>, stillOn: Array<{ subcheck: string; capability: string }>): Array<{ code: "SCANNER_RUNS_TWICE"; message: string }> {
  const t = translator("security");
  const subs = [...new Set([...superseded.values()].map((s) => s.subcheck))];
  return subs
    .filter((sub) => stillOn.some((p) => p.subcheck === sub))
    .map((sub) => ({
      code: "SCANNER_RUNS_TWICE" as const,
      message: t("bridge_runs_twice", {
        subcheck: sub,
        capabilities: stillOn.filter((p) => p.subcheck === sub).map((p) => p.capability).join(", "),
        by: [...superseded.values()].filter((s) => s.subcheck === sub).flatMap((s) => s.by).join(", "),
      }),
    }));
}

/**
 * MegaLinter's lint subcheck runs ESLint with the trusted config and --no-inline-config (governed mode) and
 * cannot be told to leave it out here, so when the ESLint adapter runs the lint capability too, the duplication is
 * intentional and the plan says so: the direct run uses the project's config, the bridge one the trusted config.
 */
export function duplicateLinters(active: ActivePair[], stillOn: Array<{ subcheck: string; capability: string }>): Array<{ code: "LINTER_RUNS_TWICE"; message: string }> {
  const t = translator("security");
  const by = active.filter((a) => a.adapter === "eslint" && a.capability === "lint").map((a) => `${a.tool}#${a.capability}`);
  if (by.length === 0 || !stillOn.some((p) => p.subcheck === "megalinter" && p.capability === "lint")) return [];
  return [{ code: "LINTER_RUNS_TWICE", message: t("bridge_linter_twice", { by: by.join(", ") }) }];
}
