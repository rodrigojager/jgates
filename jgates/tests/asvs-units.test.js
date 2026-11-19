import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
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
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020").default;

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
  for (const [rel, value] of Object.entries(edit.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeJson(path.join(dir, rel), value);
  }
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

// ---- the AI review of the source against the requirement itself (asvs-review) ------------------------------------

const REVIEW_LEDGER = path.join("evidence", "asvs-review", "requirements-ledger.json");
const workspace = path.join(tmpRoot, "workspace");
fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
fs.writeFileSync(path.join(workspace, "src", "auth.js"), "line 1\nline 2\nline 3\nline 4\n");
fs.writeFileSync(path.join(workspace, "src", "session.js"), "line 1\nline 2\n");
fs.writeFileSync(path.join(tmpRoot, "outside.js"), "outside the workspace\n");

const reviewLedger = (requirements, over = {}) => ({ schemaVersion: 1, kind: "asvs-review-ledger", method: "asvs-review", asvsVersion: "5.0.0", level: 1, requirements, ...over });
const ANSWERS = [
  { id: "V6.2.1", unit: "V6", answer: "examined", references: [{ path: "src/auth.js", startLine: 1, endLine: 4 }], outcome: "no-violation-found" },
  { id: "V6.2.2", unit: "V6", answer: "examined", references: [{ path: "src/auth.js", startLine: 2, endLine: 3 }, { path: "src/session.js", startLine: 1, endLine: 2 }], outcome: "finding", findings: ["fp-1"] },
  { id: "V6.2.3", unit: "V6", answer: "examined", references: [{ path: "src/missing.js", startLine: 1, endLine: 2 }], outcome: "no-violation-found" },
  { id: "V6.2.4", unit: "V6", answer: "examined", references: [{ path: "../outside.js", startLine: 1, endLine: 1 }], outcome: "no-violation-found" },
  { id: "V6.2.5", unit: "V6", answer: "examined", references: [{ path: "src/auth.js", startLine: 3, endLine: 2 }], outcome: "no-violation-found" },
  { id: "V6.2.6", unit: "V6", answer: "not-examinable", reason: "running-system", detail: "the lockout is enforced by the identity provider" },
];
const reviewRun = ({ ledger, noLedger, result } = {}) =>
  materialize("semantic-defaults", {
    result: (r) => {
      r.semanticRun.methods = ["asvs-review"];
      r.findings = [{ fingerprint: "fp-1", waived: false }];
      result?.(r);
    },
    files: noLedger ? {} : { [REVIEW_LEDGER]: ledger ?? reviewLedger(ANSWERS) },
  });
const reviewUnits = (edit = {}, input = { workspaceDir: workspace, asvsVersion: "5.0.0" }) => asvs.collectCheckUnits({ semantic: [asvs.readSemanticRunRecord(reviewRun(edit))], ...input });
const requirementUnit = (list, id) => {
  const found = list.units.filter((u) => u.unit === "semantic-requirement" && u.requirement === id);
  assert.equal(found.length, 1, `${id}: ${JSON.stringify(found)}`);
  return found[0];
};

test("asvs-review: a finished run with a valid ledger gives one semantic-requirement unit per answer; only an examined answer whose files exist in the workspace ran", () => {
  const list = reviewUnits();
  const run = { gate: "semantic", runId: "sem_20261114T120000Z_4e5f6a7b" };
  assert.equal(one(list, "semantic-method", "asvs-review").state, "completed");
  const units = ofKind(list, "semantic-requirement");
  assert.deepEqual(units.map((u) => u.requirement), ["V6.2.1", "V6.2.2", "V6.2.3", "V6.2.4", "V6.2.5", "V6.2.6"]);
  for (const u of units) {
    assert.equal(u.id, "asvs-review");
    assert.equal(u.basis, "ai-source-review");
    assert.equal(asvs.CHECK_UNIT_BASIS_LABELS[u.basis], AI);
    assert.deepEqual(u.run, run);
  }
  const clean = requirementUnit(list, "V6.2.1");
  assert.deepEqual([clean.state, clean.code, clean.references, clean.outcome], ["completed", null, 1, "no-violation-found"]);
  const finding = requirementUnit(list, "V6.2.2");
  assert.deepEqual([finding.state, finding.references, finding.outcome, finding.findings], ["completed", 2, "finding", ["fp-1"]]);
  // A reference to a missing file, a path that leaves the workspace, a range that ends before it starts: nothing.
  for (const [id, pattern] of [
    ["V6.2.3", /src\/missing\.js: no such file/],
    ["V6.2.4", /not a path inside the workspace/],
    ["V6.2.5", /ends before it starts/],
  ]) {
    const u = requirementUnit(list, id);
    assert.deepEqual([u.state, u.code], ["error", "REFERENCE_MISSING"], id);
    assert.match(u.reason, pattern, id);
  }
  const no = requirementUnit(list, "V6.2.6");
  assert.deepEqual([no.state, no.code], ["not-applicable", "NOT_EXAMINABLE"]);
  assert.match(no.reason, /it needs a running system: the lockout is enforced by the identity provider/);
});

test("asvs-review: a link that leads out of the workspace counts for nothing, and without a workspace no examined answer counts", (t) => {
  try {
    fs.symlinkSync(path.join(tmpRoot, "outside.js"), path.join(workspace, "src", "link.js"));
  } catch {
    t.diagnostic("symbolic links are not available here; the link case is skipped");
  }
  if (fs.existsSync(path.join(workspace, "src", "link.js"))) {
    const linked = reviewUnits({ ledger: reviewLedger([{ id: "V6.2.1", answer: "examined", references: [{ path: "src/link.js", startLine: 1, endLine: 1 }], outcome: "no-violation-found" }]) });
    assert.deepEqual([requirementUnit(linked, "V6.2.1").state, requirementUnit(linked, "V6.2.1").code], ["error", "REFERENCE_MISSING"]);
    assert.match(requirementUnit(linked, "V6.2.1").reason, /outside the workspace/);
    fs.rmSync(path.join(workspace, "src", "link.js"));
  }
  const unknown = reviewUnits({}, { asvsVersion: "5.0.0" });
  for (const u of ofKind(unknown, "semantic-requirement").filter((x) => x.requirement !== "V6.2.6")) assert.deepEqual([u.state, u.code], ["error", "REFERENCES_UNVERIFIED"], u.requirement);
});

test("asvs-review: a missing, invalid or other-version ledger, or a run that did not finish, gives no semantic-requirement unit and the method says why", () => {
  const cases = [
    ["missing ledger", { noLedger: true }, "error", "REVIEW_LEDGER_MISSING"],
    ["an id answered twice", { ledger: reviewLedger([ANSWERS[0], ANSWERS[0]]) }, "error", "REVIEW_LEDGER_INVALID"],
    ["examined without references", { ledger: reviewLedger([{ id: "V6.2.1", answer: "examined", outcome: "no-violation-found" }]) }, "error", "REVIEW_LEDGER_INVALID"],
    ["not-examinable without a reason", { ledger: reviewLedger([{ id: "V6.2.1", answer: "not-examinable" }]) }, "error", "REVIEW_LEDGER_INVALID"],
    ["a finding without its fingerprints", { ledger: reviewLedger([{ ...ANSWERS[0], outcome: "finding" }]) }, "error", "REVIEW_LEDGER_INVALID"],
    ["the requirement text copied in a field the schema does not have", { ledger: reviewLedger([{ ...ANSWERS[0], text: "x" }]) }, "error", "REVIEW_LEDGER_INVALID"],
    ["another ASVS version", { ledger: reviewLedger(ANSWERS, { asvsVersion: "4.0.3" }) }, "error", "REVIEW_LEDGER_OTHER_VERSION"],
    ["unfinished run", { result: (r) => (r.partial = true) }, "error", "RUN_UNFINISHED"],
    ["timed out", { result: (r) => Object.assign(r.semanticRun.outcome, { state: "timeout", reason: "the review timed out" }) }, "timed-out", "TIMEOUT"],
  ];
  for (const [label, edit, state, code] of cases) {
    const list = reviewUnits(edit);
    assert.equal(ofKind(list, "semantic-requirement").length, 0, label);
    const method = one(list, "semantic-method", "asvs-review");
    assert.deepEqual([method.state, method.code], [state, code], label);
    assert.ok(method.reason, label);
  }
});

test("asvs-review: the ledger schema and the validator agree, and a sound ledger validates", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true, strictTypes: false });
  const validate = ajv.compile(readJson(path.join(JGATES, "schemas", "coverage", "asvs-review-ledger.schema.json")));
  const sound = reviewLedger(ANSWERS);
  assert.ok(validate(sound), ajv.errorsText(validate.errors));
  assert.deepEqual(asvs.asvsReviewLedgerProblems(sound), []);
  for (const bad of [
    reviewLedger([{ id: "V6.2.1", answer: "examined", references: [], outcome: "no-violation-found" }]),
    reviewLedger([{ id: "V6.2.1", answer: "examined", references: [{ path: "/etc/passwd", startLine: 1, endLine: 1 }], outcome: "no-violation-found" }]),
    reviewLedger([{ id: "V6.2.1", answer: "examined", references: [{ path: "C:/x.js", startLine: 1, endLine: 1 }], outcome: "no-violation-found" }]),
    reviewLedger([{ id: "V6.2.6", answer: "not-examinable", reason: "running-system", outcome: "no-violation-found" }]),
    reviewLedger([{ id: "6.2.1", answer: "examined", references: [{ path: "a.js", startLine: 1, endLine: 1 }], outcome: "no-violation-found" }]),
    { ...sound, method: "general-review" },
  ]) {
    assert.equal(validate(bad), false, JSON.stringify(bad.requirements?.[0] ?? bad.method));
    assert.notDeepEqual(asvs.asvsReviewLedgerProblems(bad), []);
  }
  assert.equal(asvs.ASVS_REVIEW_LEDGER_FILE, "evidence/asvs-review/requirements-ledger.json");
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
