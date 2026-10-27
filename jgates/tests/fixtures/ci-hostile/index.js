// A project that tries to choose its own rules in jgates ci, and the same project without the attempts. The files are
// kept here as text (never as real configuration files of this repository, where they would configure its own tools)
// and written into a temporary Git repository by the tests.
//
// What the hostile copy adds:
//   - configuration files that switch every check off: eslint.config.js (ignore everything), pyproject.toml with a
//     permissive [tool.ruff], .semgrepignore, .gitleaks.toml that allows everything, .gitleaksignore, .jscpd.json,
//     .shellcheckrc, a .quality-gate-policy.json without budgets;
//   - suppression comments on the offending lines: # noqa, # ruff: noqa, eslint-disable, nosem, gitleaks:allow,
//     a ShellCheck directive;
//   - a fake ESLint in node_modules/.bin that writes an empty report (the project's code, never the tool);
//   - conftest.py that turns every failed test into a pass.

/** Files both copies share: the code with the findings the policy's tools must report. */
function common({ hostile }) {
  const tail = (comment) => (hostile ? `  ${comment}` : "");
  return {
    "README.md": "# Hostile CI fixture\n",
    "app/__init__.py": "",
    "app/main.py": [
      ...(hostile ? ["# ruff: noqa"] : []),
      `import os${tail("# noqa: F401")}`,
      `import sys${tail("# noqa")}`,
      "",
      "",
      "def run(expression):",
      `    return eval(expression)${tail("# nosem")}`,
      "",
    ].join("\n"),
    "web/app.js": [
      ...(hostile ? ["/* eslint-disable */"] : []),
      `var unused = 1;${tail("// eslint-disable-line no-unused-vars")}`,
      `export const token = "not-a-secret";${tail("// gitleaks:allow")}`,
      "",
    ].join("\n"),
    "scripts/run.sh": ["#!/bin/sh", ...(hostile ? ["# shellcheck disable=SC2086"] : []), "echo $1", ""].join("\n"),
  };
}

/** The configuration a hostile project commits to switch the checks off. */
const HOSTILE_CONFIG = {
  "eslint.config.js": 'export default [{ ignores: ["**/*"] }];\n',
  "package.json": '{ "name": "hostile", "version": "1.0.0", "type": "module", "jscpd": { "ignore": ["**/*"] } }\n',
  "pyproject.toml": '[project]\nname = "hostile"\nversion = "0.1.0"\n\n[tool.ruff]\nexclude = ["*"]\n\n[tool.ruff.lint]\nselect = []\nignore = ["ALL"]\n',
  "ruff.toml": "[lint]\nselect = []\n",
  ".semgrepignore": "*\n",
  ".gitleaks.toml": "title = \"allow everything\"\n\n[allowlist]\ndescription = \"everything\"\npaths = ['''.*''']\nregexes = ['''.*''']\n",
  ".gitleaksignore": "*\n",
  ".jscpd.json": '{ "ignore": ["**/*"] }\n',
  ".shellcheckrc": "disable=all\n",
  ".quality-gate-policy.json": '{ "schemaVersion": 1, "budgets": { "enabled": false } }\n',
  // A fake ESLint: whatever it is asked, it writes an empty report and exits 0.
  "node_modules/package.json": '{ "name": "eslint", "version": "9.30.0" }\n',
  "node_modules/.bin/eslint":
    '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "--output-file" ]; then shift; printf "[]" > "$1"; fi; shift; done\nexit 0\n',
};

/** Files of the project: the clean copy, or the hostile one (EXECUTABLES lists the files committed with mode 755). */
export function projectFiles({ hostile }) {
  return { ...common({ hostile }), ...(hostile ? HOSTILE_CONFIG : {}) };
}

/** Executable files of the hostile copy (mode 755 in the commit). */
export const EXECUTABLES = ["node_modules/.bin/eslint", "scripts/run.sh"];

/** The tests and the conftest.py that forges their result. */
export function forgedTestFiles({ forged, csproj = false }) {
  return {
    "README.md": "# Self-reported results fixture\n",
    "tests/__init__.py": "",
    "tests/test_math.py": "def test_addition():\n    assert 1 + 1 == 3\n",
    ...(forged
      ? {
          "conftest.py": [
            "import pytest",
            "",
            "",
            "@pytest.hookimpl(hookwrapper=True)",
            "def pytest_runtest_makereport(item, call):",
            "    outcome = yield",
            "    report = outcome.get_result()",
            '    report.outcome = "passed"',
            "",
          ].join("\n"),
        }
      : {}),
    // MSBuild runs the targets of a project file: a linter that loads it runs the project's code.
    ...(csproj ? { "Sample.csproj": '<Project Sdk="Microsoft.NET.Sdk">\n  <Target Name="Forge" BeforeTargets="Build">\n    <Exec Command="echo forged" />\n  </Target>\n</Project>\n' } : {}),
  };
}

/** The CI policy of the hostile test: Ruff, ESLint and Semgrep with the policy's configuration, budgets, secrets. */
export function hostilePolicy() {
  return {
    "jgates.yml": "schemaVersion: 1\nextends:\n  - .jgates/profiles.yml\nselection:\n  profile: gate\n",
    ".jgates/profiles.yml": [
      "schemaVersion: 1",
      "profiles:",
      "  gate:",
      "    label: gate",
      "    extends: builtin:minimal",
      "    checks:",
      "      capability:sast:",
      "        enabled: true",
      "",
    ].join("\n"),
    ".jgates/tools.yml": [
      "schemaVersion: 1",
      "tools:",
      "  ruff:",
      "    adapter: ruff",
      "    capabilities: [lint]",
      "    config: .jgates/ruff.toml",
      "  eslint:",
      "    adapter: eslint",
      "    capabilities: [lint]",
      "    config: .jgates/eslint.config.mjs",
      "  semgrep:",
      "    adapter: semgrep",
      "    capabilities: [sast]",
      "    config:",
      "      path: .jgates/rules",
      "      kind: directory",
      "      role: rules",
      "",
    ].join("\n"),
    ".jgates/ruff.toml": '[lint]\nselect = ["F"]\n',
    ".jgates/eslint.config.mjs": 'export default [{ files: ["**/*.js"], languageOptions: { sourceType: "module" }, rules: { "no-unused-vars": "error" } }];\n',
    ".jgates/rules/no-eval.yml": "rules:\n  - id: no-eval\n    pattern: eval(...)\n    message: eval runs arbitrary code\n    languages: [python]\n    severity: ERROR\n",
    ".jgates/quality-policy.json": '{\n  "schemaVersion": 1,\n  "budgets": { "maxFileLines": 400 }\n}\n',
  };
}

/** The CI policy of the self-reported test: budgets and the project's tests through pytest. */
export function testsPolicy({ trustSelfReported = false } = {}) {
  return {
    "jgates.yml": [
      "schemaVersion: 1",
      "extends:",
      "  - .jgates/profiles.yml",
      "selection:",
      "  profile: gate",
      ...(trustSelfReported ? ["execution:", "  trustSelfReported: true"] : []),
      "",
    ].join("\n"),
    ".jgates/profiles.yml": [
      "schemaVersion: 1",
      "profiles:",
      "  gate:",
      "    label: gate",
      "    extends: builtin:minimal",
      "    checks:",
      "      capability:lint:",
      "        enabled: false",
      "      capability:secrets:",
      "        enabled: false",
      "      capability:unit:",
      "        enabled: true",
      "      tool:quality-bridge.project-tests:",
      "        enabled: false",
      "",
    ].join("\n"),
    ".jgates/tools.yml": "schemaVersion: 1\ntools:\n  pytest:\n    adapter: pytest\n    capabilities: [unit]\n",
  };
}
