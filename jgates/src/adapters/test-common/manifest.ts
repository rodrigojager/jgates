import type { AdapterManifest, OutputPath, StackSupport } from "../../core/catalog/index.js";

export interface TestManifestInput {
  id: string;
  displayName: string;
  toolName: string;
  toolVersionRange: string;
  languages: string[];
  configDiscovery: string;
  configPrecedence: string;
  exitCodes: Array<{ code: number; meaning: string }>;
  redirectionFlags: string[];
  redirectionEnv: string[];
  outputPaths?: OutputPath[];
  unavoidableWorkspaceWrites?: string[];
  license: string;
  limitations: string[];
  stackSupport: StackSupport[];
  sourceUrl: string;
  acquisition: string[];
  setup: string[];
  mode: "customer-supplied";
}

/** The manifest of a stack test runner: unit, coverage, integration and properties; it executes the project's tests. */
export function testManifest(input: TestManifestInput): AdapterManifest {
  return {
    schemaVersion: 1,
    id: input.id,
    displayName: input.displayName,
    adapterVersion: "0.1.0",
    apiRange: ">=0.3.0 <1.0.0",
    toolName: input.toolName,
    toolVersionRange: input.toolVersionRange,
    runtimes: ["native", "container"],
    platforms: ["linux", "darwin", "win32"],
    cpuArchitectures: ["x64", "arm64"],
    categories: ["tests"],
    capabilities: ["unit", "coverage", "integration", "properties"],
    languages: input.languages,
    granularity: ["workspace", "component"],
    minimumContext: ["workspace"],
    configFiles: [{ format: "other", discovery: input.configDiscovery, precedence: input.configPrecedence }],
    editing: { implemented: ["text"], tested: [] },
    exitCodes: { codes: input.exitCodes, reportRequired: true },
    effects: {
      readsCode: true,
      writesOutputs: true,
      mayChangeCode: false,
      // The tests are the project's code: never cacheable.
      executesProjectCode: true,
      usesNetwork: false,
      needsService: false,
      usesAi: false,
      needsLicense: false,
    },
    redirection: {
      flags: input.redirectionFlags,
      env: input.redirectionEnv,
      ...(input.outputPaths ? { outputPaths: input.outputPaths } : {}),
      unavoidableWorkspaceWrites: input.unavoidableWorkspaceWrites ?? [],
    },
    toggles: { togglable: [], perRunByFlag: false },
    relativeCost: "high",
    origin: "builtin",
    license: input.license,
    kind: "tool",
    limitations: input.limitations,
    stackSupport: input.stackSupport,
    distribution: { mode: input.mode, sourceUrl: input.sourceUrl, spdx: input.license, acquisition: input.acquisition, setup: input.setup },
  };
}
