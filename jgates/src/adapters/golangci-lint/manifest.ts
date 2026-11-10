import type { AdapterManifest } from "../../core/catalog/index.js";
import { lintManifest } from "../lint-common/manifest.js";

/**
 * golangci-lint v2 as the Go lint adapter: `golangci-lint run ./...` in the Go module of the component, with the
 * project's own .golangci.yml / .golangci.yaml / .golangci.toml / .golangci.json (without one, golangci-lint's default
 * linters: errcheck, govet, ineffassign, staticcheck, unused). The JSON report on stdout is read; nothing is rewritten
 * (no --fix). golangci-lint is a tool of the JGates tools image.
 */
export const golangciLintManifest: AdapterManifest = lintManifest({
  id: "golangci-lint",
  displayName: "golangci-lint (Go lint)",
  toolName: "golangci-lint",
  toolVersionRange: ">=2.0.0 <3.0.0",
  configDiscovery: ".golangci.yml, .golangci.yaml, .golangci.toml or .golangci.json in the module (golangci-lint walks up from the working folder); without one the default linters run",
  configPrecedence: "the configuration of the project decides which linters run and which findings are excluded; JGates only adds the report format and the cache folders",
  exitCodes: [
    { code: 0, meaning: "no issue" },
    { code: 1, meaning: "issues found" },
    { code: 3, meaning: "failure to run (bad configuration, packages that do not load)" },
    { code: 5, meaning: "no Go files to analyze" },
  ],
  executesProjectCode: false,
  redirectionFlags: ["--output.json.path", "--output.text.path", "--show-stats", "--max-issues-per-linter", "--max-same-issues"],
  redirectionEnv: ["GOCACHE", "GOLANGCI_LINT_CACHE", "GOPROXY", "GOTOOLCHAIN", "GOTELEMETRY", "NO_COLOR"],
  outputPaths: [
    { path: "cache/golangci-lint/go-build", purpose: "cache", env: ["GOCACHE"] },
    { path: "cache/golangci-lint/lint", purpose: "cache", env: ["GOLANGCI_LINT_CACHE"] },
  ],
  relativeCost: "medium",
  license: "GPL-3.0-only",
  limitations: [
    "analyzes the packages of the module with go/packages: the modules must be in the dependency volume (the run is offline) and go.sum complete",
    "version 2 configuration files only: a version 1 .golangci.yml makes golangci-lint fail, which is an error stage, never a pass",
    "the issues and their first location come from the JSON report; an output or exit code the adapter cannot explain is an error, never a pass",
  ],
  stackSupport: [
    {
      capability: "lint",
      stack: "go",
      state: "validated",
      prerequisites: ["golangci-lint 2.x in the JGates tools image", "a go.mod in the component", "the module's dependencies in the dependency volume"],
      limitations: ["golangci-lint run ./... with the project's .golangci.yml (default linters without one)"],
    },
  ],
  sourceUrl: "https://github.com/golangci/golangci-lint",
  acquisition: ["https://golangci-lint.run/welcome/install/"],
  setup: ["https://golangci-lint.run/usage/configuration/"],
});
