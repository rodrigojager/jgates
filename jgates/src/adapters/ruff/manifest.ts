import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * Ruff: Python linter. Runs as a local executable, or in a container (tools.yml `runner: container`), with the
 * configuration file the binding (or the native resolution) picks. Its cache goes to the run folder, never the project.
 */
export const ruffManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "ruff",
  displayName: "Ruff",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "ruff",
  toolVersionRange: ">=0.5.0",
  runtimes: ["native", "container"],
  platforms: ["linux", "win32", "darwin"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["quality"],
  capabilities: ["lint"],
  languages: ["python"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "toml",
      discovery: "ruff.toml, .ruff.toml or [tool.ruff] in pyproject.toml, nearest directory first (native resolution); a tools.yml binding overrides it",
      precedence: "ruff.toml over .ruff.toml over pyproject.toml in the same directory",
      ownedSelector: "tool.ruff",
    },
  ],
  // The Options tab edits [tool.ruff] through the form of src/adapters/ruff/form; the text editor stays.
  editing: { implemented: ["text", "structured-read", "structured-write"], tested: ["text", "structured-read", "structured-write"] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "no violations" },
      { code: 1, meaning: "violations found" },
      { code: 2, meaning: "abnormal termination" },
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
  redirection: {
    flags: ["--cache-dir", "--output-format"],
    env: ["RUFF_CACHE_DIR"],
    // Without it Ruff writes .ruff_cache in the project.
    outputPaths: [{ path: "cache/ruff", purpose: "cache", env: ["RUFF_CACHE_DIR"] }],
    unavoidableWorkspaceWrites: [],
  },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "low",
  origin: "builtin",
  license: "MIT",
  kind: "tool",
};
