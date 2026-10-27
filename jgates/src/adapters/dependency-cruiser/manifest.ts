import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * dependency-cruiser as the extractor of the dependency graph of JavaScript and TypeScript components. It does not
 * judge: it produces the normalized graph (nodes, edges, unresolved imports, coverage) and the architecture evaluator
 * applies the contract of .jgates/architecture.yml to it. The executable is the one of the project or of JGates
 * itself, never `npx` (nothing is downloaded during a run).
 */
export const dependencyCruiserManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "dependency-cruiser",
  displayName: "dependency-cruiser (TS/JS architecture)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "dependency-cruiser",
  toolVersionRange: ">=16.0.0",
  runtimes: ["node"],
  platforms: ["linux", "win32", "darwin"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["architecture"],
  capabilities: ["architecture"],
  languages: ["javascript", "typescript"],
  granularity: ["workspace"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "javascript",
      discovery: "generated in the run folder from .jgates/architecture.yml; the config binding of the instance in .jgates/tools.yml imports the user's own .dependency-cruiser.cjs, .js or .json instead",
      precedence: "the binding when present, otherwise the generated file; a configuration found in the project is never picked up on its own",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "graph written (no rule is evaluated by the tool itself)" },
      { code: 1, meaning: "error reading the configuration or the sources" },
    ],
    reportRequired: true,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    // The generated configuration is data; the user's own configuration (binding) is JavaScript the tool loads, and the plan says so.
    executesProjectCode: false,
    usesNetwork: false,
    needsService: false,
    usesAi: false,
    needsLicense: false,
  },
  redirection: { flags: ["--output-to", "--config"], unavoidableWorkspaceWrites: [] },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "low",
  origin: "builtin",
  license: "MIT",
  kind: "tool",
  limitations: [
    "Reads the dependency graph only: the contract of .jgates/architecture.yml is evaluated by JGates on the normalized graph.",
    "An import the tool cannot resolve (an alias without a matching tsconfig path, a package that is not installed) is a gap of coverage, not a pass.",
  ],
};
