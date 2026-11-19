import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-99 (fake engine, scripted model): the Semantic method asvs-review (PLAN-product-changes.md section 7.2). Without a
// Quality run the method refuses with the reason, through the terminal, in English and in Portuguese. With one, its plan
// lists exactly the repository requirements of the project's level that no deterministic check examined and that are not
// recorded as not applicable. A finished run with a valid requirements ledger makes the requirements answered examined
// show as examined with the basis "AI review of the source", counted apart, and only where a reviewed entry names the
// unit; an answer whose file reference does not exist counts for nothing; not-examinable gives nothing;
// --deterministic-only leaves them out; its findings are needs-validation. No engine and no provider is called: every
// model answer is scripted (the mock provider), the Quality run is a stored record.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const fixture = await import(pathToFileURL(path.join(root, "tests", "v2", "fixtures", "asvs-review", "fixture.mjs")).href);
const { R, PLANNED, CHAPTERS, LEDGER_SCHEMA, setupAsvsReview, scriptedReviewer, runAsvsReview, mapOf, asvs } = fixture;
const Ajv2020 = createRequire(path.join(root, "jgates", "package.json"))("ajv/dist/2020").default;
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const row = (map, r) => map.requirements.find((x) => x.id === r.id);

/** `jgates semantic plan --method asvs-review --json` in the workspace, with the run's environment. */
function cliPlan(ws, locale) {
  const r = spawnSync(process.execPath, [MAIN, "semantic", "plan", "--method", "asvs-review", "--cwd", ws.dir, "--json"], { cwd: ws.dir, encoding: "utf8", env: { ...ws.env, JGATES_LOCALE: locale }, input: "", timeout: 120_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout).plan;
}

test("V2-99: without a Quality run asvs-review is refused with the reason, in both languages", { timeout: 300_000 }, () => {
  const ws = setupAsvsReview("v2-99-noq", { quality: false });
  try {
    for (const [locale, words] of [["en", /validate the project first/], ["pt-BR", /valide o projeto primeiro/]]) {
      const plan = cliPlan(ws, locale);
      assert.equal(plan.ready, false, locale);
      const blocker = plan.blockers.find((b) => b.code === "ASVS_REVIEW_NO_QUALITY_RUN");
      assert.ok(blocker, `${locale}: ${JSON.stringify(plan.blockers)}`);
      assert.match(blocker.message, words);
    }
    assert.equal(fs.existsSync(path.join(ws.home, "workspaces", ws.wsId, "semantic-runs")) && fs.readdirSync(path.join(ws.home, "workspaces", ws.wsId, "semantic-runs")).some((n) => n.startsWith("sem_")), false, "a refused plan starts no run");
  } finally {
    ws.cleanup();
  }
});

test("V2-99: the plan lists exactly the unexamined repository requirements of the level, minus not applicable, with their number", { timeout: 300_000 }, () => {
  const ws = setupAsvsReview("v2-99-plan");
  try {
    const plan = cliPlan(ws, "en");
    assert.equal(plan.methods[0].applicability.state, "applicable", JSON.stringify(plan.methods[0]));
    assert.deepEqual(plan.asvsReview.requirements, PLANNED);
    assert.equal(plan.asvsReview.count, PLANNED.length);
    assert.deepEqual(plan.asvsReview.units.map((u) => u.id), [CHAPTERS.A, CHAPTERS.B]);
    for (const r of [R.det, R.na, R.person, R.level2]) assert.equal(plan.asvsReview.requirements.includes(r.id), false, r.id);
    // Only the request selects it: a purpose never plans it.
    for (const purpose of ["general-review", "security"]) {
      const r = spawnSync(process.execPath, [MAIN, "semantic", "plan", "--purpose", purpose, "--cwd", ws.dir, "--json"], { cwd: ws.dir, encoding: "utf8", env: ws.env, input: "", timeout: 120_000 });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).plan.methods.some((m) => m.id === "asvs-review"), false, purpose);
    }
  } finally {
    ws.cleanup();
  }
});

test("V2-99: a finished run with a valid ledger shows examined answers as AI review of the source, apart, where a reviewed entry names the unit", { timeout: 300_000 }, async () => {
  const ws = setupAsvsReview("v2-99-run");
  try {
    const { result, outcome } = await runAsvsReview(ws, { script: scriptedReviewer() });
    assert.equal(outcome.state, "completed", outcome.reason);
    const ledger = readJson(path.join(result.runDir, "evidence", "asvs-review", "requirements-ledger.json"));
    const validate = new Ajv2020({ strict: true, allErrors: true, strictTypes: false }).compile(readJson(LEDGER_SCHEMA));
    assert.ok(validate(ledger), JSON.stringify(validate.errors));
    assert.equal(ledger.requirements.some((a) => a.id === R.ghost.id), false, "the answer with a missing file is not in the ledger");
    assert.equal(ledger.requirements.find((a) => a.id === R.ne.id).answer, "not-examinable");

    // Its findings are needs-validation.
    assert.deepEqual(outcome.conclusion.findings.map((f) => f.confirmation), ["needs-validation"]);

    const map = mapOf(ws);
    for (const r of [R.ai, R.find]) {
      assert.equal(row(map, r).state, "examined", r.id);
      assert.equal(row(map, r).basis, "ai-source-review", r.id);
    }
    assert.equal(map.totals.examinedAiOnly, 2);
    assert.equal(row(map, R.det).basis, "deterministic");
    assert.notEqual(row(map, R.ghost).state, "examined", "an answer whose file does not exist counts for nothing");
    assert.notEqual(row(map, R.ne).state, "examined", "not-examinable gives nothing");
    assert.notEqual(row(map, R.unnamed).state, "examined", "no reviewed entry names the unit");
    const det = mapOf(ws, { deterministicOnly: true });
    assert.equal(det.totals.examinedAiOnly, 0);
    for (const r of [R.ai, R.find]) assert.notEqual(row(det, r).state, "examined", `${r.id} under --deterministic-only`);

    // The terminal reads the same map: `jgates coverage asvs --json` and its --deterministic-only.
    const cli = (extra) => {
      const r = spawnSync(process.execPath, [MAIN, "coverage", "asvs", "--cwd", ws.dir, "--json", ...extra], { cwd: ws.dir, encoding: "utf8", env: ws.env, input: "", timeout: 120_000 });
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      return JSON.parse(r.stdout);
    };
    assert.equal(row(cli([]), R.ai).basis, "ai-source-review");
    assert.equal(cli(["--deterministic-only"]).totals.examinedAiOnly, 0);
    assert.deepEqual(asvs.asvsReviewLedgerProblems(ledger), []);
  } finally {
    ws.cleanup();
  }
});
