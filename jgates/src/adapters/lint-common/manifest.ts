import type { AdapterManifest, OutputPath, StackSupport } from "../../core/catalog/index.js";

export interface LintManifestInput {
  id: string;
  displayName: string;
  toolName: string;
  toolVersionRange: string;
  /** What the adapter reads, in prose (the manifest's discovery text). */
  configDiscovery: string;
  configPrecedence: string;
  exitCodes: Array<{ code: number; meaning: string }>;
  executesProjectCode: boolean;
  redirectionFlags: string[];
  redirectionEnv: string[];
  outputPaths?: OutputPath[];
  unavoidableWorkspaceWrites?: string[];
  relativeCost: "low" | "medium" | "high";
  license: string;
  limitations: string[];
  stackSupport: StackSupport[];
  sourceUrl: string;
  acquisition: string[];
  setup: string[];
  /** The capability (default lint) and its catalogue category (default quality): the linter engine's tools give theirs. */
  capability?: string;
  category?: string;
  /** The tool needs the network (default false). */
  usesNetwork?: boolean;
  /** Step container resources when the defaults do not fit. */
  resources?: AdapterManifest["resources"];
  /** The default is workspace and component; the linter engine's tools check the workspace. */
  granularity?: AdapterManifest["granularity"];
}

/** The manifest of a stack lint adapter: capability lint (or the one given), one tool of the JGates tools image, read-only. */
export function lintManifest(input: LintManifestInput): AdapterManifest {
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
    categories: [input.category ?? "quality"],
    capabilities: [input.capability ?? "lint"],
    granularity: input.granularity ?? ["workspace", "component"],
    minimumContext: ["workspace"],
    configFiles: [{ format: "other", discovery: input.configDiscovery, precedence: input.configPrecedence }],
    editing: { implemented: ["text"], tested: [] },
    exitCodes: { codes: input.exitCodes, reportRequired: true },
    effects: {
      readsCode: true,
      writesOutputs: true,
      mayChangeCode: false,
      executesProjectCode: input.executesProjectCode,
      usesNetwork: input.usesNetwork === true,
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
    ...(input.resources ? { resources: input.resources } : {}),
    relativeCost: input.relativeCost,
    origin: "builtin",
    license: input.license,
    kind: "tool",
    limitations: input.limitations,
    stackSupport: input.stackSupport,
    distribution: {
      mode: "customer-supplied",
      sourceUrl: input.sourceUrl,
      spdx: input.license,
      acquisition: input.acquisition,
      setup: input.setup,
    },
  };
}
