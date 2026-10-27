import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * Gitleaks as its own adapter (it leaves the bridge's gitleaks subcheck): the project's .gitleaks.toml and its ignore
 * file are two documents of the instance, each bound in tools.yml (config, configFiles.ignore) or found where Gitleaks
 * itself looks (the scan root). The scan of the directory (capability secrets) and the scan of the Git history
 * (capability secrets-history) are different capabilities: one instance runs one of them, with its real scope in
 * the plan. --redact=100 is part of the command and no document can turn it off. Runs on the container runner only.
 */
export const gitleaksManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "gitleaks",
  displayName: "Gitleaks",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "gitleaks",
  // The JSON report of the dir and git commands (8.19 onwards); the fixtures are of the pinned 8.30.1.
  toolVersionRange: ">=8.19.0 <9.0.0",
  runtimes: ["container"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64"],
  categories: ["security"],
  capabilities: ["secrets", "secrets-history"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "toml",
      discovery: "tools.yml config of the instance, otherwise .gitleaks.toml in the scan root (where Gitleaks looks itself)",
      precedence: "the bound file over the native one; without either, the default rules of the Gitleaks version",
    },
    {
      format: "text",
      discovery: "tools.yml configFiles.ignore of the instance, otherwise .gitleaksignore in the scan root",
      precedence: "a separate document: fingerprints the scanner skips (a scanner exception, not a waiver of the gate)",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "no leak found" },
      { code: 3, meaning: "leaks found (--exit-code 3, so that 1 stays an error)" },
      { code: 1, meaning: "error" },
    ],
    reportRequired: true,
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
  },
  redirection: { flags: ["--report-path", "--redact=100", "--no-banner"], env: ["HOME", "TMPDIR"], unavoidableWorkspaceWrites: [] },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "low",
  origin: "builtin",
  license: "MIT",
  kind: "tool",
  limitations: [
    "runs only on the container runner, in the image `jgates tools prepare` pins in .jgates/lock.json (the sidecar image by default)",
    "the project's ignore file and gitleaks:allow comments are scanner exceptions, not waivers of the gate",
  ],
};
