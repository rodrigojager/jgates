"use strict";

// Compatibility suite for the component commands (quality-gate, semantic-gate). It pins the contract they had before JGates: exit codes, JSON
// fields and files written in the target. The governed CI path is jgates ci (jgates/tests/ci-governed.test.js).
// Rows that need Docker are not covered here (Docker is outside the default suite). Every contract change made by the
// JGates work is listed in MIGRATED below, with the test that proves the new behavior.
//
// The semantic gate uses the mock provider: no test spends model tokens.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const QUALITY_GATE = path.join(ROOT, "quality-gate", "bin", "quality-gate.js");
const SEMANTIC_GATE = path.join(ROOT, "semantic-gate", "dist", "cli.js");

// Changes of semantics made after that contract was recorded, migrated explicitly (never silently).
const MIGRATED = [];

// Docker would build/run the sidecar image and make the fixtures depend on the daemon; ambient CI refs would make
// the temporary repositories resolve an unrelated range.
const BASE_ENV = {
  ...process.env,
  DOCKER_CONTEXT: "",
  DOCKER_HOST: "tcp://127.0.0.1:1",
  GITHUB_BASE_REF: "",
  GITHUB_HEAD_REF: "",
  GITHUB_SHA: "",
  GITLAB_CI: "",
  CI_MERGE_REQUEST_DIFF_BASE_SHA: "",
  CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "",
  CI_COMMIT_SHA: "",
  QUALITY_GATE_START_DOCKER: "0"
};

const cleanups = [];
test.after(() => {
  for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true });
});

function temp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function exec(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...BASE_ENV, ...(options.env || {}) },
    input: options.input,
    timeout: 120000
  });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function repository(prefix, files = { "app.py": "VALUE = 1\n" }) {
  const dir = temp(prefix);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "compat@example.invalid");
  git(dir, "config", "user.name", "Compat Tests");
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content, "utf8");
  return dir;
}

const exists = (...parts) => fs.existsSync(path.join(...parts));
const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(...parts), "utf8"));

// --- quality-gate ---------------------------------------------------------------------------------------------

function qualityGate(dir, ...args) {
  return exec(process.execPath, [QUALITY_GATE, ".", "--no-start-docker", ...args], { cwd: dir });
}

test("quality-gate: exit 0 APPROVED prints text (not JSON) and writes quality-report.json and .md", () => {
  const dir = repository("compat-qc-ok-");
  const result = qualityGate(dir, "--mode", "quick", "--scope", "full");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^APPROVED score=/);
  assert.throws(() => JSON.parse(result.stdout));
  const report = readJson(dir, ".quality", "reports", "quality-report.json");
  assert.equal(report.schemaVersion, "1.0.0");
  assert.ok(exists(dir, ".quality", "reports", "quality-report.md"));
});

test("quality-gate: exit 1 REJECTED with a policy finding", () => {
  const dir = repository("compat-qc-rejected-", { "large.txt": "one\ntwo\nthree\n" });
  const result = qualityGate(dir, "--mode", "quick", "--scope", "full", "--max-file-lines", "1");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^REJECTED score=/);
});

test("quality-gate: exit 2 NEEDS_CHANGES when full mode has no tools", () => {
  const dir = repository("compat-qc-needs-");
  const result = qualityGate(dir, "--mode", "full", "--scope", "full", "--max-file-lines", "1000");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /^NEEDS_CHANGES score=/);
});

test("quality-gate: exit 3 for an operational error (missing target)", () => {
  const dir = temp("compat-qc-missing-");
  const result = exec(process.execPath, [QUALITY_GATE, path.join(dir, "does-not-exist"), "--mode", "quick", "--no-start-docker"], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /Target path does not exist/);
});

// --- semantic-gate (mock provider) -----------------------------------------------------------------------------

function semanticGate(dir, args, env = {}) {
  const home = temp("compat-sg-home-");
  return exec(process.execPath, [SEMANTIC_GATE, ...args], { cwd: dir, env: { SEMANTIC_GATE_HOME: home, ...env } });
}

function semanticProject() {
  const dir = repository("compat-sg-", { "app.js": "exports.answer = () => 42;\n" });
  fs.writeFileSync(path.join(dir, "objective.md"), "Add the answer helper.\n", "utf8");
  return dir;
}

test("semantic-gate: exit 0 APPROVED writes semantic-result.json, .md and the raw responses", () => {
  const dir = semanticProject();
  const result = semanticGate(dir, ["run", "--objective-file", "objective.md", "--provider", "mock", "--scope", "full", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.gate, "semantic");
  assert.equal(parsed.status, "APPROVED");
  const out = path.join(dir, ".quality", "semantic-gate");
  assert.ok(exists(out, "semantic-result.json"));
  assert.ok(exists(out, "semantic-result.md"));
  assert.ok(fs.readdirSync(out).length >= 3, "a file with the raw provider responses");
  assert.equal(readJson(out, "semantic-result.json").gate, "semantic");
});

test("semantic-gate: exit 1 for any status other than APPROVED", () => {
  const dir = semanticProject();
  const response = JSON.stringify({ gate: "semantic", status: "NEEDS_CHANGES", score: 10, threshold: 90 });
  const result = semanticGate(dir, ["run", "--objective-file", "objective.md", "--provider", "mock", "--scope", "full", "--json"], { SEMANTIC_GATE_MOCK_RESPONSE: response });
  assert.equal(result.status, 1, result.stdout + result.stderr);
});

test("semantic-gate: exit 2 for a provider error", () => {
  const dir = semanticProject();
  const result = semanticGate(dir, ["run", "--objective-file", "objective.md", "--scope", "full", "--json"]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
});

test("semantic-gate: exit 3 for a usage error and for a missing objective", () => {
  const dir = semanticProject();
  const scope = semanticGate(dir, ["run", "--objective-file", "objective.md", "--provider", "mock", "--scope", "nope"]);
  assert.equal(scope.status, 3);
  assert.match(scope.stderr, /scope must be changed, full, or paths/);
  const objective = semanticGate(dir, ["run", "--provider", "mock"]);
  assert.equal(objective.status, 3);
  assert.match(objective.stderr, /Missing objective input/);
});

// --- the migrated changes are all accounted for ----------------------------------------------------------------

test("every migrated change names the test that proves it", () => {
  const source = fs.readFileSync(__filename, "utf8");
  for (const change of MIGRATED) {
    assert.ok(source.includes(`test("${change.proof}`) || source.includes(`"${change.proof}`), `${change.id}: ${change.proof}`);
  }
});

// --- npm run verify --------------------------------------------------------------------------------------------

test("verify: package.json runs the Node script, and engines require Node 22 in the root, in jgates and in the components, as the docs say", () => {
  const pkg = readJson(ROOT, "package.json");
  assert.equal(pkg.scripts.verify, "node scripts/verify-all.mjs");
  assert.equal(pkg.engines.node, ">=22");
  assert.equal(readJson(ROOT, "jgates", "package.json").engines.node, ">=22");
  assert.equal(readJson(ROOT, "quality-gate", "package.json").engines.node, ">=22");
  assert.equal(readJson(ROOT, "semantic-gate", "package.json").engines.node, ">=22");
  assert.match(fs.readFileSync(path.join(ROOT, "docs", "jgates", "primeiros-passos.pt-BR.md"), "utf8"), /Node 22 ou mais novo/);
  assert.match(fs.readFileSync(path.join(ROOT, "docs", "jgates", "primeiros-passos.en.md"), "utf8"), /Node 22 or newer/);
});

test("verify: verify-all.mjs lists the steps verify-all.ps1 used to run, without PowerShell", () => {
  const result = exec(process.execPath, [path.join(ROOT, "scripts", "verify-all.mjs"), "--list"]);
  assert.equal(result.status, 0, result.stderr);
  const steps = JSON.parse(result.stdout).map((s) => `${s.cwd} ${s.command} ${s.args.join(" ")}`);
  const expected = [
    /^\. python3? -m pip install .* defusedxml==0\.7\.1$/,
    /^semantic-gate npm ci --workspaces=false$/,
    /^semantic-gate npm run build --workspaces=false$/,
    /^\. node --check quality-gate\/bin\/quality-gate\.js$/,
    /^\. npm run test:root$/,
    /^\. npm pack --dry-run$/,
    /^semantic-gate npm run test:build --workspaces=false$/,
    /^semantic-gate npm run pack:dry-run --workspaces=false$/,
    /^quality-gate npm ci --workspaces=false$/,
    /^quality-gate npm test --workspaces=false$/,
    /^quality-gate npm pack --dry-run$/
  ];
  assert.equal(steps.length, expected.length, steps.join("\n"));
  expected.forEach((pattern, index) => assert.match(steps[index], pattern));
});

test("verify: verify-all.ps1 only calls the Node script and does not duplicate its logic", () => {
  const ps1 = fs.readFileSync(path.join(ROOT, "scripts", "verify-all.ps1"), "utf8");
  const code = ps1.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#"));
  const codeText = code.join("\n");
  assert.ok(code.some((line) => /verify-all\.mjs/.test(line)), "calls verify-all.mjs");
  assert.ok(code.length <= 5, `only a few lines of code, got ${code.length}`);
  for (const forbidden of [/npm\s+(ci|pack|test|run)/, /pip\s+install|-m\s+pip/, /git\s+-C|status/, /Invoke-Native/, /Push-Location/]) {
    assert.doesNotMatch(codeText, forbidden);
  }
});

test("verify: verify-all.mjs fails closed on an unknown failure (exit code is the step failure)", () => {
  const source = fs.readFileSync(path.join(ROOT, "scripts", "verify-all.mjs"), "utf8");
  assert.match(source, /failed with exit code/);
  assert.match(source, /Verification changed the Git worktree/);
});
