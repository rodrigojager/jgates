import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * govulncheck as its own adapter: Go dependency vulnerabilities, reported only when the code reaches the vulnerable
 * symbol (the call-graph analysis of the Go team), against the Go vulnerability database. One
 * `govulncheck -format json ./...` per tool instance in the Go module; the JSON stream is on stdout. govulncheck is
 * BSD-3-Clause, a single Go binary that the customer supplies (`go install golang.org/x/vuln/cmd/govulncheck@latest` or
 * a release of the Go team): JGates checks it (`jgates doctor`) and says where to get it, but never downloads a tool
 * during a run. It loads the packages with the Go toolchain and asks vuln.go.dev for the database, so it needs `go`,
 * the modules in the module cache (or the network to fetch them) and the network for the database.
 */
export const govulncheckManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "govulncheck",
  displayName: "govulncheck (Go dependency vulnerabilities)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "govulncheck",
  // The v1.0.0 JSON protocol (config, SBOM, osv, finding messages); the fixtures are of the pinned 1.9.0.
  toolVersionRange: ">=1.0.0 <2.0.0",
  runtimes: ["native"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["dependencies"],
  capabilities: ["dependencies"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "other",
      discovery: "go.mod of the scan root (the module being analysed); govulncheck has no configuration file of its own",
      precedence: "the command-line flags of the plan (format, scan level) decide everything",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "analysis finished (with -format json the findings are in the output, never in the exit code)" },
      { code: 1, meaning: "error (invalid arguments, a module that does not load, the database unreachable)" },
      { code: 3, meaning: "vulnerabilities found (text and sarif formats only; not used by the plan)" },
    ],
    reportRequired: true,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    // It loads (type-checks) the packages of the module; it does not build or run them.
    executesProjectCode: false,
    // The vulnerability database (vuln.go.dev) and the modules missing from the module cache.
    usesNetwork: true,
    needsService: false,
    usesAi: false,
    needsLicense: false,
  },
  redirection: {
    flags: ["-format"],
    env: ["GOCACHE", "GOTELEMETRY", "NO_COLOR"],
    outputPaths: [{ path: "cache/govulncheck/gocache", purpose: "cache", env: ["GOCACHE"] }],
    unavoidableWorkspaceWrites: [],
  },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "medium",
  origin: "builtin",
  license: "BSD-3-Clause",
  kind: "tool",
  limitations: [
    "source mode only: a binary is not scanned; the findings are the vulnerabilities whose symbol the code reaches, and the ones in code that is required or imported but never called are only counted",
    "the Go vulnerability database has no severity: a reachable vulnerability blocks, and its severity stays unknown",
    "needs the Go toolchain, the network for vuln.go.dev and the modules in the module cache (go.sum must be complete: the run never rewrites it)",
    "vulnerabilities of the Go standard library are judged against the toolchain that runs the analysis, so they depend on the installed Go version",
  ],
  stackSupport: [
    {
      capability: "dependencies",
      stack: "go",
      state: "validated",
      prerequisites: ["govulncheck 1.0+ (customer-supplied: go install golang.org/x/vuln/cmd/govulncheck@latest)", "the Go toolchain on the PATH", "go.mod and a complete go.sum", "network access to vuln.go.dev"],
      limitations: ["reachable (called) vulnerabilities only; binary mode is not supported", "validated with the real govulncheck 1.9.0 and Go 1.26.2 on Windows; the tool itself is customer-setup-required on every machine (never shipped or installed by JGates)"],
    },
  ],
  distribution: {
    mode: "customer-supplied",
    sourceUrl: "https://github.com/golang/vuln",
    spdx: "BSD-3-Clause",
    acquisition: ["https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck", "https://go.dev/doc/security/vuln/"],
    setup: ["https://go.dev/doc/tutorial/govulncheck", "https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck#hdr-Usage"],
  },
};
