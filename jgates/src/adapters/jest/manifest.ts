import { testManifest } from "../test-common/manifest.js";

/**
 * Jest as its own adapter: the project's own Jest (a dev dependency, installed into the dependency volume) with the JSON
 * results file and the json-summary coverage report in the run folder, the integration selection by project
 * (--selectProjects / --ignoreProjects) or by file pattern, and the fast-check property tests among the tests that ran.
 */
export const jestManifest = testManifest({
  id: "jest",
  displayName: "Jest (JavaScript/TypeScript tests, coverage and fast-check properties)",
  toolName: "jest",
  toolVersionRange: ">=27.0.0",
  languages: ["javascript", "typescript"],
  configDiscovery: "jest.config.* or the jest key of package.json, as Jest resolves it from the component folder",
  configPrecedence: "the command-line options of the plan (--json, --outputFile, --coverage, the selection) win over the configuration",
  exitCodes: [
    { code: 0, meaning: "all tests passed" },
    { code: 1, meaning: "a test failed (or a coverage threshold of the project's configuration was not met: then an error stage)" },
  ],
  redirectionFlags: ["--json", "--outputFile", "--coverageDirectory", "--no-cache", "--watchman=false"],
  redirectionEnv: ["CI"],
  license: "MIT",
  limitations: [
    "Jest is the project's own dev dependency (it is not in the tools image): without it in package.json the stage is blocked with the instruction",
    "the tests and the project's configuration, transforms and setup files execute",
    "line coverage of the json-summary report (Jest's default istanbul instrumentation); the project's collectCoverageFrom decides the denominator",
    "property tests are detected statically: tests running fast-check (fc.assert / fc.property) or declared with test.prop of @fast-check/jest",
  ],
  stackSupport: [
    { capability: "unit", stack: "javascript", state: "validated", toolVersions: "jest >=27", prerequisites: ["jest in the devDependencies of the component"], limitations: ["validated with jest 30 installed by the deps phase"] },
    { capability: "coverage", stack: "javascript", state: "validated", toolVersions: "jest >=27", prerequisites: ["jest in the devDependencies of the component"], limitations: ["line coverage of the json-summary report"] },
    { capability: "integration", stack: "javascript", state: "validated", toolVersions: "jest >=27", prerequisites: ["integration tests in *.integration.test.* files, a project named integration, or tools.<id>.selection"], limitations: ["services come from the compose section when the tests need them"] },
    { capability: "properties", stack: "javascript", state: "validated", toolVersions: "jest >=27, fast-check 3+", prerequisites: ["fast-check in the devDependencies of the component"], limitations: ["static detection of fast-check properties"] },
    { capability: "unit", stack: "typescript", state: "customer-setup-required", prerequisites: ["jest with a TypeScript transform (ts-jest or babel) in the component"], limitations: ["No JGates test exercises a TypeScript Jest project yet; the JavaScript fixture proves the adapter."] },
    { capability: "coverage", stack: "typescript", state: "customer-setup-required", prerequisites: ["jest with a TypeScript transform (ts-jest or babel) in the component"], limitations: ["No JGates test exercises a TypeScript Jest project yet; the JavaScript fixture proves the adapter."] },
  ],
  sourceUrl: "https://github.com/jestjs/jest",
  acquisition: ["https://jestjs.io/docs/getting-started"],
  setup: ["https://jestjs.io/docs/cli", "https://jestjs.io/docs/configuration", "https://fast-check.dev/"],
  mode: "customer-supplied",
});
