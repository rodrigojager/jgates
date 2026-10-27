import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * Import Linter: architecture contracts for Python. The rules of .jgates/architecture.yml are translated into a
 * configuration generated in the run folder (owner "generated", read-only in the UI), or the native configuration the
 * user keeps (.importlinter, setup.cfg or pyproject.toml) runs as it is. The adapter also hands the normalized import
 * graph to the architecture evaluator, so an import the tool cannot resolve is a coverage gap, never silence.
 */
export const importLinterManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "import-linter",
  displayName: "Import Linter (Python architecture)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "import-linter",
  toolVersionRange: ">=2.15.0 <3.0.0",
  runtimes: ["native"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["architecture"],
  capabilities: ["architecture"],
  languages: ["python"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "ini",
      discovery: "the config binding of the instance in .jgates/tools.yml, else .importlinter, setup.cfg ([importlinter]) or pyproject.toml ([tool.importlinter]); without a native file the contracts come from .jgates/architecture.yml",
      precedence: "a native configuration runs as it is; otherwise the configuration generated in the run folder from architecture.yml",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "all contracts kept" },
      { code: 1, meaning: "a contract is broken, or the configuration is invalid" },
    ],
    reportRequired: true,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    // Import Linter builds its graph by reading the source (grimp parses it); it does not import the project's code.
    executesProjectCode: false,
    usesNetwork: false,
    needsService: false,
    usesAi: false,
    needsLicense: false,
  },
  redirection: {
    flags: ["--no-cache", "--config"],
    env: ["PYTHONDONTWRITEBYTECODE"],
    unavoidableWorkspaceWrites: [],
  },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "low",
  origin: "builtin",
  license: "BSD-2-Clause",
  kind: "tool",
};
