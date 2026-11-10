import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * CodeQL as its own adapter: interprocedural, cross-file dataflow analysis with query suites (Security). The CodeQL CLI
 * is customer-supplied: its terms restrict use (public repositories and licensed organizational private use), so JGates
 * ships and installs nothing of it. `codeql database create` builds a database under the run folder, then
 * `codeql database analyze` runs the chosen suite and writes SARIF, which is normalized into findings. Settings of the
 * instance in tools.yml: language (required), suite and buildCommand (compiled languages).
 */
export const codeqlManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "codeql",
  displayName: "CodeQL (dataflow, customer-supplied)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "codeql",
  toolVersionRange: ">=2.15.0 <3.0.0",
  runtimes: ["native"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["security"],
  capabilities: ["dataflow"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "yaml",
      discovery: "codeql-config.yml is not read; the language, the suite and the build command live in the instance of .jgates/tools.yml",
      precedence: "command-line flags of the plan over any other source",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "database created / analysis finished (findings are in the SARIF file, never in the exit code)" },
      { code: 1, meaning: "error (the database could not be created, a query pack is missing, a query failed)" },
      { code: 2, meaning: "cancelled" },
    ],
    reportRequired: true,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    // Compiled languages are built by CodeQL (buildCommand or autobuild): the project's build runs.
    executesProjectCode: true,
    // Query packs come with the prepared bundle (volume jgates-codeql); JGates runs it with --no-download.
    usesNetwork: false,
    needsService: false,
    usesAi: false,
    needsLicense: true,
  },
  redirection: {
    flags: ["--format", "--output", "--no-download", "--overwrite"],
    // HOME stays the customer's: their installed query packs and CodeQL configuration live under it.
    env: ["NO_COLOR"],
    outputPaths: [
      { path: "cache/codeql/db", purpose: "cache" },
    ],
    unavoidableWorkspaceWrites: [],
  },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "high",
  origin: "builtin",
  license: "GitHub CodeQL Terms and Conditions (customer-supplied; not redistributed by JGates)",
  kind: "tool",
  limitations: [
    "customer-supplied: JGates never bundles CodeQL or installs it on the host; it downloads the bundle of the official release (checksum verified) into the jgates-codeql volume only after you accept the CodeQL terms with `jgates tools prepare-codeql --accept-terms`, and a run without it is blocked (CUSTOMER_SUPPLIED), never passed",
    "the CodeQL terms restrict use to public repositories and licensed organizational private use; the customer owns that entitlement",
    "one database per language per tool instance; compiled languages need a working build (buildCommand or autobuild)",
    "the query packs come with the prepared bundle (JGates passes --no-download), which the step mounts read-only at /codeql",
  ],
  stackSupport: ["python", "javascript", "typescript", "java", "go", "csharp", "ruby"].map((stack) => ({
    capability: "dataflow",
    stack,
    state: "customer-setup-required" as const,
    prerequisites: ["CodeQL CLI 2.15+ prepared into the jgates-codeql volume (jgates tools prepare-codeql --accept-terms)", "the CodeQL query pack of the language, which the CodeQL bundle carries", "an entitlement that covers the repository under the CodeQL terms"],
    limitations: ["No JGates test runs a real CodeQL here: the adapter is exercised with a stand-in executable that replays a SARIF in the CodeQL shape."],
  })),
  distribution: {
    mode: "customer-supplied",
    sourceUrl: "https://github.com/github/codeql-cli-binaries",
    spdx: "NOASSERTION",
    notices: ["The CodeQL CLI is under the GitHub CodeQL Terms and Conditions; JGates does not ship, bundle or install it."],
    acquisition: ["https://github.com/github/codeql-action/releases", "https://docs.github.com/en/code-security/codeql-cli/getting-started-with-the-codeql-cli/setting-up-the-codeql-cli"],
    setup: ["https://docs.github.com/en/code-security/codeql-cli", "https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-cli"],
  },
};
