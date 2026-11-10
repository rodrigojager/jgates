// golangci-lint adapter (Go lint): runs `golangci-lint run ./...` in the Go module of the component, in the step container
// of the tools image, and turns the JSON report into located, blocking findings. See ../lint-common for the shared plan
// and run; this file holds what is specific to the tool.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { makeLintAdapter, RUN_DIR, type LintSpec } from "../lint-common/index.js";
import { golangciLintManifest } from "./manifest.js";
import { parseGolangci } from "./normalize.js";

export { golangciLintManifest } from "./manifest.js";
export { parseGolangci } from "./normalize.js";

const CACHE = `${RUN_DIR}/cache/golangci-lint`;

export const golangciLintSpec: LintSpec = {
  manifest: golangciLintManifest,
  tool: "golangci-lint",
  imageTool: "golangci-lint",
  commandTool: "golangci-lint",
  overrideEnv: "JGATES_GOLANGCI_LINT",
  scope: "component",
  executesProjectCode: false,
  prepare(scanDir) {
    if (!fs.existsSync(path.join(scanDir, "go.mod"))) return { skip: translator("lint-stacks")("lint_no_file", { tool: "golangci-lint", file: "go.mod" }) };
    return {
      // The JSON report is the only output on stdout (the text report goes to the null device); the caches live in the run folder.
      args: ["run", "--output.json.path=stdout", "--output.text.path=/dev/null", "--show-stats=false", "--max-issues-per-linter=0", "--max-same-issues=0", "./..."],
      // The run never reaches the network or downloads a toolchain.
      env: { GOPROXY: "off", GOTOOLCHAIN: "local", GOTELEMETRY: "off", GOCACHE: `${CACHE}/go-build`, GOLANGCI_LINT_CACHE: `${CACHE}/lint`, NO_COLOR: "1" },
      configFiles: [".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"].filter((f) => fs.existsSync(path.join(scanDir, f))),
    };
  },
  parse: (stdout, _stderr, exitCode) => parseGolangci(stdout, exitCode),
};

export const golangciLintAdapter = makeLintAdapter(golangciLintSpec);
