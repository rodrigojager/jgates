import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-90 (fake engine): `jgates coverage asvs` (PLAN-asvs.md sections 2, 5 and 6). From a fixture mapping and stored runs
// written into the data folder of a throwaway workspace, every requirement reaches one of the five states for the stated
// reason:
//   - examined only when a mapped, reviewed check completed in the run read (deterministic, or only an AI review of the
//     source, counted apart); the same check switched off, in error or timed out leaves it unexamined with that reason;
//   - a requirement mapped only to a rule of a language the project lacks is unsupported; a run that used another
//     version of the rule pack, or that has no scanned-languages record, does not count;
//   - "not applicable" is one entry of .jgates/asvs.json (the diff is that entry), needs a reason, has a preview and an
//     undo, and is refused in governed mode;
//   - the level changes the rows (70, 253, 345); --deterministic-only leaves out what only a Semantic run examined;
//     --json validates against schemas/coverage/asvs.schema.json and carries the source block; the text prints the
//     attribution line; the exit code is 0;
//   - "compliant", "conformant", "certified" and a percentage appear nowhere, in either language; a Quality run and a
//     Semantic run of different revisions produce the warning.
// The command reads stored files only: the fake engine named in the environment records no call.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const JGATES = path.join(root, "jgates");
const DIST = path.join(JGATES, "dist");
const MAIN = path.join(DIST, "cli", "main.js");
const FAKE = path.join(JGATES, "tests", "docker", "fake-docker.cjs");
const RULES = path.join(JGATES, "packs", "semgrep", "jgates-semgrep", "rules");
const MAP_PACK = path.join(JGATES, "packs", "asvs", "jgates-asvs-map", "5.0.0");
const SCHEMA = path.join(JGATES, "schemas", "coverage", "asvs.schema.json");
const RECORDED_AT = "/opt/jgates/packs/semgrep/jgates-semgrep/rules/";
const FILE = ".jgates/asvs.json";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const { workspaceId } = await import(pathToFileURL(path.join(DIST, "core", "ids", "index.js")).href);
const asvs = await import(pathToFileURL(path.join(DIST, "core", "coverage", "asvs", "index.js")).href);
const semgrep = await import(pathToFileURL(path.join(DIST, "adapters", "semgrep", "index.js")).href);
const matrix = await import(pathToFileURL(path.join(DIST, "core", "matrix", "index.js")).href);

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const made = [];
const tmp = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validate = ajv.compile(readJson(SCHEMA));
const assertSchema = (doc, what) => assert.ok(validate(doc), `${what}: ${ajv.errorsText(validate.errors)}`);

// ---- the fixture: requirements, checks and the mapping ---------------------------------------------------------

const data = asvs.loadAsvs("5.0.0");
const level1 = asvs.asvsRequirements(data, { level: 1 });
const distinctSections = [];
for (const r of level1) if (!distinctSections.some((x) => x.section === r.section)) distinctSections.push(r);
// One requirement per section, so a section-wide decision touches only the requirement chosen for it.
const R = {
  capability: distinctSections[0],
  rule: distinctSections[1],
  goRule: distinctSections[2],
  semantic: distinctSections[3],
  deployment: distinctSections[4],
  person: distinctSections[5],
  pending: distinctSections[6],
  na: distinctSections[7],
  plain: distinctSections[8],
};
assert.equal(new Set(Object.values(R).map((r) => r?.id)).size, 9, "nine distinct level-1 requirements");

const capabilityRow = matrix.buildMatrix().rows.find((r) => r.state === "validated" && r.stack === "any" && r.adapter !== "semgrep");
assert.ok(capabilityRow, "a capability with a validated row for any stack");
const CAPABILITY = `${capabilityRow.adapter}#${capabilityRow.capability}`;
const packRules = semgrep.buildPackIndex(RULES).rules;
const jsRule = packRules.find((r) => r.language === "javascript");
const goRule = packRules.find((r) => r.language === "go");
assert.ok(jsRule && goRule, "the pack has a JavaScript rule and a Go rule");

const check = (unit, id, extra = {}) => ({ unit, id, covers: "a construct this check flags", misses: "what it does not model", depth: "partial", ...extra });
const why = "It bears on the requirement for a reason of its own.";

/** A copy of the shipped mapping pack, every entry reset to nothing mapped, with the fixture entries. */
function fixtureMapping() {
  const dir = tmp("v2-90-map-");
  const versionDir = path.join(dir, "5.0.0");
  fs.cpSync(MAP_PACK, versionDir, { recursive: true });
  // The counts below are those of the fixture alone, whatever the shipped mapping maps: every chapter entry starts
  // unmapped, with repository evidence (an undefined field is left out when the file is written).
  const unmapped = (evidence) => ({ status: "unmapped", evidence, subdimensions: [], checks: [], why: undefined, review: undefined });
  for (const name of fs.readdirSync(versionDir).filter((f) => /^V\d+\.json$/.test(f))) {
    const doc = readJson(path.join(versionDir, name));
    for (const entry of doc.entries) Object.assign(entry, unmapped("repository"));
    writeJson(path.join(versionDir, name), doc);
  }
  const set = (requirement, patch) => {
    const file = path.join(versionDir, `${asvs.chapterFileStem(requirement.chapter)}.json`);
    const doc = readJson(file);
    const entry = doc.entries.find((e) => e.requirement === requirement.id);
    Object.assign(entry, patch);
    writeJson(file, doc);
  };
  const reviewed = (checks, subdimensions) => ({ status: "reviewed", evidence: "repository", subdimensions, checks, why, review: { by: "independent context", date: "2026-11-14" } });
  set(R.capability, reviewed([check("capability", CAPABILITY)], ["secrets"]));
  set(R.rule, reviewed([check("semgrep-rule", jsRule.id)], [jsRule.subdimension]));
  set(R.goRule, reviewed([check("semgrep-rule", goRule.id)], [goRule.subdimension]));
  set(R.semantic, reviewed([check("semantic-method", "differential-review")], ["business-logic"]));
  set(R.deployment, unmapped("deployment"));
  set(R.person, unmapped("person"));
  set(R.pending, { status: "pending", evidence: "repository", subdimensions: ["secrets"], checks: [check("capability", CAPABILITY)], why });
  set(R.na, reviewed([check("capability", CAPABILITY)], ["secrets"]));
  return dir;
}

// ---- stored runs ---------------------------------------------------------------------------------------------------

const packRecords = (kind) =>
  semgrep.listPackRuleFiles(RULES).map((rel) => ({
    file: `${RECORDED_AT}${rel}`,
    sha256: kind === "current" ? `sha256:${sha256(fs.readFileSync(path.join(RULES, ...rel.split("/"))))}` : `sha256:${sha256(Buffer.from(`an older version of ${rel}`))}`,
  }));

const COMMIT = "1111111111111111111111111111111111111111";
const OTHER_COMMIT = "2222222222222222222222222222222222222222";

/**
 * A finished Quality run with a Semgrep step (the JGates pack selected) and the step of the mapped capability.
 * capability: completed | error | timeout | off. pack: current | stale. scanned: the scanned-languages record or null.
 */
function storeQuality(home, project, runId, startedAt, { capability = "completed", pack = "current", scanned = { javascript: 4, typescript: 1 }, commit = COMMIT } = {}) {
  const dir = path.join(home, "workspaces", workspaceId(project), "runs", runId);
  const semgrepStage = { id: "semgrep#sast", label: "Semgrep", kind: "step", adapter: "semgrep", state: "completed", interpreted: true, ...(scanned ? { scannedLanguages: scanned } : {}) };
  const semgrepItem = { id: "semgrep#sast", tool: "semgrep", adapter: "semgrep", subcheck: null, capabilities: ["sast"], languages: ["javascript", "typescript"], configFiles: packRecords(pack), state: { enabled: true, originLabel: "profile Balanced" }, reason: { code: "SELECTED", message: "Selected by capability:sast" } };
  const item = { id: CAPABILITY, tool: capabilityRow.adapter, adapter: capabilityRow.adapter, subcheck: null, capabilities: [capabilityRow.capability], languages: [], configFiles: [] };
  const stages = [semgrepStage];
  const willRun = [semgrepItem];
  const notRun = [];
  if (capability === "off") notRun.push({ ...item, state: { enabled: false, originLabel: "profile Balanced" }, reason: { code: "DISABLED", message: `Switched off by capability:${capabilityRow.capability}` } });
  else {
    willRun.push({ ...item, state: { enabled: true, originLabel: "profile Balanced" }, reason: { code: "SELECTED", message: "Selected" } });
    const reasons = { error: "the tool exited with code 2", timeout: "timed out after 600 s" };
    stages.push({ id: CAPABILITY, label: capabilityRow.adapter, kind: "step", adapter: capabilityRow.adapter, state: capability, interpreted: capability === "completed", ...(reasons[capability] ? { reason: reasons[capability] } : {}) });
  }
  const finding = (stageId, ruleId, waived) => ({ stageId, tool: stageId.split("#")[0], ruleId, severity: "high", normalizedSeverity: "high", message: "a finding", location: { path: "src/app.js", line: 3 }, blocking: true, waived });
  writeJson(path.join(dir, "result.json"), {
    schemaVersion: 1,
    runId,
    gate: "quality",
    tool: "jgates",
    version: "2.0.0",
    startedAt,
    finishedAt: startedAt,
    decision: "failed",
    complete: true,
    reduced: false,
    exitCode: 1,
    requirements: [],
    stages,
    findings: [finding(CAPABILITY, "cap.rule", false), finding(CAPABILITY, "cap.rule", true), finding("semgrep#sast", `rules.${jsRule.id}`, false)],
    unsatisfied: [],
    warnings: [],
    blockingViolations: 0,
    disabled: [],
    workspaceChanges: { checked: true, added: [], modified: [], removed: [] },
    artifacts: { result: "result.json", logs: [], outputs: [], plan: "plan.json" },
  });
  writeJson(path.join(dir, "plan.json"), { schemaVersion: 1, kind: "jgates-plan", groups: { willRun, notApplicableOrDisabled: notRun } });
  writeJson(path.join(dir, "run.json"), { schemaVersion: 1, gate: "quality", runId, source: { commit, dirty: false, dirtyContentHash: null } });
}

function storeSemantic(home, project, runId, startedAt, { commit = COMMIT, methods = ["differential-review"] } = {}) {
  const dir = path.join(home, "workspaces", workspaceId(project), "semantic-runs", runId);
  writeJson(path.join(dir, "result.json"), {
    schemaVersion: 1,
    runId,
    gate: "semantic",
    tool: "jgates",
    version: "2.0.0",
    startedAt,
    finishedAt: startedAt,
    decision: "passed",
    complete: true,
    reduced: false,
    exitCode: 0,
    requirements: [],
    stages: [],
    findings: [],
    unsatisfied: [],
    warnings: [],
    blockingViolations: 0,
    disabled: [],
    workspaceChanges: { checked: false, added: [], modified: [], removed: [] },
    artifacts: { result: "result.json", logs: [], outputs: [] },
    semanticRun: { schemaVersion: 1, enforcement: "advisory", methods, outcome: { requested: true, state: "completed", separateFromDecision: true, provider: "scripted", model: "fixture" }, source: { id: "fixture", basis: "git", traceable: true }, quality: null },
  });
  writeJson(path.join(dir, "run.json"), { schemaVersion: 1, gate: "semantic", runId, source: { commit, dirty: false, dirtyContentHash: null } });
}

const RUNS = {
  good: "run_20261114T100000Z_aaaaaaaa",
  error: "run_20261113T100000Z_bbbbbbbb",
  timeout: "run_20261112T100000Z_cccccccc",
  off: "run_20261111T100000Z_dddddddd",
  stale: "run_20261110T100000Z_eeeeeeee",
  noscan: "run_20261109T100000Z_ffffffff",
};
const SEM_SAME = "sem_20261114T110000Z_0a0a0a0a";
const SEM_OTHER = "sem_20261101T110000Z_0b0b0b0b";

/** A throwaway project and data folder with the stored runs, the fixture mapping and a fake engine that records calls. */
function crafted() {
  const project = tmp("v2-90-project-");
  const home = tmp("v2-90-home-");
  const engine = tmp("v2-90-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(runtime, `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nrequire(${JSON.stringify(FAKE)});\n`);
  const mapDir = fixtureMapping();
  storeQuality(home, project, RUNS.good, "2026-11-14T10:00:00.000Z");
  storeQuality(home, project, RUNS.error, "2026-11-13T10:00:00.000Z", { capability: "error" });
  storeQuality(home, project, RUNS.timeout, "2026-11-12T10:00:00.000Z", { capability: "timeout" });
  storeQuality(home, project, RUNS.off, "2026-11-11T10:00:00.000Z", { capability: "off" });
  storeQuality(home, project, RUNS.stale, "2026-11-10T10:00:00.000Z", { pack: "stale" });
  storeQuality(home, project, RUNS.noscan, "2026-11-09T10:00:00.000Z", { scanned: null });
  storeSemantic(home, project, SEM_SAME, "2026-11-14T11:00:00.000Z");
  storeSemantic(home, project, SEM_OTHER, "2026-11-01T11:00:00.000Z", { commit: OTHER_COMMIT });
  const cli = (args, { locale = "en", env = {} } = {}) => {
    const full = { ...process.env, JGATES_HOME: home, JGATES_LOCALE: locale, NO_COLOR: "1", JGATES_ASVS_MAP_DIR: mapDir, JGATES_CONTAINER_RUNTIME: runtime, ...env };
    if (!("JGATES_POLICY_DIR" in env)) delete full.JGATES_POLICY_DIR;
    const r = spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env: full, input: "", timeout: 120_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const json = (args, options) => {
    const r = cli([...args, "--json"], options);
    try {
      return { ...r, doc: JSON.parse(r.out) };
    } catch {
      assert.fail(`no JSON from ${args.join(" ")}: ${r.out}\n${r.err}`);
    }
  };
  const map = (extra = [], options) => {
    const r = json(["coverage", "asvs", "--cwd", project, ...extra], options);
    assert.equal(r.code, 0, `${extra.join(" ")}: ${r.out}${r.err}`);
    assertSchema(r.doc, `coverage asvs ${extra.join(" ")}`);
    return r.doc;
  };
  const engineCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter((l) => l.trim() !== "") : []);
  return { project, home, cli, json, map, engineCalls };
}

const row = (doc, requirement) => {
  const found = doc.requirements.find((r) => r.id === requirement.id);
  assert.ok(found, `${requirement.id} is in the map`);
  return found;
};

// ---- the cases -----------------------------------------------------------------------------------------------------

test("V2-90: stored runs and a fixture mapping reach each of the five states for the stated reason", () => {
  const p = crafted();
  const doc = p.map();
  assert.deepEqual(doc.runs.quality.runId, RUNS.good, "the last finished validation is read by default");
  assert.deepEqual(doc.runs.semantic.map((s) => s.runId), [SEM_SAME], "the last finished run of each Semantic method");
  assert.equal(doc.level, 1);
  assert.equal(doc.levelSource, "default");
  assert.deepEqual(doc.source, data.source, "the source block carries version, licence and attribution");
  assert.equal(doc.source.version, "5.0.0");
  assert.equal(doc.source.licence, "CC BY-SA 4.0");

  const cap = row(doc, R.capability);
  assert.equal(cap.state, "examined");
  assert.equal(cap.code, "EXAMINED");
  assert.equal(cap.basis, "deterministic");
  assert.equal(cap.text, R.capability.text, "the official text, unchanged");
  assert.equal(cap.textLanguage, "en");
  assert.deepEqual(cap.checks.map((c) => [c.id, c.status, c.ran, c.runId, c.openFindings]), [[CAPABILITY, "ran", true, RUNS.good, 1]], "one open finding: the waived one is not counted");
  assert.ok(cap.reason.includes(CAPABILITY), cap.reason);

  const rule = row(doc, R.rule);
  assert.equal(rule.state, "examined");
  assert.deepEqual(rule.checks.map((c) => [c.id, c.status, c.language, c.openFindings]), [[jsRule.id, "ran", "javascript", 1]]);

  const go = row(doc, R.goRule);
  assert.equal(go.state, "unsupported", "a rule of a language the project lacks");
  assert.equal(go.code, "UNSUPPORTED_OTHER_STACKS");
  assert.deepEqual(go.checks.map((c) => [c.status, c.code, c.language]), [["unsupported", "LANGUAGE_NOT_SCANNED", "go"]]);

  const ai = row(doc, R.semantic);
  assert.equal(ai.state, "examined");
  assert.equal(ai.code, "EXAMINED_AI_ONLY");
  assert.equal(ai.basis, "ai-source-review");
  assert.match(ai.reason, /AI review of the source/);

  assert.deepEqual([row(doc, R.deployment).state, row(doc, R.deployment).code], ["awaiting-evidence", "AWAITING_DEPLOYMENT"]);
  assert.deepEqual([row(doc, R.person).state, row(doc, R.person).code], ["awaiting-evidence", "AWAITING_PERSON"]);

  const pending = row(doc, R.pending);
  assert.deepEqual([pending.state, pending.code, pending.review, pending.checks.length], ["unsupported", "UNSUPPORTED_PENDING_REVIEW", "pending", 0], "a pending entry counts for nothing even when its check ran");
  const plain = row(doc, R.plain);
  assert.deepEqual([plain.state, plain.code, plain.reason], ["unsupported", "UNSUPPORTED_NO_CHECK", "no JGates check examines this"]);

  // Unexamined: the same check in a run where it ended in error.
  const failed = p.map(["--run", RUNS.error]);
  assert.equal(row(failed, R.capability).state, "unexamined");

  // Not applicable: the user's decision, with the reason; the check that ran anyway is still shown.
  const na = p.json(["coverage", "asvs", "not-applicable", R.na.id, "--reason", "no such feature in this product", "--yes", "--cwd", p.project]);
  assert.equal(na.code, 0, na.out + na.err);
  const after = p.map();
  const naRow = row(after, R.na);
  assert.deepEqual([naRow.state, naRow.code, naRow.decision.scope, naRow.decision.reason], ["not-applicable", "NOT_APPLICABLE_RECORDED", "requirement", "no such feature in this product"]);
  assert.ok(naRow.reason.includes("no such feature in this product"));
  assert.deepEqual(naRow.checks.map((c) => c.status), ["ran"]);

  // The totals count every row once, examined split into deterministic and AI review only; no state is left out.
  const t = after.totals;
  assert.equal(t.rows, 70);
  assert.equal(t.examined + t.unexamined + t.unsupported + t.notApplicable + t.awaitingEvidence, t.rows);
  assert.equal(t.examinedDeterministic + t.examinedAiOnly, t.examined);
  assert.equal(t.examinedAiOnly, 1);
  assert.equal(t.notApplicable, 1);
  assert.equal(t.awaitingEvidence, 2);
  assert.deepEqual(new Set(after.requirements.map((r) => r.state)), new Set(["examined", "unsupported", "not-applicable", "awaiting-evidence"]));
  const byState = p.map(["--state", "awaiting-evidence"]);
  assert.deepEqual(byState.requirements.map((r) => r.id).sort(), [R.deployment.id, R.person.id].sort());
  assert.equal(byState.totals.rows, 70, "the state filter narrows the rows listed, not the totals");
  assert.deepEqual(p.engineCalls(), [], "the map reads stored files only: no engine call");
});

test("V2-90: a requirement is examined only when its check completed; off, in error or timed out it is unexamined with that reason", () => {
  const p = crafted();
  assert.equal(row(p.map(["--run", RUNS.good]), R.capability).state, "examined");
  const cases = [
    [RUNS.off, "DISABLED", /Switched off by capability/],
    [RUNS.error, "ERROR", /the tool exited with code 2/],
    [RUNS.timeout, "TIMEOUT", /timed out after 600 s/],
  ];
  for (const [runId, code, detail] of cases) {
    const doc = p.map(["--run", runId]);
    assert.equal(doc.runs.quality.runId, runId);
    const r = row(doc, R.capability);
    assert.equal(r.state, "unexamined", runId);
    assert.equal(r.code, "UNEXAMINED", runId);
    assert.deepEqual(r.checks.map((c) => [c.status, c.ran, c.code]), [["not-run", false, code]], runId);
    assert.match(r.checks[0].detail ?? "", detail, runId);
    assert.ok(r.reason.includes(CAPABILITY) && r.reason.includes(r.checks[0].reason), `${runId}: the row names the check and its reason: ${r.reason}`);
  }
  const words = { [RUNS.off]: "switched off", [RUNS.error]: "ended in error", [RUNS.timeout]: "timed out" };
  for (const [runId, word] of Object.entries(words)) {
    const text = p.cli(["coverage", "asvs", "--cwd", p.project, "--run", runId]);
    assert.equal(text.code, 0, text.err);
    const line = text.out.split("\n").find((l) => l.includes(R.capability.id));
    assert.ok(line && line.includes("unexamined") && text.out.includes(word), `${runId}: ${line}`);
  }
  const pt = p.cli(["coverage", "asvs", "--cwd", p.project, "--run", RUNS.error], { locale: "pt-BR" });
  assert.equal(pt.code, 0, pt.err);
  assert.ok(pt.out.split("\n").some((l) => l.includes(R.capability.id) && l.includes("não examinado")), pt.out);
  assert.ok(pt.out.includes("terminou com erro"), pt.out);
  const missing = p.json(["coverage", "asvs", "--cwd", p.project, "--run", "run_nope"]);
  assert.equal(missing.code, 3);
  assert.equal(missing.doc.code, "ASVS_RUN_NOT_FOUND");
});

test("V2-90: a rule of a language the project lacks is unsupported; another version of the pack or no scanned-languages record does not count", () => {
  const p = crafted();
  const stale = p.map(["--run", RUNS.stale]);
  assert.equal(row(stale, R.rule).state, "unexamined");
  assert.deepEqual(row(stale, R.rule).checks.map((c) => [c.status, c.code]), [["not-run", "PACK_OTHER_VERSION"]]);
  assert.match(row(stale, R.rule).checks[0].reason, /another version of the JGates rule pack: validate again/);
  assert.equal(row(stale, R.capability).state, "examined", "the other checks of that run still count");

  const noscan = p.map(["--run", RUNS.noscan]);
  assert.equal(row(noscan, R.rule).state, "unexamined");
  assert.deepEqual(row(noscan, R.rule).checks.map((c) => [c.status, c.code]), [["not-run", "NO_SCANNED_LANGUAGES"]]);
  assert.match(row(noscan, R.rule).checks[0].reason, /validate again/);
  // Without the record the project's languages still come from the plan: a Go rule stays unsupported, never examined.
  assert.equal(row(noscan, R.goRule).state, "unsupported");
  assert.deepEqual(row(noscan, R.goRule).checks.map((c) => c.code), ["LANGUAGE_ABSENT"]);
  assert.equal(row(p.map(["--run", RUNS.good]), R.goRule).state, "unsupported");
});

test("V2-90: not applicable is one entry of .jgates/asvs.json with a reason, a preview and an undo, refused in governed mode", () => {
  const p = crafted();
  const target = path.join(p.project, FILE);
  const before = '{\n  "$comment": "team file",\n  "notApplicable": [\n    { "id": "V17", "reason": "no WebRTC in this product", "recorded": "2026-11-01", "owner": "ana" }\n  ],\n  "note": 1\n}\n';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, before);
  const args = ["coverage", "asvs", "not-applicable", R.na.id, "--cwd", p.project];

  // A reason is required: none, too short, too long, with a control character.
  for (const [name, extra] of [
    ["no reason", []],
    ["2 characters", ["--reason", "ab"]],
    ["301 characters", ["--reason", "x".repeat(301)]],
    ["a control character", ["--reason", "bad\treason"]],
  ]) {
    const r = p.json([...args, "--yes", ...extra]);
    assert.equal(r.code, 3, `${name}: ${r.out}`);
    assert.equal(r.doc.code, "ASVS_REASON_INVALID", name);
    assert.equal(fs.readFileSync(target, "utf8"), before, `${name}: nothing written`);
  }
  const unknown = p.json(["coverage", "asvs", "not-applicable", "V99.9.9", "--reason", "fine reason", "--yes", "--cwd", p.project]);
  assert.equal(unknown.doc.code, "ASVS_TARGET_UNKNOWN");

  // The preview shows the entry and the change of the file and writes nothing.
  const preview = p.json([...args, "--reason", "no such feature in this product", "--preview"]);
  assert.equal(preview.code, 0, preview.out + preview.err);
  assert.deepEqual([preview.doc.preview, preview.doc.written], [true, false]);
  assert.equal(preview.doc.entry.id, R.na.id);
  assert.ok(preview.doc.diff.includes(`+++ b/${FILE}`) && preview.doc.diff.includes(`"id": "${R.na.id}"`), preview.doc.diff);
  assert.equal(fs.readFileSync(target, "utf8"), before);
  // Without --yes and with nobody to ask, the text shows the entry and writes nothing.
  const asked = p.cli([...args, "--reason", "no such feature in this product"]);
  assert.equal(asked.code, 3, asked.out + asked.err);
  assert.ok(asked.out.includes(`+++ b/${FILE}`) && asked.out.includes(R.na.id), asked.out);
  assert.equal(fs.readFileSync(target, "utf8"), before);

  // The write: the file changes by that entry and nothing else.
  const written = p.json([...args, "--reason", "no such feature in this product", "--yes"]);
  assert.equal(written.code, 0, written.out + written.err);
  const after = fs.readFileSync(target, "utf8");
  const cut = before.indexOf("\n  ],");
  assert.equal(after.slice(0, cut), before.slice(0, cut), "everything before the end of the list is the same bytes");
  assert.ok(after.endsWith(before.slice(cut)), "everything after the list is the same bytes");
  const middle = after.slice(cut, after.length - (before.length - cut));
  assert.match(middle, /^,\n    \{\n/, "the entry is appended with the indentation of the others");
  const entry = JSON.parse(middle.slice(1));
  assert.deepEqual(entry, { id: R.na.id, reason: "no such feature in this product", recorded: entry.recorded });
  assert.match(entry.recorded, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(row(p.map(), R.na).state, "not-applicable");
  assert.equal(p.json([...args, "--reason", "again", "--yes"]).doc.code, "ASVS_ALREADY_NOT_APPLICABLE");

  // Governed (read-only) mode: refused, nothing written; the map is still built.
  const env = { JGATES_POLICY_DIR: tmp("v2-90-policy-") };
  const governed = p.json(["coverage", "asvs", "not-applicable", R.plain.id, "--reason", "fine reason", "--yes", "--cwd", p.project], { env });
  assert.equal(governed.code, 3, governed.out);
  assert.equal(governed.doc.code, "ASVS_READ_ONLY");
  assert.match(governed.doc.message, /governed \(read-only\)/);
  assert.equal(p.json(["coverage", "asvs", "level", "2", "--yes", "--cwd", p.project], { env }).doc.code, "ASVS_READ_ONLY");
  assert.equal(p.json(["coverage", "asvs", "undo", written.doc.undo.token, "--cwd", p.project], { env }).doc.code, "ASVS_READ_ONLY");
  assert.equal(fs.readFileSync(target, "utf8"), after);
  assert.equal(p.map([], { env }).requirements.length, 70);

  // Undo puts the file back byte for byte; --remove takes the entry out the same way.
  const undone = p.json(["coverage", "asvs", "undo", written.doc.undo.token, "--cwd", p.project]);
  assert.equal(undone.code, 0, undone.out + undone.err);
  assert.equal(fs.readFileSync(target, "utf8"), before);
  assert.equal(row(p.map(), R.na).state, "examined");
  assert.equal(p.json([...args, "--reason", "no such feature in this product", "--yes"]).code, 0);
  const removed = p.json([...args, "--remove", "--yes"]);
  assert.equal(removed.code, 0, removed.out + removed.err);
  assert.equal(fs.readFileSync(target, "utf8"), before);

  // A missing file is created by the first entry and the undo takes it away again.
  const fresh = crafted();
  const freshFile = path.join(fresh.project, FILE);
  const made = fresh.json(["coverage", "asvs", "not-applicable", R.plain.section, "--reason", "not in this product", "--yes", "--cwd", fresh.project]);
  assert.equal(made.code, 0, made.out + made.err);
  assert.equal(made.doc.created, true);
  assert.deepEqual(readJson(freshFile), { version: "5.0.0", notApplicable: [{ id: R.plain.section, reason: "not in this product", recorded: made.doc.entry.recorded }] });
  const sectionRow = row(fresh.map(), R.plain);
  assert.deepEqual([sectionRow.state, sectionRow.decision.scope, sectionRow.decision.id], ["not-applicable", "section", R.plain.section], "a section decision covers its requirements");
  assert.equal(fresh.json(["coverage", "asvs", "undo", made.doc.undo.token, "--cwd", fresh.project]).code, 0);
  assert.equal(fs.existsSync(freshFile), false);
});

test("V2-90: the level changes the rows (70, 253, 345); --deterministic-only leaves out the AI review; JSON, attribution and exit 0", () => {
  const p = crafted();
  for (const [level, rows] of [
    ["1", 70],
    ["2", 253],
    ["3", 345],
  ]) {
    const doc = p.map(["--level", level]);
    assert.equal(doc.level, Number(level));
    assert.equal(doc.levelSource, "option");
    assert.equal(doc.requirements.length, rows, `level ${level}`);
    assert.equal(doc.totals.rows, rows);
    assert.equal(
      doc.chapters.reduce((n, c) => n + c.totals.rows, 0),
      rows,
      "the chapters add up to the rows",
    );
    assert.ok(doc.requirements.every((r) => r.level <= Number(level)));
  }
  assert.equal(p.json(["coverage", "asvs", "--level", "4", "--cwd", p.project]).doc.code, "ASVS_LEVEL_INVALID");

  // Recording the project's level changes the default rows; --level shows another without changing it.
  const recorded = p.json(["coverage", "asvs", "level", "2", "--yes", "--cwd", p.project]);
  assert.equal(recorded.code, 0, recorded.out + recorded.err);
  assert.equal(readJson(path.join(p.project, FILE)).level, 2);
  const byProject = p.map();
  assert.deepEqual([byProject.level, byProject.levelSource, byProject.requirements.length], [2, "project", 253]);
  assert.equal(p.map(["--level", "1"]).requirements.length, 70);
  assert.equal(readJson(path.join(p.project, FILE)).level, 2);

  // Deterministic only: what only the Semantic run examined is no longer examined, and nothing counts as AI review.
  const det = p.map(["--deterministic-only", "--level", "1"]);
  assert.equal(det.deterministicOnly, true);
  const ai = row(det, R.semantic);
  assert.equal(ai.state, "unexamined");
  assert.deepEqual(ai.checks.map((c) => [c.status, c.code]), [["excluded", "DETERMINISTIC_ONLY"]]);
  assert.equal(det.totals.examinedAiOnly, 0);
  assert.equal(row(det, R.capability).state, "examined");

  // The text: the statement, the totals, the rows and the attribution line, once; exit 0.
  const text = p.cli(["coverage", "asvs", "--cwd", p.project, "--level", "1"]);
  assert.equal(text.code, 0, text.err);
  assert.ok(text.out.includes("This map shows what was examined, not whether the project meets the standard."), text.out.slice(0, 400));
  assert.equal(text.out.split(data.source.attribution).length - 1, 1, "the attribution line is printed once");
  assert.ok(text.out.includes(R.capability.text), "the official text of a row");
  assert.ok(text.out.includes("70 requirements"));
  const pt = p.cli(["coverage", "asvs", "--cwd", p.project, "--level", "1"], { locale: "pt-BR" });
  assert.equal(pt.code, 0, pt.err);
  assert.ok(pt.out.includes("© The OWASP Foundation, CC BY-SA 4.0") && pt.out.includes("Este mapa mostra o que foi examinado"), pt.out.slice(-400));
});

test("V2-90: no claim of compliance in either language, and runs of different revisions are named", () => {
  const p = crafted();
  fs.mkdirSync(path.join(p.project, ".jgates"), { recursive: true });
  fs.writeFileSync(path.join(p.project, FILE), `{\n  "notApplicable": [\n    { "id": "${R.na.id}", "reason": "not in this product", "recorded": "2026-11-14" }\n  ]\n}\n`);
  const same = p.map();
  assert.deepEqual(same.warnings.map((w) => w.code), [], "the same revision gives no warning");

  const differ = p.map(["--semantic-run", SEM_OTHER]);
  const warning = differ.warnings.find((w) => w.code === "REVISIONS_DIFFER");
  assert.ok(warning, JSON.stringify(differ.warnings));
  assert.deepEqual([warning.params.qualityRun, warning.params.semanticRun], [RUNS.good, SEM_OTHER]);
  assert.ok(warning.params.qualityRevision.startsWith(COMMIT) && warning.params.semanticRevision.startsWith(OTHER_COMMIT));
  const enText = p.cli(["coverage", "asvs", "--cwd", p.project, "--semantic-run", SEM_OTHER]);
  assert.ok(enText.out.includes("different revisions") && enText.out.includes(SEM_OTHER), enText.out.slice(0, 800));
  const ptText = p.cli(["coverage", "asvs", "--cwd", p.project, "--semantic-run", SEM_OTHER], { locale: "pt-BR" });
  assert.ok(ptText.out.includes("revisões diferentes"), ptText.out.slice(0, 800));

  const outputs = [];
  for (const locale of ["en", "pt-BR"]) {
    for (const extra of [["--level", "3"], ["--level", "3", "--semantic-run", SEM_OTHER], ["--run", RUNS.error], ["--run", RUNS.noscan, "--deterministic-only"]]) {
      const text = p.cli(["coverage", "asvs", "--cwd", p.project, ...extra], { locale });
      const json = p.cli(["coverage", "asvs", "--cwd", p.project, ...extra, "--json"], { locale });
      assert.equal(text.code, 0, text.err);
      assert.equal(json.code, 0, json.err);
      outputs.push([`${locale} ${extra.join(" ")}`, text.out + text.err], [`${locale} ${extra.join(" ")} --json`, json.out + json.err]);
    }
    const preview = p.cli(["coverage", "asvs", "not-applicable", R.plain.id, "--reason", "not in this product", "--preview", "--cwd", p.project], { locale });
    outputs.push([`${locale} preview`, preview.out + preview.err]);
  }
  for (const locale of ["en", "pt-BR"]) outputs.push([`coverage.${locale}.json`, fs.readFileSync(path.join(DIST, "i18n", `coverage.${locale}.json`), "utf8")]);
  const forbidden = [/\bcompliant\b/i, /\bconformant\b/i, /\bcertified\b/i, /\bcompliance\b/i, /\bconformidade\b/i, /\bcertificad[oa]s?\b/i, /\d+(?:[.,]\d+)?\s*%/];
  for (const [name, text] of outputs) for (const word of forbidden) assert.doesNotMatch(text, word, `${name}: ${word}`);
  assert.deepEqual(p.engineCalls(), []);
});
