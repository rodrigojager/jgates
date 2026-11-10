import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Container-first probes (ADR-0004): a tool is available when the JGates tools image's image.json lists it, and the
// probe starts nothing to learn its version. A tool the image lacks is one shared cause in the plan (TOOL_MISSING, with
// the image as its single action), never a per-tool install offer. Older configurations (jgates.yml schema 1 with
// execution.runner, a tools.yml runner) load through the migration reader with a notice.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const { writeImageJson, imageJsonWithout, releaseImageJson } = await import(pathToFileURL(path.join(here, "setup", "image-json.mjs")).href);

// Every process this test file's own code would start is recorded: the probes run in this process.
const spawned = [];
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = childProcess[name];
  childProcess[name] = (...args) => {
    spawned.push([name, String(args[0])]);
    return original(...args);
  };
}
syncBuiltinESMExports();

const ruff = await load("adapters", "ruff", "probe.js");
const semgrep = await load("adapters", "semgrep", "probe.js");
const zizmor = await load("adapters", "zizmor", "probe.js");
const schemathesis = await load("adapters", "schemathesis", "probe.js");
const oasdiff = await load("adapters", "oasdiff", "probe.js");
const govulncheck = await load("adapters", "govulncheck", "probe.js");
const cargoAudit = await load("adapters", "cargo-audit", "probe.js");
const cargoTest = await load("adapters", "cargo-test", "probe.js");
const importLinter = await load("adapters", "import-linter", "probe.js");
const pytest = await load("adapters", "pytest", "probe.js");
const mutation = await load("adapters", "mutation", "probe.js");
const eslint = await load("adapters", "eslint", "probe.js");
const vitest = await load("adapters", "vitest", "probe.js");
const depcruise = await load("adapters", "dependency-cruiser", "probe.js");
const buildCheck = await load("adapters", "build-check", "probe.js");
const codeql = await load("adapters", "codeql", "probe.js");
const bridge = await load("core", "bridge", "index.js");

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/** A clean environment: no override of any tool, an empty PATH, JGates inside an image whose image.json is `file`. */
function envFor(file) {
  const env = { ...process.env, PATH: tmp("jgates-ip-path-"), JGATES_IMAGE_JSON: file };
  for (const name of Object.keys(env)) if (/^JGATES_(RUFF|SEMGREP|ZIZMOR|SCHEMATHESIS|OASDIFF|GOVULNCHECK|CARGO_AUDIT|CARGO|IMPORT_LINTER|PYTHON|STRYKER|ESLINT|VITEST|DEPCRUISE|TSC|MYPY|PYRIGHT|GO|DOTNET|CODEQL|SIDECAR_DIR)$/.test(name)) delete env[name];
  return env;
}

/** Every probe of the image's tools, with the image.json name each one reads. */
function probes(env, workspace) {
  return [
    ["ruff", () => ruff.probeRuff(env)],
    ["semgrep", () => semgrep.probeSemgrep(env)],
    ["zizmor", () => zizmor.probeZizmor(env)],
    ["schemathesis", () => schemathesis.probeSchemathesis(env)],
    ["oasdiff", () => oasdiff.probeOasdiff(env)],
    ["govulncheck", () => govulncheck.probeGovulncheck(env)],
    ["cargo-audit", () => cargoAudit.probeCargoAudit(env)],
    ["cargo", () => cargoTest.probeCargo(env)],
    ["import-linter", () => importLinter.probeImportLinter(env)],
    ["pytest", () => pytest.probePytest(env, workspace)],
    ["mutmut", () => mutation.findMutmut(env)],
    ["stryker", () => mutation.findStryker(workspace, null, env)],
    ["eslint", () => eslint.findEslint(workspace, null, env)],
    ["vitest", () => vitest.findVitest(workspace, null, env)],
    ["dependency-cruiser", () => depcruise.probeDepcruise(workspace, env)],
    ["typescript", () => buildCheck.probeChecker("tsc", workspace, null, env)],
    ["mypy", () => buildCheck.probeChecker("mypy", workspace, null, env)],
    ["go", () => buildCheck.probeChecker("go", workspace, null, env)],
    ["dotnet", () => buildCheck.probeChecker("dotnet", workspace, null, env)],
  ];
}

test("with a fake image.json listing a tool, its probe reports it available with that version and starts nothing", () => {
  const versions = { ruff: "0.17.9", semgrep: "1.184.7", zizmor: "1.32.5", schemathesis: "4.33.9", oasdiff: "1.37.5", govulncheck: "1.9.3", "cargo-audit": "0.22.7", cargo: "1.99.4", "import-linter": "2.17", pytest: "9.2.7", "pytest-cov": "7.1.0", mutmut: "3.8.6", stryker: "10.1.6", eslint: "10.14.6", vitest: "5.1.6", "vitest-coverage-v8": "5.1.6", "dependency-cruiser": "18.7.6", typescript: "6.0.6", mypy: "2.4.6", go: "1.27.6", dotnet: "10.0.406" };
  const env = envFor(writeImageJson(versions));
  const workspace = tmp("jgates-ip-ws-");
  spawned.length = 0;
  for (const [tool, probe] of probes(env, workspace)) {
    const p = probe();
    const problem = p.problem ?? null;
    assert.equal(problem, null, `${tool}: ${JSON.stringify(p)}`);
    const expected = /^\d+\.\d+$/.test(versions[tool]) ? `${versions[tool]}.0` : versions[tool];
    assert.equal(p.version, expected, tool);
  }
  assert.equal(vitest.findCoverageProvider(workspace, null, vitest.findVitest(workspace, null, env)).installed, true);
  assert.equal(pytest.probePytest(env, workspace).coverage, true);
  assert.equal(bridge.sidecarAvailability(env).problem, null);
  assert.deepEqual(spawned, [], "no probe started a process");
});

test("with the tool absent from the image.json the probe says so (not found, the image named), still without a spawn", () => {
  const all = ["ruff", "semgrep", "zizmor", "schemathesis", "oasdiff", "govulncheck", "cargo-audit", "cargo", "import-linter", "pytest", "mutmut", "stryker", "eslint", "vitest", "dependency-cruiser", "typescript", "mypy", "go", "dotnet"];
  const env = envFor(imageJsonWithout(...all));
  const workspace = tmp("jgates-ip-ws-");
  spawned.length = 0;
  for (const [tool, probe] of probes(env, workspace)) {
    const p = probe();
    assert.notEqual(p.problem ?? null, null, `${tool}: ${JSON.stringify(p)}`);
    assert.equal(p.version ?? null, null, tool);
    assert.match(p.detail, /not in the JGates tools image/, tool);
  }
  // CodeQL is never in the image (customer supplied).
  assert.equal(codeql.probeCodeql(env).problem, "not_found");
  assert.deepEqual(spawned, []);
});

test("on the host (container mode) the probes read the package's mirror of the pinned image's image.json, and an override names nothing", () => {
  const env = { ...envFor(""), JGATES_RUFF: path.join(os.tmpdir(), "a-host-ruff"), JGATES_PYTHON: process.execPath };
  spawned.length = 0;
  const p = ruff.probeRuff(env);
  assert.equal(p.problem, null);
  assert.equal(p.executable, "ruff", "the command inside the image, never a host path");
  assert.equal(p.version, releaseImageJson().tools.ruff);
  // The sidecar's Python is the image's, started only by a step container: never a host Python.
  const sidecar = bridge.sidecarRuntime(env);
  assert.equal(sidecar.interpreter, bridge.IMAGE_SIDECAR_PYTHON);
  assert.equal(sidecar.native, false);
  assert.deepEqual(spawned, []);
});

/** A Python project for the CLI (in-image mode with `imageJson`). */
function cliProject(imageJson, profile = "strict") {
  const dir = tmp("jgates-ip-proj-");
  const home = tmp("jgates-ip-home-");
  fs.mkdirSync(path.join(dir, "app"));
  fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(dir, "app", "main.py"), "import os\n");
  fs.writeFileSync(path.join(dir, ".github", "workflows", "ci.yml"), "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n");
  const env = { ...envFor(imageJson), PATH: process.env.PATH, JGATES_HOME: home, JGATES_LOCALE: "en", NO_COLOR: "1" };
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input: "", timeout: 120_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  const init = cli(["init", "--cwd", dir, "--profile", profile, "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  return { dir, cli };
}

test("tools the image lacks are the single shared TOOL_MISSING cause of the plan, with the image as action: no per-tool install offer", () => {
  const p = cliProject(imageJsonWithout("ruff", "semgrep", "zizmor", "gitleaks", "trivy", "osv-scanner"));
  const r = p.cli(["plan", "--cwd", p.dir, "--json"]);
  assert.ok(r.doc?.plan, r.out + r.err);
  const plan = r.doc.plan;
  // What the plan says about the missing tools: the shared cause, the warnings, the blockers and every item's reason.
  const text = JSON.stringify({
    missing: plan.groups.notApplicableRequirements.filter((n) => n.reasonCode === "TOOL_MISSING"),
    warnings: plan.warnings,
    blockers: plan.blockers,
    reasons: [...plan.groups.willRun, ...plan.groups.notApplicableOrDisabled].map((i) => i.availability.reason),
  });
  const install = /pip install|doctor --fix|npm install --save-dev|go install|cargo install/.exec(text);
  assert.equal(install, null, install ? text.slice(Math.max(0, install.index - 400), install.index + 80) : "");
  const na = plan.groups.notApplicableRequirements.filter((n) => n.reasonCode === "TOOL_MISSING");
  const shared = [...na, ...plan.warnings.filter((w) => w.code === "TOOL_MISSING"), ...plan.blockers.filter((b) => b.code === "TOOL_MISSING")];
  assert.ok(shared.length >= 1, JSON.stringify({ warnings: plan.warnings, blockers: plan.blockers, na: plan.groups.notApplicableRequirements.map((n) => [n.selector, n.reasonCode]) }));
  for (const n of na) {
    assert.equal(n.action.kind, "prepare-image", n.selector);
    assert.deepEqual(n.action.docs, [], n.selector);
    assert.match(n.message, /not in the JGates tools image/, n.selector);
  }
  assert.ok(!plan.groups.notApplicableRequirements.some((n) => n.action.kind === "prepare-tool"));
  // Whatever the number of missing tools, one shared warning or blocker, never one per tool.
  assert.ok(plan.warnings.filter((w) => w.code === "TOOL_MISSING").length <= 1, JSON.stringify(plan.warnings));
  assert.ok(plan.blockers.filter((b) => b.code === "TOOL_MISSING").length <= 1, JSON.stringify(plan.blockers));
  const missingWarning = plan.warnings.find((w) => w.code === "TOOL_MISSING");
  if (missingWarning) assert.match(missingWarning.message, /ruff/);
});

test("a jgates.yml of schema 1 with execution.runner and a ruff runner in tools.yml load through the migration reader with a notice", async () => {
  const { loadProjectConfig, ROOT_SCHEMA_VERSION } = await load("core", "config", "load", "index.js");
  assert.equal(ROOT_SCHEMA_VERSION, 2);
  const schema = JSON.parse(fs.readFileSync(path.resolve(here, "..", "schemas", "config", "jgates.schema.json"), "utf8"));
  assert.equal(schema.properties.schemaVersion.const, 2, "the schema version is bumped");
  assert.equal(schema.properties.execution.properties.runner, undefined, "execution.runner left the schema");
  const tools = JSON.parse(fs.readFileSync(path.resolve(here, "..", "schemas", "config", "tools.schema.json"), "utf8"));
  assert.ok(!JSON.stringify(tools).includes('"runner"'), "the tools runner left the schema");

  const p = cliProject(process.env.JGATES_IMAGE_JSON, "minimal");
  const root = path.join(p.dir, "jgates.yml");
  const current = fs.readFileSync(root, "utf8");
  assert.match(current, /^schemaVersion: 2$/m, "init writes the current schema version");
  fs.writeFileSync(root, `${current.replace(/^schemaVersion: 2$/m, "schemaVersion: 1")}execution:\n  runner: local\n  failFast: true\n`);
  fs.writeFileSync(path.join(p.dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  ruff:\n    adapter: ruff\n    capabilities: [lint]\n    runner: container\n");

  const loaded = loadProjectConfig(p.dir);
  assert.equal(loaded.valid, true, JSON.stringify(loaded.diagnostics));
  assert.deepEqual(loaded.notices.map((n) => [n.code, n.file, n.path]), [
    ["CONFIG_MIGRATED", "jgates.yml", "execution.runner"],
    ["CONFIG_MIGRATED", ".jgates/tools.yml", "tools.ruff.runner"],
  ]);
  const rootDoc = loaded.documents.find((d) => d.kind === "root").value;
  assert.equal(rootDoc.schemaVersion, 2);
  assert.deepEqual(rootDoc.execution, { failFast: true }, "the other settings stay");

  const validate = p.cli(["config", "validate", "--cwd", p.dir, "--json"]);
  assert.equal(validate.code, 0, validate.out + validate.err);
  assert.equal(validate.doc.valid, true);
  assert.equal(validate.doc.notices.length, 2);
  assert.match(validate.doc.notices[0].message, /execution\.runner \(local\) was removed/);
  const text = p.cli(["config", "validate", "--cwd", p.dir]);
  assert.match(text.out, /the runner of ruff \(container\) was removed/);

  const plan = p.cli(["plan", "--cwd", p.dir, "--json"]);
  assert.ok(plan.doc?.plan, plan.out + plan.err);
  assert.equal(plan.doc.plan.warnings.filter((w) => w.code === "CONFIG_MIGRATED").length, 2, JSON.stringify(plan.doc.plan.warnings));
  assert.equal(fs.readFileSync(root, "utf8").includes("runner: local"), true, "the file on disk is never rewritten by the reader");

  // Schema 2 is strict: execution.runner there is an unknown key, not a migration.
  fs.writeFileSync(root, `${current}execution:\n  runner: local\n`);
  const strict = loadProjectConfig(p.dir);
  assert.equal(strict.valid, false);
  assert.ok(strict.diagnostics.some((d) => d.path.startsWith("execution")), JSON.stringify(strict.diagnostics));
});
