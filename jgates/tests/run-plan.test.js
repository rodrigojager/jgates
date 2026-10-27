import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// run executes exactly one plan: the one assembled now or the one received with --plan.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const require = createRequire(import.meta.url);
const mainFixture = require("../../tests/fixtures/jgates/main-fixture.js");
const bridge = await import(pathToFileURL(path.join(dist, "adapters", "quality-bridge", "index.js")).href);
const planApi = await import(pathToFileURL(path.join(dist, "core", "plan", "index.js")).href);
const { findOnPath } = await import(pathToFileURL(path.join(dist, "core", "bridge", "index.js")).href);
const { computeDecision } = await import(pathToFileURL(path.join(dist, "core", "contract", "index.js")).href);

const PYTHON = findOnPath("python") ?? findOnPath("python3");
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const NO_DOCKER = { DOCKER_CONTEXT: "", DOCKER_HOST: "tcp://127.0.0.1:1", GITHUB_BASE_REF: "", GITHUB_HEAD_REF: "", GITHUB_SHA: "", GITLAB_CI: "" };

function project(profile = "strict") {
  assert.ok(PYTHON, "python not found on PATH: put the repository .venv/bin first on PATH");
  const { dir } = mainFixture.createMainFixture();
  const home = tmp("jgates-rp-home-");
  const emptyBin = tmp("jgates-rp-bin-");
  // Plan files saved by a test (plan --out) go here, and cleanup removes it with the rest.
  const planDir = tmp("jgates-rp-plan-");
  const env = { ...process.env, ...NO_DOCKER, JGATES_HOME: home, JGATES_PYTHON: PYTHON, PATH: emptyBin };
  const cliWith = (extraEnv, ...args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: { ...env, ...extraEnv }, timeout: 600_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const cli = (...args) => cliWith({}, ...args);
  const init = cli("init", "--cwd", dir, "--profile", profile, "--no-interactive", "--json");
  assert.equal(init.code, 0, init.out + init.err);
  const runsDir = () => {
    const ws = path.join(home, "workspaces");
    if (!fs.existsSync(ws)) return [];
    return fs.readdirSync(ws).flatMap((id) => (fs.existsSync(path.join(ws, id, "runs")) ? fs.readdirSync(path.join(ws, id, "runs")) : []));
  };
  const cleanup = () => {
    mainFixture.removeFixture(dir);
    for (const d of [home, emptyBin, planDir]) fs.rmSync(d, { recursive: true, force: true });
  };
  return { dir, home, planDir, cli, cliWith, runsDir, cleanup };
}

const one = (r) => {
  try {
    return JSON.parse(r.out);
  } catch (error) {
    throw new Error(`stdout is not one JSON document (${error.message}):\n${r.out}\n${r.err}`);
  }
};
const willRunIds = (plan) => plan.groups.willRun.map((i) => i.id).sort();
const readRunPlan = (result) => JSON.parse(fs.readFileSync(path.join(result.runDir, "plan.json"), "utf8"));

test("profiles save --run stores the selection as a profile and run --profile reproduces the same items", () => {
  const p = project();
  try {
    const first = one(p.cli("run", "--cwd", p.dir, "--skip", "capability:unit", "--no-interactive", "--json"));
    assert.equal(first.reduced, true);
    const firstPlan = readRunPlan(first);

    const save = p.cli("profiles", "save", "--run", first.runId, "--as", "rapido", "--cwd", p.dir, "--no-interactive", "--json");
    assert.equal(save.code, 0, save.out + save.err);
    const saved = one(save);
    assert.equal(saved.id, "rapido");
    assert.deepEqual(saved.skip, ["capability:unit"]);
    const yml = fs.readFileSync(path.join(p.dir, ".jgates", "profiles.yml"), "utf8");
    assert.match(yml, /rapido:/);
    assert.match(yml, /capability:unit/);

    const second = one(p.cli("run", "--cwd", p.dir, "--profile", "rapido", "--no-interactive", "--json"));
    const secondPlan = readRunPlan(second);
    assert.deepEqual(willRunIds(secondPlan), willRunIds(firstPlan));
    assert.ok(!willRunIds(secondPlan).some((id) => /project-tests/.test(id)));

    // An existing id is not overwritten, and an unknown run is refused with exit 3.
    const again = p.cli("profiles", "save", "--run", first.runId, "--as", "rapido", "--cwd", p.dir, "--no-interactive", "--json");
    assert.equal(again.code, 3);
    assert.equal(one(again).code, "PROFILE_EXISTS");
    const missing = p.cli("profiles", "save", "--run", "run_nope", "--as", "x", "--cwd", p.dir, "--no-interactive", "--json");
    assert.equal(missing.code, 3);
    assert.equal(one(missing).code, "RUN_NOT_FOUND");
  } finally {
    p.cleanup();
  }
});

test("run --plan executes a valid plan file; an edited command is refused with 3 and nothing runs", () => {
  const p = project();
  try {
    const file = path.join(p.planDir, "plano.json");
    assert.equal(p.cli("plan", "--cwd", p.dir, "--out", file, "--no-interactive", "--json").code, 0);

    const ok = p.cli("run", "--cwd", p.dir, "--plan", file, "--no-interactive", "--json");
    const result = one(ok);
    assert.equal(result.selection.planSource, "file");
    assert.equal(result.selection.planHash, JSON.parse(fs.readFileSync(file, "utf8")).planHash);
    assert.equal(p.runsDir().length, 1);

    // The command is edited in the JSON: the hash no longer matches.
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.invocations[0].command.args = ["-c", "print('not the bridge')"];
    const tampered = path.join(path.dirname(file), "adulterado.json");
    fs.writeFileSync(tampered, JSON.stringify(doc));
    const bad = p.cli("run", "--cwd", p.dir, "--plan", tampered, "--no-interactive", "--json");
    assert.equal(bad.code, 3, bad.out + bad.err);
    const err = one(bad);
    assert.equal(err.code, "PLAN_TAMPERED");
    assert.equal(err.executed, false);

    // Edited with the hash recomputed: still not what the configuration gives.
    doc.planHash = planApi.computePlanHash(doc);
    fs.writeFileSync(tampered, JSON.stringify(doc));
    const rehashed = p.cli("run", "--cwd", p.dir, "--plan", tampered, "--no-interactive", "--json");
    assert.equal(rehashed.code, 3);
    assert.equal(one(rehashed).code, "PLAN_TAMPERED");
    assert.equal(p.runsDir().length, 1, "a refused plan starts no run");

    // Plan flags do not mix with --plan.
    const mixed = p.cli("run", "--cwd", p.dir, "--plan", file, "--skip", "capability:unit", "--json");
    assert.equal(mixed.code, 3);
    assert.equal(one(mixed).code, "PLAN_WITH_FLAGS");
  } finally {
    p.cleanup();
  }
});

test("run --plan accepts a plan made with --locale pt-BR when the run uses --locale en", () => {
  const p = project();
  try {
    const file = path.join(p.planDir, "plano-pt.json");
    assert.equal(p.cli("plan", "--cwd", p.dir, "--out", file, "--locale", "pt-BR", "--no-interactive", "--json").code, 0);
    const r = p.cli("run", "--cwd", p.dir, "--plan", file, "--locale", "en", "--no-interactive", "--json");
    assert.notEqual(r.code, 3, r.out + r.err);
    const result = one(r);
    assert.equal(result.selection.planSource, "file");
    assert.equal(result.selection.planHash, JSON.parse(fs.readFileSync(file, "utf8")).planHash);
    assert.equal(p.runsDir().length, 1);
  } finally {
    p.cleanup();
  }
});

test("run --plan accepts a plan made in English when the run is in Portuguese (JGATES_LOCALE)", () => {
  const p = project();
  try {
    const file = path.join(p.planDir, "plan-en.json");
    assert.equal(p.cliWith({ JGATES_LOCALE: "en" }, "plan", "--cwd", p.dir, "--out", file, "--no-interactive", "--json").code, 0);
    const r = p.cliWith({ JGATES_LOCALE: "pt-BR" }, "run", "--cwd", p.dir, "--plan", file, "--no-interactive", "--json");
    assert.notEqual(r.code, 3, r.out + r.err);
    const result = one(r);
    assert.equal(result.selection.planSource, "file");
    assert.equal(result.selection.planHash, JSON.parse(fs.readFileSync(file, "utf8")).planHash);
    assert.equal(p.runsDir().length, 1);
  } finally {
    p.cleanup();
  }
});

test("a plan edited after it was made in another locale is still refused as PLAN_TAMPERED", () => {
  const p = project();
  try {
    const file = path.join(p.planDir, "plano-pt.json");
    assert.equal(p.cli("plan", "--cwd", p.dir, "--out", file, "--locale", "pt-BR", "--no-interactive", "--json").code, 0);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.invocations[0].command.args = ["-c", "print('not the bridge')"];
    const tampered = path.join(p.planDir, "adulterado.json");
    fs.writeFileSync(tampered, JSON.stringify(doc));
    const bad = p.cli("run", "--cwd", p.dir, "--plan", tampered, "--locale", "en", "--no-interactive", "--json");
    assert.equal(bad.code, 3, bad.out + bad.err);
    assert.equal(one(bad).code, "PLAN_TAMPERED");

    // Edited with the hash recomputed: no locale rebuilds this content, so it is still refused.
    doc.planHash = planApi.computePlanHash(doc);
    fs.writeFileSync(tampered, JSON.stringify(doc));
    const rehashed = p.cli("run", "--cwd", p.dir, "--plan", tampered, "--locale", "en", "--no-interactive", "--json");
    assert.equal(rehashed.code, 3, rehashed.out + rehashed.err);
    assert.equal(one(rehashed).code, "PLAN_TAMPERED");
    assert.equal(p.runsDir().length, 0, "a refused plan starts no run");
  } finally {
    p.cleanup();
  }
});

test("run --plan after the configuration changed is refused and asks for a new plan", () => {
  const p = project();
  try {
    const file = path.join(p.planDir, "plano.json");
    assert.equal(p.cli("plan", "--cwd", p.dir, "--out", file, "--no-interactive", "--json").code, 0);
    const root = path.join(p.dir, "jgates.yml");
    fs.writeFileSync(root, `${fs.readFileSync(root, "utf8")}\n# edited after the plan\n`);
    const r = p.cli("run", "--cwd", p.dir, "--plan", file, "--no-interactive", "--json");
    assert.equal(r.code, 3, r.out + r.err);
    const err = one(r);
    assert.equal(err.code, "PLAN_STALE");
    assert.match(err.fix, /plan/i);
    assert.equal(p.runsDir().length, 0);
    assert.ok(err.problems.some((x) => /jgates\.yml/.test(x)));

    const unreadable = p.cli("run", "--cwd", p.dir, "--plan", path.join(p.dir, "nao-existe.json"), "--json");
    assert.equal(unreadable.code, 3);
    assert.equal(one(unreadable).code, "PLAN_UNREADABLE");
  } finally {
    p.cleanup();
  }
});

test("legacy bridge flags still drive a project without JGates configuration, and are refused next to a plan", () => {
  const p = project();
  try {
    const bare = mainFixture.createMainFixture().dir;
    try {
      const r = p.cli("run", "--cwd", bare, "--bridge-mode", "quick", "--json");
      const result = one(r);
      assert.equal(result.selection.options.bridgeMode, "quick");
      // The option flags become an equivalent plan, written to plan.json and executed.
      assert.equal(result.selection.planSource, "options");
      assert.match(result.selection.planHash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(result.artifacts.plan, "plan.json");
    } finally {
      mainFixture.removeFixture(bare);
    }
    const refused = p.cli("run", "--cwd", p.dir, "--bridge-mode", "quick", "--json");
    assert.equal(refused.code, 3);
    assert.equal(one(refused).code, "OPTION_NOT_SUPPORTED");
  } finally {
    p.cleanup();
  }
});

test("normalization from a plan: items the plan turned off are disabled with the plan's origin even when the sidecar ran them", () => {
  const p = project();
  try {
    const built = planApi.buildPlan(p.dir, { skip: ["capability:unit", "tool:quality-bridge.semgrep"], compare: false, env: { ...process.env, JGATES_PYTHON: PYTHON } });
    assert.ok(built.ok, JSON.stringify(built));
    const plan = built.plan;
    const ids = bridge.qualityBridgeManifest.subchecks.map((s) => s.id);
    const subs = bridge.subchecksFromPlan(plan, ids);
    const semgrep = subs.find((s) => s.subcheckId === "semgrep");
    const tests = subs.find((s) => s.subcheckId === "project-tests");
    assert.equal(semgrep.disabled.origin, "run");
    assert.equal(tests.disabled.origin, "run");
    assert.equal(subs.find((s) => s.subcheckId === "file-size").required, true);

    // The sidecar ran semgrep anyway and reported a blocking finding: it does not count, the stage stays disabled.
    const response = {
      schemaVersion: 1,
      ok: true,
      status: "REJECTED",
      exitCode: 1,
      outputDir: "/out",
      reportPath: "/out/quality-report.json",
      subchecks: ids.map((id) => ({ id, status: id === "semgrep" ? "findings" : "ok" })),
      report: {
        schemaVersion: "1.0.0",
        status: "REJECTED",
        exitCode: 1,
        mode: "full",
        tools: [],
        findings: [{ tool: "semgrep", rule: "r1", severity: "critical", category: "sast", message: "m", path: "a.py", line: 3, allowed: false }],
        score: { value: 100, threshold: 80 },
        summary: { reasons: [] },
      },
    };
    const out = bridge.normalizeBridge({ kind: "response", interpreter: "python", exitCode: 1, stdout: "", stderr: "", durationMs: 1, response }, subs);
    const stage = out.stages.find((s) => s.id === "quality-bridge.semgrep");
    assert.equal(stage.state, "disabled");
    assert.equal(out.findings.length, 0);
    assert.ok(out.disabled.some((d) => d.id === "quality-bridge.semgrep" && d.origin === "run"));
    const decision = computeDecision({ resolved: true, requirements: out.requirements, stages: out.stages, disabled: out.disabled });
    assert.equal(decision.reduced, true);
    assert.equal(decision.blockingViolations, 0);
  } finally {
    p.cleanup();
  }
});

test("an empty or not approvable plan never runs: run exits 3, creates no run and names the blocker (no approval of an empty plan)", () => {
  const p = project();
  try {
    // Every check off for this run: the plan is empty with selected requirements.
    const empty = p.cli("run", "--cwd", p.dir, "--skip", "tool:quality-bridge,tool:ruff,tool:builtin-pii","--no-interactive", "--json");
    assert.equal(empty.code, 3, empty.out + empty.err);
    const err = one(empty);
    assert.equal(err.error?.code ?? err.code, "PLAN_NOT_APPROVABLE");
    assert.equal(err.executed, false);
    assert.equal(err.blockers[0].code, "PLAN_EMPTY");
    assert.equal(p.runsDir().length, 0, "a refused plan starts no run");

    // The same plan saved with --out is refused by run --plan as well.
    const file = path.join(p.planDir, "vazio.json");
    const saved = p.cli("plan", "--cwd", p.dir, "--skip", "tool:quality-bridge,tool:ruff,tool:builtin-pii","--out", file, "--no-interactive", "--json");
    assert.equal(saved.code, 3);
    if (fs.existsSync(file)) {
      const viaFile = p.cli("run", "--cwd", p.dir, "--plan", file, "--no-interactive", "--json");
      assert.equal(viaFile.code, 3, viaFile.out + viaFile.err);
      assert.equal(p.runsDir().length, 0);
    }
  } finally {
    p.cleanup();
  }
});

test("a run from a plan with the required scanners absent is incomplete, never passed", () => {
  const p = project("standard");
  try {
    const r = p.cli("run", "--cwd", p.dir, "--no-interactive", "--json");
    const result = one(r);
    assert.equal(result.decision, "incomplete");
    assert.equal(r.code, 2);
    assert.equal(result.complete, false);
    assert.ok(result.unsatisfied.length > 0);
  } finally {
    p.cleanup();
  }
});

test("without a usable Python or sidecar the planned run is recorded as incomplete (exit 2) with the bridge stage blocked and the reason; it is never passed", () => {
  const p = project();
  const emptyBin = tmp("jgates-rp-bin2-");
  try {
    const cases = [
      ["python", { JGATES_PYTHON: path.join(p.home, "no-such-python") }, /Python/],
      ["sidecar", { JGATES_SIDECAR_DIR: path.join(p.home, "no-such-sidecar") }, /quality_sidecar/],
    ];
    for (const [name, extra, why] of cases) {
      const before = p.runsDir().length;
      const env = { ...process.env, ...NO_DOCKER, JGATES_HOME: p.home, JGATES_PYTHON: PYTHON, PATH: emptyBin, ...extra };
      // The plan says the bridge cannot run, as a warning: it does not refuse the run any more.
      const planned = spawnSync(process.execPath, [MAIN, "plan", "--cwd", p.dir, "--json"], { encoding: "utf8", env });
      if (name === "python") {
        const plan = one({ out: planned.stdout, err: planned.stderr }).plan;
        assert.ok(plan.warnings.some((w) => w.code === "TOOL_UNAVAILABLE"), name);
        assert.ok(!plan.blockers.some((b) => b.code === "TOOL_UNAVAILABLE"), name);
      }
      const r = spawnSync(process.execPath, [MAIN, "run", "--cwd", p.dir, "--no-interactive", "--json"], { encoding: "utf8", env });
      assert.equal(r.status, 2, `${name}: ${r.stdout}${r.stderr}`);
      const doc = JSON.parse(r.stdout);
      assert.equal(doc.decision, "incomplete", name);
      assert.notEqual(doc.decision, "passed", name);
      assert.equal(doc.complete, false, name);
      assert.equal(p.runsDir().length, before + 1, `${name}: the run is recorded`);
      assert.ok(fs.existsSync(path.join(doc.runDir, "result.json")), name);
      assert.ok(fs.existsSync(path.join(doc.runDir, "plan.json")), name);
      const composite = doc.stages.find((s) => s.id === "quality-bridge");
      assert.ok(composite, name);
      assert.equal(composite.state, "blocked", name);
      assert.match(composite.reason, why, name);
      assert.equal(composite.execution.notRun.cause, "preflight", name);
      for (const s of doc.stages.filter((x) => x.parentId === "quality-bridge")) assert.ok(["blocked", "disabled"].includes(s.state), `${name}: ${s.id} ${s.state}`);
      assert.ok(doc.unsatisfied.length > 0, name);
    }
  } finally {
    fs.rmSync(emptyBin, { recursive: true, force: true });
    p.cleanup();
  }
});
