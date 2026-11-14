// Complementary Semantic methods B (property reasoning, post-patch validation, supply-chain assessment), the explicit
// method selection of `jgates semantic` (CLI, API, plan applicability), the test-file runner and the regression
// proposals. Every model answer is scripted through the real executor and the mock provider; no test spends tokens.
// Tests the methods execute run in containers of the tools image: here the fake engine replays recorded container runs
// (tests/v2/fixtures/complementary-b/recorded/semantic-tests.json), so no test file runs on the host.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = (name) => pathToFileURL(path.resolve(here, "..", "..", "tests", "v2", "fixtures", name)).href;
const H = await import(FIX("complementary-b/helpers.mjs"));
const { IDOR } = await import(FIX("complementary-a/analyst.mjs"));
const modules = await H.load("core/semantic-modules/index.js");
const semantic = await H.load("core/semantic/index.js");
const regressions = await H.load("core/regressions/index.js");
const { BOUND_LINE, PAGINATE_BAD, PAGINATE_GOOD, PROPERTY_TEST, PROPERTY_TEST_NAME, readJson, treeHash } = H;

const NEW_METHODS = [
  ["property-reasoning", modules.propertyReasoning.propertyReasoningModule],
  ["post-patch-validation", modules.postPatch.postPatchModule],
  ["supply-chain-assessment", modules.supplyChain.supplyChainModule],
];

test("the three methods are registered with their documented provenance and applicability check, and every registered method is in the catalog", () => {
  const registered = modules.registeredInvestigationModules();
  for (const [method, create] of NEW_METHODS) {
    assert.ok(registered.some((m) => m.methodId === method && m.module === method), method);
    const m = create();
    assert.equal(m.provenance.origin, "original JGates method", method);
    assert.equal(typeof m.applicability, "function", method);
    assert.ok(m.stages.some((s) => s.role === "validate" && s.contexts === "per-candidate" && s.required), `${method} has an independent validation stage`);
  }
  assert.deepEqual(modules.unavailableModules, []);
  const catalog = semantic.semanticMethodCatalog();
  const ids = catalog.map((m) => m.id);
  for (const id of ["general-review", "security-audit", "differential-review", "variant-analysis", "insecure-defaults", "cross-component", "property-reasoning", "post-patch-validation", "supply-chain-assessment"]) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes("investigation"), "the executor's built-in module is not a method");
  assert.deepEqual(catalog.find((m) => m.id === "security-audit").purposes, ["security"]);
  assert.ok(catalog.every((m) => m.available));
});

test("a non-default method is planned and run through the CLI with the scripted mock provider: not applicable with its reason while its input is missing, then run once the input exists", () => {
  const ws = H.setupWorkspace("compb-cli", IDOR);
  const cli = H.cliFor(ws);
  try {
    const listed = cli(["semantic", "methods", "--cwd", ws.dir, "--json"]);
    assert.equal(listed.code, 0, listed.err);
    assert.ok(listed.doc.methods.some((m) => m.id === "variant-analysis" && m.available && m.checksApplicability));

    // No history yet: variant analysis has no confirmed root cause. The plan says so before anything starts.
    const plan = cli(["semantic", "plan", "--cwd", ws.dir, "--method", "variant-analysis", "--json"]);
    assert.equal(plan.code, 0, plan.err);
    assert.equal(plan.doc.plan.methodSelection, "explicit");
    assert.deepEqual(plan.doc.plan.methods.map((m) => [m.id, m.selectedBy]), [["variant-analysis", "explicit"]]);
    assert.equal(plan.doc.plan.methods[0].applicability.state, "not-applicable");
    assert.equal(plan.doc.plan.methods[0].applicability.code, "VARIANT_NO_CONFIRMED_ROOT_CAUSE");
    assert.equal(plan.doc.plan.ready, true, "not applicable is shown, never a blocker");
    const text = cli(["semantic", "plan", "--cwd", ws.dir, "--method", "variant-analysis"]);
    assert.match(text.out, /variant-analysis \(Variant analysis\): not applicable \(VARIANT_NO_CONFIRMED_ROOT_CAUSE: /);

    // Running it: nothing is sent (no script is needed: any call would fail), the outcome is unavailable with the reason.
    const na = cli(["semantic", "run", "--cwd", ws.dir, "--method", "variant-analysis", "--json"]);
    assert.notEqual(na.code, 0, "not applicable is never favorable");
    assert.ok(na.doc, na.out + na.err);
    assert.notEqual(na.doc.decision, "passed");
    const naOutcome = na.doc.semanticRun.outcome;
    assert.equal(naOutcome.state, "unavailable");
    assert.equal(naOutcome.code, "METHOD_NOT_APPLICABLE");
    assert.equal(naOutcome.calls, 0);
    assert.match(naOutcome.reason, /confirmed root cause/);
    assert.equal(naOutcome.investigation.applicability.code, "VARIANT_NO_CONFIRMED_ROOT_CAUSE");
    assert.deepEqual(readJson(path.join(na.doc.runDir, "plan.json")).methods.map((m) => m.id), ["variant-analysis"]);

    // The default purpose (the general review) confirms the IDOR in orders.
    const prior = cli(["semantic", "run", "--cwd", ws.dir, "--json"], { script: H.priorReviewScript() });
    assert.ok(prior.doc, prior.out + prior.err);
    assert.equal(prior.doc.semanticRun.outcome.investigation.module.id, "general-review");
    assert.equal(prior.doc.semanticRun.outcome.investigation.candidates[0].status, "confirmed");

    // Now variant analysis applies (the plan previews it) and runs from the CLI with its own scripted analyst.
    const applicable = cli(["semantic", "plan", "--cwd", ws.dir, "--method=variant-analysis", "--json"]);
    assert.equal(applicable.doc.plan.methods[0].applicability.state, "applicable");
    const run = cli(["semantic", "run", "--cwd", ws.dir, "--method", "variant-analysis", "--json"], { script: H.variantScript() });
    assert.ok(run.doc, run.out + run.err);
    const outcome = run.doc.semanticRun.outcome;
    assert.equal(outcome.state, "completed", outcome.reason);
    assert.equal(outcome.investigation.module.id, "variant-analysis");
    assert.equal(outcome.investigation.applicability.seeds[0].source.runId, prior.doc.runId);
    const byPath = Object.fromEntries(outcome.investigation.candidates.map((c) => [c.path, c.status]));
    assert.deepEqual(byPath, { "src/routes/invoices.js": "confirmed", "src/routes/documents.js": "rejected" });
    assert.ok(outcome.calls > 0);
    assert.equal(run.doc.decision, "failed", "a confirmed blocking variant fails the run");
    assert.deepEqual(readJson(path.join(run.doc.runDir, "plan.json")).methods.map((m) => m.id), ["variant-analysis"]);

    // Several methods: one Semantic run each, in order, each with its own plan; the worst exit code is returned.
    const many = cli(["semantic", "run", "--cwd", ws.dir, "--method", "post-patch-validation,supply-chain-assessment", "--json"]);
    assert.ok(many.doc, many.out + many.err);
    assert.deepEqual(many.doc.methods, ["post-patch-validation", "supply-chain-assessment"]);
    assert.equal(many.doc.runs.length, 2);
    assert.notEqual(many.doc.runs[0].runId, many.doc.runs[1].runId);
    assert.deepEqual(many.doc.runs.map((r) => r.semanticRun.outcome.investigation.applicability.code), ["POST_PATCH_NO_PATCH", "SUPPLY_CHAIN_NO_LOCKFILE"]);
    assert.ok(many.doc.runs.every((r) => r.semanticRun.outcome.calls === 0 && r.decision !== "passed"));
    assert.notEqual(many.code, 0);

    // Unknown or malformed methods are refused before anything starts.
    const unknown = cli(["semantic", "plan", "--cwd", ws.dir, "--method", "made-up-method", "--json"]);
    assert.equal(unknown.doc.plan.ready, false);
    assert.equal(unknown.doc.plan.blockers[0].code, "SEMANTIC_METHOD_UNKNOWN");
    const bad = cli(["semantic", "run", "--cwd", ws.dir, "--method", "Bad Method!", "--json"]);
    assert.equal(bad.code, 3);
    assert.equal(bad.doc.error.code, "BAD_METHOD");
  } finally {
    ws.cleanup();
  }
});

test("the API takes the same method selection: plan, scope preview with applicability, options catalog, and a run started with methods", async () => {
  const ws = H.setupWorkspace("compb-api", { "src/math.js": "exports.clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));\n" });
  const saved = process.env.JGATES_HOME;
  process.env.JGATES_HOME = ws.home;
  try {
    const { workspaceId } = await H.load("core/ids/index.js");
    const server = { home: ws.home, projectDir: ws.dir, policyMode: false, workspace: { id: workspaceId(ws.dir), path: ws.dir, name: "compb" }, version: "0.0.0-test", log: () => undefined };
    const all = (await Promise.all(["semantic-runs.js", "semantic-scope.js", "semantic-views.js"].map((f) => H.load(`server/routes/${f}`)))).flatMap((m) => m.routes);
    const call = (method, p, input = {}) => all.find((r) => r.method === method && r.path === p).handler({ params: {}, query: {}, ...input, server });
    const preview = (await call("POST", "/api/semantic/scope/preview", { body: { methods: ["property-reasoning", "insecure-defaults"], scope: { mode: "full" } } })).json;
    assert.equal(preview.methodSelection, "explicit");
    assert.deepEqual(preview.methods.map((m) => [m.id, m.applicability.state]), [["property-reasoning", "applicable"], ["insecure-defaults", "not-applicable"]]);
    assert.equal(preview.methods[1].applicability.code, "INSECURE_DEFAULTS_NO_CONFIGURATION");
    const plan = (await call("GET", "/api/semantic/plan", { query: { methods: "supply-chain-assessment" } })).json.plan;
    assert.deepEqual(plan.methods.map((m) => [m.id, m.applicability.code]), [["supply-chain-assessment", "SUPPLY_CHAIN_NO_LOCKFILE"]]);
    const options = (await call("GET", "/api/semantic/options", { query: {} })).json;
    assert.ok(options.catalog.some((m) => m.id === "post-patch-validation"));
    const routes = await H.load("server/routes/semantic-scope.js");
    assert.deepEqual(routes.choiceProperties.methods.items.pattern, semantic.METHOD_ID_PATTERN);

    // A run started through the API with methods runs that method (the child CLI gets --method).
    const started = await call("POST", "/api/semantic/runs", { body: { methods: ["post-patch-validation"], scope: { mode: "full" } } });
    assert.equal(started.status, 202);
    assert.deepEqual(started.json.methods.map((m) => m.id), ["post-patch-validation"]);
    const runId = started.json.run.runId;
    const deadline = Date.now() + 120_000;
    let view = null;
    while (Date.now() < deadline) {
      view = semantic.readSemanticRun(ws.home, server.workspace.id, runId);
      if (view?.lifecycle === "settled" && view.result) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(view?.lifecycle, "settled");
    assert.equal(view.result.semanticRun.outcome.code, "METHOD_NOT_APPLICABLE");
    assert.equal(view.result.semanticRun.outcome.investigation.module.id, "post-patch-validation");
    assert.deepEqual(view.result.semanticRun.methods ?? readJson(path.join(view.dir, "plan.json")).methods.map((m) => m.id), ["post-patch-validation"]);
  } finally {
    if (saved === undefined) delete process.env.JGATES_HOME;
    else process.env.JGATES_HOME = saved;
    ws.cleanup();
  }
});

test("property reasoning: a violated bound invariant is confirmed in a fresh context, its property test is recorded as a proposal, and the project is not touched", async () => {
  const ws = H.setupWorkspace("compb-property", { "src/paginate.js": PAGINATE_BAD });
  Object.assign(ws.env, H.containerEnv(ws));
  try {
    const before = treeHash(ws.dir);
    const model = H.propertyAnalyst(["src/paginate.js", "jgates.yml"]);
    const { result, outcome, investigation } = await H.runModule(ws, modules.propertyReasoning.propertyReasoningModule(), { script: model.script });
    assert.equal(outcome.state, "completed", outcome.reason);
    assert.equal(investigation.applicability.state, "applicable");
    assert.deepEqual(investigation.applicability.targets.map((t) => t.path), ["src/paginate.js"]);
    assert.match(model.requests[0].messages[0].text, /Target code found by the host/);
    const [c] = investigation.candidates;
    assert.equal(c.status, "confirmed");
    assert.equal(c.category, "property");
    assert.equal(c.line, BOUND_LINE);
    assert.equal(c.details.evidence_basis, "source-argument");
    assert.equal(c.validation.context, `falsify:${c.id}`);
    const doc = readJson(path.join(result.runDir, modules.propertyReasoning.INVARIANTS_FILE));
    assert.equal(doc.invariants[0].status, "violated");
    assert.equal(doc.invariants[0].test.proposal, "P1");
    assert.equal(doc.evidenceBasis, "source-argument");
    const proposals = regressions.readRunProposals(result.runDir);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].file, PROPERTY_TEST_NAME);
    assert.equal(proposals[0].content, PROPERTY_TEST);
    assert.deepEqual(proposals[0].origin, { runId: result.runId, method: "property-reasoning", stage: "invariants", candidate: c.id, candidateStatus: "confirmed", invariant: "I1" });
    assert.equal(proposals[0].execution, null, "the method never executed it");
    assert.equal(treeHash(ws.dir), before, "a proposal never enters the project by itself");

    // Validation runs it in a container on an isolated copy: it fails on the bad source (it shows the defect), writes nothing.
    const listed = regressions.findProposal(ws.home, path.basename(path.dirname(path.dirname(result.runDir))), `${result.runId}/P1`);
    const validation = await regressions.validateProposal(ws.dir, listed, { workDir: path.join(ws.root, "work"), env: ws.env, home: ws.home });
    assert.equal(validation.run.executed, true, validation.run.reason);
    assert.equal(validation.run.outcome, "failed");
    assert.equal(validation.detectsDefect, true);
    assert.equal(validation.runtime.mode, "container");
    assert.equal(validation.runtime.image, H.TOOLS_IMAGE_ID);
    assert.equal(validation.run.container.network, "none");
    assert.equal(validation.run.container.readOnlyTree, true);
    assert.deepEqual(H.replayedTests(ws).map((r) => r.recording), ["paginate-bound-too-large"]);
    const [container] = H.testContainers(ws);
    assert.ok(container.mounts.every((m) => !String(m.src).startsWith(ws.dir)), "the project folder is never mounted");
    assert.equal(treeHash(ws.dir), before);
  } finally {
    ws.cleanup();
  }
});

test("property reasoning and supply-chain assessment are not applicable without their inputs, and send nothing", async () => {
  const ws = H.setupWorkspace("compb-na", { "README.md": "# Notes\n", "docs/guide.md": "Text only.\n" });
  try {
    for (const [module, code] of [
      [modules.propertyReasoning.propertyReasoningModule(), "PROPERTY_NO_TARGETS"],
      [modules.supplyChain.supplyChainModule(), "SUPPLY_CHAIN_NO_LOCKFILE"],
      [modules.postPatch.postPatchModule(), "POST_PATCH_NO_PATCH"],
    ]) {
      const model = H.forbidden();
      const { outcome, investigation, result } = await H.runModule(ws, module, { script: model.script });
      assert.deepEqual(model.calls, [], module.id);
      assert.equal(outcome.code, "METHOD_NOT_APPLICABLE", module.id);
      assert.equal(investigation.applicability.code, code);
      assert.notEqual(result.decision, "passed");
    }
  } finally {
    ws.cleanup();
  }
  const clean = H.setupWorkspace("compb-sc-clean", { "package.json": H.PACKAGE_JSON, "package-lock.json": H.LOCK_CLEAN });
  try {
    const model = H.forbidden();
    const { investigation } = await H.runModule(clean, modules.supplyChain.supplyChainModule(), { script: model.script });
    assert.equal(investigation.applicability.code, "SUPPLY_CHAIN_NO_SIGNALS");
    assert.deepEqual(model.calls, []);
  } finally {
    clean.cleanup();
  }
});

test("supply-chain assessment interprets the install-script signal of the deterministic analysis and confirms the exposure in a fresh context", async () => {
  const ws = H.setupWorkspace("compb-supply", { "package.json": H.PACKAGE_JSON, "package-lock.json": H.LOCK_WITH_SCRIPT });
  try {
    const model = H.supplyAnalyst();
    const { result, outcome, investigation } = await H.runModule(ws, modules.supplyChain.supplyChainModule(), { script: model.script });
    assert.equal(outcome.state, "completed", outcome.reason);
    assert.match(model.requests[0].messages[0].text, /"signal": "install-script"/);
    assert.match(model.requests[0].messages[0].text, /native-thing/);
    const [c] = investigation.candidates;
    assert.equal(c.status, "confirmed");
    assert.equal(c.details.risk, "install-time-execution");
    assert.equal(c.details.verdict.exposure, "install-time");
    const doc = readJson(path.join(result.runDir, modules.supplyChain.ASSESSMENT_FILE));
    assert.equal(doc.evidenceBasis, "lockfile-metadata");
    assert.equal(doc.signals[0].signal, "install-script");
    assert.equal(doc.signals[0].assessment.assessment, "risk");
  } finally {
    ws.cleanup();
  }
});

/** A Git workspace whose base commit has the bad pagination and the format helper with its node:test file. */
function patchWorkspace(prefix) {
  const ws = H.setupWorkspace(prefix, { "src/paginate.js": PAGINATE_BAD, "src/format.js": H.FORMAT, "test/format.test.mjs": H.FORMAT_TEST });
  const base = ws.git("rev-parse", "HEAD");
  const scope = { mode: "incremental", base, context: { allow: ["test/format.test.mjs", "src/format.js"] } };
  // The tests run in containers of the tools image; the fake engine replays the recorded runs.
  Object.assign(ws.env, H.containerEnv(ws));
  return { ws, base, scope };
}

test("post-patch validation: the reproducer fails before and passes after the patch in isolated fixtures, the nearby test stays green, with execution evidence", async () => {
  const { ws, scope } = patchWorkspace("compb-patch-ok");
  try {
    fs.writeFileSync(path.join(ws.dir, "src/paginate.js"), PAGINATE_GOOD);
    ws.git("commit", "-q", "-am", "fix: one page holds size items");
    const before = treeHash(ws.dir);
    const model = H.postPatchAnalyst();
    const { result, outcome, investigation } = await H.runModule(ws, modules.postPatch.postPatchModule(), { script: model.script, scope });
    assert.equal(outcome.state, "completed", outcome.reason);
    assert.equal(investigation.candidates.length, 0, JSON.stringify(investigation.candidates));
    const v = readJson(path.join(result.runDir, modules.postPatch.VALIDATION_FILE));
    assert.equal(v.evidenceBasis, "execution");
    assert.equal(v.executed, true);
    assert.equal(v.reproduced, true);
    assert.equal(v.fixed, true);
    assert.deepEqual(v.regressions, []);
    assert.equal(v.before.outcome, "failed");
    assert.equal(v.before.executed, true);
    assert.equal(v.after.outcome, "passed");
    assert.deepEqual(v.neighbours.map((n) => [n.path, n.before.outcome, n.after.outcome, n.regression]), [["test/format.test.mjs", "passed", "passed", false]]);
    const ex = readJson(path.join(result.runDir, modules.postPatch.EXECUTION_FILE));
    assert.equal(ex.before.container.mode, "container");
    assert.equal(ex.before.container.network, "none");
    assert.equal(ex.before.container.image, H.TOOLS_IMAGE_ID);
    assert.equal(H.testContainers(ws).length, 4, "the reproducer and the nearby test at both ends");
    assert.match(ex.before.output, /not ok 1/);
    assert.doesNotMatch(ex.before.output, new RegExp(ws.root.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")), "fixture paths are not kept");
    // The reproducer the model wrote, observed failing before and passing after, is a proposal with that evidence.
    const [p] = regressions.readRunProposals(result.runDir);
    assert.equal(p.origin.method, "post-patch-validation");
    assert.deepEqual([p.execution.before.outcome, p.execution.after.outcome], ["failed", "passed"]);
    assert.equal(result.decision, "passed");
    assert.equal(treeHash(ws.dir), before, "the workspace is never the fixture");
    assert.ok(!fs.existsSync(path.join(result.runDir, "work", "post-patch", "before")), "fixtures are removed after their runs");
  } finally {
    ws.cleanup();
  }
});

test("post-patch validation: a patch that does not fix the defect and breaks a nearby test is reported from the runs, each failure judged in a fresh context", async () => {
  const { ws, scope } = patchWorkspace("compb-patch-bad");
  try {
    fs.writeFileSync(path.join(ws.dir, "src/paginate.js"), PAGINATE_BAD.replace("start + size + 1", "start + size + 2"));
    fs.writeFileSync(path.join(ws.dir, "src/format.js"), H.FORMAT_BROKEN);
    ws.git("commit", "-q", "-am", "refactor: pagination and labels");
    const model = H.postPatchAnalyst();
    const { result, investigation } = await H.runModule(ws, modules.postPatch.postPatchModule(), { script: model.script, scope });
    const kinds = Object.fromEntries(investigation.candidates.map((c) => [c.details.kind, c]));
    assert.deepEqual(Object.keys(kinds).sort(), ["not-fixed", "regression"]);
    assert.equal(kinds["not-fixed"].status, "confirmed");
    assert.equal(kinds.regression.path, "test/format.test.mjs");
    assert.equal(kinds.regression.validation.context, `assessment:${kinds.regression.id}`);
    const brief = model.requests.find((r) => r.contextLabel === `assessment:${kinds.regression.id}`).messages[0].text;
    assert.match(brief, /Execution records of the host/);
    const v = readJson(path.join(result.runDir, modules.postPatch.VALIDATION_FILE));
    assert.equal(v.reproduced, true);
    assert.equal(v.fixed, false);
    assert.deepEqual(v.regressions, ["test/format.test.mjs"]);
    assert.equal(v.proposal, null, "a reproducer that does not pass after the patch is not proposed");
    assert.equal(result.decision, "failed");
  } finally {
    ws.cleanup();
  }
});

test("post-patch validation never claims a reproduction without execution: a reproducer that cannot run, a missing container engine, and a run with nothing executed", async () => {
  const { ws, scope } = patchWorkspace("compb-patch-noexec");
  try {
    fs.writeFileSync(path.join(ws.dir, "src/paginate.js"), PAGINATE_GOOD);
    ws.git("commit", "-q", "-am", "fix");
    // A reproducer that does not load: executed, but no verdict; reproduction is not claimed and the run does not pass.
    const broken = H.postPatchAnalyst({ reproducer: 'import test from "node:test";\nthis is not javascript\n' });
    const first = await H.runModule(ws, modules.postPatch.postPatchModule(), { script: broken.script, scope });
    const v = readJson(path.join(first.result.runDir, modules.postPatch.VALIDATION_FILE));
    assert.equal(v.before.executed, true);
    assert.equal(v.before.outcome, "error");
    assert.equal(v.reproduced, false);
    assert.equal(v.fixed, false);
    assert.equal(first.investigation.candidates[0].details.kind, "not-reproduced");
    assert.notEqual(first.result.decision, "passed");

    // No container engine: the method does not apply, with the engine's own code; nothing is sent, nothing is claimed.
    const model = H.forbidden();
    const env = { ...ws.env, JGATES_CONTAINER_RUNTIME: path.join(ws.root, "missing-engine") };
    const { buildSemanticPlan, executeSemanticRun } = semantic;
    const plan = buildSemanticPlan({ workspacePath: ws.dir, home: ws.home, env, scope });
    const noEngine = await executeSemanticRun({ workspacePath: ws.dir, home: ws.home, env, version: "0.0.0-test", plan, cancelPollMs: 50, investigation: { module: modules.postPatch.postPatchModule(), deps: { script: model.script } } });
    assert.deepEqual(model.calls, []);
    assert.equal(noEngine.semanticRun.outcome.code, "METHOD_NOT_APPLICABLE");
    assert.equal(noEngine.semanticRun.outcome.investigation.applicability.code, "ENGINE_NOT_INSTALLED");
    assert.ok(!fs.existsSync(path.join(noEngine.runDir, modules.postPatch.VALIDATION_FILE)));

    // The report step refuses to write a validation when the reproducer never ran.
    const m = modules.postPatch.postPatchModule();
    assert.throws(
      () => m.finalize({ stages: [], accepted: { reproducer: { execution: { executed: false, reason: "the test could not start" } } }, candidates: [], runDir: ws.root, now: new Date(), inputs: undefined }),
      /claims nothing without execution/,
    );
  } finally {
    ws.cleanup();
  }
});

test("the test-file runner starts one container of the tools image per file under the step contract, mounts prepared dependencies read-only, and runs nothing without an engine or the image", async () => {
  const ws = H.setupWorkspace("compb-runner", { "src/format.js": H.FORMAT });
  Object.assign(ws.env, H.containerEnv(ws));
  const { workspaceId } = await H.load("core/ids/index.js");
  const wsId = workspaceId(ws.dir);
  const files = [
    { path: "src/format.js", content: H.FORMAT },
    { path: "test/format.test.mjs", content: H.FORMAT_TEST },
  ];
  try {
    const prepared = await regressions.testEnvironment({ env: ws.env, home: ws.home, workspace: wsId, run: "compb-runner" });
    assert.equal(prepared.ok, true, prepared.reason);
    const { environment } = prepared;
    assert.deepEqual(regressions.dependencyMountPoints(environment, regressions.TEST_RECIPES["node:test"]), [], "no dependencies prepared yet");
    const fx = regressions.writeFixture(path.join(ws.root, "fx"), files);
    const run = await regressions.runTestFile(environment, fx, "test/format.test.mjs");
    assert.equal(run.executed, true, run.reason);
    assert.equal(run.outcome, "passed", run.output);
    assert.equal(run.tests.total, 1);
    assert.deepEqual({ ...run.container, name: "-", user: "-" }, { mode: "container", image: H.TOOLS_IMAGE_ID, name: "-", network: "none", readOnlyTree: true, readOnlyRoot: true, user: "-", limits: { memoryMb: 1024, cpus: 1, pids: 256, tmpfsMb: 64, timeoutSeconds: 60 }, dependencies: [] });
    const [c] = H.testContainers(ws);
    assert.equal(c.name, run.container.name);
    assert.equal(c.network, "none");
    assert.equal(c.readOnlyRoot, true);
    assert.deepEqual(c.capDrop, ["ALL"]);
    assert.ok(c.user && !/^(root|0)(:|$)/.test(c.user), `never root: ${c.user}`);
    assert.equal(c.user, run.container.user);
    assert.deepEqual([c.memory, c.cpus, c.pids], ["1024m", "1", "256"]);
    assert.ok(c.args.includes("--rm"));
    assert.deepEqual(
      { managed: c.labels["org.jgates.managed"], kind: c.labels["org.jgates.kind"], workspace: c.labels["org.jgates.workspace"], run: c.labels["org.jgates.run"], runner: c.labels["org.jgates.test-runner"] },
      { managed: "true", kind: "step", workspace: wsId, run: "compb-runner", runner: "node:test" },
    );
    assert.deepEqual(c.mounts, [{ type: "bind", src: path.resolve(fx.dir), dst: "/workspace", readonly: true }], "only the fixture, read-only; never the project folder");
    assert.equal(c.image, H.TOOLS_IMAGE_ID);
    assert.deepEqual(c.command, ["node", "--test-reporter=tap", "test/format.test.mjs"]);

    // A test that needs a package while the workspace's dependencies are not prepared ends as error with that reason.
    const needs = 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport leftPad from "left-pad";\ntest("left-pad pads", () => assert.equal(leftPad("1", 3, "0"), "001"));\n';
    const rel = ".jgates/regressions/paginate-pages.test.mjs";
    const fx2 = regressions.writeFixture(path.join(ws.root, "fx2"), [...files, { path: rel, content: needs }]);
    const missing = await regressions.runTestFile(environment, fx2, rel);
    assert.equal(missing.executed, true);
    assert.equal(missing.outcome, "error");
    assert.equal(missing.dependenciesMissing, true);
    assert.match(missing.reason, /^DEPENDENCIES_NOT_PREPARED: the test needs the package left-pad/);
    assert.doesNotMatch(missing.output, /\/workspace\//, "container paths are masked");

    // Once prepared, the dependency volume is mounted read-only on an empty node_modules of the fixture.
    const volume = await H.prepareDependencies(ws);
    const withDeps = await regressions.testEnvironment({ env: ws.env, home: ws.home, workspace: wsId, run: "compb-runner" });
    const points = regressions.dependencyMountPoints(withDeps.environment, regressions.TEST_RECIPES["node:test"]);
    assert.deepEqual(points, ["node_modules"]);
    const fx3 = regressions.writeFixture(path.join(ws.root, "fx3"), [...files, { path: rel, content: needs }], { mountPoints: points });
    assert.deepEqual(fs.readdirSync(path.join(fx3.dir, "node_modules")), []);
    const resolved = await regressions.runTestFile(withDeps.environment, fx3, rel);
    assert.equal(resolved.outcome, "passed", resolved.output);
    assert.deepEqual(resolved.container.dependencies, [{ volume, target: "/workspace/node_modules" }]);
    assert.deepEqual(H.testContainers(ws).at(-1).mounts.at(-1), { type: "volume", src: volume, dst: "/workspace/node_modules", readonly: true });

    // A file no recipe runs, no engine, no image: nothing is started.
    const before = H.testContainers(ws).length;
    assert.equal((await regressions.runTestFile(environment, fx, "src/format.py")).outcome, "not-run");
    const noEngine = await regressions.testRuntime({ ...ws.env, JGATES_CONTAINER_RUNTIME: path.join(ws.root, "missing-engine") });
    assert.deepEqual([noEngine.ok, noEngine.code], [false, "ENGINE_NOT_INSTALLED"]);
    const noImage = await regressions.testRuntime({ ...ws.env, FAKE_DOCKER_LABELS: "none" });
    assert.deepEqual([noImage.ok, noImage.code], [false, "IMAGE_MISSING"]);
    assert.equal(H.testContainers(ws).length, before);
  } finally {
    ws.cleanup();
  }
});
