import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * cargo-audit as its own adapter: the RustSec advisories that affect the packages locked in Cargo.lock. One
 * `cargo-audit audit --json` per tool instance in the Rust workspace; the JSON is on stdout. cargo-audit is
 * MIT OR Apache-2.0, a single Rust binary that the customer supplies (`cargo install cargo-audit --locked` or a release
 * of the RustSec project): JGates checks it (`jgates doctor`) and says where to get it, but never downloads a tool
 * during a run. It reads Cargo.lock only (nothing is compiled or run) and fetches the RustSec advisory database
 * (github.com/RustSec/advisory-db) into the run folder, so it needs git network access.
 */
export const cargoAuditManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "cargo-audit",
  displayName: "cargo-audit (Rust advisories)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "cargo-audit",
  // The audit --json document (database, lockfile, settings, vulnerabilities, warnings); the fixtures are of the pinned 0.22.2.
  toolVersionRange: ">=0.20.0 <1.0.0",
  runtimes: ["native"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["dependencies"],
  capabilities: ["dependencies"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "toml",
      discovery: ".cargo/audit.toml in the scan root (cargo-audit's own lookup); its ignore list is a scanner exception",
      precedence: "command-line flags of the plan (json, db) over the file",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "audit finished and found no vulnerability" },
      { code: 1, meaning: "vulnerabilities found, or an error (the plan tells them apart by the JSON document: without a valid report the stage is an error)" },
    ],
    reportRequired: true,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    executesProjectCode: false,
    // The advisory database is fetched with git from github.com into the run folder.
    usesNetwork: true,
    needsService: false,
    usesAi: false,
    needsLicense: false,
  },
  redirection: {
    flags: ["--json", "--db", "--color"],
    env: ["NO_COLOR"],
    // The folder holds the advisory-db clone that cargo-audit creates itself (it must not exist yet).
    outputPaths: [{ path: "cache/cargo-audit", purpose: "cache" }],
    unavoidableWorkspaceWrites: [],
  },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "low",
  origin: "builtin",
  license: "MIT OR Apache-2.0",
  kind: "tool",
  limitations: [
    "reads Cargo.lock only: a project without a lock file has nothing to audit and the stage is blocked, never passed",
    "advisories are matched on package versions, not on the call graph: an advisory blocks even when the code never calls the affected function",
    "the RustSec advisory database is cloned on every run into the run folder (network needed); the ignore list of .cargo/audit.toml is a scanner exception, not a waiver of the gate",
    "unmaintained, unsound and yanked packages are reported as non-blocking findings",
  ],
  stackSupport: [
    {
      capability: "dependencies",
      stack: "rust",
      state: "validated",
      prerequisites: ["cargo-audit 0.20+ (customer-supplied: cargo install cargo-audit --locked)", "a Cargo.lock in the scan root", "network access to github.com for the RustSec advisory database"],
      limitations: ["package-version matching only; no reachability analysis", "validated with the real cargo-audit 0.22.2 on Windows; the tool itself is customer-setup-required on every machine (never shipped or installed by JGates)"],
    },
  ],
  distribution: {
    mode: "customer-supplied",
    sourceUrl: "https://github.com/rustsec/rustsec",
    spdx: "MIT OR Apache-2.0",
    acquisition: ["https://crates.io/crates/cargo-audit", "https://github.com/rustsec/rustsec/tree/main/cargo-audit#installation"],
    setup: ["https://github.com/rustsec/rustsec/tree/main/cargo-audit#usage", "https://rustsec.org/"],
  },
};
