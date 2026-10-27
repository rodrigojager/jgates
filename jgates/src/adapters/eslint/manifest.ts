import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * ESLint with the project's own flat config: an editable configuration file (text and partial, static subset editing;
 * the file is parsed, never executed to be opened), and a direct run in local mode:
 * loading the config and its plugins executes project code, which the plan declares. The ESLint inside the bridge's
 * MegaLinter is another path: it always runs with the trusted config and --no-inline-config.
 */
export const eslintManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "eslint",
  displayName: "ESLint",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "eslint",
  toolVersionRange: ">=9.0.0",
  runtimes: ["node"],
  platforms: ["linux", "win32", "darwin"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["quality"],
  capabilities: ["lint"],
  languages: ["javascript", "typescript"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "javascript",
      discovery: "eslint.config.js, .mjs, .cjs, .ts, .mts or .cts in the component directory (flat config); a tools.yml binding overrides it",
      precedence: "the first of eslint.config.js, .mjs, .cjs, .ts, .mts, .cts that exists",
    },
  ],
  editing: { implemented: ["text", "partial"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "no problems" },
      { code: 1, meaning: "lint errors found" },
      { code: 2, meaning: "configuration or internal error" },
    ],
    reportRequired: true,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    // Running ESLint loads the config and its plugins, which run during the lint.
    executesProjectCode: true,
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
  limitations: [
    "Executes project code: the eslint.config and its plugins run during the lint (the ESLint inside the bridge's MegaLinter keeps the trusted config and --no-inline-config).",
    "Needs ESLint installed in the project (or JGATES_ESLINT); a TypeScript project also needs its own parser in the config. Nothing is installed.",
    "Visual editing covers static literals; imports, spreads, functions, process.env and conditionals keep the file in text mode.",
  ],
};
