import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXECUTABLES, forgedTestFiles, hostilePolicy, projectFiles, testsPolicy } from "./fixtures/ci-hostile/index.js";

// jgates ci, hardened: whoever is evaluated does not choose the rules. Every tool takes its configuration from the
// policy only, the suppressions written in the code are turned off or reported, the linters of the quality gate come
// from a closed list, and what the analyzed project produces itself (its tests, MSBuild, coverage files) never approves
// alone. Plus the protections the old governed launcher had, checked against jgates ci.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const exe = (name) => path.join(VENV_BIN, process.platform === "win32" ? `${name}.exe` : name);
const NEEDS_TOOLS = fs.existsSync(exe("ruff")) && fs.existsSync(exe("semgrep")) ? false : "Ruff and Semgrep are not installed in the repository .venv";
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const mod = (rel) => import(pathToFileURL(path.join(dist, ...rel.split("/"))).href);
const { readPolicyBundle } = await mod("core/policy/index.js");
const { findOnPath } = await mod("core/bridge/index.js");
const { computeDecision } = await mod("core/contract/index.js");
const { executeRun } = await mod("core/run/index.js");
const governedSteps = await mod("core/governed/steps.js");
const { governedBridgeEnv } = await mod("core/governed/env.js");
const { readBridgeLinters, lintersFile, ciLinters, LinterListError } = await mod("core/governed/linters.js");
const { ADAPTER_TRUST, SUBCHECK_TRUST, untrustedSubchecks, adapterTreatment } = await mod("core/governed/trust.js");
const { externalAdapterIds } = await mod("core/plan/adapters.js");
const { STANDARD_BUDGET_CEILINGS } = await mod("core/governed/budgets.js");
const { resolveInTree } = await mod("core/governed/tree.js");

const GIT = findOnPath("git");
const NO_DOCKER = { DOCKER_CONTEXT: "", DOCKER_HOST: "tcp://127.0.0.1:1", GITHUB_BASE_REF: "", GITHUB_HEAD_REF: "", GITHUB_SHA: "", GITLAB_CI: "" };
const SIDECAR = path.join(repo, "quality-gate", "sidecar");
const validateResult = new Ajv2020({ strict: true, allErrors: true }).compile(
  JSON.parse(fs.readFileSync(path.resolve(here, "..", "schemas", "result", "result.schema.json"), "utf8")),
);

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function write(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, ...name.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

const GIT_ENV = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
const git = (dir, ...args) => {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

/** A Git repository with `files` committed (the EXECUTABLES among them with mode 755). */
function repository(files) {
  const dir = tmp("jgates-hard-proj-");
  git(dir, "init", "-q", "-b", "main");
  write(dir, files);
  for (const rel of EXECUTABLES) if (files[rel] !== undefined) fs.chmodSync(path.join(dir, ...rel.split("/")), 0o755);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "fixture");
  return dir;
}

/** The project `files`, the policy `policy` and a CLI that runs jgates ci with the right hash. */
function setup(files, policy, extraEnv = {}) {
  assert.ok(fs.existsSync(PYTHON), "the repository .venv has no python: create it (python3 -m venv .venv) and install the dev tools");
  assert.ok(GIT, "git not found on PATH");
  const dir = repository(files);
  const home = tmp("jgates-hard-home-");
  const policyDir = tmp("jgates-hard-policy-");
  const emptyBin = tmp("jgates-hard-bin-");
  write(policyDir, policy);
  const base = { ...process.env, ...NO_DOCKER, JGATES_HOME: home, JGATES_PYTHON: PYTHON, JGATES_GIT: GIT, PATH: emptyBin, ...extraEnv };
  for (const name of ["JGATES_POLICY_DIR", "JGATES_POLICY_SHA256", "JGATES_NO_CACHE", "JGATES_ESLINT", "JGATES_RUFF", "JGATES_SEMGREP"]) delete base[name];
  const sha = () => readPolicyBundle(policyDir).bundle.sha256;
  const cli = (env, ...args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: { ...base, ...env }, timeout: 600_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const ci = (...args) => cli({ JGATES_POLICY_SHA256: sha() }, "ci", "--cwd", dir, "--policy", policyDir, "--json", ...args);
  const runs = () => {
    const ws = path.join(home, "workspaces");
    if (!fs.existsSync(ws)) return [];
    return fs.readdirSync(ws).flatMap((id) => (fs.existsSync(path.join(ws, id, "runs")) ? fs.readdirSync(path.join(ws, id, "runs")) : []));
  };
  const commit = (more, message = "change") => {
    write(dir, more);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", message);
  };
  const cleanup = () => {
    for (const d of [dir, home, policyDir, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
  };
  return { dir, home, policyDir, emptyBin, sha, cli, ci, runs, commit, cleanup };
}

const one = (r) => {
  try {
    return JSON.parse(r.out);
  } catch (error) {
    throw new Error(`stdout is not one JSON document (${error.message}):\n${r.out}\n${r.err}`);
  }
};
const readRun = (result, name) => fs.readFileSync(path.join(result.runDir, name), "utf8");
const stage = (result, id) => result.stages.find((s) => s.id === id);
const toolFindings = (result, tools) =>
  result.findings
    .filter((f) => tools.includes(f.tool))
    .map((f) => `${f.tool}:${f.ruleId}:${f.location?.path}`)
    .sort();

/** A minimal policy: the budgets (file size) and what `checks` adds; the quality policy given. */
function smallPolicy({ checks = {}, quality = { schemaVersion: 1, budgets: { maxFileLines: 40 } }, extraRoot = "" } = {}) {
  const lines = Object.entries({ "capability:lint": false, "capability:secrets": false, ...checks }).map(([k, v]) => `      ${k}:\n        enabled: ${v}\n`);
  return {
    "jgates.yml": `schemaVersion: 1\nextends:\n  - .jgates/profiles.yml\nselection:\n  profile: gate\n${extraRoot}`,
    ".jgates/profiles.yml": `schemaVersion: 1\nprofiles:\n  gate:\n    label: gate\n    extends: builtin:minimal\n    checks:\n${lines.join("")}`,
    ...(quality ? { ".jgates/quality-policy.json": `${JSON.stringify(quality, null, 2)}\n` } : {}),
  };
}

test("ci hardening: a hostile project (its own ESLint, Ruff, Semgrep and Gitleaks configuration, suppression comments, a fake ESLint) does not change the decision; the findings stay and the suppressions appear", { skip: NEEDS_TOOLS }, () => {
  const clean = setup(projectFiles({ hostile: false }), hostilePolicy());
  const hostile = setup(projectFiles({ hostile: true }), hostilePolicy());
  try {
    const before = clean.ci();
    const after = hostile.ci();
    const a = one(before);
    const b = one(after);
    // Same decision and the same findings of the policy's tools: nothing the project wrote switched them off.
    assert.equal(b.decision, a.decision, after.out + after.err);
    assert.equal(after.code, before.code);
    assert.equal(b.decision, "failed");
    const tools = ["ruff", "eslint", "semgrep"];
    const expected = toolFindings(a, tools);
    assert.deepEqual(toolFindings(b, tools), expected);
    for (const needle of ["ruff:F401:app/main.py", "eslint:no-unused-vars:web/app.js", "semgrep:no-eval:app/main.py"]) {
      assert.ok(expected.some((f) => f.startsWith(needle)), `${needle} in ${JSON.stringify(expected)}`);
    }
    for (const id of ["ruff#lint", "eslint#lint", "semgrep#sast"]) assert.equal(stage(b, id)?.state, "completed", JSON.stringify(stage(b, id)));

    // The suppressions appear: neutralized ones as information, the ones a check still honors as blocking.
    const suppressions = b.findings.filter((f) => f.ruleId.startsWith("suppression."));
    const kinds = new Set(suppressions.map((f) => f.ruleId));
    for (const kind of ["suppression.noqa", "suppression.eslint", "suppression.nosem", "suppression.gitleaks", "suppression.shellcheck"]) assert.ok(kinds.has(kind), `${kind}: ${JSON.stringify([...kinds])}`);
    for (const f of suppressions.filter((x) => ["suppression.noqa", "suppression.eslint", "suppression.nosem", "suppression.gitleaks"].includes(x.ruleId))) {
      assert.equal(f.blocking, false, JSON.stringify(f));
    }
    const shellcheck = suppressions.find((f) => f.ruleId === "suppression.shellcheck");
    assert.equal(shellcheck.blocking, true, JSON.stringify(shellcheck));
    assert.deepEqual(shellcheck.location, { path: "scripts/run.sh", line: 2 });
    assert.equal(stage(b, "jgates-ci.suppressions").state, "completed");
    assert.ok(stage(b, "jgates-ci.suppressions").blockingViolations >= 1);
    assert.equal(a.findings.filter((f) => f.ruleId.startsWith("suppression.")).length, 0, "the clean copy has no suppression comment");

    // The plan names only the policy's files and forces the flags; the project's configuration is never read.
    const plan = JSON.parse(readRun(b, "plan.json"));
    const invocation = (id) => plan.invocations.find((i) => i.id === id).command;
    const policyFile = (rel) => path.join(hostile.policyDir, ...rel.split("/"));
    const eslint = invocation("eslint");
    assert.ok(eslint.args.includes("--no-inline-config"), JSON.stringify(eslint.args));
    assert.equal(eslint.args[eslint.args.indexOf("--config") + 1], policyFile(".jgates/eslint.config.mjs"));
    assert.ok(!JSON.stringify(eslint).includes("node_modules/.bin/eslint"), "ESLint is never the project's copy");
    const ruff = invocation("ruff");
    assert.equal(ruff.args[ruff.args.indexOf("--config") + 1], policyFile(".jgates/ruff.toml"));
    for (const flag of ["--ignore-noqa", "--no-respect-gitignore"]) assert.ok(ruff.args.includes(flag), flag);
    const semgrep = invocation("semgrep");
    for (const flag of ["--disable-nosem", "--x-ignore-semgrepignore-files", "--no-git-ignore"]) assert.ok(semgrep.args.includes(flag), flag);
    assert.ok(semgrep.args.includes(policyFile(".jgates/rules/no-eval.yml")), JSON.stringify(semgrep.args));
    const bridge = plan.invocations.find((i) => i.adapter === "quality-bridge").command.stdin;
    assert.equal(bridge.hardened, true);
    assert.equal(bridge.toolConfigs, undefined);
    const gitleaks = plan.groups.willRun.find((i) => i.tool === "quality-bridge.gitleaks");
    assert.equal(gitleaks.bridge.effectiveCommand.config.source, "package");
    assert.ok(gitleaks.bridge.effectiveCommand.args.includes("--ignore-gitleaks-allow"));
    const projectConfigs = ["eslint.config.js", "pyproject.toml", "ruff.toml", ".semgrepignore", ".gitleaks.toml", ".gitleaksignore", ".jscpd.json", ".quality-gate-policy.json"];
    const planFiles = [...plan.inputs.configFiles.map((f) => f.file), ...plan.groups.willRun.flatMap((i) => i.configFiles.map((f) => f.file))];
    for (const file of projectConfigs) assert.ok(!planFiles.includes(file), `${file} in ${JSON.stringify(planFiles)}`);
    assert.ok(validateResult(JSON.parse(readRun(b, "result.json"))), JSON.stringify(validateResult.errors));
  } finally {
    clean.cleanup();
    hostile.cleanup();
  }
});

test("ci hardening: a conftest.py that forges the tests' result does not approve alone; the stage is selfReported and only the policy can trust it", () => {
  const forged = setup(forgedTestFiles({ forged: true }), testsPolicy());
  try {
    const r = forged.ci();
    const result = one(r);
    const pytest = stage(result, "pytest#unit");
    // The forged pass is what pytest reports: the stage completed, but the project controls it.
    assert.equal(pytest?.state, "completed", JSON.stringify(result.stages));
    assert.equal(pytest.selfReported, true);
    assert.equal(r.code, 2, r.out + r.err);
    assert.equal(result.decision, "incomplete");
    assert.ok(result.unsatisfied.some((u) => u.requirementId === "pytest#unit"), JSON.stringify(result.unsatisfied));
    assert.equal(result.policy.trustSelfReported, false);
    const plan = JSON.parse(readRun(result, "plan.json"));
    assert.ok(plan.groups.willRun.find((i) => i.id === "pytest#unit").conditions.some((c) => c.includes("trustSelfReported")));
    assert.ok(validateResult(JSON.parse(readRun(result, "result.json"))), JSON.stringify(validateResult.errors));

    // A self-reported failure still fails: the honest copy (no conftest.py) is rejected.
    fs.rmSync(path.join(forged.dir, "conftest.py"));
    git(forged.dir, "add", "-A");
    git(forged.dir, "commit", "-qm", "honest");
    const honest = forged.ci();
    assert.equal(honest.code, 1, honest.out + honest.err);
    assert.equal(one(honest).decision, "failed");
  } finally {
    forged.cleanup();
  }

  // The policy may decide to trust the project's own results (execution.trustSelfReported): then the forged pass counts.
  const trusted = setup(forgedTestFiles({ forged: true }), testsPolicy({ trustSelfReported: true }));
  try {
    const r = trusted.ci();
    const result = one(r);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(result.decision, "passed");
    assert.equal(stage(result, "pytest#unit").selfReported, true);
    assert.equal(result.policy.trustSelfReported, true);
  } finally {
    trusted.cleanup();
  }
});

test("ci hardening: a .csproj makes MegaLinter's stage selfReported (MSBuild runs the project's targets), and a self-reported pass never approves alone", async () => {
  const p = setup(forgedTestFiles({ forged: false, csproj: true }), smallPolicy({ checks: { "capability:lint": true, "tool:ruff": false } }));
  try {
    const result = one(p.ci());
    assert.equal(stage(result, "quality-bridge.megalinter")?.selfReported, true, JSON.stringify(result.stages));
    // Without a project file MSBuild has nothing to load: the stage is trusted.
    fs.rmSync(path.join(p.dir, "Sample.csproj"));
    git(p.dir, "add", "-A");
    git(p.dir, "commit", "-qm", "no project file");
    const again = one(p.ci());
    assert.equal(stage(again, "quality-bridge.megalinter")?.selfReported, undefined);
  } finally {
    p.cleanup();
  }

  // The decision: a completed self-reported stage satisfies its requirement only when the run trusts it.
  const stages = [{ id: "unit", state: "completed", selfReported: true }];
  const requirements = [{ id: "unit", required: true }];
  assert.equal(computeDecision({ resolved: true, requirements, stages }).decision, "passed");
  assert.equal(computeDecision({ resolved: true, requirements, stages, selfReportedSatisfies: false }).decision, "incomplete");
  const failing = [{ id: "unit", state: "completed", selfReported: true, blockingViolations: 2 }];
  assert.equal(computeDecision({ resolved: true, requirements, stages: failing, selfReportedSatisfies: false }).decision, "failed");

  // The marking itself, from the plan and the snapshot facts.
  const plan = { groups: { willRun: [
    { id: "quality-bridge.megalinter#lint", adapter: "quality-bridge", subcheck: "megalinter", effects: { executesProjectCode: false } },
    { id: "quality-bridge.coverage#coverage", adapter: "quality-bridge", subcheck: "coverage", effects: { executesProjectCode: false } },
    { id: "ruff#lint", adapter: "ruff", subcheck: null, effects: { executesProjectCode: false } },
    { id: "run-tests#unit", adapter: "generic-command", subcheck: null, effects: { executesProjectCode: true } },
  ] } };
  const linters = readBridgeLinters(lintersFile({ JGATES_SIDECAR_DIR: SIDECAR }));
  const facts = { listing: { files: ["src/App.csproj"], truncated: false }, linters, msbuildFiles: ["src/App.csproj"], coverageReports: [] };
  assert.deepEqual([...governedSteps.selfReportedStages(plan, facts)].sort(), ["quality-bridge.coverage", "quality-bridge.megalinter", "run-tests#unit"]);
  assert.deepEqual([...governedSteps.selfReportedStages(plan, { ...facts, msbuildFiles: [] })].sort(), ["quality-bridge.coverage", "run-tests#unit"]);
  const unreadable = { ...facts, msbuildFiles: [], linters: new LinterListError("broken") };
  assert.ok(governedSteps.selfReportedStages(plan, unreadable).has("quality-bridge.megalinter"), "an unreadable list proves nothing");

  // executeRun applies it.
  const home = tmp("jgates-hard-engine-home-");
  const workspace = tmp("jgates-hard-engine-ws-");
  try {
    const output = { stages: [{ id: "unit", state: "completed", selfReported: true }], requirements, disabled: [], findings: [], logs: [], outputs: [] };
    const base = { workspacePath: workspace, home, version: "0.0.0-test", adapter: "fake", options: {}, env: { ...process.env, JGATES_GIT: "/nonexistent-git" }, execute: async () => structuredClone(output) };
    assert.equal((await executeRun(base)).decision, "passed");
    const governed = await executeRun({ ...base, selfReportedSatisfies: false });
    assert.equal(governed.decision, "incomplete");
    assert.equal(governed.exitCode, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("ci hardening: the list of MegaLinter's linters exists, covers every linter the quality gate can activate, and closes MegaLinter's list in jgates ci", () => {
  const linters = readBridgeLinters(lintersFile({ JGATES_SIDECAR_DIR: SIDECAR }));
  const ids = new Set(linters.map((l) => l.id));
  for (const l of linters) {
    assert.ok(l.config.length > 0 && l.suppressions.length > 0, l.id);
    if (l.ci === "excluded") assert.ok(l.reason, `${l.id} is excluded without a reason`);
  }
  // The linters the sidecar activates by name (the dotnetweb list) or configures by name (<LINTER>_* variables).
  const script = [
    "import json, re, inspect",
    "from quality_sidecar import tools",
    "src = inspect.getsource(tools)",
    "named = set(tools.MEGALINTER_ENABLED_LINTERS.split(','))",
    "configured = set(m for m in re.findall(r'\"([A-Z]+_[A-Z0-9_]+?)_(?:ARGUMENTS|RULES_PATH|CONFIG_FILE)\"', src))",
    "print(json.dumps({",
    "  'named': sorted(named), 'configured': sorted(configured),",
    "  'generic': tools.megalinter_hardened_env('generic'), 'dotnetweb': tools.megalinter_hardened_env('dotnetweb'),",
    "}))",
  ].join("\n");
  const r = spawnSync(PYTHON, ["-c", script], { encoding: "utf8", env: { ...process.env, PYTHONPATH: SIDECAR, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(r.status, 0, r.stderr);
  const py = JSON.parse(r.stdout);
  const active = new Set([...py.named, ...py.configured]);
  assert.ok(active.size >= py.named.length && active.has("JAVASCRIPT_ES"));
  for (const id of active) assert.ok(ids.has(id), `${id} is activated or configured by the quality gate but missing from megalinter-linters.json`);

  // jgates ci: ENABLE_LINTERS is exactly the linters the list does not exclude (no auto-detection), each with its
  // forcing arguments; the dotnetweb flavor keeps only the ones it ships.
  const allowed = ciLinters(linters).map((l) => l.id);
  assert.deepEqual(py.generic.ENABLE_LINTERS.split(","), allowed);
  assert.deepEqual(py.dotnetweb.ENABLE_LINTERS.split(","), allowed.filter((id) => py.named.includes(id)));
  for (const l of ciLinters(linters).filter((x) => x.ciArguments)) assert.ok(py.generic[`${l.id}_ARGUMENTS`]?.length > 0, l.id);
  assert.ok(py.generic.JAVASCRIPT_ES_ARGUMENTS.includes("--no-inline-config"));
  assert.ok(!py.generic.JAVASCRIPT_ES_ARGUMENTS.includes("{configDir}"));
  assert.equal(py.generic.BASH_SHELLCHECK_ARGUMENTS, "--norc");
  for (const excluded of linters.filter((l) => l.ci === "excluded")) assert.ok(!allowed.includes(excluded.id));

  // A hardened bridge request: MegaLinter cannot be replaced by MEGALINTER_COMMAND, DISABLE_LINTERS is gone and the list
  // is closed; a hardened request never takes the project's scanner configuration.
  const hardened = [
    "import json, os, pathlib, tempfile",
    "from quality_sidecar import tools, bridge",
    "seen = {}",
    "def fake(name, command, raw_dir, **kw):",
    "    seen['command'] = command; seen['env'] = kw.get('env')",
    "    return tools.ToolResult(name=name, status='missing')",
    "tools.run_command = fake",
    "os.environ['MEGALINTER_COMMAND'] = '/tmp/fake-megalinter'",
    "root = pathlib.Path(tempfile.mkdtemp())",
    "tools._run_megalinter(root, root / 'raw', hardened=True)",
    "hard = seen.copy()",
    "tools._run_megalinter(root, root / 'raw')",
    "loose = seen.copy()",
    "try:",
    "    bridge.validate_request({'schemaVersion': 1, 'target': str(root), 'outputDir': str(root / 'out'), 'hardened': True, 'toolConfigs': {'gitleaks': 'x.toml'}})",
    "    refused = False",
    "except bridge.BridgeError:",
    "    refused = True",
    "print(json.dumps({'hard': hard, 'loose': loose, 'refused': refused}))",
  ].join("\n");
  const h = spawnSync(PYTHON, ["-c", hardened], { encoding: "utf8", env: { ...process.env, PYTHONPATH: SIDECAR, PYTHONDONTWRITEBYTECODE: "1", QUALITY_GATE_FLAVOR: "generic" } });
  assert.equal(h.status, 0, h.stderr);
  const out = JSON.parse(h.stdout);
  assert.deepEqual(out.hard.command, ["/entrypoint.sh"]);
  assert.equal(out.hard.env.ENABLE_LINTERS, allowed.join(","));
  assert.equal(out.hard.env.DISABLE_LINTERS, undefined);
  assert.deepEqual(out.loose.command, ["/tmp/fake-megalinter"], "outside jgates ci nothing changes");
  assert.ok(out.loose.env.DISABLE_LINTERS.length > 0 && out.loose.env.ENABLE_LINTERS === undefined);
  assert.equal(out.refused, true);

  // The run reads the same list: a malformed one fails closed.
  const broken = tmp("jgates-hard-linters-");
  try {
    fs.writeFileSync(path.join(broken, "list.json"), '{"schemaVersion":1,"linters":[{"id":"X","ci":"maybe","config":"","suppressions":""}]}');
    assert.throws(() => readBridgeLinters(path.join(broken, "list.json")), LinterListError);
    assert.throws(() => readBridgeLinters(null), LinterListError);
  } finally {
    fs.rmSync(broken, { recursive: true, force: true });
  }

  // The trust table knows every adapter and every subcheck (an unknown one is excluded, fail-closed).
  for (const id of externalAdapterIds()) assert.ok(ADAPTER_TRUST[id], `${id} is missing from the trust table of jgates ci`);
  assert.deepEqual(untrustedSubchecks(), []);
  assert.equal(adapterTreatment("not-an-adapter", false), "excluded");
  assert.equal(SUBCHECK_TRUST["project-tests"].treatment, "self-reported");
  // Every excluded adapter has its reason in both languages.
  for (const locale of ["en", "pt-BR"]) {
    const catalog = JSON.parse(fs.readFileSync(path.resolve(here, "..", "src", "i18n", `governed.${locale}.json`), "utf8"));
    for (const [id, trust] of Object.entries(ADAPTER_TRUST)) if (trust.treatment === "excluded") assert.ok(catalog[`governed_excluded_${id}`], `${locale}: ${id}`);
  }
});

test("ci hardening: an adapter jgates ci does not trust (it reads its configuration from the analyzed tree) is refused with the reason before anything runs", () => {
  const policy = smallPolicy();
  policy[".jgates/tools.yml"] = "schemaVersion: 1\ntools:\n  gitleaks:\n    adapter: gitleaks\n    capabilities: [secrets]\n    runner: container\n";
  policy[".jgates/profiles.yml"] = policy[".jgates/profiles.yml"].replace("capability:secrets:\n        enabled: false", "capability:secrets:\n        enabled: true");
  const p = setup({ "README.md": "# project\n", ".gitleaks.toml": "[allowlist]\npaths = ['''.*''']\n" }, policy);
  try {
    const r = p.ci();
    assert.equal(r.code, 3, r.out + r.err);
    const doc = one(r);
    assert.equal(doc.code, "PLAN_NOT_APPROVABLE");
    assert.ok(doc.blockers.some((b) => b.items?.includes("gitleaks#secrets") && /jgates ci/.test(b.message)), JSON.stringify(doc.blockers));
    assert.deepEqual(p.runs(), []);
    // jgates run keeps working as before with the same instance (nothing of this applies outside jgates ci).
    write(p.dir, { "jgates.yml": policy["jgates.yml"], ".jgates/profiles.yml": policy[".jgates/profiles.yml"], ".jgates/tools.yml": policy[".jgates/tools.yml"] });
    const plan = one(p.cli({}, "plan", "--cwd", p.dir, "--json"));
    const item = plan.plan.groups.willRun.find((i) => i.id === "gitleaks#secrets");
    assert.ok(item && !/jgates ci/.test(item.availability.reason ?? ""), JSON.stringify(item?.availability));
  } finally {
    p.cleanup();
  }
});

test("ci hardening: coverage reports carried by the commit are evidence the project supplied: the coverage stage is refused", () => {
  const lcov = "TN:\nSF:app.py\nDA:1,1\nDA:2,1\nLF:2\nLH:2\nend_of_record\n";
  const p = setup({ "app.py": "x = 1\ny = 2\n", "coverage/lcov.info": lcov }, smallPolicy({ checks: { "capability:coverage": true, "tool:quality-bridge.coverage": true } }));
  try {
    const result = one(p.ci());
    const coverage = stage(result, "quality-bridge.coverage");
    assert.equal(coverage?.state, "error", JSON.stringify(result.stages));
    assert.equal(coverage.interpreted, false);
    assert.match(coverage.reason, /coverage\/lcov\.info/);
    assert.equal(coverage.selfReported, true);
    assert.notEqual(result.decision, "passed");
  } finally {
    p.cleanup();
  }
});

test("ci hardening: the quality policy cannot turn the budgets off or loosen them, and the policy cannot switch the file size check off", () => {
  const cases = [
    [{ schemaVersion: 1, budgets: { enabled: false } }, "POLICY_BUDGETS_WEAKENED"],
    [{ schemaVersion: 1, budgets: { maxChangedFiles: STANDARD_BUDGET_CEILINGS.maxChangedFiles + 1 } }, "POLICY_BUDGETS_WEAKENED"],
    [{ schemaVersion: 1, budgets: { maxFileLines: 0 } }, "POLICY_BUDGETS_WEAKENED"],
  ];
  for (const [quality, code] of cases) {
    const p = setup({ "README.md": "# project\n" }, smallPolicy({ quality }));
    try {
      const r = p.ci();
      assert.equal(r.code, 3, `${JSON.stringify(quality)}: ${r.out}${r.err}`);
      assert.equal(one(r).code, code);
      assert.deepEqual(p.runs(), []);
    } finally {
      p.cleanup();
    }
  }
  // Tighter budgets are fine; the file size check switched off by the policy's profile is refused.
  const off = setup({ "README.md": "# project\n" }, smallPolicy({ checks: { "capability:file-size": false, "capability:sast": true } }));
  try {
    const r = off.ci();
    assert.equal(r.code, 3, r.out + r.err);
    assert.equal(one(r).code, "POLICY_BUDGETS_DISABLED");
    assert.deepEqual(off.runs(), []);
  } finally {
    off.cleanup();
  }
  // The ceilings are the standard profile of the quality gate.
  const r = spawnSync(PYTHON, ["-c", "import json; from quality_sidecar.metrics import PROFILE_BUDGETS as B; print(json.dumps(B['standard']))"], { encoding: "utf8", env: { ...process.env, PYTHONPATH: SIDECAR } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(STANDARD_BUDGET_CEILINGS, JSON.parse(r.stdout));
});

test("ci hardening: a submodule or a symbolic link out of the checkout fails closed before anything runs; a link inside is fine", { skip: process.platform === "win32" ? "symbolic links in Git need a Unix file system here" : false }, () => {
  const p = setup({ "README.md": "# project\n", "docs/guide.md": "guide\n" }, smallPolicy());
  try {
    fs.symlinkSync("../README.md", path.join(p.dir, "docs", "readme-link.md"));
    git(p.dir, "add", "-A");
    git(p.dir, "commit", "-qm", "link inside");
    const inside = p.ci();
    assert.equal(inside.code, 0, inside.out + inside.err);

    fs.symlinkSync("../../../etc/hostname", path.join(p.dir, "docs", "host.txt"));
    git(p.dir, "add", "-A");
    git(p.dir, "commit", "-qm", "link outside");
    const outside = p.ci();
    assert.equal(outside.code, 3, outside.out + outside.err);
    assert.equal(one(outside).code, "CI_SYMLINK_ESCAPE");
    assert.match(one(outside).message, /docs\/host\.txt/);
    const runsAfterLink = p.runs().length;

    git(p.dir, "rm", "-q", "docs/host.txt");
    git(p.dir, "commit", "-qm", "drop the link");
    const head = git(p.dir, "rev-parse", "HEAD");
    git(p.dir, "update-index", "--add", "--cacheinfo", `160000,${head},vendor/submodule`);
    git(p.dir, "commit", "-qm", "gitlink");
    const sub = p.ci();
    assert.equal(sub.code, 3, sub.out + sub.err);
    assert.equal(one(sub).code, "CI_SUBMODULE_REFUSED");
    assert.equal(p.runs().length, runsAfterLink, "nothing ran for the refused commits");
  } finally {
    p.cleanup();
  }
  // Links are followed the way the file system would: through a link to a folder, ".." leaves from the real folder.
  const links = { "a/up": "..", "a/escape": "up/../x", "b": "/etc", "loop": "loop" };
  const target = (p) => links[p] ?? null;
  assert.equal(resolveInTree("a/escape", target), null);
  assert.equal(resolveInTree("b", target), null);
  assert.equal(resolveInTree("loop", target), null);
  assert.equal(resolveInTree("a/up", target), "");
});

test("ci hardening: the quality gate gets an allowlisted environment (no CI token, no MEGALINTER_COMMAND), the proxy and certificates stay", { skip: process.platform === "win32" ? "the interpreter wrapper that records the environment is a POSIX shell script" : false }, () => {
  const dumpDir = tmp("jgates-hard-dump-");
  const wrapper = path.join(dumpDir, "python");
  const dump = path.join(dumpDir, "env.txt");
  fs.writeFileSync(wrapper, `#!/bin/sh\n/usr/bin/env > "${dump}"\nexec "${PYTHON}" "$@"\n`, { mode: 0o755 });
  const secrets = {
    CI_JOB_TOKEN: "job-secret",
    MEGALINTER_COMMAND: "unexpected-command",
    SONAR_TOKEN: "sonar-secret",
    AWS_ACCESS_KEY_ID: "synthetic-access-key",
    AWS_SECRET_ACCESS_KEY: "synthetic-secret-key",
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/synthetic-google-credentials.json",
    NPM_CONFIG_USERCONFIG: "/tmp/synthetic-npmrc",
    GIT_ASKPASS: "/tmp/synthetic-askpass",
    HTTPS_PROXY: "http://proxy.example.invalid:8080",
    SSL_CERT_FILE: "/etc/company/ca.pem",
  };
  const p = setup({ "README.md": "# project\n" }, smallPolicy(), { ...secrets, JGATES_PYTHON: wrapper });
  try {
    const r = p.ci();
    assert.equal(r.code, 0, r.out + r.err);
    const seen = Object.fromEntries(fs.readFileSync(dump, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    for (const name of ["CI_JOB_TOKEN", "MEGALINTER_COMMAND", "SONAR_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "NPM_CONFIG_USERCONFIG", "GIT_ASKPASS"]) {
      assert.equal(seen[name], undefined, `${name} reached the quality gate`);
    }
    assert.equal(seen.HTTPS_PROXY, secrets.HTTPS_PROXY);
    assert.equal(seen.SSL_CERT_FILE, secrets.SSL_CERT_FILE);
  } finally {
    p.cleanup();
    fs.rmSync(dumpDir, { recursive: true, force: true });
  }
  // The same allowlist, directly; jgates run keeps the bridge's environment as it was.
  const env = governedBridgeEnv({ PATH: "/bin", CI_JOB_TOKEN: "x", JGATES_PYTHON: "/py", HTTP_PROXY: "http://p" });
  assert.deepEqual(env, { PATH: "/bin", JGATES_PYTHON: "/py", HTTP_PROXY: "http://p" });
});

test("ci hardening: the analysis is the whole commit whatever --base or the CI variables say; an unknown base fails closed; tracked outputs, logs and databases are analyzed", () => {
  const big = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const p = setup({ "README.md": "# project\n", "dist/bundle.js": big, "build/generated.cs": big, "coverage/raw.txt": big, "runtime.log": big, "state.db": big }, smallPolicy());
  try {
    const head = git(p.dir, "rev-parse", "HEAD");
    const paths = (result) => [...new Set(result.findings.filter((f) => f.ruleId === "budget.file-lines").map((f) => f.location?.path))].sort();
    const expected = ["build/generated.cs", "coverage/raw.txt", "dist/bundle.js", "runtime.log", "state.db"];
    const full = one(p.ci());
    assert.deepEqual(paths(full), expected);

    // A base equal to the head (an empty change set) and spoofed CI variables do not shrink or move the analysis.
    const spoofed = p.cli(
      {
        JGATES_POLICY_SHA256: p.sha(),
        CI_MERGE_REQUEST_DIFF_BASE_SHA: head,
        CI_COMMIT_SHA: "0".repeat(40),
        CI_PROJECT_DIR: os.tmpdir(),
        GITHUB_BASE_REF: "main",
        GITHUB_SHA: "0".repeat(40),
      },
      "ci", "--cwd", p.dir, "--policy", p.policyDir, "--json", "--scope", "changed", "--base", head,
    );
    const doc = one(spoofed);
    assert.equal(doc.analyzed.snapshot.commit, head);
    assert.deepEqual(paths(doc), expected);
    assert.equal(spoofed.code, 1, spoofed.out + spoofed.err);

    // A base that names no commit: refused before anything runs.
    const before = p.runs().length;
    const unknown = p.ci("--scope", "changed", "--base", "no-such-ref");
    assert.equal(unknown.code, 3, unknown.out + unknown.err);
    assert.equal(one(unknown).code, "REF_UNKNOWN");
    assert.equal(p.runs().length, before);

    // Project code does not run unless the policy turns on a self-reported check: nothing in this plan executes it.
    const plan = JSON.parse(readRun(full, "plan.json"));
    assert.ok(plan.groups.willRun.every((i) => !i.effects.executesProjectCode), JSON.stringify(plan.groups.willRun.map((i) => i.id)));
    const stdin = plan.invocations.find((i) => i.adapter === "quality-bridge").command.stdin;
    assert.notEqual(stdin.projectTests, true);
  } finally {
    p.cleanup();
  }
});

test("ci hardening: a policy reached through a symbolic link into the checkout is refused like any policy inside it", { skip: process.platform === "win32" ? "symbolic links need privileges on Windows" : false }, () => {
  const p = setup({ "README.md": "# project\n" }, smallPolicy());
  const linkDir = tmp("jgates-hard-link-");
  try {
    const inside = path.join(p.dir, "ci-policy");
    write(inside, smallPolicy());
    p.commit({}, "policy inside");
    const link = path.join(linkDir, "policy");
    fs.symlinkSync(inside, link);
    const r = p.cli({ JGATES_POLICY_SHA256: readPolicyBundle(inside).bundle.sha256 }, "ci", "--cwd", p.dir, "--policy", link, "--json");
    assert.equal(r.code, 3, r.out + r.err);
    assert.equal(one(r).code, "POLICY_INSIDE_PROJECT");
  } finally {
    p.cleanup();
    fs.rmSync(linkDir, { recursive: true, force: true });
  }
});
