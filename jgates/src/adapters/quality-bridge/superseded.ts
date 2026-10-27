// Bridge subchecks that an individual adapter replaces (the same tool never runs twice). When an instance of the
// adapter runs a capability in the plan, the bridge's pair of that subcheck and that capability is off, with the
// reason and the item that replaces it; the bridge then does not run the subcheck at all once none of its pairs is on.
// A subcheck left with another capability still on (Trivy's iac while the trivy adapter runs only dependencies) keeps
// running in the bridge, and the plan says the tool runs twice.
import { translator } from "../../i18n/index.js";

/** Subcheck id -> the adapter that replaces it. */
export const SUPERSEDING_ADAPTERS: Readonly<Record<string, string>> = {
  gitleaks: "gitleaks",
  trivy: "trivy",
  "osv-scanner": "osv-scanner",
  checkov: "checkov",
  jscpd: "jscpd",
};

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
    const adapter = SUPERSEDING_ADAPTERS[pair.subcheck];
    if (!adapter) continue;
    const by = active.filter((a) => a.adapter === adapter && a.capability === pair.capability).map((a) => `${a.tool}#${a.capability}`);
    if (by.length === 0) continue;
    out.set(`${pair.subcheck}#${pair.capability}`, {
      subcheck: pair.subcheck,
      capability: pair.capability,
      by,
      reason: { code: "SUPERSEDED", message: t("bridge_superseded", { subcheck: pair.subcheck, capability: pair.capability, by: by.join(", ") }) },
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
