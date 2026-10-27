import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Vitest adapter: runs the project's tests with the JSON reporter and the v8 coverage provider, reports the
// tests executed and the line coverage with numerator and denominator, names the failing test in the finding, blocks
// the coverage stage (never installs) when the provider is absent, and leaves no coverage/ folder in the workspace.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const REPO_MODULES = path.join(repo, "node_modules");
const HAS_VITEST = fs.existsSync(path.join(REPO_MODULES, "vitest", "package.json"));
const adapter = await import(pathToFileURL(path.join(dist, "adapters", "vitest", "index.js")).href);

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const TOOLS = "schemaVersion: 1\ntools:\n  vitest:\n    adapter: vitest\n    capabilities: [unit, coverage]\n";

const SOURCE = "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function unused(): number {\n  return 1;\n}\n";
const PASSING = 'import { expect, test } from "vitest";\nimport { add } from "./math.js";\n\ntest("adds two numbers", () => {\n  expect(add(1, 2)).toBe(3);\n});\n\ntest("adds negatives", () => {\n  expect(add(-1, -2)).toBe(-3);\n});\n';
const FAILING = 'import { expect, test } from "vitest";\nimport { add } from "./math.js";\n\ntest("adds two numbers", () => {\n  expect(add(1, 2)).toBe(3);\n});\n\ntest("adds wrongly on purpose", () => {\n  expect(add(1, 2)).toBe(4);\n});\n';

/** node_modules for a fixture: the repository's own (with the provider), or one without @vitest/coverage-v8. */
function linkModules(dir, { withProvider }) {
  const target = path.join(dir, "node_modules");
  if (withProvider) {
    fs.symlinkSync(REPO_MODULES, target, "dir");
    return;
  }
  // A copy of vitest itself (it resolves its provider from its own location) and links to everything else.
  fs.mkdirSync(path.join(target, ".bin"), { recursive: true });
  fs.mkdirSync(path.join(target, "@vitest"));
  for (const name of fs.readdirSync(REPO_MODULES)) {
    if (name === ".bin" || name === "@vitest" || name.startsWith(".")) continue;
    const from = path.join(REPO_MODULES, name);
    if (name === "vitest") fs.cpSync(from, path.join(target, name), { recursive: true });
    else fs.symlinkSync(from, path.join(target, name), "dir");
  }
  for (const name of fs.readdirSync(path.join(REPO_MODULES, "@vitest"))) {
    if (name === "coverage-v8") continue;
    fs.symlinkSync(path.join(REPO_MODULES, "@vitest", name), path.join(target, "@vitest", name), "dir");
  }
  fs.symlinkSync(path.join("..", "vitest", "vitest.mjs"), path.join(target, ".bin", "vitest"));
}

function project({ testSource = PASSING, withProvider = true, capabilities = "unit, coverage", extraEnv = {} } = {}) {
  assert.ok(HAS_VITEST, "vitest is not installed in the repository node_modules: run `npm install` at the repository root");
  const dir = tmp("jgates-vt-ws-");
  const home = tmp("jgates-vt-home-");
  const emptyBin = tmp("jgates-vt-bin-");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "vt-fixture", private: true, type: "module" }, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "vitest.config.ts"), 'export default { test: { include: ["src/**/*.test.ts"] }, coverage: { include: ["src/**/*.ts"], exclude: ["src/**/*.test.ts"] } };\n');
  fs.writeFileSync(path.join(dir, "src", "math.ts"), SOURCE);
  fs.writeFileSync(path.join(dir, "src", "math.test.ts"), testSource);
  linkModules(dir, { withProvider });
  const env = { ...process.env, JGATES_HOME: home, PATH: emptyBin, ...extraEnv };
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input: "", timeout: 240_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  const init = cli(["init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), TOOLS.replace("unit, coverage", capabilities));
  const plan = () => cli(["plan", "--cwd", dir, "--only", "tool:vitest", "--json"]);
  const run = () => cli(["run", "--cwd", dir, "--only", "tool:vitest", "--no-interactive", "--json"]);
  const cleanup = () => {
    for (const d of [dir, home, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
  };
  return { dir, home, cli, plan, run, cleanup };
}

const metric = (doc, id) => (doc.metrics ?? []).find((m) => m.id === id);
const stage = (doc, id) => doc.stages.find((s) => s.id === id);
/** Files of the workspace outside node_modules and the JGates configuration the test itself wrote. */
const tree = (dir) => fs.readdirSync(dir).filter((n) => n !== "node_modules").sort();

test("a fixture with passing tests returns the tests executed and the line coverage with numerator and denominator [proves: vitest#unit, vitest#coverage]", () => {
  const p = project({ extraEnv: { JGATES_NO_CACHE: "1" } });
  try {
    const planned = p.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const items = planned.doc.plan.groups.willRun.filter((i) => i.adapter === "vitest");
    assert.deepEqual(items.map((i) => i.id).sort(), ["vitest#coverage", "vitest#unit"]);
    const args = items[0].command.args;
    assert.ok(args.includes("run") && args.includes("--reporter=json"));
    assert.ok(args.some((a) => a === "--coverage.provider=v8"));
    // Every output lands in the run folder; none in the project.
    const outputs = args.filter((a) => a.includes("outputFile") || a.includes("reportsDirectory"));
    assert.equal(outputs.length, 2);
    assert.ok(outputs.every((a) => a.includes("{runDir}/outputs/vitest/vitest")), JSON.stringify(outputs));
    assert.match(items[0].versions.toolVersion, /^\d+\.\d+\.\d+/);
    assert.ok(items[0].configFiles.some((f) => f.file === "vitest.config.ts" && /^sha256:/.test(f.sha256)));
    assert.equal(items[0].effects.executesProjectCode, true);

    const before = tree(p.dir);
    const ran = p.run();
    assert.equal(ran.code, 0, ran.out + ran.err);
    assert.equal(ran.doc.decision, "passed");
    assert.equal(stage(ran.doc, "vitest#unit").state, "completed");
    assert.equal(stage(ran.doc, "vitest#coverage").state, "completed");
    assert.equal(metric(ran.doc, "tests.executed").value, 2);
    assert.equal(metric(ran.doc, "tests.failed").value, 0);
    const lines = metric(ran.doc, "coverage.lines");
    // add() runs, unused() never does: the denominator counts the executable lines of src/math.ts.
    assert.ok(lines.denominator > 0 && lines.numerator > 0 && lines.numerator < lines.denominator, JSON.stringify(lines));
    assert.equal(lines.unit, "percent");
    assert.equal(lines.value, Math.round((lines.numerator / lines.denominator) * 10000) / 100);
    assert.equal(lines.origin, "vitest");
    assert.deepEqual(tree(p.dir), before, "nothing is left in the workspace");
    assert.ok(!fs.existsSync(path.join(p.dir, "coverage")), "no coverage/ folder in the workspace");
    assert.deepEqual(ran.doc.workspaceChanges.added, []);
    assert.ok(fs.existsSync(path.join(ran.doc.runDir, "outputs", "vitest", "vitest", "vitest.json")));
    assert.ok(fs.existsSync(path.join(ran.doc.runDir, "outputs", "vitest", "vitest", "coverage", "coverage-summary.json")));
  } finally {
    p.cleanup();
  }
});

test("a failing Vitest test fails the stage and the finding carries the test name, file and line", () => {
  const p = project({ testSource: FAILING, extraEnv: { JGATES_NO_CACHE: "1" } });
  try {
    const ran = p.run();
    assert.equal(ran.code, 1, ran.out + ran.err);
    assert.equal(ran.doc.decision, "failed");
    const unit = stage(ran.doc, "vitest#unit");
    assert.equal(unit.state, "completed");
    assert.equal(unit.blockingViolations, 1);
    const found = ran.doc.findings.filter((f) => f.tool === "vitest");
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.equal(found[0].ruleId, "vitest.test-failed");
    assert.match(found[0].message, /adds wrongly on purpose/);
    assert.equal(found[0].blocking, true);
    assert.equal(found[0].stageId, "vitest#unit");
    assert.equal(found[0].location.path, "src/math.test.ts");
    assert.equal(found[0].location.line, 9);
    assert.equal(metric(ran.doc, "tests.executed").value, 2);
    assert.equal(metric(ran.doc, "tests.failed").value, 1);
    // The coverage of a failed run is still reported (reportOnFailure).
    assert.ok(metric(ran.doc, "coverage.lines"));
    assert.ok(!fs.existsSync(path.join(p.dir, "coverage")));
  } finally {
    p.cleanup();
  }
});

test("without the coverage provider the coverage stage is blocked with the instruction, the tests still run and nothing is installed", () => {
  const p = project({ withProvider: false, extraEnv: { JGATES_NO_CACHE: "1" } });
  try {
    const planned = p.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = planned.doc.plan.groups.willRun.find((i) => i.id === "vitest#coverage");
    assert.ok(item);
    assert.ok(!item.command.args.some((a) => a.startsWith("--coverage")), "the plan does not ask for coverage the provider cannot give");
    assert.ok(item.conditions.some((c) => /@vitest\/coverage-v8/.test(c)), JSON.stringify(item.conditions));

    const ran = p.run();
    assert.equal(stage(ran.doc, "vitest#unit").state, "completed");
    const coverage = stage(ran.doc, "vitest#coverage");
    assert.equal(coverage.state, "blocked");
    assert.match(coverage.reason, /npm install --save-dev @vitest\/coverage-v8@\d+\.\d+\.\d+/);
    assert.match(coverage.reason, /não instala nada/);
    assert.equal(metric(ran.doc, "coverage.lines"), undefined);
    assert.equal(metric(ran.doc, "tests.executed").value, 2);
    assert.ok(!fs.existsSync(path.join(p.dir, "node_modules", "@vitest", "coverage-v8")), "the provider was not installed");
    assert.ok(!fs.existsSync(path.join(p.dir, "coverage")));
    assert.equal(fs.existsSync(path.join(p.dir, "package-lock.json")), false);
    assert.deepEqual(ran.doc.workspaceChanges.added, []);
  } finally {
    p.cleanup();
  }
});

test("only the unit capability runs without coverage flags and leaves no coverage stage", () => {
  const p = project({ capabilities: "unit", extraEnv: { JGATES_NO_CACHE: "1" } });
  try {
    const planned = p.plan();
    const items = planned.doc.plan.groups.willRun.filter((i) => i.adapter === "vitest");
    assert.deepEqual(items.map((i) => i.id), ["vitest#unit"]);
    assert.ok(!items[0].command.args.some((a) => a.startsWith("--coverage")));
    const ran = p.run();
    assert.equal(ran.code, 0, ran.out + ran.err);
    assert.equal(stage(ran.doc, "vitest#coverage"), undefined);
    assert.equal(metric(ran.doc, "coverage.lines"), undefined);
  } finally {
    p.cleanup();
  }
});

test("the plan says that vitest.config prevails over the Vite config in the same folder", () => {
  const p = project();
  try {
    fs.writeFileSync(path.join(p.dir, "vite.config.ts"), "export default {};\n");
    const planned = p.plan();
    const item = planned.doc.plan.groups.willRun.find((i) => i.id === "vitest#unit");
    assert.ok(item.conditions.some((c) => /vitest\.config\.ts prevalece sobre vite\.config\.ts/.test(c)), JSON.stringify(item.conditions));
    const files = item.configFiles.map((f) => f.file);
    assert.ok(files.includes("vitest.config.ts") && !files.includes("vite.config.ts"), JSON.stringify(files));
  } finally {
    p.cleanup();
  }
});

test("a Vitest run is never served from the cache (it executes project code)", () => {
  const p = project();
  try {
    const first = p.run();
    const second = p.run();
    assert.equal(first.code, 0, first.out + first.err);
    for (const doc of [first.doc, second.doc]) {
      const cache = stage(doc, "vitest#unit").cache;
      assert.equal(cache.status, "uncacheable");
      assert.equal(cache.code, "EXECUTES_PROJECT_CODE");
    }
  } finally {
    p.cleanup();
  }
});

test("the report parsers read failures, load errors and the coverage summary", () => {
  const report = JSON.stringify({
    numTotalTests: 3,
    numPassedTests: 1,
    numFailedTests: 1,
    numPendingTests: 1,
    numTodoTests: 0,
    success: false,
    testResults: [
      { name: "/ws/src/a.test.ts", status: "failed", assertionResults: [{ fullName: "suite works", title: "works", status: "failed", failureMessages: ["AssertionError: expected 1 to be 2\n    at /ws/src/a.test.ts:7:12"] }, { fullName: "ok", status: "passed", failureMessages: [] }] },
      { name: "/ws/src/b.test.ts", status: "failed", message: "Cannot find module './missing'", assertionResults: [] },
    ],
  });
  const parsed = adapter.parseVitestReport(report, "/ws");
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.counts, { total: 3, passed: 1, failed: 1, skipped: 1 });
  assert.equal(parsed.failures.length, 2);
  assert.deepEqual(parsed.failures[0], { name: "suite works", file: "src/a.test.ts", line: 7, column: 12, message: "AssertionError: expected 1 to be 2", suite: false });
  assert.equal(parsed.failures[1].suite, true);
  assert.equal(parsed.failures[1].file, "src/b.test.ts");
  assert.equal(adapter.parseVitestReport("not json", "/ws").ok, false);
  assert.equal(adapter.parseVitestReport("{}", "/ws").ok, false);
  const cov = adapter.parseLineCoverage('{"total":{"lines":{"total":10,"covered":4,"skipped":0,"pct":40}}}');
  assert.deepEqual(cov, { ok: true, lines: { covered: 4, total: 10 } });
  assert.equal(adapter.parseLineCoverage("{}").ok, false);
});
