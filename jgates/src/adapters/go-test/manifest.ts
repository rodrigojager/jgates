import { testManifest } from "../test-common/manifest.js";

/**
 * go test as its own adapter: the unit run (`go test -json ./...`, with `-coverprofile` when coverage is selected), the
 * integration run (`-tags=<tag> -run` of the tests in the tagged files) and the property tests of rapid and testing/quick
 * among them. Runs in the step container of the tools image; the modules come from the dependency volume (offline).
 */
export const goTestManifest = testManifest({
  id: "go-test",
  displayName: "go test (Go tests, coverage and rapid/quick properties)",
  toolName: "go",
  toolVersionRange: ">=1.21.0",
  languages: ["go"],
  configDiscovery: "go.mod of the component; the build tags of the test files (//go:build) decide the integration selection",
  configPrecedence: "the command-line flags of the plan (-tags, -run, -coverprofile) win",
  exitCodes: [
    { code: 0, meaning: "all tests passed" },
    { code: 1, meaning: "a test failed or a package did not build (the JSON events tell them apart)" },
  ],
  redirectionFlags: ["-json", "-count=1", "-coverprofile"],
  redirectionEnv: ["GOCACHE", "GOTMPDIR", "GOPROXY", "GOTOOLCHAIN", "GOTELEMETRY"],
  outputPaths: [{ path: "cache/go-test", purpose: "cache", env: ["GOCACHE", "GOTMPDIR"] }],
  license: "BSD-3-Clause",
  limitations: [
    "the tests of the project execute; the modules must already be in the dependency volume (the run is offline)",
    "top-level tests are counted (a failing subtest fails its parent); a package that does not build is a failing suite",
    "coverage counts statements of the packages that have tests (go test -coverprofile); a package without tests is not in the denominator",
    "the integration selection is the test functions of the files with the build tag; a test of the same name in an untagged file of the same package also runs",
    "property tests are detected statically: tests calling rapid.Check or quick.Check / quick.CheckEqual",
  ],
  stackSupport: [
    { capability: "unit", stack: "go", state: "validated", toolVersions: "go >=1.21", prerequisites: ["go.mod in the component, modules in the dependency volume"], limitations: ["validated with the real go 1.27.3 of the tools image"] },
    { capability: "coverage", stack: "go", state: "validated", toolVersions: "go >=1.21", prerequisites: ["go.mod in the component"], limitations: ["statement coverage from -coverprofile"] },
    { capability: "integration", stack: "go", state: "validated", toolVersions: "go >=1.21", prerequisites: ["integration tests in files with a //go:build integration constraint (or the tag of tools.<id>.selection.tag)"], limitations: ["services come from the compose section when the tests need them"] },
    { capability: "properties", stack: "go", state: "validated", toolVersions: "go >=1.21, pgregory.net/rapid 1.x or testing/quick", prerequisites: ["rapid in go.mod (fetched into the dependency volume) or the standard testing/quick"], limitations: ["static detection of rapid.Check and quick.Check calls"] },
  ],
  sourceUrl: "https://github.com/golang/go",
  acquisition: ["https://go.dev/doc/install"],
  setup: ["https://pkg.go.dev/cmd/go#hdr-Test_packages", "https://pkg.go.dev/pgregory.net/rapid"],
  mode: "customer-supplied",
});
