import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// build-check adapter: for each stack declared validated, a fixture with a type error yields a located, blocking
// finding and its clean twin none, through the real plan and run services and the real toolchain of this machine
// (tsc, mypy, pyright, go, cargo, dotnet). A checker that is not installed is a blocked stage with the way to get it,
// never a pass; the parsers are fail-closed. Python's checkers come from a virtual environment this test creates in
// the temp folder (JGATES_MYPY / JGATES_PYRIGHT point at ready ones).

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const FIXTURES = path.join(here, "fixtures", "build-check");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const { planInit, writeInit } = await load("core", "init", "index.js");
const { buildPlan } = await load("core", "plan", "index.js");
const { executeRun } = await load("core", "run", "index.js");
const { planSteps, planDisabled } = await load("core", "run", "plan-run.js");
const adapter = await load("adapters", "build-check", "index.js");

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const home = tmp("jgates-bc-home-");
const baseEnv = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1", NO_COLOR: "1" };

/** mypy and pyright from a throwaway virtual environment (or the ones JGATES_MYPY / JGATES_PYRIGHT name). */
let pythonTools = null;
function pythonEnv() {
  if (pythonTools) return pythonTools;
  if (process.env.JGATES_MYPY && process.env.JGATES_PYRIGHT) return (pythonTools = {});
  const venv = path.join(tmp("jgates-bc-venv-"), "venv");
  const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", timeout: 600_000 });
  const created = run(process.platform === "win32" ? "python" : "python3", ["-m", "venv", venv]);
  assert.equal(created.status, 0, `python -m venv failed: ${created.stderr}`);
  const bin = path.join(venv, process.platform === "win32" ? "Scripts" : "bin");
  const py = path.join(bin, process.platform === "win32" ? "python.exe" : "python");
  const installed = run(py, ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "mypy", "pyright"]);
  assert.equal(installed.status, 0, `pip install mypy pyright failed (the Python checkers need the network once): ${installed.stderr}`);
  const exe = process.platform === "win32" ? ".exe" : "";
  pythonTools = { JGATES_MYPY: path.join(bin, `mypy${exe}`), JGATES_PYRIGHT: path.join(bin, `pyright${exe}`) };
  return pythonTools;
}

/** A workspace with one fixture, initialized by the real init service (the template of the stack comes by evidence). */
function workspace(stack, kind) {
  const dir = tmp(`jgates-bc-${stack}-${kind}-`);
  fs.cpSync(path.join(FIXTURES, stack, kind), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  writeInit(dir, planInit(dir, "minimal"));
  return dir;
}

function plan(dir, tool, env = baseEnv) {
  const built = buildPlan(dir, { only: [`tool:${tool}`], env, home, compare: false, version: "test" });
  assert.equal(built.ok, true, JSON.stringify(built.errors ?? built.error));
  return built.plan;
}

function run(dir, builtPlan, env = baseEnv) {
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

/** The known-bad fixture fails with one located blocking finding; its clean twin passes with none. */
async function proveStack({ stack, tool, file, line, ruleId, env = baseEnv, minimumFindings = 1 }) {
  const bad = workspace(stack, "bad");
  const badPlan = plan(bad, tool, env);
  const item = badPlan.groups.willRun.find((i) => i.id === `${tool}#typecheck`);
  assert.ok(item, `${tool}#typecheck is in the plan of the ${stack} fixture`);
  assert.equal(item.category, "quality");
  assert.equal(item.availability.status, "available", item.availability.reason ?? "");
  const failed = await run(bad, badPlan, env);
  assert.equal(failed.decision, "failed");
  const stage = failed.stages.find((s) => s.id === `${tool}#typecheck`);
  assert.equal(stage.state, "completed", stage.reason);
  assert.notEqual(stage.interpreted, false);
  const found = failed.findings.filter((f) => f.tool === item.versions.tool || f.origin === "build-check");
  assert.ok(found.length >= minimumFindings, `the type error is a finding (${JSON.stringify(failed.findings)})`);
  const hit = found.find((f) => f.ruleId === ruleId) ?? found[0];
  assert.equal(hit.category, "typecheck");
  assert.equal(hit.blocking, true);
  assert.equal(hit.normalizedSeverity, "high");
  assert.equal(hit.location.path, file);
  assert.equal(hit.location.line, line);
  if (ruleId) assert.equal(hit.ruleId, ruleId);
  assert.ok(hit.message.length > 0);

  const clean = workspace(stack, "clean");
  const passed = await run(clean, plan(clean, tool, env), env);
  assert.equal(passed.decision, "passed", JSON.stringify(passed.stages));
  assert.equal(passed.findings.filter((f) => f.origin === "build-check").length, 0);
  const cleanStage = passed.stages.find((s) => s.id === `${tool}#typecheck`);
  assert.equal(cleanStage.state, "completed");
  assert.equal(cleanStage.interpreted !== false, true);
}

test("build-check typescript: tsc reports the type error with its location and the clean twin none [proves: build-check#typecheck, build-check#typecheck@typescript]", async (t) => {
  const probe = adapter.probeChecker("tsc", FIXTURES, null, process.env);
  assert.ok(probe.executable && probe.version, `tsc is installed on this machine (${probe.detail})`);
  t.diagnostic(`tsc ${probe.version}`);
  await proveStack({ stack: "typescript", tool: "tsc", file: "src/index.ts", line: 1, ruleId: "TS2322" });
});

test("build-check python (mypy): the type error is a located finding and the clean twin none [proves: build-check#typecheck, build-check#typecheck@python]", async (t) => {
  const env = { ...baseEnv, ...pythonEnv() };
  const probe = adapter.probeChecker("mypy", FIXTURES, null, env);
  assert.ok(probe.executable && probe.version, `mypy answers (${probe.detail})`);
  t.diagnostic(`mypy ${probe.version}`);
  await proveStack({ stack: "python", tool: "mypy", file: "app.py", line: 5, ruleId: "arg-type", env });
});

test("build-check python (pyright): the type error is a located finding and the clean twin none [proves: build-check#typecheck, build-check#typecheck@python]", async (t) => {
  const env = { ...baseEnv, ...pythonEnv() };
  const probe = adapter.probeChecker("pyright", FIXTURES, null, env);
  assert.ok(probe.executable && probe.version, `pyright answers (${probe.detail})`);
  t.diagnostic(`pyright ${probe.version}`);
  await proveStack({ stack: "python-pyright", tool: "pyright", file: "app.py", line: 5, ruleId: "reportArgumentType", env });
});

test("build-check go: go build reports the type error with its location and the clean twin none [proves: build-check#typecheck, build-check#typecheck@go]", async (t) => {
  const probe = adapter.probeChecker("go", FIXTURES, null, process.env);
  assert.ok(probe.executable && probe.version, `go is installed on this machine (${probe.detail})`);
  t.diagnostic(`go ${probe.version}`);
  await proveStack({ stack: "go", tool: "go-build", file: "main.go", line: 4, ruleId: "go-build" });
});

test("build-check rust: cargo check reports the type error with its location and the clean twin none [proves: build-check#typecheck, build-check#typecheck@rust]", async (t) => {
  const probe = adapter.probeChecker("cargo", FIXTURES, null, process.env);
  assert.ok(probe.executable && probe.version, `cargo is installed on this machine (${probe.detail})`);
  t.diagnostic(`cargo ${probe.version}`);
  await proveStack({ stack: "rust", tool: "cargo-check", file: "src/main.rs", line: 2, ruleId: "E0308" });
});

test("build-check csharp: dotnet build reports the type error with its location and the clean twin none [proves: build-check#typecheck, build-check#typecheck@csharp]", async (t) => {
  const probe = adapter.probeChecker("dotnet", FIXTURES, null, process.env);
  assert.ok(probe.executable && probe.version, `dotnet is installed on this machine (${probe.detail})`);
  t.diagnostic(`dotnet ${probe.version}`);
  await proveStack({ stack: "csharp", tool: "dotnet-build", file: "Program.cs", line: 1, ruleId: "CS0029" });
});

test("build-check: a stack whose checker is missing is blocked with the way to get it and never passed", async () => {
  const dir = workspace("typescript", "bad");
  const env = { ...baseEnv, JGATES_TSC: path.join(home, "no-such-tsc") };
  const built = plan(dir, "tsc", env);
  const item = built.groups.willRun.find((i) => i.id === "tsc#typecheck");
  assert.equal(item.availability.status, "unavailable");
  assert.match(item.availability.reason, /npm install/);
  const result = await run(dir, built, env);
  assert.equal(result.stages.find((s) => s.id === "tsc#typecheck").state, "blocked");
  assert.notEqual(result.decision, "passed");
  assert.equal(result.findings.length, 0);

  const goEnv = { ...baseEnv, JGATES_GO: path.join(home, "no-such-go") };
  const goDir = workspace("go", "clean");
  const goItem = plan(goDir, "go-build", goEnv).groups.willRun.find((i) => i.id === "go-build#typecheck");
  assert.equal(goItem.availability.status, "unavailable");
  assert.match(goItem.availability.reason, /go\.dev\/doc\/install/);
});

test("build-check: a component without the evidence of the checker is skipped and said so, never passed", () => {
  const dir = workspace("typescript", "clean");
  fs.rmSync(path.join(dir, "tsconfig.json"));
  // Still a TypeScript component (it depends on typescript), but without the tsconfig.json that tsc needs.
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "bc-ts-noconfig", private: true, devDependencies: { typescript: "^5.0.0" } }));
  // The template no longer matches without a tsconfig.json; an explicit instance shows the unit as skipped.
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  tsc:\n    adapter: build-check\n    capabilities: [typecheck]\n    checker: tsc\n");
  const item = plan(dir, "tsc").groups.willRun.find((i) => i.id === "tsc#typecheck");
  assert.ok(item, "the explicit instance is in the plan");
  assert.equal(item.availability.status, "unavailable");
  assert.match(item.availability.reason, /tsconfig\.json/);
});

test("build-check: an invalid checker or tsconfig setting refuses the plan instead of guessing", () => {
  const dir = workspace("typescript", "clean");
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  tsc:\n    adapter: build-check\n    capabilities: [typecheck]\n    checker: rustc\n");
  const built = buildPlan(dir, { only: ["tool:tsc"], env: baseEnv, home, compare: false, version: "test" });
  const refused = built.ok === false || built.plan.groups.willRun.find((i) => i.id === "tsc#typecheck")?.availability.status === "unavailable";
  assert.equal(refused, true);
  const settings = adapter.buildCheckSettings({ tool: "tsc", config: { tools: { tsc: { checker: "tsc", tsconfig: "../outside.json" } } } });
  assert.equal(settings.problems.length, 1);
  assert.match(settings.problems[0], /tsconfig/);
});

test("build-check: the parsers are fail-closed (an exit without a located error, a missing summary or an unlocated error proves nothing)", () => {
  assert.equal(adapter.parseTsc("", 2).ok, false);
  assert.equal(adapter.parseTsc("error TS5083: Cannot read file 'tsconfig.json'.\n", 1).ok, false);
  assert.equal(adapter.parseTsc("", 0).ok, true);
  assert.equal(adapter.parseMypy("mypy: can't read file 'x.py'\n", 2).ok, false);
  assert.equal(adapter.parseMypy("", 1).ok, false);
  assert.equal(adapter.parsePyright("{}", 0).ok, false);
  assert.equal(adapter.parsePyright("not json", 1).ok, false);
  assert.equal(adapter.parseGo("go: no go.mod found\n", 1, "go-build").ok, false);
  assert.equal(adapter.parseCargo("", 101).ok, false);
  assert.equal(adapter.parseCargo('{"reason":"build-finished","success":false}\n', 101).ok, false);
  assert.equal(adapter.parseDotnet("MSBUILD : error MSB1009: Project file does not exist.\n", 1).ok, false);
  const located = adapter.parseTsc("src/a.ts(3,14): error TS2322: Type 'string' is not assignable to type 'number'.\n", 2);
  assert.equal(located.ok, true);
  assert.deepEqual([located.diagnostics[0].file, located.diagnostics[0].line, located.diagnostics[0].column, located.diagnostics[0].ruleId], ["src/a.ts", 3, 14, "TS2322"]);
});
