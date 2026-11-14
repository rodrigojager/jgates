import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// What ran, read from stored runs with no engine (core/coverage/asvs, collectCheckUnits): the check units of a Quality
// run (each stage, each plan item left off, each rule of the JGates Semgrep pack that really ran) and of Semantic runs
// (each attack-class block a security audit examined, each other method and category), as one list with the state of
// each unit and, when it did not run, why. The fixtures under fixtures/asvs/ are stored run folders; the records of
// the pack's rule files in a plan are filled in when a test copies the folder ("@current": the hash of the file in this
// JGates, "@stale": the hash of an older version), because those hashes change whenever a rule of the pack changes.

const here = path.dirname(fileURLToPath(import.meta.url));
const JGATES = path.resolve(here, "..");
const dist = path.join(JGATES, "dist");
const asvs = await import(pathToFileURL(path.join(dist, "core", "coverage", "asvs", "index.js")).href);
const semgrep = await import(pathToFileURL(path.join(dist, "adapters", "semgrep", "index.js")).href);

const FIXTURES = path.join(here, "fixtures", "asvs");
const RULES = path.join(JGATES, "packs", "semgrep", "jgates-semgrep", "rules");
const RECORDED_AT = "/opt/jgates/packs/semgrep/jgates-semgrep/rules/";
const LEDGER = path.join("evidence", "security-audit", "coverage-ledger.json");
const AI = "AI review of the source";

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

const packRules = semgrep.buildPackIndex(RULES).rules;
const packFiles = semgrep.listPackRuleFiles(RULES);
const currentHash = (rel) => `sha256:${sha256(fs.readFileSync(path.join(RULES, ...rel.split("/"))))}`;
const packRecords = (kind, drop = []) =>
  packFiles.filter((rel) => !drop.includes(rel)).map((rel) => ({ file: `${RECORDED_AT}${rel}`, sha256: kind === "@current" ? currentHash(rel) : `sha256:${sha256(Buffer.from(`an older version of ${rel}`))}` }));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-asvs-units-"));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let copies = 0;

/** Copies a stored-run fixture, fills in the pack records and applies the edits; returns the run folder. */
function materialize(name, edit = {}) {
  const dir = path.join(tmpRoot, `${copies++}-${name}`);
  fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  const planFile = path.join(dir, "plan.json");
  if (fs.existsSync(planFile)) {
    const plan = readJson(planFile);
    for (const item of [...plan.groups.willRun, ...plan.groups.notApplicableOrDisabled]) {
      item.configFiles = item.configFiles.flatMap((f) => (f.file === "@pack" ? packRecords(f.sha256, edit.dropPackFiles) : [f]));
    }
    edit.plan?.(plan);
    writeJson(planFile, plan);
  }
  if (edit.result) {
    const result = readJson(path.join(dir, "result.json"));
    edit.result(result);
    writeJson(path.join(dir, "result.json"), result);
  }
  if (edit.ledger) {
    const ledger = readJson(path.join(dir, LEDGER));
    edit.ledger(ledger);
    writeJson(path.join(dir, LEDGER), ledger);
  }
  if (edit.removeLedger) fs.rmSync(path.join(dir, LEDGER));
  return dir;
}

const qualityUnits = (name, edit) => asvs.collectCheckUnits({ quality: asvs.readQualityRunRecord(materialize(name, edit)) });
const semanticUnits = (name, edit) => asvs.collectCheckUnits({ semantic: [asvs.readSemanticRunRecord(materialize(name, edit))] });
const ofKind = (list, unit) => list.units.filter((u) => u.unit === unit);
const one = (list, unit, id, category) => {
  const found = list.units.filter((u) => u.unit === unit && u.id === id && u.category === category);
  assert.equal(found.length, 1, `${unit} ${id}${category ? ` ${category}` : ""}: ${JSON.stringify(found)}`);
  return found[0];
};
const ids = (units) => units.map((u) => u.id).sort();
const semgrepStage = (result) => result.stages.find((s) => s.id === "semgrep#sast");
const semgrepItem = (plan) => plan.groups.willRun.find((i) => i.id === "semgrep#sast");
const jsRules = packRules.filter((r) => r.language === "javascript");

test("a Quality run gives one unit per stage and per plan item left off, each with its state and reason, in one list with the Semantic runs", () => {
  const list = qualityUnits("quality-current");
  const run = { gate: "quality", runId: "run_20261114T100000Z_1a2b3c4d" };
  assert.deepEqual(list.runs, [run]);
  const expected = {
    "semgrep#sast": ["completed", null],
    "gitleaks#secrets": ["completed", null],
    "trivy#iac": ["error", "ERROR"],
    "zap#dast": ["timed-out", "TIMEOUT"],
    "schemathesis#api": ["blocked", "BLOCKED"],
    "jscpd#duplication": ["error", "NOT_INTERPRETED"],
    "checkov#iac": ["off", "DISABLED"],
    "osv-scanner#deps": ["not-selected", "NOT_SELECTED"],
    "zizmor#workflows": ["not-applicable", "NOT_AVAILABLE_HERE"],
  };
  const capabilities = ofKind(list, "capability");
  assert.deepEqual(ids(capabilities), Object.keys(expected).sort());
  for (const [id, [state, code]] of Object.entries(expected)) {
    const unit = one(list, "capability", id);
    assert.equal(unit.state, state, id);
    assert.equal(unit.code, code, id);
    assert.deepEqual(unit.run, run);
    assert.equal(unit.basis, "deterministic");
    if (state === "completed") assert.equal(unit.reason, null, id);
    else assert.ok(typeof unit.reason === "string" && unit.reason.length > 0, `${id} says why it did not run`);
  }
  assert.equal(one(list, "capability", "trivy#iac").reason, "trivy exited with code 2");
  assert.equal(one(list, "capability", "zap#dast").reason, "timed out after 600 s");
  assert.equal(one(list, "capability", "schemathesis#api").reason, "the target service did not start");
  assert.match(one(list, "capability", "checkov#iac").reason, /Switched off by capability:iac \(profile Balanced\)/);
  assert.equal(one(list, "capability", "gitleaks#secrets").reused, true, "a stage served from the cache ran on the same inputs and says so");
  assert.equal(one(list, "capability", "semgrep#sast").reused, undefined);
  assert.deepEqual(one(list, "capability", "semgrep#sast").languages, ["javascript", "typescript"]);

  // One list for a Quality run and the Semantic runs of the workspace.
  const all = asvs.collectCheckUnits({
    quality: asvs.readQualityRunRecord(materialize("quality-current")),
    semantic: [asvs.readSemanticRunRecord(materialize("semantic-audit")), asvs.readSemanticRunRecord(materialize("semantic-defaults"))],
  });
  assert.deepEqual(all.runs, [run, { gate: "semantic", runId: "sem_20261114T110000Z_0a1b2c3d" }, { gate: "semantic", runId: "sem_20261114T120000Z_4e5f6a7b" }]);
  assert.deepEqual([...new Set(all.units.map((u) => u.unit))].sort(), ["capability", "semantic-ledger", "semantic-method", "semgrep-rule"]);
  for (const u of all.units) assert.ok(asvs.CHECK_UNIT_STATES.includes(u.state), `${u.unit} ${u.id}: ${u.state}`);
});

test("a semgrep-rule unit exists only when the stage completed and was interpreted, the pack was selected, the recorded rule file has this JGates's hash and a file of the rule's language was scanned", () => {
  assert.ok(jsRules.length > 0 && packRules.some((r) => r.language === "python"), "the pack has JavaScript and Python rules");
  const list = qualityUnits("quality-current");
  const rules = ofKind(list, "semgrep-rule");
  assert.deepEqual(ids(rules), ids(jsRules), "exactly the rules of the scanned language (JavaScript: 3 files, TypeScript: 1, Python: 0)");
  for (const unit of rules) {
    const rule = jsRules.find((r) => r.id === unit.id);
    assert.equal(unit.state, "completed");
    assert.equal(unit.basis, "deterministic");
    assert.equal(unit.language, "javascript");
    assert.equal(unit.scannedFiles, 3);
    assert.equal(unit.stageId, "semgrep#sast");
    assert.equal(unit.ruleFile, rule.file);
    assert.deepEqual(unit.run, { gate: "quality", runId: "run_20261114T100000Z_1a2b3c4d" });
  }
  // A rule of a language the scan did not cover (Python: 0 files; Go, Java... absent) gives no unit, only the reason.
  for (const rule of packRules.filter((r) => r.language !== "javascript")) {
    assert.equal(list.units.some((u) => u.unit === "semgrep-rule" && u.id === rule.id), false, rule.id);
    const skipped = list.skippedRules.find((s) => s.id === rule.id);
    assert.equal(skipped?.code, "LANGUAGE_NOT_SCANNED", rule.id);
    assert.match(skipped.reason, new RegExp(`no ${rule.language} file`));
  }

  // The stage did not complete, or completed without an interpreted output: no rule unit.
  for (const [label, change] of [
    ["error", (s) => Object.assign(s, { state: "error", interpreted: false, reason: "semgrep exited with code 7" })],
    ["timeout", (s) => Object.assign(s, { state: "timeout", reason: "timed out" })],
    ["not interpreted", (s) => Object.assign(s, { interpreted: false, reason: "the output could not be read" })],
  ]) {
    const l = qualityUnits("quality-current", { result: (r) => change(semgrepStage(r)) });
    assert.equal(ofKind(l, "semgrep-rule").length, 0, label);
    assert.notEqual(one(l, "capability", "semgrep#sast").state, "completed", label);
    assert.ok(l.skippedRules.length === packRules.length && l.skippedRules.every((s) => s.code === "STAGE_NOT_COMPLETED"), label);
  }

  // The pack was not selected for the step: no rule unit.
  const unselected = qualityUnits("quality-current", { plan: (p) => (semgrepItem(p).configFiles = semgrepItem(p).configFiles.filter((f) => !f.file.includes("jgates-semgrep"))) });
  assert.equal(ofKind(unselected, "semgrep-rule").length, 0);
  assert.equal(one(unselected, "capability", "semgrep#sast").state, "completed", "the stage itself ran");
  assert.ok(unselected.skippedRules.every((s) => s.code === "PACK_NOT_SELECTED"));

  // One rule file recorded with another hash, or not recorded at all: its rules give no unit, the other files' rules do.
  const changedFile = jsRules[0].file;
  const ofFile = ids(jsRules.filter((r) => r.file === changedFile));
  const others = ids(jsRules.filter((r) => r.file !== changedFile));
  for (const [label, edit] of [
    ["another hash", { plan: (p) => (semgrepItem(p).configFiles.find((f) => f.file.endsWith(`/rules/${changedFile}`)).sha256 = `sha256:${sha256(Buffer.from("older"))}`) }],
    ["not recorded", { dropPackFiles: [changedFile] }],
  ]) {
    const l = qualityUnits("quality-current", edit);
    assert.deepEqual(ids(ofKind(l, "semgrep-rule")), others, label);
    for (const id of ofFile) assert.equal(l.skippedRules.find((s) => s.id === id)?.code, "PACK_OTHER_VERSION", `${label}: ${id}`);
  }

  // The same pack recorded under another installation path (Windows separators) is still this pack.
  const windows = qualityUnits("quality-current", {
    plan: (p) => {
      for (const f of semgrepItem(p).configFiles) if (f.file.startsWith(RECORDED_AT)) f.file = `C:\\Program Files\\jgates\\packs\\semgrep\\jgates-semgrep\\rules\\${f.file.slice(RECORDED_AT.length).split("/").join("\\")}`;
    },
  });
  assert.deepEqual(ids(ofKind(windows, "semgrep-rule")), ids(jsRules));

  // A rule counts for a Semgrep language of the rule too (a TypeScript-only scan still ran the JavaScript rules that apply to TypeScript).
  const tsOnly = qualityUnits("quality-current", { result: (r) => (semgrepStage(r).scannedLanguages = { typescript: 2 }) });
  assert.deepEqual(ids(ofKind(tsOnly, "semgrep-rule")), ids(jsRules.filter((r) => r.languages.includes("typescript"))));
});

test("a run made before the scanned-languages record existed gives no semgrep-rule unit, and a run that used another version of the pack gives none either", () => {
  const legacy = qualityUnits("quality-legacy");
  assert.equal(ofKind(legacy, "semgrep-rule").length, 0);
  assert.equal(one(legacy, "capability", "semgrep#sast").state, "completed", "the stage ran; only its rules cannot be credited");
  assert.equal(legacy.skippedRules.length, packRules.length);
  for (const s of legacy.skippedRules) {
    assert.equal(s.code, "NO_SCANNED_LANGUAGES", s.id);
    assert.match(s.reason, /validate again/);
  }

  const other = qualityUnits("quality-other-pack");
  assert.equal(ofKind(other, "semgrep-rule").length, 0);
  assert.equal(other.skippedRules.length, packRules.length);
  for (const s of other.skippedRules) {
    assert.equal(s.code, "PACK_OTHER_VERSION", s.id);
    assert.match(s.reason, /another version of the rule pack/);
  }
});

test("security-audit units come from its coverage ledger: only examined blocks count, each with the basis AI review of the source", () => {
  const list = semanticUnits("semantic-audit");
  const run = { gate: "semantic", runId: "sem_20261114T110000Z_0a1b2c3d" };
  const blocks = ofKind(list, "semantic-ledger");
  // Injection: one covered unit. Resource and file handling: one deferred unit and one covered unit. Access control
  // (planned), Business logic (unsupported) and Cryptography and secrets (not applicable) give nothing.
  assert.deepEqual(ids(blocks), ["ATTACK-CLASSES.md#Injection", "ATTACK-CLASSES.md#Resource and file handling"]);
  for (const unit of blocks) {
    assert.equal(unit.state, "completed");
    assert.equal(unit.basis, "ai-source-review");
    assert.equal(asvs.CHECK_UNIT_BASIS_LABELS[unit.basis], AI);
    assert.equal(unit.examinedUnits, 1);
    assert.deepEqual(unit.run, run);
  }
  for (const block of ["Access control", "Business logic", "Cryptography and secrets"]) {
    assert.equal(list.units.some((u) => u.id === `ATTACK-CLASSES.md#${block}`), false, block);
  }
  const method = one(list, "semantic-method", "security-audit");
  assert.equal(method.state, "completed");
  assert.equal(method.basis, "ai-source-review");

  // A block whose only examined unit becomes pending gives nothing.
  const pending = semanticUnits("semantic-audit", {
    ledger: (units) => {
      const u = units.find((x) => x.coverage_id.startsWith("src%2Fupload.js"));
      Object.assign(u, { status: "planned", state: "pending", agent_id: null, reviewed_paths: [], local_checks: [] });
    },
  });
  assert.deepEqual(ids(ofKind(pending, "semantic-ledger")), ["ATTACK-CLASSES.md#Injection"]);

  // An invalid ledger, a missing ledger, an unfinished or timed-out run: no ledger unit, and the method says why.
  for (const [label, edit, state, code] of [
    ["invalid ledger", { ledger: (units) => (units.find((x) => x.attack_class === "Injection").state = "pending") }, "error", "LEDGER_INVALID"],
    ["missing ledger", { removeLedger: true }, "error", "LEDGER_MISSING"],
    ["unfinished run", { result: (r) => (r.partial = true) }, "error", "RUN_UNFINISHED"],
    ["timed out", { result: (r) => Object.assign(r.semanticRun.outcome, { state: "timeout", reason: "the review timed out after 900 s" }) }, "timed-out", "TIMEOUT"],
  ]) {
    const l = semanticUnits("semantic-audit", edit);
    assert.equal(ofKind(l, "semantic-ledger").length, 0, label);
    const m = one(l, "semantic-method", "security-audit");
    assert.equal(m.state, state, label);
    assert.equal(m.code, code, label);
    assert.ok(m.reason, label);
  }
});

test("another Semantic method gives one unit for the run and one per category its record shows, examined or not", () => {
  const list = semanticUnits("semantic-defaults");
  const run = { gate: "semantic", runId: "sem_20261114T120000Z_4e5f6a7b" };
  const method = one(list, "semantic-method", "insecure-defaults");
  assert.equal(method.state, "completed");
  assert.equal(method.basis, "ai-source-review");
  assert.deepEqual(method.run, run);
  const expected = {
    "fallback-secrets": ["completed", null],
    "default-credentials": ["completed", null],
    "fail-open-security": ["error", "CATEGORY_PENDING"],
    "permissive-access": ["not-applicable", "NO_FILE_SCANNED"],
    "debug-features": ["error", "CATEGORY_NOT_REPORTED"],
  };
  for (const [category, [state, code]] of Object.entries(expected)) {
    const unit = one(list, "semantic-method", "insecure-defaults", category);
    assert.equal(unit.state, state, category);
    assert.equal(unit.code, code, category);
    assert.equal(asvs.CHECK_UNIT_BASIS_LABELS[unit.basis], AI);
  }
  assert.equal(one(list, "semantic-method", "insecure-defaults", "fail-open-security").reason, "the sweep ran out of budget before this category");
  assert.equal(ofKind(list, "semantic-ledger").length, 0);

  // A run that did not complete its review: the method and every category carry the run's state and reason.
  const blocked = semanticUnits("semantic-defaults", { result: (r) => Object.assign(r.semanticRun.outcome, { state: "not-configured", reason: "no model provider is set" }) });
  for (const u of ofKind(blocked, "semantic-method")) {
    assert.equal(u.state, "blocked", u.category ?? u.id);
    assert.equal(u.reason, "no model provider is set");
  }
});
