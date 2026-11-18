import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * zizmor as its own adapter: the static analysis of GitHub Actions workflows (template injection, excessive
 * permissions, unpinned actions, credential persistence...). One `zizmor --format json-v1 .` per tool instance, offline
 * by default, with the JSON on stdout. zizmor is MIT and comes from the JGates tools image (installed there from PyPI);
 * JGates never installs it on the host or during a run.
 * Settings of the instance in tools.yml: persona (regular, pedantic, auditor), minSeverity and offline.
 */
export const zizmorManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "zizmor",
  displayName: "zizmor (GitHub Actions security)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "zizmor",
  // The json-v1 format; the fixtures are of the pinned 1.32.0.
  toolVersionRange: ">=1.32.0 <2.0.0",
  runtimes: ["native"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["infrastructure"],
  capabilities: ["ci-cd"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "yaml",
      discovery: "zizmor.yml or .github/zizmor.yml in the scan root (zizmor's own lookup); the settings persona, minSeverity and offline live in the instance of .jgates/tools.yml",
      precedence: "command-line flags of the plan (format, persona, min-severity, offline) over the file",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "audit finished (findings are in the JSON output; --no-exit-codes keeps the finding severity out of the code)" },
      { code: 1, meaning: "error" },
      { code: 3, meaning: "no input could be collected (no workflow parsed)" },
    ],
    reportRequired: true,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    executesProjectCode: false,
    // The default is --offline; the setting offline: false turns on the audits that ask the GitHub API (needs a token).
    usesNetwork: false,
    needsService: false,
    usesAi: false,
    needsLicense: false,
    // Reads the synchronized copy of the project only: its step may run beside others (ADR-0023).
    onlyReadsProject: true,
  },
  redirection: {
    flags: ["--format", "--no-exit-codes", "--no-progress", "--cache-dir", "--offline"],
    env: ["HOME", "USERPROFILE", "NO_COLOR"],
    outputPaths: [
      { path: "cache/zizmor/home", purpose: "home", env: ["HOME", "USERPROFILE"] },
      { path: "cache/zizmor/cache", purpose: "cache" },
    ],
    unavoidableWorkspaceWrites: [],
  },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "low",
  origin: "builtin",
  license: "MIT",
  kind: "tool",
  limitations: [
    "reads workflows and actions (.github/workflows, action.yml); it does not run them and knows nothing about the other CI systems",
    "offline by default: the audits that need the GitHub API (impostor commits, known vulnerable actions) run only with offline: false and a GITHUB_TOKEN",
    "ignore comments (zizmor: ignore[rule]) and the zizmor.yml ignore rules are scanner exceptions, not waivers of the gate",
  ],
  stackSupport: [
    {
      capability: "ci-cd",
      stack: "any",
      state: "validated",
      prerequisites: ["zizmor 1.32+ (in the JGates tools image)", "GitHub Actions workflows in .github/workflows"],
      limitations: ["GitHub Actions only"],
    },
  ],
  distribution: {
    mode: "prepared-from-authorized-source",
    sourceUrl: "https://github.com/zizmorcore/zizmor",
    spdx: "MIT",
    acquisition: ["https://docs.zizmor.sh/installation/", "https://pypi.org/project/zizmor/"],
    setup: ["https://docs.zizmor.sh/configuration/", "https://docs.zizmor.sh/usage/"],
  },
};
