import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * Mutation testing as its own adapter: StrykerJS for JavaScript and TypeScript, mutmut for Python. The engine runs in
 * an isolated copy of the component inside the run folder (both engines write into their working folder), so nothing
 * is left in the workspace. It mutates the project's code and re-runs the project's tests, so it executes project
 * code and is never cached. Scope (`mutate`), the time bound (timeoutSeconds of the stage) and the minimum score are
 * settings of the instance in tools.yml. Stryker and mutmut are the project's own dev dependencies: a run never
 * installs them.
 */
export const mutationManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "mutation",
  displayName: "Mutation testing (Stryker, mutmut)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "stryker",
  // Stryker 8-10 (JSON report schema 1); the fixture ran with 10.1.1. mutmut 3.x is declared in limitations.
  toolVersionRange: ">=8.0.0 <11.0.0",
  runtimes: ["node", "python"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["tests"],
  capabilities: ["mutation"],
  languages: ["javascript", "typescript", "python"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "json",
      discovery: "stryker.config.json/.mjs/.js or stryker.conf.* in the component (Stryker's own lookup); [mutmut] in setup.cfg or [tool.mutmut] in pyproject.toml",
      precedence: "the flags of the plan (reporters, mutate, concurrency) over the file",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "the engine finished; the survivors are in its report" },
      { code: 1, meaning: "the tests fail before mutation, a threshold.break of the project configuration was not met, or an error" },
    ],
    reportRequired: true,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    // The engine mutates a copy and runs the project's tests (and configuration) over it: never cacheable.
    executesProjectCode: true,
    usesNetwork: false,
    needsService: false,
    usesAi: false,
    needsLicense: false,
  },
  redirection: {
    flags: ["--reporters", "--tempDirName", "--logLevel"],
    outputPaths: [{ path: "work/mutation", purpose: "output" }],
    // The engines run in a copy of the component under the run folder.
    unavoidableWorkspaceWrites: [],
  },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "high",
  origin: "builtin",
  license: "Apache-2.0",
  kind: "tool",
  limitations: [
    "Runs the engine in a copy of the component (node_modules is linked, not copied); a test setup that reads files outside the component folder does not see them.",
    "The score is detected / (detected + survived + not covered): mutants that did not compile, crashed or were ignored are outside it; equivalent mutants count as survivors.",
    "The stage time bound is the timeoutSeconds of the instance; a run that exceeds it is reported as a timeout with no score, never a partial score.",
    "mutmut 3 forks worker processes and does not run natively on Windows: the stage is blocked there with that reason (run it on Linux, macOS or WSL).",
    "The Stryker test runner (command, vitest, jest, mocha...) and its plugins come from the project's own Stryker configuration.",
  ],
  stackSupport: [
    {
      capability: "mutation",
      stack: "javascript",
      state: "validated",
      prerequisites: ["@stryker-mutator/core 8+ in the project (node_modules) with a Stryker configuration and a test runner plugin or the command runner"],
      toolVersions: ">=8.0.0 <11.0.0",
      limitations: ["Proven with the Stryker command runner over node:test; other runners use the same JSON report."],
    },
    {
      capability: "mutation",
      stack: "typescript",
      state: "customer-setup-required",
      prerequisites: ["@stryker-mutator/core 8+ with a test runner plugin (for example @stryker-mutator/vitest-runner)"],
      limitations: ["No JGates fixture runs Stryker over TypeScript yet; the JSON report and the adapter are the same as for JavaScript."],
    },
    {
      capability: "mutation",
      stack: "python",
      state: "validated",
      prerequisites: ["mutmut 3.x installed in the project's Python environment", "Linux, macOS or WSL (mutmut does not run natively on Windows)"],
      toolVersions: ">=3.0.0 <4.0.0",
      limitations: ["Proven on Linux in the quality-sidecar container; on Windows the stage is blocked with the reason."],
    },
  ],
  distribution: {
    mode: "customer-supplied",
    sourceUrl: "https://github.com/stryker-mutator/stryker-js",
    spdx: "Apache-2.0",
    acquisition: ["https://stryker-mutator.io/docs/stryker-js/getting-started/", "https://mutmut.readthedocs.io/en/latest/"],
    setup: ["https://stryker-mutator.io/docs/stryker-js/configuration/", "https://github.com/boxed/mutmut#readme"],
  },
};
