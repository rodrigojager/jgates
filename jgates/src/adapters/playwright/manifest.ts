import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * End-to-end tests with Playwright against the project's compose services: Playwright Test (TypeScript/JavaScript, the
 * project's @playwright/test) and pytest-playwright (Python, the project's pytest-playwright), in the step container of
 * the tools image on the services network, with Chromium from the toolchain volume (fetched for the installed Playwright
 * version by the deps phase). The application the tests drive is the services target (jgates.yml services.target or
 * tools.<id>.target), handed over as BASE_URL / --base-url. Without services configured the check is SERVICES_REQUIRED,
 * never run and never a blocker.
 */
export const playwrightManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "playwright",
  displayName: "Playwright e2e (Playwright Test, pytest-playwright)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "playwright",
  toolVersionRange: ">=1.40.0 <2.0.0",
  runtimes: ["native", "container"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["tests"],
  capabilities: ["e2e"],
  languages: ["typescript", "javascript", "python"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "other",
      discovery: "playwright.config.(ts|js|mjs|cjs) of the component (Playwright Test); pytest.ini, pyproject.toml [tool.pytest.ini_options] or conftest.py (pytest-playwright)",
      precedence: "the plan's flags (--reporter=json, --output, --junitxml, --base-url) over the file",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "every test passed" },
      { code: 1, meaning: "a test failed (the report lists it), or an error before the tests" },
    ],
    reportRequired: true,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    // The tests are the project's code: never cacheable.
    executesProjectCode: true,
    usesNetwork: false,
    needsService: true,
    usesAi: false,
    needsLicense: false,
  },
  redirection: {
    flags: ["--reporter", "--output", "--junitxml", "--base-url"],
    env: ["PLAYWRIGHT_JSON_OUTPUT_NAME", "BASE_URL"],
    outputPaths: [{ path: "outputs/playwright", purpose: "output" }],
    unavoidableWorkspaceWrites: [],
  },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "high",
  origin: "builtin",
  license: "Apache-2.0",
  kind: "tool",
  limitations: [
    "needs the project's compose services (jgates.yml services:); without them the check is SERVICES_REQUIRED and does not run",
    "Chromium only: the browsers come from the toolchain volume for the installed Playwright version (Firefox and WebKit are not fetched)",
    "Playwright Test reads the target from process.env.BASE_URL in its configuration; pytest-playwright gets --base-url",
    "the tests execute (the project's code): the result is self-reported and never cached",
  ],
  stackSupport: [
    {
      capability: "e2e",
      stack: "typescript",
      state: "validated",
      toolVersions: "@playwright/test >=1.40 (fixture ran 1.65.0)",
      prerequisites: ["@playwright/test in the devDependencies of the component", "a services section in jgates.yml with the application to test"],
      limitations: ["Chromium only"],
    },
    {
      capability: "e2e",
      stack: "javascript",
      state: "validated",
      toolVersions: "@playwright/test >=1.40 (fixture ran 1.65.0)",
      prerequisites: ["@playwright/test in the devDependencies of the component", "a services section in jgates.yml with the application to test"],
      limitations: ["Chromium only; the JavaScript fixture is the TypeScript one's runner and report"],
    },
    {
      capability: "e2e",
      stack: "python",
      state: "validated",
      toolVersions: "pytest-playwright 0.5+ with playwright >=1.40 (fixture ran 0.10.0 / 1.65.0)",
      prerequisites: ["pytest-playwright in the dependencies of the component", "a services section in jgates.yml with the application to test"],
      limitations: ["Chromium only"],
    },
  ],
  distribution: {
    mode: "customer-supplied",
    sourceUrl: "https://github.com/microsoft/playwright",
    spdx: "Apache-2.0",
    acquisition: ["https://playwright.dev/docs/intro", "https://playwright.dev/python/docs/test-runners"],
    setup: ["https://playwright.dev/docs/test-configuration", "https://playwright.dev/python/docs/test-runners"],
  },
};
