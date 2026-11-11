import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * Performance budgets: the project's own language-native benchmarks, run in the step container of the tools image, and
 * their mean times compared with the budgets of the instance (tools.<id>.budgets: benchmark name or `*` pattern ->
 * maximum mean in milliseconds) and with a stored baseline file (tools.<id>.baseline, allowed regression
 * tools.<id>.maxRegressionPercent, default 20). pytest-benchmark (Python), vitest bench (TypeScript/JavaScript),
 * go test -bench (Go), criterion (Rust) and BenchmarkDotNet (.NET). Every run also writes a baseline candidate with the
 * means it measured into the run folder.
 */
export const performanceManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "performance",
  displayName: "Performance budgets (pytest-benchmark, vitest bench, go test -bench, criterion, BenchmarkDotNet)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "benchmark",
  toolVersionRange: ">=0.0.0",
  runtimes: ["native", "container"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["quality"],
  capabilities: ["performance"],
  languages: ["python", "typescript", "javascript", "go", "rust", "csharp"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "json",
      discovery: "the baseline file of tools.<id>.baseline (a JSON object: benchmark name -> mean in milliseconds); the harness's own configuration (pytest, vitest, Cargo.toml [[bench]], the BenchmarkDotNet project)",
      precedence: "the budgets of tools.yml and the baseline file; the plan's flags select the harness's machine-readable output",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "the benchmarks ran; the budgets are judged from the report" },
      { code: 1, meaning: "a benchmark or the build failed" },
    ],
    reportRequired: true,
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
  redirection: {
    flags: ["--benchmark-json", "--outputJson", "--output-format", "--exporters", "--artifacts"],
    env: [],
    outputPaths: [{ path: "outputs/performance", purpose: "output" }],
    unavoidableWorkspaceWrites: ["bin", "obj"],
  },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "high",
  origin: "builtin",
  license: "MIT",
  kind: "tool",
  limitations: [
    "the times depend on the machine and on the step container's CPU limit: budgets need a margin, and a baseline is only comparable on the same kind of machine",
    "needs budgets (tools.<id>.budgets) or a baseline file (tools.<id>.baseline); a budget whose benchmark did not run is a finding, never a pass",
    "the benchmarks execute (the project's code): the result is self-reported and never cached",
  ],
  stackSupport: [
    { capability: "performance", stack: "python", state: "validated", toolVersions: "pytest-benchmark 4+ (fixture ran 5.3.1)", prerequisites: ["pytest-benchmark in the dependencies of the component"], limitations: [] },
    { capability: "performance", stack: "typescript", state: "validated", toolVersions: "vitest 1+ bench (fixture ran 5.1.0)", prerequisites: ["*.bench.ts files (vitest bench); the project's vitest, else the tools image's"], limitations: [] },
    { capability: "performance", stack: "javascript", state: "validated", toolVersions: "vitest 1+ bench (fixture ran 5.1.0)", prerequisites: ["*.bench.js files (vitest bench)"], limitations: ["the TypeScript fixture proves the runner and the report"] },
    { capability: "performance", stack: "go", state: "validated", toolVersions: "go 1.20+ (the tools image's 1.27.3)", prerequisites: ["Benchmark functions in the _test.go files"], limitations: [] },
    { capability: "performance", stack: "rust", state: "validated", toolVersions: "criterion 0.5+ (fixture ran 0.7)", prerequisites: ["criterion in the dev-dependencies and [[bench]] targets with harness = false"], limitations: [] },
    { capability: "performance", stack: "csharp", state: "validated", toolVersions: "BenchmarkDotNet 0.13+ (fixture ran 0.15.8)", prerequisites: ["a console project referencing BenchmarkDotNet whose Main runs BenchmarkSwitcher with the command-line arguments"], limitations: ["runs in process (--inProcess) with the short job"] },
  ],
  distribution: {
    mode: "customer-supplied",
    sourceUrl: "https://github.com/ionelmc/pytest-benchmark",
    spdx: "BSD-2-Clause",
    acquisition: ["https://pytest-benchmark.readthedocs.io/", "https://vitest.dev/guide/features#benchmarking", "https://pkg.go.dev/testing#hdr-Benchmarks", "https://bheisler.github.io/criterion.rs/book/", "https://benchmarkdotnet.org/"],
    setup: ["https://pytest-benchmark.readthedocs.io/en/latest/usage.html", "https://benchmarkdotnet.org/articles/guides/console-args.html"],
  },
};
