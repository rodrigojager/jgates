import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * Supply-chain check as its own adapter (Dependencies domain, "supply-chain" subdimension: provenance and
 * package-execution signals that a CVE database does not give). It reads the npm and Python lockfiles of the workspace
 * in-process: install scripts, missing integrity hashes, registries that are not public or not pinned, git sources
 * without a pinned commit and deprecated packages. It is offline and runs nothing of the project; what needs the
 * network (the deprecation of a Python package) or a lockfile it cannot read is reported as `unknown`, never as clean.
 * Settings of the instance in tools.yml: blockOn, allowInstallScripts, trustedHosts and lockfiles.
 */
export const supplyChainManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "supply-chain",
  displayName: "Supply chain (lockfile provenance)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "jgates-supply-chain",
  toolVersionRange: "*",
  runtimes: ["native"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["dependencies"],
  capabilities: ["supply-chain"],
  granularity: ["workspace"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "yaml",
      discovery: "no tool file; the settings blockOn, allowInstallScripts, trustedHosts and lockfiles live in the instance of .jgates/tools.yml",
      precedence: "the instance settings over the defaults",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [{ code: 0, meaning: "in-process analysis finished (findings and unknowns are in the result)" }],
    reportRequired: false,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    executesProjectCode: false,
    usesNetwork: false,
    needsService: false,
    usesAi: false,
    needsLicense: false,
    // Reads the synchronized copy of the project only: its step may run beside others (ADR-0023).
    onlyReadsProject: true,
  },
  redirection: { flags: [], unavoidableWorkspaceWrites: [] },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "low",
  origin: "builtin",
  license: "MIT",
  kind: "tool",
  limitations: [
    "reads package-lock.json, npm-shrinkwrap.json, requirements.txt, poetry.lock and Pipfile.lock only; other ecosystems are not analyzed",
    "offline: the deprecation of a Python package and the age of a release need a registry and are reported as unknown, never as clean",
    "an unreadable lockfile or one that lists no packages is unknown, so the stage is not interpreted instead of passed",
  ],
  stackSupport: [
    {
      capability: "supply-chain",
      stack: "any",
      state: "validated",
      prerequisites: ["a package-lock.json, npm-shrinkwrap.json, poetry.lock or Pipfile.lock (requirements.txt through the lockfiles setting)"],
      limitations: ["npm and Python lockfiles only"],
    },
  ],
  distribution: {
    mode: "shipped",
    spdx: "MIT",
    notices: ["LICENSE"],
  },
};
