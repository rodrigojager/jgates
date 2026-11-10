import type { AdapterManifest } from "../../core/catalog/index.js";
import { lintManifest } from "../lint-common/manifest.js";

/**
 * Clippy as the Rust lint adapter: `cargo clippy --offline --message-format json` in the crate (or workspace) of the
 * component, with the project's clippy.toml / .clippy.toml and its `[lints]` tables and `#![warn]` attributes. The
 * diagnostics of the JSON stream are the findings; nothing is rewritten (no --fix). Clippy compiles the crate (build
 * scripts and procedural macros of the project run), so the build is redirected into the run folder.
 */
export const clippyManifest: AdapterManifest = lintManifest({
  id: "clippy",
  displayName: "Clippy (Rust lint)",
  toolName: "clippy",
  // The clippy that ships with the Rust toolchain reports its own 0.1.<minor> version.
  toolVersionRange: ">=0.1.70",
  configDiscovery: "clippy.toml or .clippy.toml in the crate, the [lints] tables of Cargo.toml and the lint attributes in the source",
  configPrecedence: "the configuration and the lint levels of the project decide what is reported; JGates adds only the JSON message format, --offline and the target folder in the run folder",
  exitCodes: [
    { code: 0, meaning: "the crate compiled (lints at warn level do not change the exit code)" },
    { code: 101, meaning: "the crate did not compile or a lint at deny level fired" },
  ],
  executesProjectCode: true,
  redirectionFlags: ["--message-format", "--offline", "--color"],
  redirectionEnv: ["CARGO_TARGET_DIR", "CARGO_TERM_COLOR", "NO_COLOR"],
  outputPaths: [{ path: "cache/clippy/target", purpose: "cache", env: ["CARGO_TARGET_DIR"] }],
  unavoidableWorkspaceWrites: ["Cargo.lock"],
  relativeCost: "medium",
  license: "MIT OR Apache-2.0",
  limitations: [
    "clippy compiles the crate: build scripts and procedural macros of the project run, so the result is self-reported",
    "the crate must compile and its dependencies must be in the cargo home of the dependency volume (the run is offline); a crate that does not compile is an error stage, never a pass",
    "the diagnostics come from the JSON message stream of cargo; a line or exit code the adapter cannot explain is an error, never a pass",
    "a component without a Cargo.toml is not checked",
  ],
  stackSupport: [
    {
      capability: "lint",
      stack: "rust",
      state: "validated",
      prerequisites: ["cargo with clippy in the JGates tools image", "a Cargo.toml in the component", "the crate's dependencies in the dependency volume"],
      limitations: ["cargo clippy with the project's clippy.toml and [lints] tables; every diagnostic of the compiler and of clippy is a finding"],
    },
  ],
  sourceUrl: "https://github.com/rust-lang/rust-clippy",
  acquisition: ["https://doc.rust-lang.org/clippy/installation.html"],
  setup: ["https://doc.rust-lang.org/clippy/configuration.html"],
});
