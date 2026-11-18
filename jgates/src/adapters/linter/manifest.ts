// The adapter manifest of a descriptor: lintManifest, filled from the descriptor (only what differs from a stack lint
// adapter: the capability and its category, the network, the resources, the files it reads, the texts).
import type { AdapterManifest } from "../../core/catalog/index.js";
import { lintManifest } from "../lint-common/manifest.js";
import { linterCategory, type LoadedLinter } from "./descriptor.js";

const cache = new WeakMap<LoadedLinter, AdapterManifest>();

export function linterManifest(linter: LoadedLinter): AdapterManifest {
  const hit = cache.get(linter);
  if (hit) return hit;
  const d = linter.descriptor;
  const en = d.text.en;
  const exitCodes = [
    ...d.run.exit.clean.map((code) => ({ code, meaning: d.run.exit.findings.includes(code) ? "clean or findings: the report decides" : "no finding" })),
    ...d.run.exit.findings.filter((code) => !d.run.exit.clean.includes(code)).map((code) => ({ code, meaning: "findings" })),
  ];
  const base = lintManifest({
    id: d.id,
    displayName: en.label,
    toolName: d.program.tool,
    toolVersionRange: d.program.versionRange,
    configDiscovery: d.configuration.files.length > 0 ? `${d.configuration.files.join(", ")} at the workspace root` : "no configuration file of the project",
    configPrecedence: d.configuration.default === "tool" ? "the project's configuration when it has one, otherwise the tool's own defaults" : `the project's configuration when it has one, otherwise JGates' default (${d.configuration.default})`,
    exitCodes,
    executesProjectCode: d.run.executesProjectCode,
    redirectionFlags: [],
    redirectionEnv: Object.keys(d.run.env ?? {}),
    ...(d.run.workspaceWrites ? { unavoidableWorkspaceWrites: d.run.workspaceWrites } : {}),
    relativeCost: d.run.mode === "each-file" ? "medium" : "low",
    license: d.license,
    limitations: [en.limitation],
    stackSupport: [{ capability: d.place.capability, stack: "any", state: "validated", prerequisites: [en.needs], limitations: [en.purpose] }],
    sourceUrl: d.sourceUrl,
    acquisition: [d.sourceUrl],
    setup: [d.sourceUrl],
    capability: d.place.capability,
    category: linterCategory(d),
    usesNetwork: d.run.network,
    ...(d.run.resources ? { resources: d.run.resources } : {}),
    granularity: ["workspace"],
  });
  const manifest: AdapterManifest = { ...base, effects: { ...base.effects, onlyReadsProject: d.run.readOnly && !d.run.executesProjectCode && (d.run.workspaceWrites ?? []).length === 0 } };
  cache.set(linter, manifest);
  return manifest;
}
