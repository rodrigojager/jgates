import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * The project's own compiler or type checker as one adapter with one tool instance per checker: tsc (TypeScript,
 * `tsc --noEmit -p tsconfig.json`), mypy and pyright (Python, only where the project configures them), go (`go build`
 * then `go vet`), cargo (`cargo check`) and dotnet (`dotnet build`). An instance checks every discovered unit
 * (component) of its stack that carries the evidence, and normalizes the diagnostics into located findings.
 * The toolchains are the customer's: JGates finds them (the project's node_modules/.bin and virtual environments, then
 * PATH), checks them (`jgates doctor`) and never installs one during a run.
 */
export const buildCheckManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "build-check",
  displayName: "Build and type check (tsc, mypy, pyright, go, cargo, dotnet)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "compiler",
  // Each checker has its own floor (MINIMUM in units.ts, stackSupport.toolVersions); the manifest range is the common lower bound.
  toolVersionRange: ">=1.0.0",
  runtimes: ["native"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["quality"],
  capabilities: ["typecheck"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "json",
      discovery: "the project's own configuration of each checker: tsconfig.json (tsc), mypy.ini / [tool.mypy] / [mypy] (mypy), pyrightconfig.json / [tool.pyright] (pyright), go.mod, Cargo.toml, the .csproj; the settings checker and tsconfig live in the instance of .jgates/tools.yml",
      precedence: "the configuration of the project decides what is checked; JGates passes no rule of its own",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "the checker finished without errors" },
      { code: 1, meaning: "diagnostics reported (tsc, mypy, pyright, go build/vet, dotnet build); an exit code without a parsed diagnostic is an error, never a pass" },
      { code: 2, meaning: "tsc: diagnostics reported; mypy and pyright: crash or bad configuration" },
      { code: 101, meaning: "cargo check: compilation errors" },
    ],
    reportRequired: true,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    // cargo (build scripts, proc macros), dotnet (analyzers, MSBuild targets) and mypy (plugins) run project code.
    executesProjectCode: true,
    usesNetwork: false,
    needsService: false,
    usesAi: false,
    needsLicense: false,
  },
  redirection: {
    flags: ["--cache-dir", "--message-format"],
    env: ["CARGO_TARGET_DIR", "NO_COLOR"],
    outputPaths: [
      { path: "cache/build-check/mypy", purpose: "cache", env: [] },
      { path: "cache/build-check/cargo-target", purpose: "cache", env: ["CARGO_TARGET_DIR"] },
    ],
    // dotnet build writes bin/ and obj/ next to the project; go build ./... discards its output.
    unavoidableWorkspaceWrites: ["bin", "obj", "Cargo.lock"],
  },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "medium",
  origin: "builtin",
  license: "Apache-2.0",
  kind: "tool",
  limitations: [
    "runs the project's own checker with the project's own configuration: a stack without that configuration (a TypeScript component without tsconfig.json, a Python component without a mypy or pyright configuration) is not checked and is reported as such, never as passed",
    "cargo check and dotnet build run project code (build scripts, proc macros, analyzers); mypy may load plugins named in its configuration",
    "dotnet build writes bin/ and obj/ in the project folder; cargo check may write Cargo.lock",
    "JavaScript without a tsconfig.json, F# and Visual Basic have no fixture here and are not claimed",
  ],
  stackSupport: [
    {
      capability: "typecheck",
      stack: "typescript",
      state: "validated",
      toolVersions: "tsc >=4.5",
      prerequisites: ["TypeScript (tsc) 4.5+ in the project's node_modules or on PATH", "a tsconfig.json in the component"],
      limitations: ["tsc --noEmit -p tsconfig.json; project references (tsc -b) are not built"],
    },
    {
      capability: "typecheck",
      stack: "python",
      state: "validated",
      toolVersions: "mypy >=1.0 or pyright >=1.1.300",
      prerequisites: ["mypy 1.0+ or pyright 1.1.300+ in the project's virtual environment or on PATH", "a mypy or pyright configuration in the component (mypy.ini, [tool.mypy], pyrightconfig.json, [tool.pyright])"],
      limitations: ["a Python component without a configured checker is not checked"],
    },
    {
      capability: "typecheck",
      stack: "go",
      state: "validated",
      toolVersions: "go >=1.18",
      prerequisites: ["the Go toolchain 1.18+ on PATH", "a go.mod in the component (dependencies already in the module cache: the run uses no network)"],
      limitations: ["go build ./... then go vet ./... (vet runs only when the build is clean)"],
    },
    {
      capability: "typecheck",
      stack: "rust",
      state: "validated",
      toolVersions: "cargo >=1.60",
      prerequisites: ["cargo and rustc 1.60+ on PATH", "a Cargo.toml in the component (dependencies already fetched: the run is offline)"],
      limitations: ["cargo check --offline for the default targets; warnings are reported as non-blocking findings"],
    },
    {
      capability: "typecheck",
      stack: "csharp",
      state: "validated",
      toolVersions: "dotnet >=6.0",
      prerequisites: ["the .NET SDK 6+ on PATH", "a .csproj in the component (packages already restored or in the offline cache)"],
      limitations: ["dotnet build of the component's project file; solutions are not built as a whole"],
    },
    {
      capability: "typecheck",
      stack: "javascript",
      state: "unsupported",
      limitations: ["no fixture proves checkJs projects; a JavaScript component is not type checked"],
    },
    {
      capability: "typecheck",
      stack: "fsharp",
      state: "unsupported",
      limitations: ["dotnet build is proven on C# only; F# projects have no fixture"],
    },
    {
      capability: "typecheck",
      stack: "visualbasic",
      state: "unsupported",
      limitations: ["dotnet build is proven on C# only; Visual Basic projects have no fixture"],
    },
  ],
  distribution: {
    mode: "customer-supplied",
    sourceUrl: "https://github.com/microsoft/TypeScript",
    spdx: "Apache-2.0",
    acquisition: [
      "https://www.typescriptlang.org/download",
      "https://mypy.readthedocs.io/en/stable/getting_started.html",
      "https://microsoft.github.io/pyright/#/installation",
      "https://go.dev/doc/install",
      "https://www.rust-lang.org/tools/install",
      "https://dotnet.microsoft.com/download",
    ],
    setup: [
      "https://www.typescriptlang.org/tsconfig",
      "https://mypy.readthedocs.io/en/stable/config_file.html",
      "https://microsoft.github.io/pyright/#/configuration",
    ],
  },
};
