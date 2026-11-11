// The governed CI path (jgates ci) keeps the quality gate's bridge. The interactive plans retired it: the base template
// declares individual instances (Semgrep, Gitleaks, OSV-Scanner, Trivy, Checkov, jscpd, file-size). Under a CI policy
// those scanners read configuration from the analyzed tree and are refused by the trust table (core/governed/trust.ts),
// while the bridge's subchecks run with the packaged, trusted configuration. So a governed plan reads the base template
// as it was before the retirement: the bridge instance and its subchecks instead of the individual instances. The legacy
// `quality-gate` package and commands stay untouched (ADR-15).
import { templateOps, type SourcedOps } from "../../core/config/resolve/layers.js";

/** Instances the base template declares that the bridge's subchecks replace in a governed plan. */
export const BASE_INSTANCES_OF_BRIDGE: readonly string[] = ["semgrep", "gitleaks", "osv-scanner", "trivy", "checkov", "jscpd", "file-size"];

/** What the base template declared for the bridge before its retirement (the `config` of the old template). */
const LEGACY_BASE_BRIDGE = {
  tools: {
    "quality-bridge": {
      adapter: "quality-bridge",
      enabled: true,
      capabilities: ["lint", "sast", "secrets", "dependencies", "duplication", "iac", "coverage", "unit", "file-size"],
    },
  },
  checks: {
    "tool:quality-bridge.file-size": { enabled: true },
    "tool:quality-bridge.megalinter": { enabled: true },
    "tool:quality-bridge.semgrep": { enabled: true },
    "tool:quality-bridge.gitleaks": { enabled: true },
    "tool:quality-bridge.trivy": { enabled: true },
    "tool:quality-bridge.osv-scanner": { enabled: true },
    "tool:quality-bridge.jscpd": { enabled: true },
    "tool:quality-bridge.checkov": { enabled: true },
    "tool:quality-bridge.project-tests": { enabled: false },
    "tool:quality-bridge.coverage": { enabled: false },
  },
};

/** The template layers of a governed plan: the base layer swaps its individual scanners for the bridge. */
export function legacyBridgeLayers(layers: SourcedOps[]): SourcedOps[] {
  return layers.map((layer) => {
    if (layer.source !== "builtin:base") return layer;
    const kept = layer.ops.filter((op) => !(op.segments[0] === "tools" && BASE_INSTANCES_OF_BRIDGE.includes(op.segments[1] ?? "")));
    return { ...layer, ops: [...kept, ...templateOps({ config: LEGACY_BASE_BRIDGE })] };
  });
}
