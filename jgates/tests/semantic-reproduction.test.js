// Confirm by reproduction (method confirm-by-reproduction): a reproducer per needs-validation finding of an earlier
// Semantic run, executed in a container, judged by a fresh context. Every model answer is scripted through the real
// executor (no tokens); the reproducers run in containers of the tools image, replayed by the fake engine
// (tests/v2/fixtures/reproduction/recorded/reproduction.json), so no test runs on the host.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const R = await import(pathToFileURL(path.resolve(here, "..", "..", "tests", "v2", "fixtures", "reproduction", "helpers.mjs")).href);
const modules = await R.load("core/semantic-modules/index.js");
const semantic = await R.load("core/semantic/index.js");
const regressions = await R.load("core/regressions/index.js");
const { reproduction } = modules;
const METHOD = "confirm-by-reproduction";
const { TESTS, LINES } = R;

/** Every path under a folder, relative and sorted (what the workspace copy holds). */
function listing(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      out.push(e.isDirectory() ? `${next}/` : next);
      if (e.isDirectory()) walk(path.join(dir, e.name), next);
    }
  };
  walk(root, "");
  return out.sort();
}

const bySeed = (investigation) => Object.fromEntries(investigation.candidates.map((c) => [c.details.seed.candidateId, c]));
const outcomes = (doc) => Object.fromEntries(doc.findings.map((f) => [f.finding.candidateId, [f.outcome, f.reason]]));

test("the method is registered and listed by jgates semantic, on request only: no purpose or template selects it", async () => {
  const registered = modules.registeredInvestigationModules();
  assert.ok(registered.some((m) => m.methodId === METHOD && m.module === METHOD));
  assert.deepEqual(modules.unavailableModules, []);
  const m = reproduction.confirmByReproductionModule();
  assert.equal(m.provenance.origin, "original JGates method");
  assert.equal(typeof m.applicability, "function");
  assert.equal(typeof m.prerequisites, "function");
  assert.deepEqual(m.stages.map((s) => [s.id, s.role, s.contexts]), [["reproducer", "explore", "per-candidate"], ["assessment", "validate", "per-candidate"]]);

  const entry = semantic.semanticMethodCatalog().find((c) => c.id === METHOD);
  assert.ok(entry, "listed in the catalog");
  assert.deepEqual([entry.available, entry.purposes, entry.checksApplicability, entry.title], [true, [], true, "Confirm by reproduction"]);
  assert.ok(Object.values(semantic.PURPOSE_METHODS).every((ids) => !ids.includes(METHOD)), "no purpose plans it");
  const templates = path.join(R.ROOT, "jgates", "src", "builtin", "templates");
  for (const f of fs.readdirSync(templates)) assert.doesNotMatch(fs.readFileSync(path.join(templates, f), "utf8"), /confirm-by-reproduction/, f);

  const { ws } = await R.reproductionWorkspace("repro-catalog");
  try {
    // The default plan never selects it; naming it selects it, and the preview shows it applies (no engine is asked).
    const plain = semantic.buildSemanticPlan({ workspacePath: ws.dir, home: ws.home, env: ws.env });
    assert.ok(!plain.methods.some((x) => x.id === METHOD));
    const named = semantic.buildSemanticPlan({ workspacePath: ws.dir, home: ws.home, env: ws.env, methods: [METHOD] });
    assert.deepEqual(named.methods.map((x) => [x.id, x.selectedBy, x.applicability.state]), [[METHOD, "explicit", "applicable"]]);
    // `jgates semantic methods` lists it among the methods, without a purpose that runs it by default.
    const listed = R.cliFor(ws)(["semantic", "methods", "--cwd", ws.dir, "--json"]);
    assert.equal(listed.code, 0, listed.err);
    const row = listed.doc.methods.find((x) => x.id === METHOD);
    assert.ok(row, listed.out);
    assert.deepEqual([row.available, row.purposes], [true, []]);
    const text = R.cliFor(ws)(["semantic", "methods", "--cwd", ws.dir]);
    assert.match(text.out, /confirm-by-reproduction {2}Confirm by reproduction {2}\[available\]\n/, "listed with no default purpose");
  } finally {
    ws.cleanup();
  }
});

test("a reproducer that fails for the defect reproduces its finding; one that passes and one that does not load leave theirs needs-validation with reproduction attempted; nothing runs on the host", async () => {
  const { ws, seed, copy } = await R.reproductionWorkspace("repro-main");
  try {
    const before = R.treeHash(ws.dir);
    const seedBefore = fs.readFileSync(seed.file);
    const model = R.reproductionAnalyst({ tests: { "src/pricing.py": TESTS.discountBound, "src/inventory.py": TESTS.reserveLimit, "src/auth.py": TESTS.tokenExpiry }, causes: { "src/pricing.py": "defect" } });
    const { value, attempts } = await R.withoutHostTests(R.ENGINE, () => R.runReproduction(ws, reproduction.confirmByReproductionModule(), { script: model.script }));
    assert.deepEqual(attempts, [], "no test process started on the host");
    const { result, outcome, investigation } = value;
    assert.equal(outcome.state, "completed", outcome.reason);
    assert.equal(investigation.module.id, METHOD);
    assert.equal(investigation.applicability.state, "applicable");
    assert.equal(investigation.applicability.seedRun.runId, seed.runId);
    assert.deepEqual(investigation.applicability.findings.map((f) => [f.candidateId, f.runner]), [["C1", "pytest"], ["C2", "pytest"], ["C3", "pytest"]], "only the needs-validation findings");

    // The candidates keep the earlier severity; only the executed, failing, attributed one is confirmed; none is rejected.
    const c = bySeed(investigation);
    assert.deepEqual(Object.keys(c).sort(), ["C1", "C2", "C3"]);
    assert.deepEqual([c.C1.status, c.C1.severity, c.C1.details.evidence_basis], ["confirmed", "blocking", "execution"]);
    assert.deepEqual([c.C2.status, c.C2.severity, c.C2.details.reproduction.reason], ["needs-validation", "important", "REPRODUCER_PASSED"]);
    assert.deepEqual([c.C3.status, c.C3.severity, c.C3.details.reproduction.reason], ["needs-validation", "important", "REPRODUCER_DID_NOT_LOAD"]);
    assert.ok(investigation.candidates.every((x) => x.status !== "rejected"));
    assert.equal(c.C1.validation.context, `assessment:${c.C1.id}`, "judged in its own fresh context");

    // One context per finding writes the reproducer; only the failing one is assessed (the others spend no assessment call).
    const labels = [...new Set(model.requests.map((r) => r.contextLabel))];
    assert.deepEqual(labels, [`reproducer:${c.C1.id}`, `reproducer:${c.C2.id}`, `reproducer:${c.C3.id}`, `assessment:${c.C1.id}`]);
    const assessBrief = model.requests.find((r) => r.contextLabel === `assessment:${c.C1.id}`).messages[0].text;
    assert.match(assessBrief, /Execution record of the host/);
    assert.match(assessBrief, /"outcome": "failed"/);
    assert.match(assessBrief, /case: discount-bound/, "the assessment sees the reproducer that ran");
    const reproBrief = model.requests.find((r) => r.contextLabel === `reproducer:${c.C1.id}`).messages[0].text;
    assert.match(reproBrief, /call apply_discount\(100, 120\)/, "the validation plan of the record is in the brief");
    assert.match(reproBrief, /Test runner of the finding's file: pytest/);

    const doc = R.readJson(path.join(result.runDir, reproduction.REPRODUCTION_FILE));
    assert.equal(doc.evidenceBasis, "execution");
    assert.equal(doc.seedRun.runId, seed.runId);
    assert.deepEqual(outcomes(doc), { C1: ["reproduced", null], C2: ["attempted", "REPRODUCER_PASSED"], C3: ["attempted", "REPRODUCER_DID_NOT_LOAD"] });
    const f1 = doc.findings.find((f) => f.finding.candidateId === "C1");
    assert.deepEqual([f1.confirmation, f1.evidenceBasis, f1.assessment.cause, f1.finding.severity], ["confirmed", "execution", "defect", "blocking"]);
    assert.deepEqual(doc.counts, { findings: 3, reproduced: 1, attempted: 2, skipped: 0, executed: 3 });

    // Every execution is recorded like execution.json of post-patch: the container's facts and the masked output.
    const ex = R.readJson(path.join(result.runDir, reproduction.EXECUTION_FILE));
    assert.equal(ex.kind, "semantic-reproduction-execution");
    assert.equal(ex.executions.length, 3);
    for (const e of ex.executions) {
      assert.equal(e.executed, true, e.reason);
      assert.equal(e.tree, "workspace-copy");
      assert.deepEqual(e.workspaceCopy, { synchronized: true, placed: true, removed: true });
      assert.deepEqual({ ...e.run.container, name: "-", user: "-" }, {
        mode: "container", image: R.TOOLS_IMAGE_ID, name: "-", network: "none", readOnlyTree: true, readOnlyRoot: true, user: "-",
        limits: { memoryMb: 1024, cpus: 1, pids: 256, tmpfsMb: 64, timeoutSeconds: 60 },
        dependencies: [{ volume: R.DEPS_VOLUME, target: "/workspace/.venv" }],
      });
      assert.doesNotMatch(e.run.output, /\/workspace\//, "container paths are masked");
      assert.match(e.reproducer.path, /^\.jgates\/regressions\/test_[a-z_]+\.py$/);
    }
    assert.deepEqual(ex.executions.map((e) => e.run.outcome), ["failed", "passed", "error"]);

    // The containers: one per reproducer, no network, the copy and the dependency volume read-only, never the project.
    const containers = R.testContainers(ws);
    assert.equal(containers.length, 3);
    for (const k of containers) {
      assert.equal(k.network, "none");
      assert.equal(k.readOnlyRoot, true);
      assert.deepEqual(k.capDrop, ["ALL"]);
      assert.ok(k.user && !/^(root|0)(:|$)/.test(k.user));
      assert.equal(k.labels["org.jgates.test-runner"], "pytest");
      assert.ok(k.mounts.every((m) => m.readonly === true), "every mount of a test container is read-only");
      assert.ok(k.mounts.every((m) => !String(m.src).startsWith(ws.dir)), "the project folder is never mounted");
    }
    for (const args of R.engineCalls(ws).filter((a) => a[0] === "run")) assert.ok(args.some((a, i) => args[i - 1] === "--network" && a === "none"), "no container has a network");

    // Nothing is left in the copy, the project and the earlier run are unchanged, and the pytest reproducer that
    // reproduced is a regression proposal (only that one).
    assert.deepEqual(listing(copy).filter((p) => /test_(discount_bound|reserve_limit|token_expiry)/.test(p)), []);
    assert.ok(listing(copy).includes("src/pricing.py"), "the copy was synchronized with the project");
    assert.equal(R.treeHash(ws.dir), before, "the project folder is byte for byte the same");
    assert.deepEqual(fs.readFileSync(seed.file), seedBefore, "the earlier run is never rewritten");
    const proposed = regressions.readRunProposals(result.runDir);
    assert.deepEqual(proposed.map((p) => [p.id, p.runner, p.file, p.origin.candidate]), [["P1", "pytest", "test_discount_bound.py", c.C1.id]]);
    assert.match(proposed[0].content, /case: discount-bound/);
    assert.deepEqual(doc.proposals, ["P1"]);
    assert.ok(!outcome.investigation.coverage.gaps.some((g) => g.code === "REGRESSION_PROPOSAL_NOT_SUPPORTED"));

    // How the outcomes read, in both languages.
    assert.equal(reproduction.reproductionText({ outcome: "reproduced", reason: null }, "en"), "Reproduced: confirmed by execution");
    assert.equal(reproduction.reproductionText({ outcome: "attempted", reason: "REPRODUCER_PASSED" }, "en"), "Reproduction attempted: the reproducer passed, so the defect was not shown");
    assert.equal(reproduction.reproductionText({ outcome: "attempted", reason: "REPRODUCER_PASSED" }, "pt-BR"), "Tentativa de reprodução: o reprodutor passou, então o defeito não apareceu");
  } finally {
    ws.cleanup();
  }
});

test("a failure attributed to the reproducer or to the environment, and a finding cut by the budget, each stay needs-validation with reproduction attempted and the reason", async () => {
  const { ws, seed } = await R.reproductionWorkspace("repro-budget");
  try {
    // standard rigor, 4 calls: 2 for the reproducers (one call each), 2 reserved for the assessments; the third finding is cut.
    const model = R.reproductionAnalyst({ tests: { "src/pricing.py": TESTS.discountRounding, "src/inventory.py": TESTS.reserveClock, "src/auth.py": TESTS.tokenExpiry }, causes: { "src/pricing.py": "reproducer", "src/inventory.py": "environment" }, readFirst: false });
    const { result, outcome, investigation } = await R.runReproduction(ws, reproduction.confirmByReproductionModule(), { script: model.script, budget: { maxCalls: 4 } });
    assert.equal(outcome.state, "budget-exhausted", outcome.reason);
    assert.equal(outcome.calls, 4);
    const c = bySeed(investigation);
    for (const id of ["C1", "C2", "C3"]) assert.notEqual(c[id].status, "rejected", id);
    assert.deepEqual([c.C1.status, c.C1.severity, c.C1.details.verdict.cause], ["needs-validation", "blocking", "reproducer"]);
    assert.deepEqual([c.C2.status, c.C2.severity, c.C2.details.verdict.cause], ["needs-validation", "important", "environment"]);
    assert.equal(c.C3.status, "unresolved", "never examined: the budget ended first");
    assert.equal(c.C3.severity, "important");
    const doc = R.readJson(path.join(result.runDir, reproduction.REPRODUCTION_FILE));
    assert.equal(doc.seedRun.runId, seed.runId);
    assert.deepEqual(outcomes(doc), { C1: ["attempted", "ATTRIBUTED_TO_REPRODUCER"], C2: ["attempted", "ATTRIBUTED_TO_ENVIRONMENT"], C3: ["attempted", "BUDGET"] });
    assert.ok(doc.findings.every((f) => f.confirmation === "needs-validation"));
    assert.equal(R.testContainers(ws).length, 2, "the cut finding never reached a container");
    // A run that ends incomplete is never favorable, and the conclusion keeps the earlier severities.
    assert.notEqual(result.decision, "passed");
    assert.deepEqual(outcome.conclusion.findings.map((f) => f.confirmation), ["needs-validation", "needs-validation", "needs-validation"]);
  } finally {
    ws.cleanup();
  }
});

test("not applicable, with the reason code and no model call: no engine, dependencies not prepared, no supported runner, no needs-validation finding", async () => {
  const { ws } = await R.reproductionWorkspace("repro-na");
  const expectNa = async (target, module, code, env = target.env) => {
    const model = R.forbidden();
    const before = R.testContainers(target).length;
    const { outcome, investigation, result } = await R.runReproduction(target, module, { script: model.script, env });
    assert.deepEqual(model.calls, [], code);
    assert.equal(outcome.calls, 0, code);
    assert.equal(outcome.state, "unavailable", code);
    assert.equal(outcome.code, "METHOD_NOT_APPLICABLE", code);
    assert.equal(investigation.applicability.code, code);
    assert.notEqual(result.decision, "passed");
    assert.equal(R.testContainers(target).length, before, `${code}: no test container`);
    assert.ok(!fs.existsSync(path.join(result.runDir, reproduction.REPRODUCTION_FILE)));
    return investigation;
  };
  try {
    // No container engine: the engine's own code.
    await expectNa(ws, reproduction.confirmByReproductionModule(), "ENGINE_NOT_INSTALLED", { ...ws.env, JGATES_CONTAINER_RUNTIME: path.join(ws.root, "missing-engine") });
    // The Python component's dependencies were never prepared.
    const { workspaceId } = await R.load("core/ids/index.js");
    const { depsStateFile } = await R.load("core/deps/index.js");
    fs.rmSync(depsStateFile(ws.home, workspaceId(ws.dir)));
    const deps = await expectNa(ws, reproduction.confirmByReproductionModule(), "DEPENDENCIES_NOT_PREPARED");
    assert.match(deps.applicability.reason, /jgates deps prepare/);
    // A run named that does not exist, and findings that are not needs-validation.
    await expectNa(ws, reproduction.confirmByReproductionModule({ from: "sem_20200101T000000Z_00000000" }), "REPRODUCTION_SEED_RUN_NOT_FOUND");
    await expectNa(ws, reproduction.confirmByReproductionModule({ findings: ["C4", "C5"] }), "REPRODUCTION_NO_NEEDS_VALIDATION");
  } finally {
    ws.cleanup();
  }

  // Findings whose files no supported runner runs (Go, TypeScript).
  const unsupported = await R.reproductionWorkspace("repro-na-runner", {
    files: { "cmd/server.go": "package main\n\nfunc main() {\n\tprintln(\"hi\")\n}\n", "web/app.ts": "export const total = (a: number) => a * 2;\n" },
    candidates: [
      { ...R.SEED_CANDIDATES[0], path: "cmd/server.go", line: 4 },
      { ...R.SEED_CANDIDATES[1], path: "web/app.ts", line: 1 },
    ],
  });
  try {
    const inv = await expectNa(unsupported.ws, reproduction.confirmByReproductionModule(), "TEST_RUNNER_NOT_SUPPORTED");
    assert.deepEqual(inv.applicability.missing, "supported test runner");
    assert.match(inv.applicability.reason, /go test is not supported/);
  } finally {
    unsupported.ws.cleanup();
  }

  // An earlier run with confirmed and rejected findings only, and a workspace without any earlier run.
  const decided = await R.reproductionWorkspace("repro-na-decided", { candidates: R.SEED_CANDIDATES.slice(3) });
  try {
    await expectNa(decided.ws, reproduction.confirmByReproductionModule(), "REPRODUCTION_NO_NEEDS_VALIDATION");
    const plan = semantic.buildSemanticPlan({ workspacePath: decided.ws.dir, home: decided.ws.home, env: decided.ws.env, methods: [METHOD] });
    assert.deepEqual([plan.methods[0].applicability.state, plan.methods[0].applicability.code], ["not-applicable", "REPRODUCTION_NO_NEEDS_VALIDATION"]);
  } finally {
    decided.ws.cleanup();
  }
  const empty = await R.reproductionWorkspace("repro-na-empty", { candidates: null });
  try {
    await expectNa(empty.ws, reproduction.confirmByReproductionModule(), "REPRODUCTION_NO_NEEDS_VALIDATION");
  } finally {
    empty.ws.cleanup();
  }
});

test("the reproducer check refuses a file that is not a test for a supported runner, that lives outside the reserved regressions folder, or that imports anything outside the readable project files", async () => {
  const files = ["src/pricing.py", "src/inventory.py", "src/app/__init__.py", "src/app/models.py", "src/x.js", "lib/util/index.js", "requirements.txt"];
  const project = { readable: (p) => files.includes(p), files };
  const ok = (runner, raw) => {
    const r = reproduction.checkReproducerTest(raw, runner, project);
    assert.equal(r.ok, true, JSON.stringify(r.problems));
    return r.reproducer;
  };
  const refused = (runner, raw, re) => {
    const r = reproduction.checkReproducerTest(raw, runner, project);
    assert.equal(r.ok, false, JSON.stringify(raw).slice(0, 120));
    assert.ok(r.problems.some((p) => re.test(p)), `${JSON.stringify(r.problems)} should match ${re}`);
  };
  const pyTest = (imports) => `${imports}\n\n\ndef test_it():\n    assert True\n`;
  const jsTest = (imports) => `import test from "node:test";\nimport assert from "node:assert/strict";\n${imports}\ntest("it", () => assert.ok(true));\n`;

  // Accepted: the reserved folder, the runner's naming, project modules, the runner and the standard library.
  const good = ok("pytest", { name: "test_discount.py", content: pyTest("import os\nimport pytest\nfrom unittest.mock import patch\nfrom src.pricing import apply_discount\nfrom inventory import reserve\nimport app.models") });
  assert.deepEqual([good.path, good.runner], [".jgates/regressions/test_discount.py", "pytest"]);
  ok("pytest", { path: ".jgates/regressions/test_discount.py", content: pyTest("from src.app import models") });
  ok("node:test", { name: "discount.test.mjs", content: jsTest('import fs from "node:fs";\nimport path from "path";\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nconst x = require("../../src/x.js");\nimport util from "../../lib/util";') });

  // Not a test for a supported runner.
  refused("pytest", { name: "check_discount.py", content: pyTest("import os") }, /is not a pytest test file/);
  refused("pytest", { name: "discount.test.mjs", content: jsTest("") }, /is not a pytest test file/);
  refused("pytest", { name: "test_discount.py", content: "from src.pricing import apply_discount\n\nprint(apply_discount(1, 2))\n" }, /declares no test_ function/);
  refused("node:test", { name: "discount.spec.ts", content: jsTest("") }, /is not a node:test test file/);
  refused("node:test", { name: "discount.test.mjs", content: 'import { test } from "vitest";\ntest("x", () => {});\n' }, /not a node:test module/);
  // Outside the reserved regressions folder.
  refused("pytest", { path: "tests/test_discount.py", content: pyTest("import os") }, /outside the reserved regressions folder/);
  refused("pytest", { path: ".jgates/regressions/sub/test_discount.py", content: pyTest("import os") }, /outside the reserved regressions folder/);
  refused("pytest", { name: "../test_discount.py", content: pyTest("import os") }, /reserved regressions folder/);
  // Imports outside the readable project files.
  refused("pytest", { name: "test_a.py", content: pyTest("import requests") }, /imports "requests", which is outside the readable project files/);
  refused("pytest", { name: "test_b.py", content: pyTest("from src.secrets import key") }, /imports "src\.secrets"/);
  refused("pytest", { name: "test_c.py", content: pyTest("from . import helpers") }, /relative import/);
  refused("pytest", { name: "test_d.py", content: pyTest("mod = __import__(name)") }, /cannot be checked/);
  refused("node:test", { name: "a.test.mjs", content: jsTest('import leftPad from "left-pad";') }, /imports "left-pad", which is outside the readable project files/);
  refused("node:test", { name: "b.test.mjs", content: jsTest('const env = require("../../.env");') }, /not a readable file of the project/);
  refused("node:test", { name: "c.test.mjs", content: jsTest('const up = require("../../../outside.js");') }, /not a readable file of the project/);
  refused("node:test", { name: "d.test.mjs", content: jsTest("const m = await import(process.env.TARGET);") }, /cannot be checked/);

  // In a run: a refused reproducer is never executed, and its finding is never rejected.
  const { ws } = await R.reproductionWorkspace("repro-refused");
  try {
    const model = R.reproductionAnalyst({ tests: { "src/pricing.py": TESTS.outside } });
    const { outcome, investigation } = await R.runReproduction(ws, reproduction.confirmByReproductionModule({ findings: ["C1"] }), { script: model.script });
    assert.equal(outcome.state, "invalid");
    const ctx = investigation.stages.find((s) => s.id === "reproducer").contexts[0];
    assert.equal(ctx.artifact.valid, false);
    assert.ok(ctx.artifact.problems.some((p) => /outside the reserved regressions folder/.test(p)));
    assert.equal(R.testContainers(ws).length, 0, "nothing was executed");
    const [only] = investigation.candidates;
    assert.equal(only.details.seed.candidateId, "C1");
    assert.notEqual(only.status, "rejected");
    assert.equal(only.severity, "blocking");
  } finally {
    ws.cleanup();
  }
});

test("a run that could execute nothing ends unavailable and claims nothing; its execution is still recorded", async () => {
  const { ws } = await R.reproductionWorkspace("repro-noexec");
  try {
    // The reproducer's path already exists in the workspace copy (an incorporated regression): it is never replaced or run.
    const model = R.reproductionAnalyst({ tests: { "src/inventory.py": TESTS.existing } });
    const { result, outcome, investigation } = await R.runReproduction(ws, reproduction.confirmByReproductionModule({ findings: ["C2"] }), { script: model.script });
    assert.equal(outcome.state, "unavailable");
    assert.match(outcome.reason, /claims nothing without execution/);
    assert.deepEqual(investigation.candidates.map((c) => [c.details.seed.candidateId, c.status, c.severity]), [["C2", "needs-validation", "important"]]);
    assert.ok(!investigation.candidates.some((c) => c.status === "confirmed"));
    const ex = R.readJson(path.join(result.runDir, reproduction.EXECUTION_FILE));
    assert.deepEqual(ex.executions.map((e) => [e.executed, e.code, e.workspaceCopy.placed]), [[false, "WORKSPACE_COPY_UNAVAILABLE", false]]);
    assert.equal(R.testContainers(ws).length, 0);
    assert.ok(!fs.existsSync(path.join(result.runDir, reproduction.REPRODUCTION_FILE)), "no outcome is written without execution");
    assert.ok(!model.requests.some((r) => r.contextLabel.startsWith("assessment:")), "nothing to assess");
  } finally {
    ws.cleanup();
  }
});
