import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * pytest: Python test runner, with the manifest, the binding and the form of [tool.pytest.ini_options]. A run reports
 * the tests through the JUnit XML and line coverage through pytest-cov (coverage.py JSON), both written in
 * the run folder. The tests and conftest.py are project code, so the effects say so (and the cache never reuses it).
 */
export const pytestManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "pytest",
  displayName: "pytest",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "pytest",
  toolVersionRange: ">=7.0.0",
  runtimes: ["native"],
  platforms: ["linux", "win32", "darwin"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["tests"],
  capabilities: ["unit", "coverage", "integration", "properties"],
  languages: ["python"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "toml",
      discovery: "pytest.ini, .pytest.ini, pyproject.toml with [tool.pytest.ini_options], tox.ini with [pytest] or setup.cfg with [tool:pytest], first match from the root directory up; a tools.yml binding overrides it",
      precedence: "pytest.ini over .pytest.ini over pyproject.toml over tox.ini over setup.cfg in the same directory",
      ownedSelector: "tool.pytest.ini_options",
    },
  ],
  editing: { implemented: ["text", "structured-read", "structured-write"], tested: ["text", "structured-read", "structured-write"] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "all tests passed" },
      { code: 1, meaning: "some tests failed" },
      { code: 2, meaning: "interrupted" },
      { code: 3, meaning: "internal error" },
      { code: 4, meaning: "usage error" },
      { code: 5, meaning: "no tests collected" },
    ],
    reportRequired: true,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    executesProjectCode: true,
    usesNetwork: false,
    needsService: false,
    usesAi: false,
    needsLicense: false,
  },
  // Without these pytest writes .pytest_cache, __pycache__ and .coverage in the project.
  redirection: { flags: ["-p no:cacheprovider", "--junitxml", "--cov-report"], env: ["PYTHONDONTWRITEBYTECODE", "COVERAGE_FILE", "HYPOTHESIS_STORAGE_DIRECTORY"], unavoidableWorkspaceWrites: [] },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "medium",
  origin: "builtin",
  license: "MIT",
  kind: "tool",
  limitations: [
    "Runs the project's tests and conftest.py (executes project code); line coverage needs the pytest-cov plugin, which is never installed during a run.",
    "Coverage is by lines of the measured source (src/ when it exists, else the component, or what the component's coverage configuration declares).",
  ],
  stackSupport: [
    { capability: "unit", stack: "python", state: "validated", prerequisites: ["pytest from the JGates tools image (the project's own dependencies come from its dependency volume)"] },
    { capability: "coverage", stack: "python", state: "validated", prerequisites: ["pytest and pytest-cov from the JGates tools image"] },
    { capability: "integration", stack: "python", state: "validated", prerequisites: ["integration tests under tests/integration or marked @pytest.mark.integration (or tools.<id>.selection)"], limitations: ["the unit run leaves the selection out (--ignore or -m \"not <marker>\"); services come from the compose section when the tests need them"] },
    { capability: "properties", stack: "python", state: "validated", prerequisites: ["Hypothesis (the tools image ships it for its pytest; a project that declares pytest brings its own)"], limitations: ["static detection of @given tests"] },
  ],
  distribution: {
    mode: "customer-supplied",
    sourceUrl: "https://github.com/pytest-dev/pytest",
    spdx: "MIT",
    acquisition: ["https://docs.pytest.org/en/stable/getting-started.html", "https://pytest-cov.readthedocs.io/en/latest/readme.html#installation"],
    setup: ["https://docs.pytest.org/en/stable/reference/customize.html"],
  },
};
