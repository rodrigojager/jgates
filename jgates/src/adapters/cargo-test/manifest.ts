import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * cargo-test as its own adapter: the tests of a Rust crate and the proptest property tests among them. One
 * `cargo test --no-fail-fast --offline` per tool instance in the Rust component; the stable libtest text output
 * (`test path::name ... ok|FAILED|ignored` and the `---- name stdout ----` failure sections) is parsed, because the
 * JSON format of libtest is nightly-only. Property tests are told apart statically, by reading the .rs files (never
 * executing them): functions inside a `proptest! { ... }` block and `#[proptest]` attribute functions.
 *
 * cargo and rustc are supplied by the customer (rustup or a distribution package): JGates checks them
 * (`jgates doctor`) and says where to get them, but never installs a toolchain during a run. The tests, build scripts
 * and procedural macros of the project execute, so the result is self-reported and never cached. Build artifacts go
 * to a target folder in the run folder; the run is offline, so the dependencies (proptest among them) must already be
 * in the cargo home.
 */
export const cargoTestManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "cargo-test",
  displayName: "cargo test (Rust tests and proptest properties)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "cargo",
  toolVersionRange: ">=1.60.0",
  runtimes: ["native"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["tests"],
  capabilities: ["tests", "unit", "coverage", "integration", "properties"],
  languages: ["rust"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "toml",
      discovery: "Cargo.toml of the component and .cargo/config.toml (cargo's own lookup); proptest reads PROPTEST_* variables, and the run disables failure persistence",
      precedence: "cargo's own resolution; the command-line flags and variables of the plan win",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "all tests passed" },
      { code: 101, meaning: "test failures, or a compilation error (the plan tells them apart by the libtest summary lines: without one the stage is an error)" },
    ],
    reportRequired: true,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    // Running cargo test compiles and executes the project's tests, build scripts and procedural macros: never cacheable.
    executesProjectCode: true,
    usesNetwork: false,
    needsService: false,
    usesAi: false,
    needsLicense: false,
  },
  redirection: {
    flags: ["--offline", "--no-fail-fast", "--color", "--output-path"],
    env: ["CARGO_TARGET_DIR", "CARGO_TERM_COLOR", "NO_COLOR", "PROPTEST_DISABLE_FAILURE_PERSISTENCE"],
    outputPaths: [{ path: "cache/cargo-test/target", purpose: "cache", env: ["CARGO_TARGET_DIR"] }],
    // cargo writes Cargo.lock when the project has none; proptest-regressions/ is avoided with PROPTEST_DISABLE_FAILURE_PERSISTENCE.
    unavoidableWorkspaceWrites: ["Cargo.lock"],
  },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "high",
  origin: "builtin",
  license: "MIT OR Apache-2.0",
  kind: "tool",
  limitations: [
    "cargo and rustc are customer-supplied and never installed by a run; without cargo the stage is blocked with the way to get it, never passed",
    "the run is offline (cargo test --offline): the dependencies, proptest included, must already be in the cargo home",
    "the stable libtest text output is parsed (the JSON format needs a nightly toolchain); a run with no libtest summary line (a compilation error) is an error, never a pass",
    "property tests are detected statically: functions inside proptest! blocks and #[proptest] functions; a property written another way counts as an ordinary test",
    "the tests, build scripts and procedural macros of the project execute",
    "cargo may write Cargo.lock when the project has none",
  ],
  stackSupport: [
    {
      capability: "tests",
      stack: "rust",
      state: "validated",
      toolVersions: "cargo >=1.60",
      prerequisites: ["cargo and rustc 1.60+ on PATH (customer-supplied: https://www.rust-lang.org/tools/install)", "a Cargo.toml in the component, with the dependencies already fetched (the run is offline)"],
      limitations: ["libtest text output; doctests are counted as tests", "validated with the real cargo 1.99.1 on Windows"],
    },
    {
      capability: "unit",
      stack: "rust",
      state: "validated",
      toolVersions: "cargo >=1.60",
      prerequisites: ["a Cargo.toml in the component, with the dependencies already fetched (the run is offline)"],
      limitations: ["with integration tests in tests/, the unit run selects --lib --bins (and the other test targets), so doctests run only under the tests capability", "validated with the real cargo 1.99.1 of the tools image"],
    },
    {
      capability: "coverage",
      stack: "rust",
      state: "validated",
      toolVersions: "cargo >=1.60, cargo-llvm-cov 0.9",
      prerequisites: ["cargo-llvm-cov and the llvm-tools component (both in the JGates tools image)"],
      limitations: ["line coverage of the llvm-cov JSON summary; the tests run instrumented under cargo llvm-cov"],
    },
    {
      capability: "integration",
      stack: "rust",
      state: "validated",
      toolVersions: "cargo >=1.60",
      prerequisites: ["integration test targets in tests/ (or the targets of tools.<id>.selection.targets)"],
      limitations: ["services come from the compose section when the tests need them"],
    },
    {
      capability: "properties",
      stack: "rust",
      state: "validated",
      toolVersions: "cargo >=1.60, proptest 1.x",
      prerequisites: ["cargo and rustc 1.60+ on PATH", "proptest 1.x as a dependency of the crate, already fetched (the run is offline)"],
      limitations: ["static detection of proptest! blocks and #[proptest] functions; the minimal failing input comes from the proptest failure message", "validated with the real cargo 1.99.1 and proptest 1.x"],
    },
  ],
  distribution: {
    mode: "customer-supplied",
    sourceUrl: "https://github.com/rust-lang/cargo",
    spdx: "MIT OR Apache-2.0",
    acquisition: ["https://www.rust-lang.org/tools/install", "https://rustup.rs/"],
    setup: ["https://doc.rust-lang.org/cargo/commands/cargo-test.html", "https://proptest-rs.github.io/proptest/intro.html"],
  },
};
