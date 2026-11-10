import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { docker, dockerAvailable } from "./dev-docker.mjs";

// Adapter migration A, with the real engine (npm run test:docker; never part of npm test): Ruff, pytest, build-check
// (mypy, pyright, tsc, go build, cargo check, dotnet build), Vitest, ESLint, mutation (mutmut), Import Linter,
// dependency-cruiser, jscpd and Schemathesis run through `jgates run` in step containers of the local development image
// jgates-tools:dev. Each adapter has a known-bad fixture (its finding or failure is detected) and a clean fixture (it
// passes). Nothing runs as a host process: every step is a `docker run` of the image, and the project folder is
// byte for byte the same afterwards. The image is selected with JGATES_TOOLS_IMAGE; the host-side probes read the
// package's mirror of the image's image.json, so there is no stand-in for any tool on the host.

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const dist = path.join(packageRoot, "dist");
const MAIN = path.join(dist, "cli", "main.js");
const BUILD_CHECK_FIXTURES = path.join(packageRoot, "tests", "fixtures", "build-check");
const RUNTIME_API_FIXTURES = path.join(packageRoot, "tests", "fixtures", "runtime-api");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const engine = await load("core", "engine", "index.js");
const { workspaceId } = await load("core", "ids", "index.js");
const IMAGE = engine.DEV_TOOLS_IMAGE;

const made = [];
const workspaces = new Set();
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};

/** Everything this suite created in the engine carries its workspace id (and the JGates labels); the cleanup selects by them only. */
function cleanup() {
  for (const ws of workspaces) {
    const filters = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${ws}`];
    for (const id of docker(["ps", "-aq", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["rm", "-f", id]);
    for (const name of docker(["volume", "ls", "-q", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["volume", "rm", "-f", name]);
  }
}

before(() => {
  assert.ok(dockerAvailable(), "Docker is required for npm run test:docker (the daemon did not answer)");
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is missing; build it with npm --prefix jgates run image:build`);
});

after(() => {
  try {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } finally {
    cleanup();
  }
});

function treeHash(root) {
  const h = crypto.createHash("sha256");
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === ".git") continue;
      if (e.isDirectory()) {
        h.update(`d:${next}\0`);
        walk(p, next);
      } else h.update(`f:${next}\0`).update(fs.readFileSync(p));
    }
  };
  walk(root, "");
  return h.digest("hex");
}

/**
 * A project in its own folder (files written, git initialized, JGates initialized), with the tools.yml of the case when
 * given (otherwise the instances `jgates init` derives from the evidence). Returns its CLI.
 */
function makeProject({ files = {}, copy = null, tools = null, extraEnv = {} }) {
  const project = tmp("jgates-adapters-a-project-");
  const home = tmp("jgates-adapters-a-home-");
  if (copy) fs.cpSync(copy, project, { recursive: true });
  const write = (entries) => {
    for (const [name, content] of entries) {
      fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
      fs.writeFileSync(path.join(project, name), content);
    }
  };
  // `jgates init` refuses a project that already has a .jgates folder: those files come after it.
  write(Object.entries(files).filter(([name]) => !name.startsWith(".jgates/")));
  const env = { ...process.env, JGATES_HOME: home, JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", ...extraEnv };
  delete env.JGATES_IMAGE_JSON;
  const cli = (args, timeout = 900_000) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  const init = cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  write(Object.entries(files).filter(([name]) => name.startsWith(".jgates/")));
  if (tools !== null) fs.writeFileSync(path.join(project, ".jgates", "tools.yml"), tools);
  spawnSync("git", ["add", "-A"], { cwd: project });
  const ws = workspaceId(project);
  workspaces.add(ws);
  return {
    project,
    home,
    ws,
    cli,
    run: (tool) => {
      const ran = cli(["run", "--cwd", project, "--no-interactive", "--json", "--only", `tool:${tool}`]);
      let doc = null;
      try {
        doc = JSON.parse(ran.stdout);
      } catch {
        doc = null;
      }
      assert.ok(doc?.stages, `${tool}: no result document\n${ran.stdout.slice(0, 3000)}\n${ran.stderr.slice(0, 3000)}`);
      return { code: ran.status, doc };
    },
  };
}

const found = (doc, tool) => doc.findings.filter((f) => f.tool === tool || f.origin === tool);
const summary = (doc) => JSON.stringify({ decision: doc.decision, stages: doc.stages.map((s) => [s.id, s.state, s.reason]), findings: doc.findings.map((f) => [f.tool, f.ruleId, f.location?.path]) }).slice(0, 4000);

/** All the step logs of a run (stdout and stderr) as one text. */
function logsOf(doc) {
  const dir = path.join(doc.runDir, "logs");
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), "utf8")).join("\n=====\n") : "";
}

/** The run really went through the engine: a step container of the image, with the contract's flags, and nothing else. */
function assertRanInContainers(doc, ws) {
  const logs = logsOf(doc);
  for (const part of ["run --rm --init --pull never --name", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges"]) {
    assert.ok(logs.includes(part), `a step log holds the docker run flag ${part}`);
  }
  assert.ok(!/HOST_EXECUTION_REFUSED/.test(JSON.stringify(doc.stages)), "no step was refused");
  assert.equal(docker(["ps", "-aq", "--filter", `label=org.jgates.workspace=${ws}`]).out.trim(), "", "no container of the run is left");
}

/**
 * The bad project fails its check (a finding of the tool, or a failed decision) and the clean one passes, both through
 * the real engine and both leaving the project folder untouched.
 */
function scenario(name, { bad, clean, tool, rule, badStage = "completed", blocking = true, check = () => {} }) {
  test(name, () => {
    for (const kind of ["bad", "clean"]) {
      const p = makeProject(kind === "bad" ? bad : clean);
      const before = treeHash(p.project);
      const { doc } = p.run(tool);
      assert.equal(treeHash(p.project), before, `${kind}: the project folder is identical after the run`);
      assert.deepEqual(doc.workspaceChanges?.added ?? [], [], `${kind}: nothing was added to the project`);
      assertRanInContainers(doc, p.ws);
      const stage = doc.stages.find((s) => s.id.startsWith(`${tool}#`));
      assert.ok(stage, `${kind}: the stage of ${tool} exists: ${summary(doc)}`);
      if (kind === "bad") {
        const mine = found(doc, rule.tool ?? tool);
        assert.equal(stage.state, badStage, `bad: ${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
        assert.ok(mine.length > 0, `bad: the tool reported findings: ${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
        if (rule.id) assert.ok(mine.some((f) => (rule.id instanceof RegExp ? rule.id.test(f.ruleId) : f.ruleId === rule.id)), `bad: rule ${rule.id} among ${JSON.stringify(mine.map((f) => f.ruleId))}`);
        if (rule.path) assert.ok(mine.some((f) => f.location?.path === rule.path), `bad: a finding at ${rule.path}: ${JSON.stringify(mine.map((f) => f.location))}`);
        if (blocking) assert.notEqual(doc.decision, "passed", `bad: the run must not pass: ${summary(doc)}`);
        check(doc, p, "bad");
      } else {
        assert.equal(stage.state, "completed", `clean: ${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
        assert.equal(found(doc, rule.tool ?? tool).length, 0, `clean: no finding: ${summary(doc)}`);
        assert.equal(doc.decision, "passed", `clean: ${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
        check(doc, p, "clean");
      }
    }
  });
}

const toolsYml = (id, adapter, capabilities, extra = "") => `schemaVersion: 1\ntools:\n  ${id}:\n    adapter: ${adapter}\n    capabilities: [${capabilities}]\n${extra}`;

// ---------------------------------------------------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------------------------------------------------

const PY_PROJECT = '[project]\nname = "demo"\nversion = "0.1.0"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\npythonpath = ["."]\n';

scenario("ruff: an unused import is a finding and the clean module passes", {
  tool: "ruff",
  rule: { id: "F401", path: "app/core.py" },
  bad: { files: { "pyproject.toml": PY_PROJECT, "app/__init__.py": "", "app/core.py": "import os\n\n\ndef double(value):\n    return value * 2\n" }, tools: toolsYml("ruff", "ruff", "lint") },
  clean: { files: { "pyproject.toml": PY_PROJECT, "app/__init__.py": "", "app/core.py": "def double(value):\n    return value * 2\n" }, tools: toolsYml("ruff", "ruff", "lint") },
});

scenario("pytest: a failing test fails the step with its name and a passing suite passes", {
  tool: "pytest",
  rule: { id: /./ },
  bad: {
    files: { "pyproject.toml": PY_PROJECT, "app/__init__.py": "", "app/core.py": "def double(value):\n    return value * 2\n", "tests/test_core.py": "from app.core import double\n\n\ndef test_double():\n    assert double(2) == 5\n" },
    tools: toolsYml("pytest", "pytest", "unit"),
  },
  clean: {
    files: { "pyproject.toml": PY_PROJECT, "app/__init__.py": "", "app/core.py": "def double(value):\n    return value * 2\n", "tests/test_core.py": "from app.core import double\n\n\ndef test_double():\n    assert double(2) == 4\n" },
    tools: toolsYml("pytest", "pytest", "unit"),
  },
  check: (doc, _p, kind) => {
    const stage = doc.stages.find((s) => s.id.startsWith("pytest#"));
    if (kind === "bad") assert.ok(found(doc, "pytest").some((f) => /test_double/.test(`${f.message} ${f.location?.path ?? ""} ${f.ruleId}`)), summary(doc));
    else assert.ok(!/error/i.test(stage.state), summary(doc));
  },
});

test("pytest: a project that declares pytest runs its own copy from the dependency volume, the image's copy is the fallback", () => {
  // The test passes only under the interpreter of the project's environment (/workspace/.venv); with the image's pytest
  // it fails. The project without a declaration (the scenario above) is the fallback.
  const where = "import sys\n\n\ndef test_runs_from_the_project_environment():\n    assert sys.prefix.startswith('/workspace/.venv'), sys.prefix\n";
  const declared = makeProject({
    files: { "pyproject.toml": '[project]\nname = "demo"\nversion = "0.1.0"\nrequires-python = ">=3.10"\ndependencies = []\n\n[dependency-groups]\ndev = ["pytest>=8"]\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n\n[tool.uv]\npackage = false\n', "tests/test_where.py": where },
    tools: toolsYml("pytest", "pytest", "unit"),
  });
  const planned = declared.cli(["plan", "--cwd", declared.project, "--only", "tool:pytest", "--json"]);
  const item = JSON.parse(planned.stdout).plan.groups.willRun.find((i) => i.id === "pytest#unit");
  assert.equal(item.toolSource?.origin, "project", JSON.stringify(item.toolSource));
  const { doc } = declared.run("pytest");
  assert.equal(doc.stages.find((s) => s.id === "pytest#unit")?.state, "completed", `${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
  assert.equal(found(doc, "pytest").length, 0, `the test passed under the project's interpreter: ${summary(doc)}`);
  assert.equal(doc.decision, "passed", summary(doc));

  const fallback = makeProject({
    files: { "pyproject.toml": PY_PROJECT, "tests/test_where.py": where.replace("startswith('/workspace/.venv')", "startswith('/opt/tools/python/')") },
    tools: toolsYml("pytest", "pytest", "unit"),
  });
  const planned2 = fallback.cli(["plan", "--cwd", fallback.project, "--only", "tool:pytest", "--json"]);
  assert.equal(JSON.parse(planned2.stdout).plan.groups.willRun.find((i) => i.id === "pytest#unit").toolSource?.origin, "image");
  const second = fallback.run("pytest");
  assert.equal(second.doc.decision, "passed", `${summary(second.doc)}\n${logsOf(second.doc).slice(-2500)}`);
});

scenario("build-check python (mypy): the type error is a located finding and the clean twin passes", {
  tool: "mypy",
  rule: { tool: "mypy", id: "arg-type", path: "app.py" },
  bad: { copy: path.join(BUILD_CHECK_FIXTURES, "python", "bad") },
  clean: { copy: path.join(BUILD_CHECK_FIXTURES, "python", "clean") },
});

scenario("build-check python (pyright): the type error is a located finding and the clean twin passes", {
  tool: "pyright",
  rule: { tool: "pyright", id: "reportArgumentType", path: "app.py" },
  bad: { copy: path.join(BUILD_CHECK_FIXTURES, "python-pyright", "bad") },
  clean: { copy: path.join(BUILD_CHECK_FIXTURES, "python-pyright", "clean") },
});

const IL_ARCHITECTURE = `schemaVersion: 1
architecture:
  layers:
    - id: domain
      paths: ["src/shop/domain/**"]
    - id: infrastructure
      paths: ["src/shop/infrastructure/**"]
  rules:
    - id: domain-independent
      kind: forbidden-dependency
      from: domain
      to: [infrastructure]
      enabled: true
      severity: high
      blocking: true
      owner: generated
`;
const IL_BASE = {
  "pyproject.toml": '[project]\nname = "shop"\nversion = "0.1.0"\n',
  "src/shop/__init__.py": "",
  "src/shop/domain/__init__.py": "",
  "src/shop/infrastructure/__init__.py": "",
  "src/shop/infrastructure/db.py": "def connect():\n    return 'db'\n",
};
const ilProject = (domain) => ({
  files: { ...IL_BASE, "src/shop/domain/model.py": domain, ".jgates/architecture.yml": IL_ARCHITECTURE },
  tools: toolsYml("import-linter", "import-linter", "architecture"),
});

scenario("import-linter: a domain module importing the infrastructure breaks the contract, and the clean domain passes", {
  tool: "import-linter",
  rule: { id: /domain-independent/ },
  bad: ilProject("from shop.infrastructure.db import connect\n\n\ndef load():\n    return connect()\n"),
  clean: ilProject("def load():\n    return 'model'\n"),
});

// ---------------------------------------------------------------------------------------------------------------------
// TypeScript and JavaScript
// ---------------------------------------------------------------------------------------------------------------------

scenario("build-check typescript (tsc): the type error is a located finding and the clean twin passes", {
  tool: "tsc",
  rule: { tool: "tsc", id: "TS2322", path: "src/index.ts" },
  bad: { copy: path.join(BUILD_CHECK_FIXTURES, "typescript", "bad") },
  clean: { copy: path.join(BUILD_CHECK_FIXTURES, "typescript", "clean") },
});

const VITEST_CONFIG = 'export default { test: { include: ["src/**/*.test.js"], globals: true } };\n';
const vitestProject = (assertion) => ({
  files: {
    "package.json": JSON.stringify({ name: "vt-fixture", private: true, type: "module" }, null, 2) + "\n",
    "vitest.config.js": VITEST_CONFIG,
    "src/math.js": "export function add(a, b) {\n  return a + b;\n}\n",
    "src/math.test.js": `import { add } from "./math.js";\n\ntest("adds two numbers", () => {\n  expect(add(1, 2)).toBe(${assertion});\n});\n`,
  },
  tools: toolsYml("vitest", "vitest", "unit"),
});

scenario("vitest: a failing test fails the step with its name and a passing suite passes", {
  tool: "vitest",
  rule: { id: /./, path: "src/math.test.js" },
  bad: vitestProject(4),
  clean: vitestProject(3),
  check: (doc, _p, kind) => {
    if (kind === "bad") assert.ok(found(doc, "vitest").some((f) => /adds two numbers/.test(`${f.message} ${f.ruleId}`)), summary(doc));
  },
});

const ESLINT_TOOLS = toolsYml("eslint", "eslint", "lint", "    config: eslint.config.mjs\n");
const ESLINT_CONFIG = 'export default [{ files: ["**/*.js"], rules: { "no-var": "error" } }];\n';
const eslintProject = (source) => ({
  files: { "package.json": JSON.stringify({ name: "es-fixture", private: true, type: "module" }) + "\n", "eslint.config.mjs": ESLINT_CONFIG, "src/index.js": source },
  tools: ESLINT_TOOLS,
});

scenario("eslint: a rule violation of the project's config is a finding and the clean source passes", {
  tool: "eslint",
  rule: { id: "no-var", path: "src/index.js" },
  bad: eslintProject("var counter = 1;\nexport const next = counter + 1;\n"),
  clean: eslintProject("const counter = 1;\nexport const next = counter + 1;\n"),
});

const BLOCK = [
  "export function compute(values) {",
  "  let total = 0;",
  "  for (const value of values) {",
  "    if (value > 10) {",
  "      total += value * 2;",
  "    } else {",
  "      total -= value;",
  "    }",
  "  }",
  "  const average = total / values.length;",
  '  console.log("average", average, total, values.length);',
  "  return average;",
  "}",
  "",
].join("\n");
const jscpdProject = (second) => ({
  files: { "package.json": JSON.stringify({ name: "dup-fixture", private: true, type: "module" }) + "\n", "src/a.js": BLOCK, "src/b.js": second, "jscpd.config.json": JSON.stringify({ minLines: 3, minTokens: 20 }) + "\n" },
  tools: toolsYml("jscpd", "jscpd", "duplication", "    config: jscpd.config.json\n"),
});

scenario("jscpd: a duplicated block is a finding and distinct code passes", {
  tool: "jscpd",
  rule: { id: "jscpd.duplicate", path: "src/a.js" },
  blocking: false,
  bad: jscpdProject(BLOCK),
  clean: jscpdProject("export const greeting = 'hello';\nexport function shout(text) {\n  return text.toUpperCase();\n}\n"),
});

const DC_TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2020", module: "commonjs" }, include: ["src"] }, null, 2) + "\n";
const DC_CYCLES = "schemaVersion: 1\narchitecture:\n  rules:\n    - id: no-import-cycles\n      kind: no-cycles\n      severity: high\n      blocking: true\n";
const dcProject = (b) => ({
  files: {
    "package.json": JSON.stringify({ name: "dc-fixture", private: true }) + "\n",
    "tsconfig.json": DC_TSCONFIG,
    "src/a.ts": 'import { b } from "./b";\n\nexport const a = (): string => b();\n',
    "src/b.ts": b,
    ".jgates/architecture.yml": DC_CYCLES,
  },
  tools: toolsYml("dependency-cruiser", "dependency-cruiser", "architecture"),
});

scenario("dependency-cruiser: an import cycle breaks the contract and the acyclic graph passes", {
  tool: "dependency-cruiser",
  rule: { id: /no-import-cycles/ },
  bad: dcProject('import { a } from "./a";\n\nexport const b = (): string => a();\n'),
  clean: dcProject('export const b = (): string => "b";\n'),
});

// ---------------------------------------------------------------------------------------------------------------------
// Other stacks of build-check
// ---------------------------------------------------------------------------------------------------------------------

scenario("build-check go: go build reports the error and the clean twin passes", {
  tool: "go-build",
  rule: { tool: "go", id: "go-build", path: "main.go" },
  bad: { copy: path.join(BUILD_CHECK_FIXTURES, "go", "bad") },
  clean: { copy: path.join(BUILD_CHECK_FIXTURES, "go", "clean") },
});

scenario("build-check rust: cargo check reports the error and the clean twin passes", {
  tool: "cargo-check",
  rule: { tool: "cargo", id: "E0308", path: "src/main.rs" },
  bad: { copy: path.join(BUILD_CHECK_FIXTURES, "rust", "bad") },
  clean: { copy: path.join(BUILD_CHECK_FIXTURES, "rust", "clean") },
});

scenario("build-check csharp: dotnet build reports the error and the clean twin passes", {
  tool: "dotnet-build",
  rule: { tool: "dotnet", id: "CS0029", path: "Program.cs" },
  bad: { copy: path.join(BUILD_CHECK_FIXTURES, "csharp", "bad") },
  clean: { copy: path.join(BUILD_CHECK_FIXTURES, "csharp", "clean") },
});

// ---------------------------------------------------------------------------------------------------------------------
// Mutation testing (mutmut) from a Windows host
// ---------------------------------------------------------------------------------------------------------------------

const MUT_FILES = {
  "pkg/__init__.py": "",
  "pkg/age.py": '"""The boundary is at 18: an adult is 18 or older."""\n\n\ndef is_adult(age):\n    return age >= 18\n\n\ndef price(total):\n    """Orders above 100 get a ten percent discount; exactly 100 does not."""\n    if total > 100:\n        return total - total / 10\n    return total\n',
  "setup.cfg": "[mutmut]\nsource_paths=pkg/\npytest_add_cli_args_test_selection=tests/\n",
};
const WEAK_TESTS = "from pkg.age import is_adult, price\n\n\ndef test_old_person_is_adult():\n    assert is_adult(40) is True\n\n\ndef test_child_is_not_adult():\n    assert is_adult(5) is False\n\n\ndef test_large_order_is_discounted():\n    assert price(200) == 180\n\n\ndef test_small_order_is_not():\n    assert price(50) == 50\n";
const STRONG_TESTS = `${WEAK_TESTS}\n\ndef test_boundary_age():\n    assert is_adult(18) is True\n    assert is_adult(17) is False\n\n\ndef test_boundary_price():\n    assert price(100) == 100\n    assert price(101) == 90.9\n`;
const mutationProject = (tests) => ({ files: { ...MUT_FILES, "tests/test_age.py": tests }, tools: toolsYml("mutation", "mutation", "mutation", "    engine: mutmut\n    minimumScore: 90\n") });

test("mutation (mutmut): from the host through the container, the weak suite leaves surviving mutants and the strengthened one kills them", () => {
  const metric = (doc, id) => (doc.metrics ?? []).find((m) => m.id === id);
  const weak = makeProject(mutationProject(WEAK_TESTS));
  const before = treeHash(weak.project);
  const w = weak.run("mutation");
  assertRanInContainers(w.doc, weak.ws);
  const weakStage = w.doc.stages.find((s) => s.id === "mutation#mutation");
  assert.equal(weakStage?.state, "completed", `${summary(w.doc)}\n${logsOf(w.doc).slice(-3000)}`);
  const weakScore = metric(w.doc, "mutation.score");
  assert.ok(weakScore.measured !== false && weakScore.denominator > 0, JSON.stringify(weakScore));
  assert.ok(weakScore.value < 90, `${weakScore.value}% is under the minimum`);
  assert.ok(metric(w.doc, "mutation.survived").value >= 2, "the two boundary mutants survive");
  assert.ok(metric(w.doc, "mutation.killed").value >= 1, "some mutants are killed");
  assert.ok(found(w.doc, "mutation").some((f) => f.ruleId === "mutation.survived" && f.location?.path === "pkg/age.py"), summary(w.doc));
  assert.equal(w.doc.decision, "failed");
  assert.equal(treeHash(weak.project), before, "the project folder is identical after the run");
  assert.ok(!fs.existsSync(path.join(weak.project, "mutants")), "mutmut worked in the run's copy, not in the project");

  const strong = makeProject(mutationProject(STRONG_TESTS));
  const s = strong.run("mutation");
  const strongStage = s.doc.stages.find((x) => x.id === "mutation#mutation");
  assert.equal(strongStage?.state, "completed", `${summary(s.doc)}\n${logsOf(s.doc).slice(-3000)}`);
  const strongScore = metric(s.doc, "mutation.score");
  assert.ok(strongScore.value > weakScore.value, `the strengthened suite scores higher (${strongScore.value} > ${weakScore.value})`);
  assert.ok(metric(s.doc, "mutation.survived").value < metric(w.doc, "mutation.survived").value);
});

// ---------------------------------------------------------------------------------------------------------------------
// Schemathesis against a target the container reaches on the host
// ---------------------------------------------------------------------------------------------------------------------

/** The fixture API in its own process (the CLI under test blocks this one while it runs), on every interface and both IP families: the container reaches the host through the engine's gateway, which may be IPv6. */
function startTarget(mode) {
  const module = pathToFileURL(path.join(RUNTIME_API_FIXTURES, "server.mjs")).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import { startServer } from ${JSON.stringify(module)}; const s = await startServer(${JSON.stringify(mode)}, { host: "::" }); console.log("listening " + s.port);`], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const m = /listening (\d+)/.exec(buffer);
      if (m) resolve({ port: Number(m[1]), close: () => new Promise((done) => (child.once("exit", done), child.kill())) });
    });
    child.once("exit", (code) => reject(new Error(`the fixture API exited with ${code}`)));
  });
}

test("schemathesis: a violating API is detected, a conforming one passes, through a network container", async () => {
  const servers = [];
  try {
    const spec = fs.readFileSync(path.join(RUNTIME_API_FIXTURES, "openapi.yaml"), "utf8");
    for (const mode of ["violating", "conforming"]) {
      const server = await startTarget(mode);
      servers.push(server);
      const p = makeProject({
        files: { "openapi.yaml": spec, "package.json": JSON.stringify({ name: "api-fixture", private: true }) + "\n" },
        // The user writes the address the host knows; the step container reaches the host through its alias.
        tools: toolsYml("schemathesis", "schemathesis", "api-contract", `    target: http://localhost:${server.port}\n    spec: openapi.yaml\n    maxExamples: 20\n`),
      });
      const before = treeHash(p.project);
      const { doc } = p.run("schemathesis");
      const stage = doc.stages.find((s) => s.id.startsWith("schemathesis#"));
      assert.ok(stage, summary(doc));
      assert.equal(treeHash(p.project), before);
      assert.ok(logsOf(doc).includes("--network bridge"), "the step container has the network the item declared");
      if (mode === "violating") {
        assert.ok(found(doc, "schemathesis").length > 0, `${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
        assert.notEqual(doc.decision, "passed");
      } else {
        assert.equal(stage.state, "completed", `${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
        assert.equal(found(doc, "schemathesis").length, 0, summary(doc));
        assert.equal(doc.decision, "passed", summary(doc));
      }
    }
  } finally {
    for (const server of servers) await server.close();
  }
});
