import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// End to end: jgates run drives the quality sidecar through the JSON bridge, without Docker
// (DOCKER_HOST on a dead port, local Python sidecar), with a temporary JGATES_HOME per run.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const MAIN = path.resolve(here, "..", "dist", "cli", "main.js");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const { createMainFixture, listTree, removeFixture } = require(path.join(repo, "tests", "fixtures", "jgates", "main-fixture.js"));
const { createPiiFixture, removePiiFixture, PII_FILE } = require(path.join(repo, "tests", "fixtures", "jgates", "pii-fixture.js"));
const bridge = await import(pathToFileURL(path.resolve(here, "..", "dist", "adapters", "quality-bridge", "index.js")).href);
const { findOnPath } = await import(pathToFileURL(path.resolve(here, "..", "dist", "core", "bridge", "index.js")).href);
const { EXIT_CODES } = await import(pathToFileURL(path.resolve(here, "..", "dist", "core", "contract", "index.js")).href);

const resultSchema = JSON.parse(fs.readFileSync(path.resolve(here, "..", "schemas", "result", "result.schema.json"), "utf8"));
const validateResult = new Ajv2020({ strict: true, allErrors: true }).compile(resultSchema);
const manifestIds = bridge.qualityBridgeManifest.subchecks.map((s) => s.id);

const PYTHON = findOnPath("python") ?? findOnPath("python3");
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const NO_DOCKER = {
  DOCKER_CONTEXT: "",
  DOCKER_HOST: "tcp://127.0.0.1:1",
  GITHUB_BASE_REF: "",
  GITHUB_HEAD_REF: "",
  GITHUB_SHA: "",
  GITLAB_CI: "",
  CI_MERGE_REQUEST_DIFF_BASE_SHA: "",
  CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "",
  CI_COMMIT_SHA: "",
};

/**
 * Runs the CLI. By default the interpreter is given by absolute path (JGATES_PYTHON) and PATH holds an empty
 * folder, so no external scanner can be found on the local path: the outcome does not depend on the machine.
 */
function jgates(args, { env = {}, keepPath = false } = {}) {
  assert.ok(PYTHON, "python not found on PATH: put the repository .venv/bin first on PATH");
  const home = tmp("jgates-home-");
  const emptyBin = tmp("jgates-bin-");
  const base = { ...process.env, ...NO_DOCKER, JGATES_HOME: home, JGATES_PYTHON: PYTHON };
  if (!keepPath) base.PATH = emptyBin;
  const r = spawnSync(process.execPath, [MAIN, "run", ...args], { encoding: "utf8", env: { ...base, ...env }, timeout: 600_000 });
  fs.rmSync(emptyBin, { recursive: true, force: true });
  return { ...r, home };
}

function parseOne(stdout) {
  // Exactly one JSON document on stdout: parsing the whole text must succeed.
  return JSON.parse(stdout);
}

function assertValidResult(doc) {
  assert.ok(validateResult(doc), JSON.stringify(validateResult.errors, null, 2));
  assert.equal(doc.exitCode, EXIT_CODES[doc.decision]);
}

function stage(doc, id) {
  const s = doc.stages.find((x) => x.id === id);
  assert.ok(s, `stage ${id} missing`);
  return s;
}

function gitStatus(dir) {
  const r = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--ignored"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** Writes a fake quality_sidecar package whose __main__ runs the given Python body. */
function fakeSidecar(body) {
  const dir = tmp("jgates-fake-sidecar-");
  fs.mkdirSync(path.join(dir, "quality_sidecar"));
  fs.writeFileSync(path.join(dir, "quality_sidecar", "__init__.py"), "");
  fs.writeFileSync(path.join(dir, "quality_sidecar", "__main__.py"), body);
  return dir;
}

test("main fixture: one JSON result, valid, run kept outside the project, required tools missing give incomplete", () => {
  const { dir } = createMainFixture();
  let home;
  try {
    const before = listTree(dir);
    assert.equal(gitStatus(dir), "");
    const r = jgates(["--cwd", dir, "--json"]);
    home = r.home;
    const doc = parseOne(r.stdout);
    assertValidResult(doc);
    assert.equal(r.status, doc.exitCode);
    assert.match(doc.runId, /^run_/);

    // The bridge is one composite stage plus one stage per subcheck of the manifest.
    const composite = stage(doc, "quality-bridge");
    assert.equal(composite.kind, "composite");
    assert.equal(composite.state, "completed");
    for (const id of manifestIds) assert.equal(stage(doc, `quality-bridge.${id}`).parentId, "quality-bridge");

    // No scanner on the local path: required subchecks are blocked, never completed, and the decision is incomplete.
    assert.equal(doc.decision, "incomplete");
    assert.equal(r.status, 2);
    assert.equal(doc.complete, false);
    const semgrep = stage(doc, "quality-bridge.semgrep");
    assert.equal(semgrep.state, "blocked");
    assert.ok(semgrep.reason);
    assert.ok(doc.unsatisfied.some((u) => u.requirementId === "quality-bridge.semgrep" && u.state === "blocked"));
    assert.ok(doc.requirements.find((q) => q.id === "quality-bridge.semgrep").required);

    // What the default selection leaves off is disabled with its origin and reason, never approved.
    const gitleaks = stage(doc, "quality-bridge.gitleaks");
    assert.equal(gitleaks.state, "disabled");
    assert.ok(doc.disabled.some((d) => d.id === "quality-bridge.gitleaks" && d.origin === "profile" && d.reason));
    assert.equal(doc.reduced, false);

    // Nothing new in the project; result.json and the logs live in JGATES_HOME/workspaces/<id>/runs/<runId>/.
    assert.equal(gitStatus(dir), "");
    assert.deepEqual(listTree(dir), before);
    assert.deepEqual(doc.workspaceChanges, { checked: true, added: [], modified: [], removed: [] });
    const runDir = path.join(home, "workspaces", doc.workspace.id, "runs", doc.runId);
    assert.equal(fs.realpathSync(doc.runDir), fs.realpathSync(runDir));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf8")), doc);
    assert.ok(doc.artifacts.logs.length > 0);
    for (const log of doc.artifacts.logs) assert.ok(fs.statSync(path.join(runDir, log)).isFile(), log);
    for (const out of doc.artifacts.outputs) assert.ok(fs.statSync(path.join(runDir, out)).isDirectory(), out);
    assert.ok(fs.statSync(path.join(runDir, doc.artifacts.outputs[0], "quality-report.json")).isFile());
    assert.equal(fs.realpathSync(doc.workspace.path), fs.realpathSync(dir));
  } finally {
    removeFixture(dir);
    if (home) fs.rmSync(home, { recursive: true, force: true });
  }
});

test("quick mode turns the external tools off for this run: disabled with the reason, reduced, never completed", () => {
  const { dir } = createMainFixture();
  let home;
  try {
    const r = jgates(["--cwd", dir, "--bridge-mode", "quick", "--json"]);
    home = r.home;
    const doc = parseOne(r.stdout);
    assertValidResult(doc);
    assert.equal(doc.decision, "passed");
    assert.equal(r.status, 0);
    assert.equal(doc.reduced, true);
    for (const id of ["megalinter", "semgrep", "trivy", "osv-scanner", "jscpd", "checkov"]) {
      const s = stage(doc, `quality-bridge.${id}`);
      assert.equal(s.state, "disabled", id);
      assert.match(s.reason, /quick/);
      assert.ok(doc.selection.overrides.some((o) => o.id === s.id));
      assert.ok(doc.disabled.some((d) => d.id === s.id && d.origin === "run"));
    }
    assert.equal(stage(doc, "quality-bridge.file-size").state, "completed");
    assert.equal(doc.selection.options.bridgeMode, "quick");
    assert.equal(gitStatus(dir), "");
  } finally {
    removeFixture(dir);
    if (home) fs.rmSync(home, { recursive: true, force: true });
  }
});

test("PII fixture with --enable-pii: blocking findings give failed and exit 1, with rule, location and severity", () => {
  const pii = createPiiFixture();
  let home;
  try {
    for (const mode of ["full", "quick"]) {
      const r = jgates(["--cwd", pii.dir, "--bridge-mode", mode, "--enable-pii", "--json"]);
      if (home) fs.rmSync(home, { recursive: true, force: true });
      home = r.home;
      const doc = parseOne(r.stdout);
      assertValidResult(doc);
      assert.equal(doc.decision, "failed", mode);
      assert.equal(r.status, 1, mode);
      assert.ok(doc.blockingViolations > 0);
      const cpf = doc.findings.find((f) => f.ruleId === "pii.cpf");
      assert.ok(cpf, "pii.cpf finding missing");
      assert.deepEqual(cpf.location, { path: PII_FILE, line: pii.lines.cpf });
      assert.equal(cpf.normalizedSeverity, cpf.severity);
      assert.equal(cpf.blocking, true);
      assert.ok(cpf.blockingReason);
      assert.ok(doc.stages.some((s) => s.id === cpf.stageId));
      assert.equal(doc.selection.options.pii, true);
      // Raw personal data never reaches the result.
      for (const value of Object.values(pii.values)) assert.ok(!r.stdout.includes(value), "raw PII in stdout");
      if (mode === "full") assert.equal(doc.complete, false);
    }
    assert.deepEqual(listTree(pii.dir), pii.files);
  } finally {
    removePiiFixture(pii.dir);
    if (home) fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sidecar failures and unreadable output give incomplete with the composite stage in error, and one JSON on stdout", () => {
  const work = tmp("jgates-ws-");
  fs.writeFileSync(path.join(work, "app.py"), "print('hello')\n");
  const cases = [
    ["unreadable stdout", fakeSidecar("import sys\nsys.stdout.write('this is not json')\nsys.stderr.write('boom')\nsys.exit(1)\n")],
    ["crash", fakeSidecar("raise RuntimeError('sidecar exploded')\n")],
    ["out of schema", fakeSidecar("import json\nprint(json.dumps({'hello': 1}))\n")],
    [
      "error answer",
      fakeSidecar(
        "import json\nprint(json.dumps({'schemaVersion': 1, 'ok': False, 'status': 'ERROR', 'exitCode': 3, 'error': {'code': 'sidecar-crashed', 'message': 'x'}, 'subchecks': []}))\n",
      ),
    ],
  ];
  const homes = [];
  try {
    for (const [name, sidecarDir] of cases) {
      const r = jgates(["--cwd", work, "--json"], { env: { JGATES_SIDECAR_DIR: sidecarDir } });
      homes.push(r.home);
      const doc = parseOne(r.stdout);
      assertValidResult(doc);
      assert.equal(doc.decision, "incomplete", name);
      assert.equal(r.status, 2, name);
      const composite = stage(doc, "quality-bridge");
      assert.equal(composite.state, "error", name);
      assert.ok(composite.reason, name);
      for (const id of manifestIds) assert.notEqual(stage(doc, `quality-bridge.${id}`).state, "completed", `${name}: ${id}`);
      assert.ok(fs.statSync(path.join(doc.runDir, "logs", "quality-bridge.stderr.log")).isFile());
    }
    const r = jgates(["--cwd", work, "--json"], { env: { JGATES_PYTHON: path.join(work, "no-such-python") } });
    homes.push(r.home);
    const doc = parseOne(r.stdout);
    assertValidResult(doc);
    assert.equal(doc.decision, "incomplete");
    assert.equal(r.status, 2);
    assert.match(stage(doc, "quality-bridge").reason, /python-not-found/);
  } finally {
    for (const [, d] of cases) fs.rmSync(d, { recursive: true, force: true });
    for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("usage errors exit 3 with error.code in the JSON", () => {
  const work = tmp("jgates-ws-");
  const homes = [];
  try {
    for (const [args, code] of [
      [["--cwd", work, "--no-such-flag", "--json"], "UNKNOWN_FLAG"],
      [["--cwd", work, "--bridge-mode", "turbo", "--json"], "INVALID_VALUE"],
      [["--cwd", path.join(work, "missing"), "--json"], "BAD_CWD"],
      [["--cwd", work, "extra", "--json"], "UNEXPECTED_ARGUMENT"],
    ]) {
      const r = jgates(args);
      homes.push(r.home);
      assert.equal(r.status, 3, args.join(" "));
      const doc = parseOne(r.stdout);
      assert.equal(doc.error.code, code);
      assert.equal(doc.exitCode, 3);
      // A usage error never starts a run.
      assert.ok(!fs.existsSync(path.join(r.home, "workspaces")), args.join(" "));
    }
  } finally {
    for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// Normalization rules, checked on crafted bridge answers (no process).
function answer({ status = "APPROVED", subchecks, findings = [], score = { value: 100, threshold: 80 }, tools = [], reasons = [] }) {
  return {
    kind: "response",
    interpreter: "python",
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    response: {
      schemaVersion: 1,
      ok: true,
      status,
      exitCode: 0,
      outputDir: "/out",
      reportPath: "/out/quality-report.json",
      subchecks: subchecks ?? manifestIds.map((id) => ({ id, status: "ok" })),
      report: { schemaVersion: "1.0.0", status, exitCode: 0, mode: "full", tools, findings, score, summary: { reasons } },
    },
  };
}
const fullPlan = (over = {}) => bridge.planSubchecks({ ...bridge.DEFAULT_SELECTION, ...over }, manifestIds);
const finding = (over = {}) => ({ tool: "semgrep", rule: "r1", severity: "low", category: "sast", message: "m", path: "a.py", line: 3, allowed: false, ...over });
const decide = async (out) => {
  const { computeDecision } = await import(pathToFileURL(path.resolve(here, "..", "dist", "core", "contract", "index.js")).href);
  return computeDecision({ resolved: true, requirements: out.requirements, stages: out.stages, disabled: out.disabled });
};

test("normalization: the requirement table is explicit and every required subcheck must complete", async () => {
  const out = bridge.normalizeBridge(answer({}), fullPlan());
  const req = Object.fromEntries(out.requirements.map((r) => [r.id, r]));
  assert.equal(req["quality-bridge"].required, true);
  assert.equal(req["quality-bridge.semgrep"].required, true);
  assert.equal(req["quality-bridge.gitleaks"].required, false);
  for (const r of out.requirements) assert.ok(r.reason, r.id);
  assert.equal((await decide(out)).decision, "passed");

  for (const status of ["missing", "timeout", "error", "skipped"]) {
    const subchecks = manifestIds.map((id) => ({ id, status: id === "semgrep" ? status : "ok" }));
    const o = bridge.normalizeBridge(answer({ subchecks }), fullPlan());
    assert.equal((await decide(o)).decision, "incomplete", status);
  }
  // A subcheck absent from the answer is not evidence.
  const partial = bridge.normalizeBridge(answer({ subchecks: [{ id: "file-size", status: "ok" }] }), fullPlan());
  assert.equal(partial.stages.find((s) => s.id === "quality-bridge.semgrep").state, "error");
  assert.equal((await decide(partial)).decision, "incomplete");
  // IaC tools skipped for lack of IaC files are not applicable, not approved.
  const iac = manifestIds.map((id) => ({ id, status: id === "checkov" ? "skipped" : "ok", reason: "No IaC files detected." }));
  assert.equal(bridge.normalizeBridge(answer({ subchecks: iac }), fullPlan()).stages.find((s) => s.id === "quality-bridge.checkov").state, "not_applicable");
  // Requested project tests that were skipped are blocked.
  const tests = manifestIds.map((id) => ({ id, status: id === "project-tests" ? "skipped" : "ok" }));
  const t = bridge.normalizeBridge(answer({ subchecks: tests }), fullPlan({ projectTests: true }));
  assert.equal(t.stages.find((s) => s.id === "quality-bridge.project-tests").state, "blocked");
  assert.equal((await decide(t)).decision, "incomplete");
});

test("normalization: blocking findings follow the legacy policy and never end looser than its verdict", async () => {
  // A critical finding blocks even under a NEEDS_CHANGES verdict.
  const crit = bridge.normalizeBridge(answer({ status: "NEEDS_CHANGES", findings: [finding({ severity: "critical" })] }), fullPlan());
  const f = crit.findings[0];
  assert.equal(f.stageId, "quality-bridge.semgrep");
  assert.equal(f.blocking, true);
  assert.equal(f.blockingReason, "critical");
  assert.equal((await decide(crit)).decision, "failed");
  // A waived finding does not block.
  const waived = bridge.normalizeBridge(answer({ findings: [finding({ severity: "critical", allowed: true, allowed_reason: "ok" })] }), fullPlan());
  assert.equal(waived.findings[0].blocking, false);
  assert.equal(waived.findings[0].waived, true);
  assert.equal((await decide(waived)).decision, "passed");
  // Score below the threshold blocks every active finding.
  const score = bridge.normalizeBridge(answer({ findings: [finding({ tool: "builtin", rule: "pii.cpf", category: "pii" })], score: { value: 70, threshold: 80 } }), fullPlan());
  assert.equal(score.findings[0].stageId, "quality-bridge");
  assert.equal(score.findings[0].blockingReason, "score-below-threshold");
  // REJECTED with nothing the table recognizes still fails.
  const rejected = bridge.normalizeBridge(answer({ status: "REJECTED" }), fullPlan());
  assert.equal((await decide(rejected)).decision, "failed");
  // NEEDS_CHANGES the stages do not explain leaves the composite unproven.
  const unexplained = bridge.normalizeBridge(answer({ status: "NEEDS_CHANGES", reasons: ["Required deterministic evidence was missing."] }), fullPlan());
  assert.equal(unexplained.stages[0].interpreted, false);
  assert.equal((await decide(unexplained)).decision, "incomplete");
  // Unknown severity stays unknown; file-size rules go to the file-size stage; evidence tools get their own stage.
  const misc = bridge.normalizeBridge(
    answer({
      findings: [finding({ severity: "weird" }), finding({ tool: "builtin", rule: "budget.file-lines", category: "quality-budget" })],
      tools: [{ name: "quality-evidence", status: "missing", summary: { required: true } }],
    }),
    fullPlan(),
  );
  assert.equal(misc.findings[0].normalizedSeverity, "unknown");
  assert.equal(misc.findings[1].stageId, "quality-bridge.file-size");
  assert.equal(misc.stages.find((s) => s.id === "quality-bridge.quality-evidence").state, "blocked");
  assert.equal((await decide(misc)).decision, "failed");
});
