import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * oasdiff as its own adapter: the API-compatibility check of an OpenAPI specification against a reference revision (a
 * git ref) or a reference file. One `oasdiff breaking <base> <spec> --format json` per tool instance; the base spec is
 * resolved with `git show <ref>:<path>` into the run folder before the tool starts. oasdiff is Apache-2.0, a single Go
 * binary that the customer supplies (official release, `go install` or a package manager): JGates checks it
 * (`jgates doctor`) and says where to get it, but never downloads a tool during a run.
 * Settings of the instance in tools.yml: spec (the specification path), baseRef or baseSpec (the reference) and failOn.
 */
export const oasdiffManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "oasdiff",
  displayName: "oasdiff (OpenAPI compatibility)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "oasdiff",
  // The breaking --format json document; the fixtures are of the pinned 1.36.0.
  toolVersionRange: ">=1.10.0 <2.0.0",
  runtimes: ["native"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["architecture"],
  capabilities: ["api-compatibility"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "yaml",
      discovery: "the OpenAPI specification (openapi.yaml, openapi.yml, openapi.json, swagger.* or api/, docs/ and spec/ copies) of the scan root; the settings spec, baseRef, baseSpec and failOn live in the instance of .jgates/tools.yml",
      precedence: "the settings of the instance decide the specification and the reference; there is no oasdiff configuration file",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "comparison finished (breaking changes are in the JSON output; the plan does not pass --fail-on, so the level stays out of the code)" },
      { code: 1, meaning: "breaking changes at the --fail-on level (not used by the plan)" },
      { code: 101, meaning: "the spec could not be loaded or parsed" },
      { code: 102, meaning: "the base spec could not be loaded" },
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
  redirection: {
    flags: ["--format"],
    env: ["HOME", "USERPROFILE", "NO_COLOR"],
    outputPaths: [{ path: "cache/oasdiff/home", purpose: "home", env: ["HOME", "USERPROFILE"] }],
    unavoidableWorkspaceWrites: [],
  },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "low",
  origin: "builtin",
  license: "Apache-2.0",
  kind: "tool",
  limitations: [
    "compares two revisions of one specification; it needs a reference (a git ref that holds the spec, or a reference file), and without one the stage is blocked, never passed",
    "a specification added after the reference revision has no base to compare with and is reported as blocked, not as compatible",
    "specifications that reference external files by $ref are read from the working tree for the target and from the git object for the base spec only",
  ],
  stackSupport: [
    {
      capability: "api-compatibility",
      stack: "any",
      state: "validated",
      prerequisites: ["oasdiff 1.10+ (customer-supplied: official release, go install or a package manager)", "an OpenAPI 3 specification file and a git ref or file as the reference"],
      limitations: ["OpenAPI 3.x files only; no code-first contract extraction"],
    },
  ],
  distribution: {
    mode: "customer-supplied",
    sourceUrl: "https://github.com/oasdiff/oasdiff",
    spdx: "Apache-2.0",
    acquisition: ["https://github.com/oasdiff/oasdiff/releases", "https://github.com/oasdiff/oasdiff#installation"],
    setup: ["https://github.com/oasdiff/oasdiff/blob/main/docs/BREAKING-CHANGES.md"],
  },
};
