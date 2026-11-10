// Clippy adapter (Rust lint): runs `cargo clippy` in the crate of the component, in the step container of the tools image,
// and turns the JSON message stream into located, blocking findings. See ../lint-common for the shared plan and run.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { makeLintAdapter, RUN_DIR, type LintSpec } from "../lint-common/index.js";
import { clippyManifest } from "./manifest.js";
import { parseClippy } from "./normalize.js";

export { clippyManifest } from "./manifest.js";
export { parseClippy } from "./normalize.js";

export const clippySpec: LintSpec = {
  manifest: clippyManifest,
  tool: "clippy",
  imageTool: "clippy",
  commandTool: "cargo",
  prefix: ["clippy"],
  overrideEnv: "JGATES_CARGO",
  scope: "component",
  executesProjectCode: true,
  prepare(scanDir, componentRoot) {
    if (!fs.existsSync(path.join(scanDir, "Cargo.toml"))) return { skip: translator("lint-stacks")("lint_no_file", { tool: "clippy", file: "Cargo.toml" }) };
    return {
      args: ["--offline", "--message-format", "json", "--color", "never"],
      env: { CARGO_TARGET_DIR: `${RUN_DIR}/cache/clippy/target`, CARGO_TERM_COLOR: "never", NO_COLOR: "1" },
      // A missing Cargo.lock is generated next to the manifest (offline); the run declares it so it is not read as a change.
      workspaceWrites: [componentRoot ? `${componentRoot}/Cargo.lock` : "Cargo.lock"],
      configFiles: ["clippy.toml", ".clippy.toml"].filter((f) => fs.existsSync(path.join(scanDir, f))),
    };
  },
  parse: (stdout, _stderr, exitCode) => parseClippy(stdout, exitCode),
};

export const clippyAdapter = makeLintAdapter(clippySpec);
