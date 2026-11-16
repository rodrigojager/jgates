import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-102: recorded Semgrep output through the run service, with no engine. The pack supplies the rule classes and
// requirement ids; only the recorded locations/messages are synthetic. Every temporary tree belongs to this test.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "jgates", "dist");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);

test("V2-102: Review is non-blocking on every result surface and per-occurrence marks preserve plain approval", async (t) => {
  const { executeRun } = await load("core", "run", "index.js");
  const semgrep = await load("adapters", "semgrep", "index.js");
  const results = await load("core", "results", "index.js");
  const { translator } = await load("i18n", "index.js");
  const index = semgrep.packRuleIndex(semgrep.bundledPackRulesDir("jgates"));
  const blocking = index.rules.find((r) => r.id === "jgates.python.weak-hash");
  const informational = index.rules.find((r) => r.id === "jgates.python.weak-cipher");
  const review = index.rules.filter((r) => r.class === "review" && r.asvsRequirements.length > 0).slice(0, 2);
  assert.ok(blocking && informational && review.length === 2, "the bundled pack has all three kinds");
  const rules = [blocking, informational, ...review];
  const packRules = new Map(index.rules.filter((r) => r.signal === null).map((r) => [r.id, r.asvsRequirements]));
  const packReviewRules = new Set(index.rules.filter((r) => r.class === "review").map((r) => r.id));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v2-102-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const ws = path.join(dir, "project");
  const home = path.join(dir, "home");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "app.py"), "hash()\npolicy()\nfirst_protection()\nsecond_protection()\n");
  const env = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1" };
  const cli = (locale, ...args) => spawnSync(process.execPath, [path.join(dist, "cli", "main.js"), ...args, "--cwd", ws], {
    encoding: "utf8", timeout: 120_000, env: { ...env, JGATES_LOCALE: locale },
  });
  const run = (withBlocking, options = {}) => executeRun({
    workspacePath: ws, home, version: "test", adapter: "semgrep", options: {}, env,
    selection: { scope: "workspace" }, ...options,
    execute: async (context) => {
      const recorded = JSON.stringify({
        results: rules.flatMap((rule, i) => !withBlocking && i === 0 ? [] : [{
          check_id: `tmp.run.rules.${rule.id}`, path: "app.py", start: { line: i + 1, col: 1 }, end: { line: i + 1, col: 9 },
          extra: { message: "Review the protection present at this location", severity: i === 0 ? "ERROR" : "INFO" },
        }]), errors: [], paths: { scanned: ["app.py"] },
      });
      const parsed = semgrep.parseSemgrepOutput(recorded, {
        stageId: "semgrep", version: "recorded", workspace: context.workspacePath, cwd: context.workspacePath, packRules, packReviewRules,
      });
      assert.equal(parsed.ok, true, parsed.problem);
      return {
        stages: [{ id: "semgrep", kind: "step", adapter: "semgrep", state: "completed", blockingViolations: parsed.findings.filter((f) => f.blocking).length, findings: parsed.findings.length }],
        requirements: [{ id: "semgrep", required: true }], disabled: [], findings: parsed.findings, logs: [], outputs: [],
      };
    },
  });

  const failed = await run(true);
  assert.deepEqual([failed.decision, failed.exitCode, failed.blockingViolations], ["failed", 1, 1]);
  assert.equal(results.reviewCount(failed), 2);
  for (const f of failed.findings) {
    const rule = rules.find((r) => f.ruleId.endsWith(r.id));
    assert.deepEqual(f.asvsRequirements, rule.asvsRequirements);
  }
  const approved = await run(false);
  assert.deepEqual([approved.decision, approved.exitCode, approved.blockingViolations], ["passed", 0, 0]);
  assert.deepEqual([results.informationalCount(approved), results.reviewCount(approved)], [1, 2]);
  for (const [locale, summary, infoHeading, reviewHeading] of [
    ["en", "approved and 1 informational and 2 to review", "Informational findings", "To review"],
    ["pt-BR", "aprovado e 1 informativo e 2 para revisar", "Achados informativos", "Para revisar"],
  ]) {
    const out = cli(locale, "report", approved.runId, "--format", "text");
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.includes(summary), out.stdout);
    assert.ok(out.stdout.indexOf(reviewHeading) > out.stdout.indexOf(infoHeading));
    for (const rule of [informational, ...review]) {
      assert.ok(out.stdout.split("\n").some((line) => line.includes(rule.id) && line.includes(`ASVS ${rule.asvsRequirements.join(", ")}`)));
    }
    assert.equal(results.resultSummary(approved, translator("run", locale)), summary);
  }
  const sarif = cli("en", "report", failed.runId, "--format", "sarif");
  assert.equal(sarif.status, 0, sarif.stderr);
  const sarifFindings = JSON.parse(sarif.stdout).runs[0].results;
  assert.equal(sarifFindings.filter((f) => f.properties.review && f.level === "note").length, 2);
  const cmp = results.compareWithBaseline(failed, approved);
  assert.deepEqual([cmp.new, cmp.kept, cmp.newInformational, cmp.keptInformational], [0, 0, 0, 1]);
  assert.deepEqual([cmp.newReview, cmp.keptReview, cmp.resolvedReview], [0, 2, 0]);
  assert.equal(results.compareWithBaseline(approved, { ...approved, findings: [] }).resolvedReview, 2);
  assert.equal(results.compareWithBaseline({ ...approved, findings: [] }, approved).newReview, 2);
  const set = cli("en", "baseline", "set", approved.runId, "--json");
  assert.equal(set.status, 0, set.stderr);

  const reviewed = approved.findings.find((f) => f.review);
  const add = (f) => cli("en", "waivers", "add", "--run", approved.runId, "--finding", f.fingerprint, "--reason", "The protection was checked", "--until", "2099-01-01", "--yes", "--json");
  const refused = add(approved.findings.find((f) => f.informational));
  assert.notEqual(refused.status, 0);
  assert.equal(fs.existsSync(path.join(ws, ".jgates", "waivers.json")), false);
  const added = add(reviewed);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  const marked = await run(false);
  assert.equal(results.reviewCount(marked), 1);
  assert.equal(marked.waivers.applied.length, 1);
  assert.equal(marked.waivers.applied[0].reviewed, 1);
  assert.deepEqual([marked.waivers.count, marked.waivers.findings], [0, 0]);
  assert.equal(results.approvalWording(marked).kind, "plain");
  for (const [locale, word] of [["en", "reviewed"], ["pt-BR", "revisado"]]) {
    const out = cli(locale, "report", marked.runId, "--format", "text");
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.includes(word), out.stdout);
    assert.doesNotMatch(out.stdout, /approved with|aprovado com/);
  }
  const noWaivers = await run(false, { noWaivers: true });
  assert.equal(results.reviewCount(noWaivers), 2);
  assert.equal(noWaivers.waivers.refused.length, 1);
  const governed = await run(false, { policy: {
    sha256: "a".repeat(64), files: [], source: { dir: path.join(dir, "policy"), from: "option" },
    qualityPolicy: { file: null, sha256: "b".repeat(64) },
  } });
  assert.equal(results.reviewCount(governed), 2, "governed mode ignores the project's mark");
  assert.equal(governed.waivers.applied.length, 0);
  const history = cli("en", "history", "--json");
  assert.equal(history.status, 0, history.stderr);
  assert.equal(JSON.parse(history.stdout).runs.find((r) => r.runId === marked.runId).findings.review, 1);

  const require = createRequire(path.join(root, "jgates", "package.json"));
  const Ajv = require("ajv/dist/2020").default;
  const schema = JSON.parse(fs.readFileSync(path.join(root, "jgates", "schemas", "result", "result.schema.json"), "utf8"));
  const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
  for (const doc of [failed, approved, marked, noWaivers, governed]) assert.equal(validate(doc), true, JSON.stringify(validate.errors));
});
