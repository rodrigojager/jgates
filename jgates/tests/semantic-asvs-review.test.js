import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// The ASVS review (core/semantic-modules/asvs-review, method `asvs-review`), run through the real planner and executor
// with a scripted model (no tokens, no provider): the plan refuses without a Quality run and otherwise lists exactly the
// unexamined repository requirements of the project's level; one fresh context reviews each chapter; the requirements
// ledger is valid against its schema and leaves out an answer whose file does not exist; findings stay needs-validation;
// the map counts an examined answer as "AI review of the source", apart, only where a reviewed entry names the unit.

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const fixture = await import(pathToFileURL(path.join(ROOT, "tests", "v2", "fixtures", "asvs-review", "fixture.mjs")).href);
const { load, readJson } = await import(pathToFileURL(path.join(ROOT, "tests", "v2", "fixtures", "semantic-executor", "helpers.mjs")).href);
const { R, PLANNED, CHAPTERS, LEDGER_SCHEMA, setupAsvsReview, scriptedReviewer, runAsvsReview, mapOf, asvs } = fixture;
const modules = await load("core/semantic-modules/index.js");
const { buildSemanticPlan, semanticMethodCatalog, PURPOSE_METHODS } = await load("core/semantic/index.js");
const { mascotForStage, projectSemanticMascots } = await load("core/semantic-mascots/index.js");
const { setLocale, getLocale } = await load("i18n/index.js");
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020").default;
const validateLedger = new Ajv2020({ strict: true, allErrors: true, strictTypes: false }).compile(readJson(LEDGER_SCHEMA));

const LEDGER = path.join("evidence", "asvs-review", "requirements-ledger.json");
const row = (map, r) => map.requirements.find((x) => x.id === r.id);
const reviewCheck = (map, r) => row(map, r).checks.find((c) => c.unit === "semantic-requirement");

test("registration: asvs-review is a module of the catalog that only an explicit request selects; its stages belong to the six mascots", () => {
  assert.equal(modules.unavailableModules.some((u) => u.method === "asvs-review"), false, JSON.stringify(modules.unavailableModules));
  assert.ok(modules.registeredInvestigationModules().some((m) => m.methodId === "asvs-review"));
  const entry = semanticMethodCatalog().find((m) => m.id === "asvs-review");
  assert.ok(entry, "the catalog lists asvs-review");
  assert.deepEqual(entry.purposes, [], "no purpose plans it");
  assert.equal(entry.checksApplicability, true);
  for (const ids of Object.values(PURPOSE_METHODS)) assert.equal(ids.includes("asvs-review"), false);
  const module = modules.asvsReview.asvsReviewModule();
  assert.deepEqual(module.stages.map((s) => [s.id, s.contexts]), [["requirement-review", "per-unit"], ["requirement-validation", "per-candidate"]]);
  assert.equal(mascotForStage({ id: "asvs-review/requirement-review", role: "explore" }), "trace");
  assert.equal(mascotForStage({ id: "asvs-review/requirement-validation", role: "validate" }), "verdict");
});

test("plan: without a Quality run asvs-review is refused with the reason, in English and in Portuguese", (t) => {
  const ws = setupAsvsReview("asvs-review-noq", { quality: false });
  const before = getLocale();
  t.after(() => {
    setLocale(before);
    ws.cleanup();
  });
  setLocale("en");
  const plan = buildSemanticPlan({ workspacePath: ws.dir, home: ws.home, env: ws.env, methods: ["asvs-review"] });
  assert.equal(plan.ready, false);
  const blocker = plan.blockers.find((b) => b.code === "ASVS_REVIEW_NO_QUALITY_RUN");
  assert.ok(blocker, JSON.stringify(plan.blockers));
  assert.match(blocker.message, /validate the project first/);
  assert.equal(plan.methods[0].applicability.state, "not-applicable");
  assert.equal(plan.asvsReview.count, 0);
  setLocale("pt-BR");
  const pt = buildSemanticPlan({ workspacePath: ws.dir, home: ws.home, env: ws.env, methods: ["asvs-review"] });
  assert.match(pt.blockers.find((b) => b.code === "ASVS_REVIEW_NO_QUALITY_RUN").message, /valide o projeto primeiro/);
  // No other method is touched: the general review still plans without a Quality run.
  setLocale("en");
  const general = buildSemanticPlan({ workspacePath: ws.dir, home: ws.home, env: ws.env, purpose: "general-review" });
  assert.deepEqual(general.methods.map((m) => m.id), ["general-review"]);
  assert.equal(general.blockers.some((b) => b.code.startsWith("ASVS_REVIEW")), false);
});

test("plan: with a Quality run it lists exactly the unexamined repository requirements of the level, minus not applicable, by chapter", (t) => {
  const ws = setupAsvsReview("asvs-review-plan");
  t.after(() => ws.cleanup());
  const plan = buildSemanticPlan({ workspacePath: ws.dir, home: ws.home, env: ws.env, methods: ["asvs-review"] });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal(plan.methods[0].applicability.state, "applicable");
  assert.equal(plan.methods[0].selectedBy, "explicit");
  const a = plan.asvsReview;
  assert.deepEqual(a.requirements, PLANNED);
  assert.equal(a.count, PLANNED.length);
  assert.equal(a.qualityRun, fixture.QUALITY_RUN);
  assert.equal(a.level, 1);
  assert.deepEqual(a.units, [
    { id: CHAPTERS.A, requirements: [R.ai.id, R.find.id] },
    { id: CHAPTERS.B, requirements: [R.ne.id, R.ghost.id, R.unnamed.id] },
  ]);
  for (const r of [R.det, R.na, R.person, R.level2]) assert.equal(a.requirements.includes(r.id), false, `${r.id} is not planned`);
  assert.ok(a.budget.maxCalls > 0);
});

test("run: one context per chapter, a schema-valid ledger, an answer with a missing file left out, findings needs-validation", async (t) => {
  const ws = setupAsvsReview("asvs-review-run");
  t.after(() => ws.cleanup());
  const requests = [];
  const { result, outcome } = await runAsvsReview(ws, { script: scriptedReviewer({ requests }) });
  assert.equal(outcome.state, "completed", outcome.reason);
  const investigation = outcome.investigation;

  // One fresh context per review unit; each brief carries the official texts of its unit's requirements, read at run time.
  const reviews = requests.filter((r) => r.label.startsWith("requirement-review:"));
  assert.deepEqual([...new Set(reviews.map((r) => r.label))], [`requirement-review:${CHAPTERS.A}`, `requirement-review:${CHAPTERS.B}`]);
  const briefA = reviews.find((r) => r.label.endsWith(`:${CHAPTERS.A}`)).brief;
  assert.ok(briefA.includes(R.ai.id) && briefA.includes(R.find.id) && !briefA.includes(R.ne.id));
  assert.ok(briefA.includes(JSON.stringify(R.ai.text).slice(1, 40)), "the official text is in the brief");
  const stage = investigation.stages.find((s) => s.id === "requirement-review");
  assert.deepEqual(stage.contexts.map((c) => c.unit), [CHAPTERS.A, CHAPTERS.B]);

  // The ledger: valid against its schema and the validator; ghost (a file that does not exist) is left out with a gap.
  const ledger = readJson(path.join(result.runDir, LEDGER));
  assert.ok(validateLedger(ledger), JSON.stringify(validateLedger.errors));
  assert.deepEqual(asvs.asvsReviewLedgerProblems(ledger), []);
  assert.deepEqual([ledger.kind, ledger.method, ledger.asvsVersion, ledger.level], ["asvs-review-ledger", "asvs-review", "5.0.0", 1]);
  const answer = (r) => ledger.requirements.find((a) => a.id === r.id);
  assert.deepEqual(ledger.requirements.map((a) => a.id), [R.ai.id, R.find.id, R.ne.id, R.unnamed.id]);
  assert.deepEqual(answer(R.ai), { id: R.ai.id, unit: CHAPTERS.A, answer: "examined", references: [{ path: "src/auth.js", startLine: 1, endLine: 4 }], outcome: "no-violation-found" });
  assert.equal(answer(R.ne).answer, "not-examinable");
  assert.equal(answer(R.ne).reason, "person");
  assert.equal(answer(R.ghost), undefined, "an answer whose file does not exist is not in the ledger");
  assert.ok(investigation.coverage.gaps.some((g) => g.code === "ASVS_ANSWER_INVALID" && g.reason.includes(R.ghost.id) && /src\/missing\.js/.test(g.reason)));
  assert.equal(investigation.report.invalid, 1);
  assert.equal(investigation.report.planned, PLANNED.length);

  // The finding: needs-validation (the scripted validation answered confirmed), linked from the ledger by its fingerprint.
  assert.equal(investigation.candidates.length, 1);
  assert.equal(investigation.candidates[0].status, "needs-validation");
  assert.deepEqual(outcome.conclusion.findings.map((f) => f.confirmation), ["needs-validation"]);
  assert.equal(answer(R.find).outcome, "finding");
  assert.equal(result.findings.length, 1);
  assert.deepEqual(answer(R.find).findings, [result.findings[0].fingerprint]);
  assert.ok(requests.some((r) => r.label === "requirement-validation:C1"), "a fresh context validated the candidate");

  // The stages show under the six mascots.
  const view = projectSemanticMascots({ stages: investigation.stages.map((s) => ({ id: s.id, state: s.state, role: s.role })), running: false });
  assert.deepEqual(view.mascots.find((m) => m.mascot === "trace").stages.map((s) => s.id), ["requirement-review"]);
  assert.deepEqual(view.mascots.find((m) => m.mascot === "verdict").stages.map((s) => s.id), ["requirement-validation"]);
});

test("map: an examined answer counts as AI review of the source, apart, only where a reviewed entry names the unit; deterministic-only leaves it out", async (t) => {
  const ws = setupAsvsReview("asvs-review-map");
  t.after(() => ws.cleanup());
  await runAsvsReview(ws, { script: scriptedReviewer() });
  const map = mapOf(ws);
  assert.equal(row(map, R.det).state, "examined");
  assert.equal(row(map, R.det).basis, "deterministic");
  for (const r of [R.ai, R.find]) {
    assert.equal(row(map, r).state, "examined", r.id);
    assert.equal(row(map, r).basis, "ai-source-review", r.id);
    assert.equal(reviewCheck(map, r).ran, true);
  }
  assert.equal(reviewCheck(map, R.find).openFindings, 1);
  assert.equal(map.totals.examinedAiOnly, 2, "counted apart");
  assert.equal(map.totals.examinedDeterministic, 1);
  // not-examinable and the invalid answer give nothing; an answer no reviewed entry names gives nothing.
  assert.notEqual(row(map, R.ne).state, "examined");
  assert.equal(reviewCheck(map, R.ne).code, "NOT_EXAMINABLE");
  assert.notEqual(row(map, R.ghost).state, "examined");
  assert.equal(reviewCheck(map, R.ghost).ran, false);
  assert.notEqual(row(map, R.unnamed).state, "examined");
  assert.equal(row(map, R.na).state, "not-applicable");

  const det = mapOf(ws, { deterministicOnly: true });
  for (const r of [R.ai, R.find]) assert.notEqual(row(det, r).state, "examined", `${r.id} under deterministic-only`);
  assert.equal(det.totals.examinedAiOnly, 0);
  assert.equal(row(det, R.det).state, "examined");

  // A referenced file that no longer exists in the workspace makes that answer count for nothing.
  fs.rmSync(path.join(ws.dir, "src", "auth.js"));
  const after = mapOf(ws);
  assert.notEqual(row(after, R.ai).state, "examined");
  assert.equal(reviewCheck(after, R.ai).code, "REFERENCE_MISSING");
});

test("run: a candidate the validation rejects leaves the requirement examined with no violation found and no finding", async (t) => {
  const ws = setupAsvsReview("asvs-review-reject");
  t.after(() => ws.cleanup());
  const { result, outcome } = await runAsvsReview(ws, { script: scriptedReviewer({ validation: "rejected" }) });
  assert.equal(outcome.state, "completed", outcome.reason);
  const ledger = readJson(path.join(result.runDir, LEDGER));
  assert.deepEqual(asvs.asvsReviewLedgerProblems(ledger), []);
  const find = ledger.requirements.find((a) => a.id === R.find.id);
  assert.equal(find.outcome, "no-violation-found");
  assert.equal(find.findings, undefined);
  assert.equal(result.findings.length, 0);
});
