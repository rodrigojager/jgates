import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * Built-in PII detector of the quality sidecar, reached through the JSON bridge (PII-only request).
 * One rule per entity (CPF, CNPJ, credit-card and phone), each on or off alone through pii.yml or the pii:<entity>
 * selector; the matched value is never reported.
 */
export const builtinPiiManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "builtin-pii",
  displayName: "PII (built-in detector)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "quality-sidecar-pii",
  toolVersionRange: "*",
  runtimes: ["python"],
  platforms: ["linux", "win32", "darwin"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["security"],
  capabilities: ["pii"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "yaml",
      discovery: ".jgates/pii.yml",
      precedence: "pii.yml over the template defaults",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "answered (findings, when any, are in the response)" },
      { code: 3, meaning: "invalid request or operational error" },
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
  redirection: { flags: [], unavoidableWorkspaceWrites: [] },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "low",
  origin: "builtin",
  license: "MIT",
  kind: "tool",
};
