import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// format-check adapter: for each of the five stacks, a fixture whose code is not formatted yields a located, blocking
// finding for the file the formatter would change, and its formatted twin none, through the real init, plan and run
// services and the real formatter of this machine (ruff, prettier, gofmt, cargo fmt, dotnet format). The formatters
// run in check mode only, so the fixture is byte for byte the same afterwards. A formatter that is not in the tools
// image is a blocked stage with the way to get it, never a pass; the parsers are fail-closed.
// Ruff and prettier come from the repository's virtual environment / a temporary npm install when this machine has
// none on its PATH (JGATES_RUFF / JGATES_PRETTIER point at ready ones).

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const FIXTURES = path.join(here, "fixtures", "format-check");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const { planInit, writeInit } = await load("core", "init", "index.js");
const { buildPlan } = await load("core", "plan", "index.js");
const { executeRun } = await load("core", "run", "index.js");
const { planSteps, planDisabled } = await load("core", "run", "plan-run.js");
const adapter = await load("adapters", "format-check", "index.js");
const manifests = await load("adapters", "manifests.js");
const matrix = await load("core", "matrix", "index.js");
const { imageJsonWithout, releaseImageJson } = await import(pathToFileURL(path.join(here, "setup", "image-json.mjs")).href);

const made = [];
const tmp = (prefix) => {
  // The real (long) spelling of the folder: the formatters print the paths they resolved.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const home = tmp("jgates-fc-home-");
const baseEnv = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1", NO_COLOR: "1", JGATES_LOCALE: "en" };

const exe = process.platform === "win32" ? ".exe" : "";
const run = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 600_000, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd), ...options });

/** ruff: the one this machine's PATH or the repository's virtual environment has, else a throwaway virtual environment. */
let ruffEnv = null;
function formatterEnv() {
  if (ruffEnv) return ruffEnv;
  const env = {};
  const repo = path.resolve(here, "..", "..");
  const candidates = [process.env.JGATES_RUFF, path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin", `ruff${exe}`)].filter(Boolean);
  let ruff = candidates.find((c) => fs.existsSync(c) && run(c, ["--version"]).status === 0);
  if (!ruff && run("ruff", ["--version"]).status === 0) ruff = "ruff";
  if (!ruff) {
    const venv = path.join(tmp("jgates-fc-venv-"), "venv");
    assert.equal(run(process.platform === "win32" ? "python" : "python3", ["-m", "venv", venv]).status, 0, "python -m venv failed");
    const bin = path.join(venv, process.platform === "win32" ? "Scripts" : "bin");
    const installed = run(path.join(bin, `python${exe}`), ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "ruff"]);
    assert.equal(installed.status, 0, `pip install ruff failed (ruff needs the network once): ${installed.stderr}`);
    ruff = path.join(bin, `ruff${exe}`);
  }
  env.JGATES_RUFF = ruff;
  // prettier: the one named, or one on the PATH, else the version of the image installed once into a throwaway folder.
  let prettier = process.env.JGATES_PRETTIER;
  if (!prettier) {
    const dir = tmp("jgates-fc-prettier-");
    const version = releaseImageJson().tools.prettier;
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"prettier-holder","private":true}\n');
    const installed = run(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund", "--loglevel", "error", `prettier@${version}`], { cwd: dir });
    assert.equal(installed.status, 0, `npm install prettier failed (prettier needs the network once): ${installed.stderr}`);
    prettier = path.join(dir, "node_modules", "prettier", "bin", "prettier.cjs");
  }
  env.JGATES_PRETTIER = prettier;
  ruffEnv = env;
  return env;
}

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

/** A workspace with one fixture, initialized by the real init service (the template of the stack comes by its language). */
function workspace(stack, kind) {
  const dir = tmp(`jgates-fc-${stack}-${kind}-`);
  fs.cpSync(path.join(FIXTURES, stack, kind), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  writeInit(dir, planInit(dir, "minimal"));
  return dir;
}

function plan(dir, tool, env) {
  const built = buildPlan(dir, { only: [`tool:${tool}`], env, home, compare: false, version: "test" });
  assert.equal(built.ok, true, JSON.stringify(built.errors ?? built.error));
  return built.plan;
}

function execute(dir, builtPlan, env) {
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

/** The unformatted fixture fails with a located blocking finding on its file; the formatted twin passes with none; neither is rewritten. */
async function proveStack({ stack, tool, file, extraEnv = {} }) {
  const env = { ...baseEnv, ...formatterEnv(), ...extraEnv };
  const stage = `${tool}#format-check`;

  const bad = workspace(stack, "bad");
  const badBefore = treeHash(bad);
  const badPlan = plan(bad, tool, env);
  const item = badPlan.groups.willRun.find((i) => i.id === stage);
  assert.ok(item, `${stage} is in the plan of the ${stack} fixture`);
  assert.equal(item.category, "quality");
  assert.equal(item.adapter, "format-check");
  assert.equal(item.availability.status, "available", item.availability.reason ?? "");
  const failed = await execute(bad, badPlan, env);
  assert.equal(failed.decision, "failed", JSON.stringify(failed.stages));
  const failedStage = failed.stages.find((s) => s.id === stage);
  assert.equal(failedStage.state, "completed", failedStage.reason);
  assert.notEqual(failedStage.interpreted, false);
  const found = failed.findings.filter((f) => f.origin === "format-check");
  assert.ok(found.length >= 1, `the unformatted file is a finding (${JSON.stringify(failed.findings)})`);
  const hit = found.find((f) => f.location?.path === file);
  assert.ok(hit, `a finding on ${file}: ${JSON.stringify(found.map((f) => f.location))}`);
  assert.equal(hit.ruleId, "format-check.unformatted");
  assert.equal(hit.category, "format-check");
  assert.equal(hit.blocking, true);
  assert.equal(hit.tool, { "ruff-format": "ruff", prettier: "prettier", "prettier-data": "prettier", gofmt: "gofmt", "cargo-fmt": "rustfmt", "dotnet-format": "dotnet-format" }[tool]);
  assert.equal(treeHash(bad), badBefore, "the formatter ran in check mode: the fixture is byte for byte the same");

  const clean = workspace(stack, "clean");
  const cleanBefore = treeHash(clean);
  const passed = await execute(clean, plan(clean, tool, env), env);
  assert.equal(passed.decision, "passed", JSON.stringify(passed.stages));
  assert.equal(passed.findings.filter((f) => f.origin === "format-check").length, 0);
  const cleanStage = passed.stages.find((s) => s.id === stage);
  assert.equal(cleanStage.state, "completed", cleanStage.reason);
  assert.equal(cleanStage.interpreted !== false, true);
  assert.equal(treeHash(clean), cleanBefore);
}

test("format-check python: ruff format --check flags the unformatted module and passes the formatted twin [proves: format-check#format-check, format-check#format-check@python]", async () => {
  await proveStack({ stack: "python", tool: "ruff-format", file: "app.py" });
});

test("format-check typescript: prettier --check flags the unformatted module and passes the formatted twin [proves: format-check#format-check, format-check#format-check@typescript]", async () => {
  await proveStack({ stack: "typescript", tool: "prettier", file: "src/index.ts" });
});

test("format-check data: prettier --check flags unformatted JSON and YAML anywhere in the project and passes the formatted twin [proves: format-check#format-check, format-check#format-check@any]", async () => {
  await proveStack({ stack: "data", tool: "prettier-data", file: "config/app.json" });
  // The YAML file two folders down is a finding too.
  const env = { ...baseEnv, ...formatterEnv() };
  const bad = workspace("data", "bad");
  const failed = await execute(bad, plan(bad, "prettier-data", env), env);
  assert.deepEqual(failed.findings.filter((f) => f.origin === "format-check").map((f) => f.location?.path).sort(), ["config/app.json", "config/deep/stack.yaml"]);
});

test("format-check data: the instance comes in by a JSON or YAML file in any folder and checks only those files", async () => {
  const dir = tmp("jgates-fc-data-");
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  put("src/main.py", "print(1)\n");
  put("README.md", "# x\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  assert.equal(planInit(dir, "minimal").templates.includes("data-prettier"), false, "no JSON or YAML file: no template");
  await new Promise((resolve) => setImmediate(resolve)); // the file census lives for one synchronous task
  put("ci/deep/pipeline.yml", "a: 1\n");
  put("conf/settings.json", "{}\n");
  put("conf/node_modules/x/package.json", "{}\n");
  put("-odd.yaml", "b: 2\n");
  const init = planInit(dir, "minimal");
  assert.ok(init.templates.includes("data-prettier"), init.templates.join(", "));
  writeInit(dir, init);
  const env = { ...baseEnv, ...formatterEnv() };
  const item = plan(dir, "prettier-data", env).invocations.find((i) => i.id === "prettier-data");
  const args = item.command.args;
  assert.deepEqual(args.slice(args.indexOf("--check")), ["--check", "--no-color", "--", "-odd.yaml", "ci/deep/pipeline.yml", "conf/settings.json", "jgates.yml"]);
  assert.equal(adapter.formatCheckSettings({ tool: "d", config: { tools: { d: { config: { formatter: "ruff", scope: "data" } } } } }).problems.length, 1, "only prettier has a data scope");
  assert.equal(adapter.formatCheckSettings({ tool: "d", config: { tools: { d: { config: { formatter: "prettier", scope: "x" } } } } }).problems.length, 1);
  assert.equal(adapter.formatCheckSettings({ tool: "d", config: { tools: { d: { config: { formatter: "prettier" } } } } }).scope, "component");
});

test("format-check go: gofmt -l flags the unformatted file and passes the formatted twin [proves: format-check#format-check, format-check#format-check@go]", async () => {
  await proveStack({ stack: "go", tool: "gofmt", file: "main.go" });
});

test("format-check rust: cargo fmt --check flags the unformatted crate and passes the formatted twin [proves: format-check#format-check, format-check#format-check@rust]", async () => {
  await proveStack({ stack: "rust", tool: "cargo-fmt", file: "src/main.rs" });
});

test("format-check csharp: dotnet format whitespace flags the unformatted file and passes the formatted twin [proves: format-check#format-check, format-check#format-check@csharp]", async () => {
  await proveStack({ stack: "csharp", tool: "dotnet-format", file: "Program.cs" });
});

test("format-check: a formatter that is not in the image is a blocked stage with the cause, never a pass", async () => {
  const dir = workspace("go", "bad");
  const env = { ...baseEnv, JGATES_GOFMT: "", JGATES_IMAGE_JSON: imageJsonWithout("go") };
  const blockedPlan = plan(dir, "gofmt", env);
  const item = blockedPlan.groups.willRun.find((i) => i.id === "gofmt#format-check");
  assert.ok(item);
  assert.equal(item.availability.status, "unavailable");
  assert.match(item.availability.reason, /jgates setup/);
  const result = await execute(dir, blockedPlan, env);
  const stage = result.stages.find((s) => s.id === "gofmt#format-check");
  assert.equal(stage.state, "blocked");
  assert.match(stage.reason, /jgates setup/);
  assert.notEqual(result.decision, "passed");
  assert.equal(result.findings.filter((f) => f.origin === "format-check").length, 0);
});

test("format-check: an instance without a valid formatter refuses the plan instead of guessing", () => {
  const dir = workspace("go", "clean");
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  fmt:\n    adapter: format-check\n    capabilities: [format-check]\n    formatter: black\n");
  const built = buildPlan(dir, { only: ["tool:fmt"], env: baseEnv, home, compare: false, version: "test" });
  const text = JSON.stringify(built);
  assert.match(text, /formatter/, text.slice(0, 1500));
  assert.ok(built.ok === false || built.plan.groups.willRun.every((i) => i.availability.status !== "available"), "the plan does not run an instance with an unknown formatter");
});

test("format-check parsers: each formatter's output lists the files it would change and anything else is a problem", () => {
  const ruff = adapter.parseRuff("app.py:1:11: unformatted: File would be reformatted\n1 file would be reformatted\n", 1);
  assert.deepEqual(ruff, { ok: true, files: [{ file: "app.py", line: 1, column: 11, edits: 1 }] });
  assert.equal(adapter.parseRuff("1 file already formatted\n", 0).files.length, 0);
  assert.equal(adapter.parseRuff("", 1).ok, false, "exit 1 with no file listed explains nothing");
  assert.equal(adapter.parseRuff("error: Failed to parse app.py\n", 2).ok, false);
  assert.equal(adapter.parseRuff("app.py:1:11: unformatted: x\n", 0).ok, false, "files listed on a clean exit contradict each other");

  const prettier = adapter.parsePrettier("Checking formatting...\n[warn] src/index.ts\n[warn] src/my file.ts\n[warn] Code style issues found in 2 files. Run Prettier with --write to fix.\n", 1);
  assert.deepEqual(prettier.files.map((f) => f.file), ["src/index.ts", "src/my file.ts"]);
  assert.equal(adapter.parsePrettier("All matched files use Prettier code style!\n", 0).ok, true);
  assert.equal(adapter.parsePrettier("[error] src/a.ts: SyntaxError: Unexpected token\n", 2).ok, false);
  assert.equal(adapter.parsePrettier("[warn] Code style issues found in the above file. Run Prettier with --write to fix.\n", 1).ok, false, "the closing sentence alone is not a file");

  assert.deepEqual(adapter.parseGofmt("main.go\nsub/util.go\n", 0).files.map((f) => f.file), ["main.go", "sub/util.go"]);
  assert.equal(adapter.parseGofmt("", 0).files.length, 0);
  assert.equal(adapter.parseGofmt("main.go\n", 2).ok, false, "gofmt exits 2 on a syntax error whatever it printed");

  const rust = adapter.parseRustfmt("Diff in /workspace/src/main.rs:1:\n-fn main(){\n+fn main() {\nDiff in /workspace/src/main.rs:5:\n-x\n+y\nDiff in C:\\p\\src\\lib.rs:2:\n", 1);
  assert.deepEqual(rust.files.map((f) => [f.file, f.line, f.edits]), [["/workspace/src/main.rs", 1, 2], ["C:\\p\\src\\lib.rs", 2, 1]]);
  assert.equal(adapter.parseRustfmt("error: expected item, found `}`\n", 1).ok, false, "exit 1 without a diff is a parse error, not a format finding");
  assert.equal(adapter.parseRustfmt("", 0).ok, true);

  const dotnet = adapter.parseDotnet("An issue was encountered verifying workloads.\n/workspace/Program.cs(1,14): error WHITESPACE: Fix whitespace formatting. Insert '\\n'. [/workspace/]\n/workspace/Program.cs(2,3): error WHITESPACE: Fix whitespace formatting. [/workspace/]\n", 2);
  assert.deepEqual(dotnet.files.map((f) => [f.file, f.line, f.column, f.edits]), [["/workspace/Program.cs", 1, 14, 2]]);
  assert.equal(adapter.parseDotnet("", 0).ok, true);
  assert.equal(adapter.parseDotnet("Could not find a MSBuild project file\n", 1).ok, false);
  assert.equal(adapter.parseDotnet("", 2).ok, false);
});

test("format-check dotnet: the full check runs on a restored solution or project, the whitespace form is the fallback", () => {
  const dir = tmp("jg-dotnet-target-");
  assert.equal(adapter.dotnetTarget(dir), null, "no solution or project file");
  assert.equal(adapter.dotnetTarget(path.join(dir, "missing")), null);
  fs.writeFileSync(path.join(dir, "App.vbproj"), "<Project />");
  assert.equal(adapter.dotnetTarget(dir), null, "an unrestored project takes the whitespace form: a run never restores");
  fs.mkdirSync(path.join(dir, "obj"));
  fs.writeFileSync(path.join(dir, "obj", "project.assets.json"), "{}");
  assert.equal(adapter.dotnetTarget(dir), "App.vbproj", "a restored Visual Basic project");
  fs.writeFileSync(path.join(dir, "App.csproj"), "<Project />");
  assert.equal(adapter.dotnetTarget(dir), "App.csproj");
  fs.writeFileSync(path.join(dir, "All.sln"), "");
  assert.equal(adapter.dotnetTarget(dir), "All.sln", "a solution wins over a project");
  const sol = tmp("jg-dotnet-sln-");
  fs.writeFileSync(path.join(sol, "All.slnx"), "");
  assert.equal(adapter.dotnetTarget(sol), null, "a solution with no restored project below it");
  fs.mkdirSync(path.join(sol, "src", "A", "obj"), { recursive: true });
  fs.writeFileSync(path.join(sol, "src", "A", "obj", "project.assets.json"), "{}");
  assert.equal(adapter.dotnetTarget(sol), "All.slnx");

  const full = adapter.parseDotnet("/workspace/Program.cs(3,5): error IDE0055: Fix formatting [/workspace/App.csproj]\n/workspace/Program.cs(4,1): error IDE0005: Using directive is unnecessary. [/workspace/App.csproj]\n", 2);
  assert.equal(full.ok, true);
  assert.equal(full.files.length, 1);
  assert.equal(full.files[0].edits, 2, "style and analyzer findings count, not only WHITESPACE");
});

test("format-check: the support matrix shows format-check validated for the five stacks, each with its proof", () => {
  const built = matrix.buildMatrix(manifests.builtinManifests());
  const rows = built.rows.filter((r) => r.adapter === "format-check");
  assert.deepEqual(rows.map((r) => r.stack).sort(), ["csharp", "go", "python", "rust", "typescript"]);
  for (const row of rows) {
    assert.equal(row.state, "validated", row.key);
    assert.equal(row.capability, "format-check");
    assert.ok(row.evidence.tests.length > 0, `${row.key} has a proving test`);
  }
  assert.deepEqual(matrix.verifyMatrix(built).filter((p) => /format-check/.test(p)), []);
});
