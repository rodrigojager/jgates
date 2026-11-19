import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * Checkov as its own adapter (it leaves the bridge's checkov subcheck): `checkov --directory` over the scan root with
 * the project's .checkov.yaml (bound in tools.yml or found where Checkov looks itself), offline (--skip-download: no
 * Prisma Cloud data, so no severities: every failed check is reported as MEDIUM). Runs on the container runner only.
 */
export const checkovManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "checkov",
  displayName: "Checkov",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "checkov",
  // The JSON of Checkov 3 (one document per framework, or the empty summary); the fixtures are of the pinned 3.3.8.
  toolVersionRange: ">=3.0.0 <4.0.0",
  runtimes: ["container"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64"],
  categories: ["infrastructure"],
  capabilities: ["iac"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "yaml",
      discovery: "tools.yml config of the instance, otherwise .checkov.yaml or .checkov.yml in the scan root (Checkov's own lookup)",
      precedence: "command-line flags of the plan (output, directory, --skip-download) over the file",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "no failed check" },
      { code: 1, meaning: "failed checks (or an error: only a valid report makes it a result)" },
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
    // Reads the synchronized copy of the project only: its step may run beside others (ADR-0023).
    onlyReadsProject: true,
  },
  redirection: { flags: ["--output-file-path", "--skip-download"], env: ["HOME", "TMPDIR"], unavoidableWorkspaceWrites: [] },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "medium",
  origin: "builtin",
  license: "Apache-2.0",
  kind: "tool",
  limitations: [
    "runs only in a step container of the JGates tools image, never as a process of the host",
    "offline (--skip-download): no severities from Prisma Cloud, every failed check is MEDIUM",
    "skip comments in the code (checkov:skip) are scanner exceptions, not waivers of the gate",
  ],
  stackSupport: [
    { capability: "iac", stack: "any", state: "validated", prerequisites: ["Docker", "the JGates tools image (jgates setup)"] },
  ],
  distribution: {
    mode: "prepared-from-authorized-source",
    sourceUrl: "https://github.com/bridgecrewio/checkov",
    spdx: "Apache-2.0",
    acquisition: ["https://www.checkov.io/2.Basics/Installing%20Checkov.html"],
    setup: ["https://www.checkov.io/2.Basics/CLI%20Command%20Reference.html"],
  },
};
