import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * Generic command: for stacks without an adapter. One explicit executable with args (no shell string), declared
 * effects and an evidence contract. The result is a boolean check by exit code; the category it may cover depends on
 * the contract.
 */
export const genericCommandManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "generic-command",
  displayName: "Generic command",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "generic-command",
  toolVersionRange: "",
  runtimes: ["native"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["custom"],
  capabilities: [],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "yaml",
      discovery: "the command, args and config block of the instance in .jgates/tools.yml or in a template (see generic-evidence.schema.json)",
      precedence: "nothing is searched for: only what the instance declares",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [{ code: 0, meaning: "success (the instance may declare other success codes)" }],
    reportRequired: false,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    executesProjectCode: true,
    usesNetwork: false,
    needsService: false,
    usesAi: false,
    needsLicense: false,
  },
  redirection: { flags: [], env: [], unavoidableWorkspaceWrites: [] },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "medium",
  origin: "builtin",
  license: "MIT",
  kind: "tool",
};
