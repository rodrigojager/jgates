import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * Format check as one adapter with one tool instance per formatter: `ruff format --check` (Python), `prettier --check`
 * (TypeScript and JavaScript), `gofmt -l` (Go), `cargo fmt --check` (Rust) and `dotnet format whitespace
 * --verify-no-changes` (.NET). An instance checks the whole component and lists the files the formatter would change;
 * nothing is rewritten (the formatters run in their check mode only). The formatter and its configuration are the
 * project's: ruff.toml / [tool.ruff], .prettierrc and .prettierignore, rustfmt.toml, .editorconfig.
 * The formatters are tools of the JGates tools image.
 */
export const formatCheckManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "format-check",
  displayName: "Format check (ruff, prettier, gofmt, rustfmt, dotnet format)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "formatter",
  // Each formatter has its own version line (ruff 0.x, prettier 3.x, Go 1.x, rustfmt 1.x, .NET SDK 6+); this is their
  // common lower bound, and the image's versions are all above it (ruff's concise output format starts at 0.9).
  toolVersionRange: ">=0.9.0",
  runtimes: ["native", "container"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["quality"],
  capabilities: ["format-check"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "other",
      discovery: "the project's own configuration of each formatter: ruff.toml, .ruff.toml or [tool.ruff] (ruff), .prettierrc* and .prettierignore (prettier), rustfmt.toml (rustfmt), .editorconfig (dotnet format); gofmt has none. The formatter setting lives in the instance of .jgates/tools.yml",
      precedence: "the configuration of the project decides how the code is formatted; JGates passes no style option of its own",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "every file is formatted (gofmt: also when it lists files, which are read from its output)" },
      { code: 1, meaning: "files would be reformatted (ruff, prettier, cargo fmt)" },
      { code: 2, meaning: "files would be reformatted (dotnet format) or the formatter failed (ruff, prettier, gofmt)" },
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
  redirection: { flags: ["--check", "--no-cache", "--output-format"], env: [], unavoidableWorkspaceWrites: [] },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "low",
  origin: "builtin",
  license: "MIT",
  kind: "tool",
  limitations: [
    "check mode only: no file is rewritten; the fix is the formatter's own write mode, run by the user",
    "the file list and the first location come from the formatter's text output; a run whose output or exit code the adapter cannot explain is an error, never a pass",
    "dotnet format runs in whitespace mode with --folder: style and analyzer rules need a build and are not part of this check",
    "cargo fmt formats the crate of the component; a component without Cargo.toml is not checked",
  ],
  stackSupport: [
    { capability: "format-check", stack: "python", state: "validated", prerequisites: ["ruff in the JGates tools image"], limitations: ["ruff format --check with the project's [tool.ruff] settings"] },
    { capability: "format-check", stack: "typescript", state: "validated", prerequisites: ["prettier in the JGates tools image"], limitations: ["prettier --check; .prettierignore and .gitignore decide which files count"] },
    { capability: "format-check", stack: "go", state: "validated", prerequisites: ["gofmt (the Go toolchain) in the JGates tools image"], limitations: ["gofmt -l lists the files whose formatting differs; gofmt has no options of its own"] },
    { capability: "format-check", stack: "rust", state: "validated", prerequisites: ["cargo with rustfmt in the JGates tools image", "a Cargo.toml in the component"], limitations: ["cargo fmt --check with the project's rustfmt.toml"] },
    { capability: "format-check", stack: "csharp", state: "validated", prerequisites: ["the .NET SDK (dotnet format) in the JGates tools image"], limitations: ["whitespace rules only (dotnet format whitespace), from the project's .editorconfig"] },
  ],
  distribution: {
    mode: "customer-supplied",
    sourceUrl: "https://github.com/astral-sh/ruff",
    spdx: "MIT",
    acquisition: ["https://docs.astral.sh/ruff/formatter/", "https://prettier.io/docs/en/cli.html", "https://pkg.go.dev/cmd/gofmt", "https://github.com/rust-lang/rustfmt", "https://learn.microsoft.com/dotnet/core/tools/dotnet-format"],
    setup: ["https://docs.astral.sh/ruff/configuration/", "https://prettier.io/docs/en/configuration.html", "https://rust-lang.github.io/rustfmt/", "https://learn.microsoft.com/dotnet/fundamentals/code-analysis/code-style-rule-options"],
  },
};
