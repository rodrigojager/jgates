import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Stack test runners (go-test, dotnet-test, cargo-test with cargo-llvm-cov, Jest, pytest, Vitest): unit and coverage on a
// known-bad fixture (a failing test and a coverage below the policy minimum) and a clean one; the integration selection
// (the unit step leaves it out, the integration step runs it alone, counts asserted); and the properties capability
// reported present for Hypothesis, fast-check, rapid, proptest and FsCheck. Everything goes through the real init, plan
// and run services. The runners are not on every machine that runs the default suite, so the override of each one points
// at tests/fixtures/test-stacks/replay.mjs, which replays what the REAL runner of the tools image printed and wrote for
// the fixture (recorded/<stack>.<kind>.<tool>.json, chosen by the content of the working folder and checked against the
// plan's command); tests/docker/adapters-tests.test.js runs the same fixtures live through the real engine.

// The services run in this process: their messages follow its locale.
process.env.JGATES_LOCALE = "en";
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const FIXTURES = path.join(here, "fixtures", "test-stacks");
const REPLAY = path.join(FIXTURES, "replay.mjs");
const MINIMUM = 80;
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const { planInit, writeInit } = await load("core", "init", "index.js");
const { buildPlan } = await load("core", "plan", "index.js");
const { executeRun } = await load("core", "run", "index.js");
const { planSteps, planDisabled } = await load("core", "run", "plan-run.js");
const goTest = await load("adapters", "go-test", "index.js");
const dotnetTest = await load("adapters", "dotnet-test", "index.js");
const jest = await load("adapters", "jest", "index.js");
const cargoTest = await load("adapters", "cargo-test", "index.js");
const selection = await load("core", "selection", "tests.js");
const manifests = await load("adapters", "manifests.js");
const matrix = await load("core", "matrix", "index.js");
const { imageJsonWithout } = await import(pathToFileURL(path.join(here, "setup", "image-json.mjs")).href);

const made = [];
const tmp = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** Node packages that stand for Vitest (with its v8 coverage provider) and Jest: their entry files load the replay. */
function standIns() {
  const modules = path.join(tmp("jgates-test-stacks-bin-"), "node_modules");
  const pkg = (dir, doc, entry) => {
    fs.mkdirSync(path.join(modules, dir, path.dirname(entry ?? "x")), { recursive: true });
    fs.writeFileSync(path.join(modules, dir, "package.json"), JSON.stringify(doc));
    if (entry) fs.writeFileSync(path.join(modules, dir, entry), `import ${JSON.stringify(pathToFileURL(REPLAY).href)};\n`);
  };
  pkg("vitest", { name: "vitest", version: "5.1.0" }, "vitest.mjs");
  pkg(path.join("@vitest", "coverage-v8"), { name: "@vitest/coverage-v8", version: "5.1.0" });
  pkg("jest", { name: "jest", version: "30.5.2" }, path.join("bin", "jest.mjs"));
  return { vitest: path.join(modules, "vitest", "vitest.mjs"), jest: path.join(modules, "jest", "bin", "jest.mjs") };
}

const home = tmp("jgates-test-stacks-home-");
const stand = standIns();
const baseEnv = {
  ...process.env,
  JGATES_HOME: home,
  JGATES_NO_CACHE: "1",
  NO_COLOR: "1",
  JGATES_LOCALE: "en",
  JGATES_GO: REPLAY,
  JGATES_DOTNET: REPLAY,
  JGATES_CARGO: REPLAY,
  JGATES_PYTEST: REPLAY,
  JGATES_VITEST: stand.vitest,
  JGATES_JEST: stand.jest,
};

function treeHash(root) {
  const h = crypto.createHash("sha256");
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === ".git" || e.name === ".jgates") continue;
      if (e.isDirectory()) {
        h.update(`d:${next}\0`);
        walk(p, next);
      } else h.update(`f:${next}\0`).update(fs.readFileSync(p));
    }
  };
  walk(root, "");
  return h.digest("hex");
}

/** A workspace with one fixture, initialized by the real init service (the test templates come by the stack's evidence), with the policy minimum. */
function workspace(stack, kind, { minimum = MINIMUM, tools = null } = {}) {
  const dir = tmp(`jgates-test-stacks-${stack}-${kind}-`);
  fs.cpSync(path.join(FIXTURES, stack, kind), dir, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  writeInit(dir, planInit(dir, "minimal"));
  if (minimum !== null) fs.writeFileSync(path.join(dir, ".jgates", "policy.yml"), `schemaVersion: 1\nrules:\n  coverage.minimum:\n    threshold: ${minimum}\n`);
  if (tools) fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), tools);
  return dir;
}

function plan(dir, tools, env = baseEnv, profile) {
  const built = buildPlan(dir, { only: tools.map((t) => `tool:${t}`), env, home, compare: false, version: "test", ...(profile ? { profile } : {}) });
  assert.equal(built.ok, true, JSON.stringify(built.errors ?? built.error));
  return built.plan;
}

function execute(dir, builtPlan, env = baseEnv) {
  return executeRun({
    workspacePath: dir,
    home,
    version: "test",
    adapter: "quality-bridge",
    options: { planHash: builtPlan.planHash, planSource: "built", profile: "minimal", scope: "full" },
    plan: builtPlan,
    steps: (context) => planSteps(context, builtPlan),
    disabled: planDisabled(builtPlan),
    env,
    cache: false,
  });
}

const metric = (doc, id, origin) => (doc.metrics ?? []).find((m) => m.id === id && (!origin || m.origin === origin));
const stage = (doc, id) => doc.stages.find((s) => s.id === id);
const summary = (doc) => JSON.stringify({ decision: doc.decision, stages: doc.stages.map((s) => [s.id, s.state, s.reason]), findings: doc.findings.map((f) => [f.ruleId, f.location?.path, f.message]) }).slice(0, 4000);

/** The known-bad fixture fails with a located finding of the failing test and a coverage finding below the minimum. */
async function proveBad({ stack, tool, adapter, test: failing, file }) {
  const dir = workspace(stack, "bad");
  const before = treeHash(dir);
  const built = plan(dir, [tool]);
  for (const cap of ["unit", "coverage"]) {
    const item = built.groups.willRun.find((i) => i.id === `${tool}#${cap}`);
    assert.ok(item, `${tool}#${cap} is in the plan of the ${stack} fixture`);
    assert.equal(item.adapter, adapter);
    assert.equal(item.availability.status, "available", item.availability.reason ?? "");
  }
  const doc = await execute(dir, built);
  assert.equal(doc.decision, "failed", summary(doc));
  const unit = stage(doc, `${tool}#unit`);
  assert.equal(unit.state, "completed", unit.reason);
  assert.notEqual(unit.interpreted, false, unit.reason);
  const hit = doc.findings.find((f) => f.origin === adapter && /test-failed$/.test(f.ruleId) && failing.test(f.message));
  assert.ok(hit, `the failing test is a finding: ${summary(doc)}`);
  assert.equal(hit.blocking, true);
  if (file) assert.equal(hit.location?.path, file, JSON.stringify(hit));
  const coverage = stage(doc, `${tool}#coverage`);
  assert.equal(coverage.state, "completed", coverage.reason);
  const cov = metric(doc, "coverage.lines", adapter);
  assert.ok(cov && cov.measured !== false && cov.value < MINIMUM && cov.denominator > 0, `coverage measured below the minimum: ${JSON.stringify(cov)}`);
  const below = doc.findings.find((f) => f.origin === adapter && /coverage-below-minimum$/.test(f.ruleId));
  assert.ok(below && below.stageId === `${tool}#coverage` && below.blocking, summary(doc));
  assert.equal(treeHash(dir), before, "the fixture is byte for byte the same");
}

/** The clean fixture passes: the unit step leaves the integration tests out, the integration step runs them alone, properties are present. */
async function proveClean({ stack, tool, adapter, unit, integration, properties, coverage = true, framework }) {
  const dir = workspace(stack, "clean");
  const before = treeHash(dir);
  const tools = [tool, `${tool}-integration`];
  const built = plan(dir, tools);
  const integrationItem = built.groups.willRun.find((i) => i.id === `${tool}-integration#integration`);
  assert.ok(integrationItem, `the integration instance is planned: ${built.groups.willRun.map((i) => i.id).join(", ")}`);
  assert.equal(integrationItem.availability.status, "available", integrationItem.availability.reason ?? "");
  const doc = await execute(dir, built);
  assert.equal(doc.decision, "passed", summary(doc));
  assert.equal(doc.findings.filter((f) => f.origin === adapter).length, 0, summary(doc));
  assert.equal(stage(doc, `${tool}#unit`).state, "completed");
  assert.equal(stage(doc, `${tool}-integration#integration`).state, "completed", stage(doc, `${tool}-integration#integration`).reason);
  const executed = (prefix) => metric(doc, `${prefix}.executed`, adapter)?.value ?? metric(doc, `${prefix}.total`, adapter)?.value;
  assert.equal(executed("tests"), unit, `the unit step ran only the unit tests: ${JSON.stringify(doc.metrics)}`);
  assert.equal(executed("tests.integration"), integration, `the integration step ran only the integration selection: ${JSON.stringify(doc.metrics)}`);
  const prop = stage(doc, `${tool}#properties`);
  assert.equal(prop.state, "completed", `the properties capability is present (${framework}): ${prop.reason}`);
  assert.match(prop.reason, new RegExp(framework));
  assert.equal(metric(doc, "tests.property.total", adapter).value, properties);
  assert.equal(metric(doc, "tests.property.failed", adapter).value, 0);
  if (coverage) {
    const cov = metric(doc, "coverage.lines", adapter);
    assert.ok(cov && cov.value >= MINIMUM, JSON.stringify(cov));
  }
  assert.equal(treeHash(dir), before, "the fixture is byte for byte the same");
}

test("go-test go: a failing test and a coverage below the minimum fail the run [proves: go-test#unit, go-test#unit@go, go-test#coverage, go-test#coverage@go]", async () => {
  await proveBad({ stack: "go", tool: "go-test", adapter: "go-test", test: /TestAdd\b/, file: "calc_test.go" });
});

test("go-test go: the clean module passes; the tagged integration tests run apart and rapid properties are present [proves: go-test#integration, go-test#integration@go, go-test#properties, go-test#properties@go]", async () => {
  await proveClean({ stack: "go", tool: "go-test", adapter: "go-test", unit: 3, integration: 2, properties: 1, framework: "rapid" });
});

test("cargo-test rust: cargo llvm-cov reports the failing test and a coverage below the minimum [proves: cargo-test#unit, cargo-test#unit@rust, cargo-test#coverage, cargo-test#coverage@rust]", async () => {
  await proveBad({ stack: "rust", tool: "cargo-test", adapter: "cargo-test", test: /adds_two_numbers/, file: "src/lib.rs" });
});

test("cargo-test rust: the clean crate passes; the tests/ targets run apart [proves: cargo-test#integration, cargo-test#integration@rust]", async () => {
  await proveClean({ stack: "rust", tool: "cargo-test", adapter: "cargo-test", unit: 3, integration: 2, properties: 1, framework: "proptest" });
});

test("dotnet-test csharp: a failing test and a coverlet coverage below the minimum fail the run [proves: dotnet-test#unit, dotnet-test#unit@csharp, dotnet-test#coverage, dotnet-test#coverage@csharp]", async () => {
  await proveBad({ stack: "csharp", tool: "dotnet-test", adapter: "dotnet-test", test: /AddsTwoNumbers/, file: "CalculatorTests.cs" });
});

test("dotnet-test csharp: the clean project passes; Category=Integration runs apart and FsCheck properties are present [proves: dotnet-test#integration, dotnet-test#integration@csharp, dotnet-test#properties, dotnet-test#properties@csharp]", async () => {
  await proveClean({ stack: "csharp", tool: "dotnet-test", adapter: "dotnet-test", unit: 3, integration: 2, properties: 1, framework: "FsCheck" });
});

test("jest javascript: a failing test and a coverage below the minimum fail the run [proves: jest#unit, jest#unit@javascript, jest#coverage, jest#coverage@javascript]", async () => {
  await proveBad({ stack: "jest", tool: "jest", adapter: "jest", test: /adds two numbers/, file: "src/calc.test.js" });
});

test("jest javascript: the clean project passes; the integration files run apart and fast-check properties are present [proves: jest#integration, jest#integration@javascript, jest#properties, jest#properties@javascript]", async () => {
  await proveClean({ stack: "jest", tool: "jest", adapter: "jest", unit: 3, integration: 2, properties: 1, framework: "fast-check" });
});

test("pytest python: tests/integration runs apart and Hypothesis properties are present [proves: pytest#integration, pytest#integration@python, pytest#properties, pytest#properties@python]", async () => {
  await proveClean({ stack: "python", tool: "pytest", adapter: "pytest", unit: 3, integration: 2, properties: 1, framework: "Hypothesis" });
});

test("vitest typescript: the integration files run apart and fast-check properties are present [proves: vitest#integration, vitest#integration@typescript, vitest#properties, vitest#properties@typescript]", async () => {
  await proveClean({ stack: "vitest", tool: "vitest", adapter: "vitest", unit: 3, integration: 2, properties: 1, framework: "fast-check" });
});

test("test runners: the unit command leaves the integration selection out and the integration command selects only it, per stack", () => {
  const args = (stack, tools) => {
    const built = plan(workspace(stack, "clean"), tools);
    return Object.fromEntries(built.invocations.map((i) => [i.id, i.command.args]));
  };
  const go = args("go", ["go-test", "go-test-integration"]);
  assert.ok(!go["go-test"].some((a) => a.startsWith("-tags")), "the unit run builds without the integration tag");
  assert.deepEqual(go["go-test-integration"].slice(-4), ["-tags=integration", "-run", "^(?:TestStoreRoundTrip|TestSumOfMany)$", "."]);
  const rust = args("rust", ["cargo-test", "cargo-test-integration"]);
  assert.ok(rust["cargo-test"].includes("--lib") && !rust["cargo-test"].includes("--test"));
  assert.deepEqual(rust["cargo-test-integration"].slice(-2), ["--test", "store"]);
  const cs = args("csharp", ["dotnet-test", "dotnet-test-integration"]);
  assert.ok(cs["dotnet-test"].includes("Category!=Integration") && cs["dotnet-test-integration"].includes("Category=Integration"));
  const js = args("jest", ["jest", "jest-integration"]);
  assert.ok(js.jest.some((a) => a.startsWith("--testPathIgnorePatterns=/") && a.includes("integration")), JSON.stringify(js.jest));
  assert.match(js["jest-integration"].at(-1), /integration/);
  const py = args("python", ["pytest", "pytest-integration"]);
  assert.ok(py.pytest.includes("--ignore=tests/integration"));
  assert.equal(py["pytest-integration"].at(-1), "tests/integration");
  const vt = args("vitest", ["vitest", "vitest-integration"]);
  assert.ok(vt.vitest.some((a) => a.startsWith("--exclude=")));
  assert.equal(vt["vitest-integration"].at(-1), "src/store.integration.test.ts");
});

test("test runners: tools.<id>.selection changes what counts as integration, and the unit instance follows its integration sibling", () => {
  const dir = workspace("python", "clean", {
    tools: "schemaVersion: 1\ntools:\n  pytest:\n    adapter: pytest\n    capabilities: [unit]\n  pytest-integration:\n    adapter: pytest\n    capabilities: [integration]\n    selection:\n      marker: slow\n",
  });
  fs.writeFileSync(path.join(dir, "tests", "test_slow.py"), "import pytest\n\n\n@pytest.mark.slow\ndef test_slow():\n    assert True\n");
  const built = plan(dir, ["pytest", "pytest-integration"]);
  const byId = Object.fromEntries(built.invocations.map((i) => [i.id, i.command.args]));
  assert.deepEqual(byId.pytest.slice(-2), ["-m", "not slow"], "the unit instance leaves the sibling's selection out");
  assert.deepEqual(byId["pytest-integration"].slice(-2), ["-m", "slow"]);
});

test("test runners: without integration tests the integration step does not apply, starts nothing and never blocks, and the unit command is the plain suite", async () => {
  const dir = workspace("go", "bad");
  const built = plan(dir, ["go-test", "go-test-integration"], baseEnv, "builtin:strict");
  const item = built.groups.willRun.find((i) => i.id === "go-test-integration#integration");
  assert.ok(item, built.groups.willRun.map((i) => i.id).join(", "));
  assert.ok(item.conditions.some((c) => /No integration test matches/.test(c)), JSON.stringify(item.conditions));
  const unit = built.invocations.find((i) => i.id === "go-test");
  assert.deepEqual(unit.command.args.slice(-1), ["./..."]);
  // Only the integration instance: no process starts (the replay knows no integration command for this fixture).
  const only = plan(dir, ["go-test-integration"]);
  const doc = await execute(dir, only);
  const st = stage(doc, "go-test-integration#integration");
  assert.equal(st.state, "not_applicable", summary(doc));
  assert.match(st.reason, /No integration test matches/);
  assert.notEqual(doc.decision, "incomplete", summary(doc));
  assert.notEqual(doc.decision, "failed", summary(doc));
});

test("test runners: an instance that asks for unit and integration together runs the unit tests and blocks the integration stage with the reason", async () => {
  const dir = workspace("go", "clean", { tools: "schemaVersion: 1\ntools:\n  go-test:\n    adapter: go-test\n    capabilities: [unit, coverage, properties, integration]\n" });
  const doc = await execute(dir, plan(dir, ["go-test"]));
  assert.equal(stage(doc, "go-test#unit").state, "completed");
  const integration = stage(doc, "go-test#integration");
  assert.equal(integration.state, "blocked");
  assert.match(integration.reason, /instance of their own/);
  assert.notEqual(doc.decision, "passed");
});

test("test runners: a runner the image lacks, or a Jest the project does not declare, is a blocked stage with the cause, never a pass", async () => {
  for (const [stack, tool, imageTool, envName] of [["go", "go-test", "go", "JGATES_GO"], ["csharp", "dotnet-test", "dotnet", "JGATES_DOTNET"]]) {
    const dir = workspace(stack, "bad");
    const env = { ...baseEnv, [envName]: "", JGATES_IMAGE_JSON: imageJsonWithout(imageTool) };
    const built = plan(dir, [tool], env);
    const item = built.groups.willRun.find((i) => i.id === `${tool}#unit`);
    assert.equal(item.availability.status, "unavailable", tool);
    assert.match(item.availability.reason, /jgates setup/, tool);
    const doc = await execute(dir, built, env);
    assert.equal(stage(doc, `${tool}#unit`).state, "blocked", tool);
    assert.notEqual(doc.decision, "passed", tool);
  }
  const dir = workspace("jest", "bad");
  const env = { ...baseEnv, JGATES_JEST: "" };
  const built = plan(dir, ["jest"], env);
  const item = built.groups.willRun.find((i) => i.id === "jest#unit");
  assert.equal(item.availability.status, "unavailable");
  assert.match(item.availability.reason, /devDependencies/);
  const doc = await execute(dir, built, env);
  assert.equal(stage(doc, "jest#unit").state, "blocked");
  assert.notEqual(doc.decision, "passed");
});

test("test runners: a command or a fixture that is not the recorded one gets no answer, so a drift cannot pass unnoticed", async () => {
  const dir = workspace("go", "clean");
  fs.writeFileSync(path.join(dir, "calc.go"), "package calc\n\nfunc Add(a, b int) int { return a + b }\n");
  const doc = await execute(dir, plan(dir, ["go-test"]));
  assert.equal(stage(doc, "go-test#unit").state, "error", summary(doc));
  assert.notEqual(doc.decision, "passed");
});

test("test runner parsers: go test -json, coverprofile, TRX, Cobertura, llvm-cov and Jest results; anything unexplained fails closed", () => {
  const recorded = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, "recorded", name), "utf8"));
  const goBad = recorded("go.bad.go-test.json");
  const reading = goTest.parseGoTestJson(goBad.stdout, () => "");
  assert.deepEqual(reading.cases.map((c) => [c.name, c.status]).sort(), [["example.com/calc.TestAdd", "failed"], ["example.com/calc.TestAddZero", "passed"]]);
  assert.equal(reading.cases.find((c) => c.status === "failed").line, 7);
  assert.equal(goTest.parseGoTestJson("not json\n", () => "").ok, false);
  const build = goTest.parseGoTestJson('{"Action":"build-fail","ImportPath":"example.com/x"}\n{"Action":"fail","Package":"example.com/x","FailedBuild":"example.com/x"}\n', () => "x");
  assert.deepEqual(build.cases.map((c) => [c.suite, c.status]), [[true, "failed"]], "a package that does not build is a failing suite");
  const profile = goTest.parseCoverProfile("mode: set\nexample.com/calc/calc.go:4.24,6.2 1 1\nexample.com/calc/calc.go:9.38,10.17 1 0\nexample.com/calc/calc.go:9.38,10.17 1 1\nexample.com/calc/calc.go:12.2,12.15 2 0\n");
  assert.deepEqual([profile.covered, profile.total], [2, 4]);
  assert.equal(goTest.parseCoverProfile("garbage").ok, false);

  const trx = dotnetTest.parseTrx(['<TestRun><Results><UnitTestResult testName="A.B.Fails" outcome="Failed"><Output><ErrorInfo><Message>Assert.Equal() Failure&#xD;&#xA;Expected: 5</Message><StackTrace>at A.B.Fails() in /workspace/T.cs:line 12</StackTrace></ErrorInfo></Output></UnitTestResult><UnitTestResult testName="A.B.Ok" outcome="Passed" /></Results></TestRun>'], (p) => (p.startsWith("/workspace/") ? p.slice(11) : null));
  assert.deepEqual(trx.cases.map((c) => [c.name, c.status, c.file, c.line]), [["A.B.Fails", "failed", "T.cs", 12], ["A.B.Ok", "passed", null, null]]);
  assert.equal(dotnetTest.parseTrx([], () => null).ok, false, "no TRX is no report");
  assert.equal(dotnetTest.parseTrx(["<html/>"], () => null).ok, false);
  const cob = dotnetTest.parseCobertura(['<coverage line-rate="0.5" lines-covered="3" lines-valid="6">']);
  assert.deepEqual([cob.covered, cob.total], [3, 6]);
  assert.equal(dotnetTest.parseCobertura(["<coverage>"]).ok, false);
  assert.deepEqual(dotnetTest.fsCheckProperties("using FsCheck.Xunit;\nclass T {\n  [Property]\n  public bool P(int a) => true;\n  [Fact]\n  public void F() {}\n  public void Q() { Prop.ForAll<int>(x => true).QuickCheckThrowOnFailure(); }\n}\n").names, ["P", "Q"]);

  assert.deepEqual(cargoTest.parseLlvmCovSummary('{"data":[{"totals":{"lines":{"count":10,"covered":7,"percent":70}}}]}'), { ok: true, covered: 7, total: 10 });
  assert.equal(cargoTest.parseLlvmCovSummary(null).ok, false);
  assert.equal(cargoTest.parseLlvmCovSummary('{"data":[]}').ok, false);

  const jestBad = recorded("jest.bad.jest.json");
  const results = jest.readJestResults(jestBad.files["outputs/jest/jest/jest.json"], "/workspace");
  assert.deepEqual(results.cases.map((c) => [c.title, c.status, c.file]).sort(), [["adds two numbers", "failed", "src/calc.test.js"], ["adds zero", "passed", "src/calc.test.js"]]);
  assert.equal(jest.readJestResults(null, "/w").ok, false);
  assert.deepEqual(goTest.goPropertyTests('package x\n\nimport (\n\t"testing"\n\tq "testing/quick"\n)\n\nfunc TestP(t *testing.T) {\n\tq.Check(func(a int) bool { return true }, nil)\n}\n\nfunc TestPlain(t *testing.T) {}\n').names, ["TestP"]);
});

test("test selection: globs, Go build tags, Rust targets and .NET categories are read statically", () => {
  const re = selection.globToRegExp(selection.DEFAULT_NODE_PATTERN);
  assert.ok(re.test("src/store.integration.test.ts") && re.test("a.integration.spec.js"));
  assert.ok(!re.test("src/calc.test.ts"));
  assert.equal(selection.jestPathRegex("**/*.it.js"), "/[^/]*\\.it\\.js$");
  assert.equal(selection.goFileHasTag("//go:build integration && linux\n\npackage x\n", "integration"), true);
  assert.equal(selection.goFileHasTag("//go:build !integration\n\npackage x\n", "integration"), false);
  assert.equal(selection.goFileHasTag("package x\n//go:build integration\n", "integration"), false, "a constraint after the package clause does not count");
  assert.deepEqual(selection.rustTestTargets(path.join(FIXTURES, "rust", "clean")), ["store"]);
  assert.ok(selection.dotnetCategoryPattern("Integration").test('[Trait("Category", "Integration")]'));
  assert.ok(selection.dotnetCategoryPattern("Integration").test('[Category("Integration")]'));
  assert.ok(!selection.dotnetCategoryPattern("Integration").test('[Trait("Kind", "Integration")]'));
});

test("test runners: the support matrix shows unit, coverage, integration and properties validated per stack, with their proof", () => {
  const built = matrix.buildMatrix(manifests.builtinManifests());
  const expect = [
    ["go-test", "go", ["unit", "coverage", "integration", "properties"]],
    ["dotnet-test", "csharp", ["unit", "coverage", "integration", "properties"]],
    ["jest", "javascript", ["unit", "coverage", "integration", "properties"]],
    ["cargo-test", "rust", ["unit", "coverage", "integration", "properties"]],
    ["pytest", "python", ["integration", "properties"]],
    ["vitest", "typescript", ["integration", "properties"]],
  ];
  for (const [adapter, stack, caps] of expect) {
    for (const cap of caps) {
      const row = built.rows.find((r) => r.adapter === adapter && r.capability === cap && r.stack === stack);
      assert.equal(row?.state, "validated", `${adapter}#${cap}@${stack}`);
      assert.ok(row.evidence.tests.length > 0, `${adapter}#${cap}@${stack} has a proving test`);
    }
    assert.deepEqual(matrix.verifyMatrix(built).filter((p) => p.includes(adapter)), [], adapter);
  }
});
