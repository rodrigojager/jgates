import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * Vitest: an editable configuration file (text and the static subset, parsed, never loaded) and the
 * run itself: `vitest run` with the JSON reporter and, when selected, the v8 coverage provider pinned to Vitest's
 * version. Every output goes to the run folder; the provider is never installed by a run.
 */
export const vitestManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "vitest",
  displayName: "Vitest",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "vitest",
  toolVersionRange: ">=1.0.0",
  runtimes: ["node"],
  platforms: ["linux", "win32", "darwin"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["tests"],
  capabilities: ["unit", "coverage"],
  languages: ["javascript", "typescript"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "javascript",
      discovery: "vitest.config.ts/.mts/.cts/.js/.mjs/.cjs, else vite.config.* with a test block (native resolution); a tools.yml binding overrides it",
      precedence: "vitest.config.* over vite.config.* in the same directory",
    },
  ],
  editing: { implemented: ["text", "partial"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "all tests passed" },
      { code: 1, meaning: "test failures or coverage thresholds not met" },
    ],
    reportRequired: true,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    // Running Vitest loads the config and executes the project's tests (and its setup files): never cacheable.
    executesProjectCode: true,
    usesNetwork: false,
    needsService: false,
    usesAi: false,
    needsLicense: false,
  },
  redirection: {
    flags: ["--outputFile", "--no-cache", "--no-fsModuleCache", "--coverage.reportsDirectory"],
    // Vite bundles a TypeScript config into node_modules/.vite-temp before loading it; node_modules is not part of the analyzed inputs.
    unavoidableWorkspaceWrites: ["node_modules/.vite-temp"],
  },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "medium",
  origin: "builtin",
  license: "MIT",
  kind: "tool",
  limitations: [
    "Only the v8 coverage provider is supported, and it must be installed at Vitest's exact version: a run never installs it.",
    "Line coverage counts the files the report includes (the project's coverage.include decides whether untested files are in the denominator).",
    "The tests and the project's configuration and setup files execute project code.",
    "Visual editing covers static literals; imports, mergeConfig, functions and conditionals keep the file in text mode.",
  ],
};
