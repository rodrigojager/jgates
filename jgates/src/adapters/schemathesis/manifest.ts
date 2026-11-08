import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * Schemathesis as a runtime API check (Tests domain, api-contract capability): property-based tests generated from an
 * OpenAPI specification and sent to a running target the customer names (tools.<id>.target). One
 * `st run <spec> --url <target>` per tool instance, with a fixed seed, a bound on examples per operation, a request
 * timeout and the stage timeout, and a configuration file written into the run folder (the authentication header comes
 * from an environment variable, never from the plan). Without a target the stage is blocked, never passed.
 * Schemathesis is MIT, installed with pip into the JGates environment by `jgates doctor --fix` (never during a run).
 */
export const schemathesisManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "schemathesis",
  displayName: "Schemathesis (API contract tests)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "schemathesis",
  // The JSON and JUnit reports of 4.x; the fixtures are of 4.33.1.
  toolVersionRange: ">=4.0.0 <5.0.0",
  runtimes: ["native"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["tests"],
  capabilities: ["api-contract"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "yaml",
      discovery: "the OpenAPI specification (tools.<id>.spec, or openapi.yaml/openapi.json/swagger.* of the scan root); the target, auth, seed, maxExamples, requestTimeoutSeconds and checks live in the instance of .jgates/tools.yml",
      precedence: "the settings of the instance decide everything; a schemathesis.toml of the project is not read (the run passes its own --config-file)",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "every generated test case passed the selected checks" },
      { code: 1, meaning: "at least one check failed (the failures are in the JSON and JUnit reports)" },
      { code: 2, meaning: "usage or internal error (the stage is an error, never passed)" },
    ],
    reportRequired: true,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    executesProjectCode: false,
    usesNetwork: true,
    needsService: true,
    usesAi: false,
    needsLicense: false,
  },
  redirection: {
    flags: ["--config-file", "--report", "--report-json-path", "--report-junit-path", "--no-color"],
    env: ["HOME", "USERPROFILE", "NO_COLOR", "PYTHONIOENCODING"],
    outputPaths: [{ path: "cache/schemathesis/home", purpose: "home", env: ["HOME", "USERPROFILE"] }],
    unavoidableWorkspaceWrites: [],
  },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "medium",
  origin: "builtin",
  license: "MIT",
  kind: "tool",
  limitations: [
    "runs only against a running target the customer names (tools.<id>.target); without it the stage is blocked, never passed",
    "sends generated requests, including invalid ones, to the target: use a local or disposable environment, never production",
    "OpenAPI specifications only (GraphQL and gRPC targets are not planned); stateful testing is limited to what the specification's links describe",
  ],
  stackSupport: [
    {
      capability: "api-contract",
      stack: "any",
      state: "validated",
      prerequisites: ["schemathesis 4.x (pip: jgates doctor --fix installs it into the JGates environment)", "an OpenAPI 3 specification and a running HTTP target (tools.<id>.target)"],
      limitations: ["HTTP APIs described by OpenAPI only"],
    },
  ],
  distribution: {
    mode: "prepared-from-authorized-source",
    sourceUrl: "https://github.com/schemathesis/schemathesis",
    spdx: "MIT",
    acquisition: ["https://pypi.org/project/schemathesis/", "https://schemathesis.readthedocs.io/en/stable/"],
    setup: ["https://schemathesis.readthedocs.io/en/stable/reference/cli/", "https://schemathesis.readthedocs.io/en/stable/reference/configuration/"],
  },
};
