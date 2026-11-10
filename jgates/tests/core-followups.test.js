import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Core behavior around images, caches, templates and the matrix:
// - container images come only from .jgates/lock.json, pinned by `tools prepare` (no JGATES_*_IMAGE);
// - the sidecar image (quality-gate/Dockerfile) declares one version label per scanner and is accepted as is;
// - Trivy's vulnerability database is cached in the data folder between runs, with its dates recorded;
// - ESLint, pytest and Vitest enter the plan by the evidence of their configuration (match.files);
// - the matrix accepts a test as proof only when its title says it exercises the capability ([proves: ...]).
// The container runtime is always a fake (a Node script); npm run test:docker covers the real one.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FAKE_DOCKER = path.join(here, "docker", "fake-docker.cjs");
const SECURITY_FIXTURES = path.join(here, "fixtures", "parsers", "security");
const FAKE_SECURITY_RUNTIME = path.join(SECURITY_FIXTURES, "fake-runtime.cjs");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const mainFixture = require(path.join(repo, "tests", "fixtures", "jgates", "main-fixture.js"));
const mx = await import(pathToFileURL(path.join(dist, "core", "matrix", "index.js")).href);
const { parseTrivyReport } = await import(pathToFileURL(path.join(dist, "adapters", "trivy", "index.js")).href);
const { builtinManifests } = await import(pathToFileURL(path.join(dist, "adapters", "manifests.js")).href);
const prepare = await import(pathToFileURL(path.join(dist, "core", "prepare", "index.js")).href);

const validateResult = new Ajv2020({ strict: true, allErrors: true }).compile(JSON.parse(fs.readFileSync(path.join(here, "..", "schemas", "result", "result.schema.json"), "utf8")));

const POSIX = process.platform !== "win32";
const NO_POSIX = "the fake container runtime is a script with a #! line (POSIX only)";
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const rm = (...dirs) => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const NO_DOCKER = { DOCKER_HOST: "tcp://127.0.0.1:1", DOCKER_CONTEXT: "" };
const IMAGE_VARS = /^JGATES_.*_IMAGE$/;

function script(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function cliIn(env) {
  return (args, input = "") => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input, timeout: 600_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
}

/** A workspace, a data folder and a bin folder with a fake runtime; the environment has no JGATES_*_IMAGE. */
function workspace({ runtime = FAKE_DOCKER, prefix = "FAKE_DOCKER_", vars = {} } = {}) {
  const dir = tmp("jgates-cf-ws-");
  const home = tmp("jgates-cf-home-");
  const bin = tmp("jgates-cf-bin-");
  // Where the advisory data is inside the image (JGATES_DATA_DIR; the real one is the jgates-data volume at /data).
  const data = tmp("jgates-cf-data-");
  const log = path.join(bin, "calls.jsonl");
  const setRuntime = (extra = {}) =>
    script(bin, "docker", `Object.assign(process.env, ${JSON.stringify({ [`${prefix}LOG`]: log, FAKE_LOG: log, ...vars, ...extra })});\nrequire(${JSON.stringify(runtime)});`);
  setRuntime();
  const env = { ...process.env, ...NO_DOCKER, JGATES_HOME: home, JGATES_PYTHON: PYTHON, JGATES_CONTAINER_RUNTIME: path.join(bin, "docker"), JGATES_NO_CACHE: "1", JGATES_DATA_DIR: data, PATH: bin };
  for (const name of Object.keys(env)) if (IMAGE_VARS.test(name)) delete env[name];
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, home, bin, data, env, cli: cliIn(env), setRuntime, calls, cleanup: () => rm(dir, home, bin, data) };
}

const allItems = (plan) => [...plan.groups.willRun, ...plan.groups.notApplicableOrDisabled];
const itemOf = (plan, id) => allItems(plan).find((i) => i.id === id);
const lockOf = (dir) => readJson(path.join(dir, ".jgates", "lock.json"));

// ---------------------------------------------------------------------------------------------------------------
// Trivy: database cache and licenses.

const TRIVY_TOOLS = (capabilities) => `schemaVersion: 1\ntools:\n  trivy:\n    adapter: trivy\n    capabilities: [${capabilities.join(", ")}]\n`;

function trivyWorkspace(capabilities, vars = {}) {
  const p = workspace({ runtime: FAKE_SECURITY_RUNTIME, prefix: "FAKE_", vars });
  // Tests run JGates "inside the image" (tests/setup/in-image.mjs): Trivy starts natively, here a stand-in that writes
  // the recorded report (and the database, like Trivy does when it downloads) where the real one would.
  script(p.bin, "trivy", `Object.assign(process.env, ${JSON.stringify({ FAKE_LOG: path.join(p.bin, "calls.jsonl"), ...vars })});\nrequire(${JSON.stringify(path.join(SECURITY_FIXTURES, "fake-scanner.cjs"))});`);
  assert.equal(p.cli(["init", "--cwd", p.dir, "--profile", "standard", "--no-interactive", "--json"]).code, 0);
  write(p.dir, "package-lock.json", '{"lockfileVersion":3,"packages":{}}\n');
  write(p.dir, ".jgates/tools.yml", TRIVY_TOOLS(capabilities));
  return p;
}

test("Trivy scans offline against the data folder: it is told not to update anything, never downloads, and the dates are the database's own", { skip: POSIX ? false : NO_POSIX }, () => {
  const scratch = tmp("jgates-cf-db-");
  const meta = path.join(scratch, "metadata.json");
  const next = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  fs.writeFileSync(meta, JSON.stringify({ Version: 2, NextUpdate: next, UpdatedAt: "2026-10-25T19:10:35.479132794Z", DownloadedAt: "2026-10-25T21:14:51.366240096Z" }));
  const p = trivyWorkspace(["dependencies"], {
    FAKE_REPORT: path.join(SECURITY_FIXTURES, "trivy", "0.72.0", "fs-report.json"),
    FAKE_DB_META: meta,
    FAKE_STDERR: '2026-10-25T21:14:51Z\tINFO\t[vulndb] Artifact successfully downloaded\trepo="mirror.gcr.io/aquasec/trivy-db:2"\n',
  });
  const runs = () => p.calls().filter((c) => c[0] === "trivy");
  try {
    const r = p.cli(["run", "--cwd", p.dir, "--only", "tool:trivy", "--no-interactive", "--json"]);
    assert.ok(r.doc, r.out + r.err);
    assert.ok(validateResult(r.doc), JSON.stringify(validateResult.errors));
    const stage = r.doc.stages.find((s) => s.id === "trivy#dependencies");
    assert.equal(stage.state, "completed", JSON.stringify(stage));
    // One scan, offline: the database is the data folder, whatever the host or the run folder has.
    assert.equal(runs().length, 1);
    const call = runs()[0];
    for (const flag of ["--skip-db-update", "--offline-scan", "--skip-check-update", "--skip-java-db-update"]) assert.ok(call.includes(flag), `${flag} in ${call.join(" ")}`);
    assert.equal(call[call.indexOf("--cache-dir") + 1], path.join(p.data, "trivy").replace(/\\/g, "/"));
    assert.equal(call[call.length - 1], ".", "the scan target stays last");
    // The dates come from the database's own metadata, and no network was needed to read it.
    const db = stage.analysisInput.database;
    assert.deepEqual({ source: db.source, updatedAt: db.updatedAt, downloadedAt: db.downloadedAt, networkRequired: db.networkRequired }, { source: "mirror.gcr.io/aquasec/trivy-db:2", updatedAt: "2026-10-25T19:10:35.479132794Z", downloadedAt: "2026-10-25T21:14:51.366240096Z", networkRequired: false });
    assert.ok(!fs.existsSync(path.join(r.doc.runDir, "outputs", "trivy", "trivy", "cache", "db", "trivy.db")), "the database is not left in the run folder");
    // The old host-side cache of the database is gone: the volume is the one place.
    assert.ok(!fs.existsSync(path.join(p.home, "tools", "cache", "trivy-db")));
  } finally {
    p.cleanup();
    rm(scratch);
  }
});

test("Trivy licenses: the recorded license report of 0.72.0 becomes a finding of the licenses capability, in the parser and in a run [proves: trivy#licenses]", { skip: POSIX ? false : NO_POSIX }, () => {
  // Recorded with `trivy fs --scanners license` of jgates-dev/security-scanners (Trivy 0.72.0) on a package-lock.json
  // whose only dependency is GPL-3.0-only.
  const report = path.join(SECURITY_FIXTURES, "trivy", "0.72.0", "fs-licenses.json");
  const parsed = parseTrivyReport(fs.readFileSync(report, "utf8"), { version: "0.72.0", cwd: "/workspace", capabilities: ["licenses"] });
  assert.equal(parsed.ok, true, parsed.problem);
  assert.deepEqual(parsed.findings.map((f) => [f.capability, f.ruleId, f.location.path, f.normalizedSeverity, f.blocking]), [["licenses", "license:GPL-3.0-only", "package-lock.json", "high", true]]);

  const p = trivyWorkspace(["licenses"], { FAKE_REPORT: report });
  try {
    const plan = p.cli(["plan", "--cwd", p.dir, "--only", "tool:trivy", "--json"]).doc.plan;
    const item = itemOf(plan, "trivy#licenses");
    assert.equal(item.availability.status, "available", item.availability.reason);
    assert.deepEqual(item.command.args.slice(item.command.args.indexOf("--scanners"), item.command.args.indexOf("--scanners") + 2), ["--scanners", "license"]);
    const ran = p.cli(["run", "--cwd", p.dir, "--only", "tool:trivy", "--no-interactive", "--json"]).doc;
    assert.ok(validateResult(ran), JSON.stringify(validateResult.errors));
    const stage = ran.stages.find((s) => s.id === "trivy#licenses");
    assert.equal(stage.state, "completed", JSON.stringify(stage));
    assert.equal(stage.findings, 1);
    assert.deepEqual(ran.findings.filter((f) => f.stageId === "trivy#licenses").map((f) => [f.ruleId, f.location.path, f.normalizedSeverity]), [["license:GPL-3.0-only", "package-lock.json", "high"]]);
    assert.equal(ran.decision, "failed", "a restricted license blocks");
    // The license scan reads no vulnerability database: nothing is cached and no update flag is added.
    assert.ok(!p.calls().find((c) => c[0] === "trivy").includes("--skip-db-update"));
    assert.ok(!fs.existsSync(path.join(p.home, "tools", "cache", "trivy-db")));
  } finally {
    p.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The bridge's own file-size budget, run for real (the sidecar's Python code, no external tool).

test("the bridge's file-size budget: a file over the line limit is a finding of the file-size subcheck [proves: quality-bridge#file-size]", { skip: fs.existsSync(PYTHON) ? false : "the repository .venv is missing (python3 -m venv .venv && .venv/bin/pip install -e quality-gate)" }, () => {
  const dir = tmp("jgates-cf-size-");
  const home = tmp("jgates-cf-size-home-");
  const bin = tmp("jgates-cf-size-bin-");
  try {
    write(dir, "small.py", "value = 1\n");
    write(dir, "big.py", "x = 1\n".repeat(12_001));
    const env = { ...process.env, ...NO_DOCKER, JGATES_HOME: home, JGATES_PYTHON: PYTHON, JGATES_NO_CACHE: "1", PATH: bin };
    const r = spawnSync(process.execPath, [MAIN, "run", "--cwd", dir, "--bridge-mode", "quick", "--json"], { encoding: "utf8", env, timeout: 600_000 });
    const doc = JSON.parse(r.stdout);
    assert.ok(validateResult(doc), JSON.stringify(validateResult.errors));
    const stage = doc.stages.find((s) => s.id === "quality-bridge.file-size");
    assert.equal(stage.state, "completed", JSON.stringify(stage));
    const findings = doc.findings.filter((f) => f.stageId === "quality-bridge.file-size");
    assert.ok(findings.some((f) => f.ruleId === "budget.file-lines" && f.location?.path === "big.py"), JSON.stringify(findings));
    assert.ok(!findings.some((f) => f.location?.path === "small.py"));
  } finally {
    rm(dir, home, bin);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Templates by configuration evidence (match.files).

function tsProject() {
  const dir = tmp("jgates-cf-ts-");
  write(dir, "package.json", JSON.stringify({ name: "demo", version: "1.0.0", type: "module" }, null, 2) + "\n");
  write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }) + "\n");
  write(dir, "src/index.ts", "export const one = 1;\n");
  return dir;
}

function quietCli() {
  const home = tmp("jgates-cf-tpl-home-");
  const bin = tmp("jgates-cf-tpl-bin-");
  const cli = cliIn({ ...process.env, ...NO_DOCKER, JGATES_HOME: home, JGATES_PYTHON: PYTHON, JGATES_NO_CACHE: "1", PATH: bin });
  return { cli, cleanup: () => rm(home, bin) };
}

const toolItems = (plan, tool) => allItems(plan).filter((i) => i.tool === tool);

test("with match.files a TypeScript project without eslint.config gets no eslint#lint, and one with eslint.config gets it from typescript-eslint", () => {
  const dir = tsProject();
  const q = quietCli();
  try {
    assert.equal(q.cli(["init", "--cwd", dir, "--profile", "standard", "--no-interactive", "--json"]).code, 0);
    const without = q.cli(["plan", "--cwd", dir, "--json"]).doc.plan;
    assert.deepEqual(toolItems(without, "eslint"), [], "no ESLint step without its configuration");
    assert.ok(!without.warnings.some((w) => /eslint/i.test(w.message)), JSON.stringify(without.warnings));
    assert.ok(without.templates.active.some((t) => t.id === "typescript"), "the typescript template itself stays");
    assert.deepEqual(toolItems(without, "dependency-cruiser"), [], "no architecture contract: no dependency-cruiser step either");

    write(dir, "eslint.config.js", "export default [];\n");
    const withConfig = q.cli(["plan", "--cwd", dir, "--json"]).doc.plan;
    const items = toolItems(withConfig, "eslint");
    assert.deepEqual(items.map((i) => i.id), ["eslint#lint"]);
    const included = items[0].includedBy.find((i) => i.kind === "template");
    assert.equal(included.entry, "typescript-eslint");
    assert.ok(included.matched.includes("eslint.config.js"), JSON.stringify(included));
    assert.notEqual(withConfig.planHash, without.planHash);
  } finally {
    q.cleanup();
    rm(dir);
  }
});

test("pytest and Vitest enter the plan by the evidence of their configuration (a section of a shared file counts only when it is there)", () => {
  const py = tmp("jgates-cf-py-");
  const ts = tsProject();
  const q = quietCli();
  try {
    write(py, "pyproject.toml", '[project]\nname = "demo"\nversion = "0.1.0"\n');
    write(py, "demo/__init__.py", "");
    write(py, "tests/test_demo.py", "def test_one():\n    assert True\n");
    for (const dir of [py, ts]) assert.equal(q.cli(["init", "--cwd", dir, "--profile", "strict", "--no-interactive", "--json"]).code, 0);
    assert.deepEqual(toolItems(q.cli(["plan", "--cwd", py, "--json"]).doc.plan, "pytest"), [], "a pyproject.toml without the pytest section is no evidence");
    assert.deepEqual(toolItems(q.cli(["plan", "--cwd", ts, "--json"]).doc.plan, "vitest"), []);

    fs.appendFileSync(path.join(py, "pyproject.toml"), '\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
    const pyPlan = q.cli(["plan", "--cwd", py, "--json"]).doc.plan;
    assert.deepEqual(toolItems(pyPlan, "pytest").map((i) => i.id).sort(), ["pytest#coverage", "pytest#properties", "pytest#unit"]);
    assert.ok(pyPlan.templates.active.find((t) => t.id === "python-pytest").matched.includes("pyproject.toml"));

    write(ts, "vitest.config.ts", "export default {};\n");
    const tsPlan = q.cli(["plan", "--cwd", ts, "--json"]).doc.plan;
    assert.deepEqual(toolItems(tsPlan, "vitest").map((i) => i.id).sort(), ["vitest#coverage", "vitest#properties", "vitest#unit"]);
    assert.ok(tsPlan.templates.active.find((t) => t.id === "typescript-vitest").matched.includes("vitest.config.ts"));
  } finally {
    q.cleanup();
    rm(py, ts);
  }
});

test("match.files is a path inside the project: a project template that points outside it is refused by the schema", () => {
  const dir = tsProject();
  const q = quietCli();
  try {
    write(dir, "jgates.yml", "schemaVersion: 1\ntemplates:\n  - id: mine\n    source: .jgates/templates/mine.yml\n    activation: detected\n");
    write(dir, ".jgates/templates/mine.yml", "schemaVersion: 1\nid: mine\nmatch:\n  files:\n    - ../outside.cfg\n");
    const resolved = q.cli(["config", "resolve", "--cwd", dir, "--json"]);
    assert.equal(resolved.code, 3, resolved.out);
    assert.ok(resolved.out.includes("TEMPLATE_INVALID"), resolved.out);
  } finally {
    q.cleanup();
    rm(dir);
  }
});

const CONFIG_MISSING = [/eslint\.config/i, /contrato/i, /architecture\.yml/i];

test("init --profile standard on the main fixture plans and runs with no step blocked for a missing configuration", () => {
  const { dir } = mainFixture.createMainFixture();
  const q = quietCli();
  try {
    const init = q.cli(["init", "--cwd", dir, "--profile", "standard", "--no-interactive", "--json"]);
    assert.equal(init.code, 0, init.out);
    const plan = q.cli(["plan", "--cwd", dir, "--json"]).doc.plan;
    assert.deepEqual(toolItems(plan, "eslint"), [], "no eslint.config in the fixture: no ESLint step");
    const configProblems = (text) => CONFIG_MISSING.some((re) => re.test(text ?? ""));
    for (const item of plan.groups.willRun) {
      if (item.availability.status !== "available") assert.ok(!configProblems(item.availability.reason), `${item.id}: ${item.availability.reason}`);
    }
    assert.ok(!plan.warnings.some((w) => w.code === "TOOL_UNAVAILABLE" && configProblems(w.message)), JSON.stringify(plan.warnings));

    const r = q.cli(["run", "--cwd", dir, "--no-interactive", "--json"]);
    assert.ok(r.doc, r.out + r.err);
    const blocked = r.doc.stages.filter((s) => s.state === "blocked");
    for (const s of blocked) assert.ok(!configProblems(s.reason), `${s.id} blocked for a configuration: ${s.reason}`);
    assert.ok(!r.doc.stages.some((s) => /^(eslint|import-linter|dependency-cruiser)#/.test(s.id) && s.state === "blocked"), JSON.stringify(blocked.map((s) => s.id)));
  } finally {
    q.cleanup();
    mainFixture.removeFixture(dir);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The matrix accepts only tests that say they exercise the capability.

test("verifyMatrix refuses a cited test whose title does not say it exercises the capability, and the bridge scanners without a real proof are declared with the reason", () => {
  const matrix = mx.buildMatrix();
  assert.deepEqual(mx.verifyMatrix(matrix), []);
  const ruff = matrix.adapters.find((a) => a.id === "ruff");
  // A real test of the Ruff adapter, but one that does not claim the capability.
  ruff.capabilities[0].tests = [{ file: "adapter-ruff.test.js", test: "the manifest is valid for the catalog" }];
  const problems = mx.verifyMatrix(matrix);
  assert.ok(problems.some((p) => p.startsWith("ruff#lint") && p.includes("[proves: ruff#lint]")), problems.join("\n"));
  // A marker of another capability does not count either.
  ruff.capabilities[0].tests = [{ file: "adapters-security.test.js", test: "Checkov 3.3.8" }];
  assert.ok(mx.verifyMatrix(matrix).some((p) => p.startsWith("ruff#lint")));

  const fresh = mx.buildMatrix();
  const bridge = fresh.adapters.find((a) => a.id === "quality-bridge");
  const status = Object.fromEntries(bridge.capabilities.map((c) => [c.id, c.status]));
  assert.equal(status["file-size"], "integrated");
  for (const id of ["lint", "sast", "secrets", "dependencies", "duplication", "iac", "coverage", "unit"]) {
    const c = bridge.capabilities.find((x) => x.id === id);
    assert.equal(c.status, "declared", id);
    assert.match(c.note.ptBR, /smoke com Docker da ponte/, id);
    assert.match(c.note.en, /Docker smoke of the bridge/, id);
  }
  assert.equal(fresh.adapters.find((a) => a.id === "trivy").capabilities.find((c) => c.id === "licenses").status, "integrated");
  // The titles parse as the test runner sees them.
  assert.deepEqual(mx.provedBy("x [proves: trivy#dependencies, trivy#iac] y"), ["trivy#dependencies", "trivy#iac"]);
  assert.deepEqual(mx.testTitles('test("a \\"b\\" [proves: x#y]", () => {});'), ['a "b" [proves: x#y]']);
});
