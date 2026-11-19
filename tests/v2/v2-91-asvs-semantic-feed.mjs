import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { FIXTURES, ROOT, fakeAuditor, load, runAudit, setupWorkspace } from "./fixtures/cloudflare/auditor.mjs";

// V2-91 (fake engine, scripted model): the Semantic security audit feeds the ASVS coverage map (PLAN-asvs.md sections 4
// and 7). A real security-audit run of the Semantic pipeline, answered by the scripted auditor, leaves a coverage ledger
// with units of four attack-class blocks: Injection examined (the hunter covered it), Business logic pending (planned,
// never closed by the hunting wave), Access control unsupported and Cryptography and secrets not applicable (both
// proposed by the planner). A fixture mapping maps requirements to those blocks, and `jgates coverage asvs` reads the
// stored runs:
//   - the requirements mapped to the examined block are examined with the basis "AI review of the source", counted
//     apart from the deterministic ones (a requirement that a deterministic check also examined stays deterministic);
//   - a block whose units are pending, unsupported or not applicable gives nothing, and a ledger unit's own "not
//     applicable" never makes a requirement not applicable;
//   - --deterministic-only leaves the Semantic units out;
//   - a Quality run and the Semantic run of different revisions produce the warning; the same revision does not.
// The map reads stored files only: the fake engine named in the environment records no call.

const JGATES = path.join(ROOT, "jgates");
const MAIN = path.join(JGATES, "dist", "cli", "main.js");
const FAKE = path.join(JGATES, "tests", "docker", "fake-docker.cjs");
const MAP_PACK = path.join(JGATES, "packs", "asvs", "jgates-asvs-map", "5.0.0");

const asvs = await load("core/coverage/asvs/index.js");
const matrix = await load("core/matrix/index.js");
const { coverageId } = (await load("core/semantic-modules/index.js")).securityAudit;

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

const INJECTION = "ATTACK-CLASSES.md#Injection";
const BUSINESS = "ATTACK-CLASSES.md#Business logic";
const ACCESS = "ATTACK-CLASSES.md#Access control";
const CRYPTO = "ATTACK-CLASSES.md#Cryptography and secrets";

// Level-1 requirements of the fixture mapping, so the default map (level 1) lists them all.
const R = { injection: "V1.2.4", injection2: "V1.2.5", mixed: "V1.2.1", pending: "V2.3.1", unsupported: "V8.2.1", na: "V11.3.1" };
const data = asvs.loadAsvs("5.0.0");
for (const id of Object.values(R)) assert.equal(data.requirements.find((r) => r.id === id)?.level, 1, `${id} is a level-1 requirement`);

const capabilityRow = matrix.buildMatrix().rows.find((r) => r.state === "validated" && r.stack === "any" && r.adapter !== "semgrep");
assert.ok(capabilityRow, "a capability with a validated row for any stack");
const CAPABILITY = `${capabilityRow.adapter}#${capabilityRow.capability}`;

const made = [];
const tmp = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};

/** A copy of the shipped mapping pack where every entry is unmapped except the fixture entries, all reviewed. */
function fixtureMapping() {
  const dir = tmp("v2-91-map-");
  const versionDir = path.join(dir, "5.0.0");
  fs.cpSync(MAP_PACK, versionDir, { recursive: true });
  const files = fs.readdirSync(versionDir).filter((f) => /^V\d\d\.json$/.test(f));
  for (const f of files) {
    const doc = readJson(path.join(versionDir, f));
    doc.entries = doc.entries.map((e) => ({ requirement: e.requirement, status: "unmapped", evidence: e.evidence, subdimensions: [], checks: [] }));
    writeJson(path.join(versionDir, f), doc);
  }
  const check = (unit, id) => ({ unit, id, covers: "what this check looks for", misses: "what it does not model", depth: "partial" });
  const set = (id, checks, subdimensions) => {
    const requirement = data.requirements.find((r) => r.id === id);
    const file = path.join(versionDir, `${asvs.chapterFileStem(requirement.chapter)}.json`);
    const doc = readJson(file);
    Object.assign(
      doc.entries.find((e) => e.requirement === id),
      { status: "reviewed", evidence: "repository", subdimensions, checks, why: "It bears on the requirement for a reason of its own.", review: { by: "independent context", date: "2026-11-14" } },
    );
    writeJson(file, doc);
  };
  set(R.injection, [check("semantic-ledger", INJECTION)], ["injection"]);
  set(R.injection2, [check("semantic-ledger", INJECTION)], ["injection"]);
  set(R.mixed, [check("capability", CAPABILITY), check("semantic-ledger", INJECTION)], ["injection"]);
  set(R.pending, [check("semantic-ledger", BUSINESS)], ["business-logic"]);
  set(R.unsupported, [check("semantic-ledger", ACCESS)], ["authorization"]);
  set(R.na, [check("semantic-ledger", CRYPTO)], ["cryptography"]);
  return dir;
}

const QUALITY_SAME = "run_20261114T100000Z_aaaaaaaa";
const QUALITY_OTHER = "run_20261113T100000Z_bbbbbbbb";
const OTHER_COMMIT = "2222222222222222222222222222222222222222";

/** A finished Quality run of the workspace whose only step is the mapped capability, completed and interpreted. */
function storeQuality(workspaceDir, runId, startedAt, source) {
  const dir = path.join(workspaceDir, "runs", runId);
  const item = { id: CAPABILITY, tool: capabilityRow.adapter, adapter: capabilityRow.adapter, subcheck: null, capabilities: [capabilityRow.capability], languages: [], configFiles: [], state: { enabled: true, originLabel: "profile Balanced" }, reason: { code: "SELECTED", message: "Selected" } };
  writeJson(path.join(dir, "result.json"), {
    schemaVersion: 1,
    runId,
    gate: "quality",
    tool: "jgates",
    version: "2.0.0",
    startedAt,
    finishedAt: startedAt,
    decision: "passed",
    complete: true,
    reduced: false,
    exitCode: 0,
    requirements: [],
    stages: [{ id: CAPABILITY, label: capabilityRow.adapter, kind: "step", adapter: capabilityRow.adapter, state: "completed", interpreted: true }],
    findings: [],
    unsatisfied: [],
    warnings: [],
    blockingViolations: 0,
    disabled: [],
    workspaceChanges: { checked: true, added: [], modified: [], removed: [] },
    artifacts: { result: "result.json", logs: [], outputs: [], plan: "plan.json" },
  });
  writeJson(path.join(dir, "plan.json"), { schemaVersion: 1, kind: "jgates-plan", groups: { willRun: [item], notApplicableOrDisabled: [] } });
  writeJson(path.join(dir, "run.json"), { schemaVersion: 1, gate: "quality", runId, source });
}

/** Units the scripted planner proposes besides the Injection unit it hunts (and its own not-applicable Cryptography unit). */
const refs = (attackClass) => ({ surface: "src/routes.js#GET /users", boundary: "src/db.js#bound parameters", subsystem: "src", attack_class: attackClass });
const EXTRA_UNITS = [
  // Planned, but the hunting wave closes only the Injection unit: the host defers it (pending).
  { canonical_refs: refs(BUSINESS), surface: "GET /users", boundary: "bound parameters", subsystem: "src", attack_class: "Business logic", starting_paths: ["src/routes.js"], selected_companion_blocks: [], excluded_blocks: [], status: "planned", priority: 2, priority_rationale: "the only workflow of the scope" },
  { canonical_refs: refs(ACCESS), status: "unsupported", reason: "the permission model lives in a gateway outside the repository", starting_paths: ["src/routes.js"] },
];

let shared = null;
/** One scripted security-audit run, one fixture mapping, two stored Quality runs and the CLI, for every case. */
async function setup() {
  if (shared) return shared;
  const ws = setupWorkspace("v2-91", FIXTURES.clean);
  const audit = await runAudit(ws, { script: fakeAuditor({ coverageId, extraUnits: EXTRA_UNITS }) });
  assert.equal(audit.outcome.state, "completed", JSON.stringify(audit.outcome.reason));
  const ledger = audit.json("coverage-ledger.json");
  const statesOf = (block) => ledger.filter((u) => u.canonical_refs.attack_class === block).map((u) => u.state);
  assert.deepEqual(statesOf(INJECTION), ["examined"], "the hunter covered the Injection unit");
  assert.deepEqual(statesOf(BUSINESS), ["pending"], "the Business logic unit was never closed");
  assert.deepEqual(statesOf(ACCESS), ["unsupported"]);
  assert.deepEqual(statesOf(CRYPTO), ["not-applicable"]);

  const semDir = audit.result.runDir;
  const semRunId = path.basename(semDir);
  assert.equal(path.basename(path.dirname(semDir)), "semantic-runs");
  const workspaceDir = path.dirname(path.dirname(semDir));
  const source = readJson(path.join(semDir, "run.json")).source;
  assert.match(String(source?.commit), /^[0-9a-f]{40}$/, "the Semantic run records the revision it analyzed");
  storeQuality(workspaceDir, QUALITY_SAME, "2026-11-14T10:00:00.000Z", source);
  storeQuality(workspaceDir, QUALITY_OTHER, "2026-11-13T10:00:00.000Z", { ...source, commit: OTHER_COMMIT, dirty: false, dirtyContentHash: null });

  const mapDir = fixtureMapping();
  const engine = tmp("v2-91-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(runtime, `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nrequire(${JSON.stringify(FAKE)});\n`);
  const cli = (args, { locale = "en" } = {}) => {
    const env = { ...process.env, JGATES_HOME: ws.home, JGATES_LOCALE: locale, NO_COLOR: "1", JGATES_ASVS_MAP_DIR: mapDir, JGATES_CONTAINER_RUNTIME: runtime };
    delete env.JGATES_POLICY_DIR;
    const r = spawnSync(process.execPath, [MAIN, "coverage", "asvs", "--cwd", ws.dir, ...args], { cwd: ws.dir, encoding: "utf8", env, input: "", timeout: 120_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const map = (args = []) => {
    const r = cli([...args, "--json"]);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.out}${r.err}`);
    return JSON.parse(r.out);
  };
  const engineCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter((l) => l.trim() !== "") : []);
  shared = { ws, semRunId, cli, map, engineCalls };
  return shared;
}

test.after(() => {
  shared?.ws.cleanup();
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const row = (doc, id) => {
  const found = doc.requirements.find((r) => r.id === id);
  assert.ok(found, `${id} is in the map`);
  return found;
};
const checksOf = (r) => r.checks.map((c) => [c.unit, c.id, c.status, c.ran, c.basis, c.code]);

test("V2-91: examined units of one attack-class block make the requirements mapped to it examined by an AI review of the source, counted apart", async () => {
  const { semRunId, map, cli, engineCalls } = await setup();
  const doc = map();
  assert.equal(doc.runs.quality.runId, QUALITY_SAME);
  assert.deepEqual(doc.runs.semantic.map((s) => s.runId), [semRunId], "the last finished security-audit run is read");
  assert.ok(doc.runs.semantic[0].methods.includes("security-audit"));

  for (const id of [R.injection, R.injection2]) {
    const r = row(doc, id);
    assert.deepEqual([r.state, r.code, r.basis], ["examined", "EXAMINED_AI_ONLY", "ai-source-review"], id);
    assert.match(r.reason, /AI review of the source/);
    assert.ok(r.reason.includes(INJECTION), r.reason);
    assert.deepEqual(checksOf(r), [["semantic-ledger", INJECTION, "ran", true, "ai-source-review", "RAN"]], id);
    assert.equal(r.checks[0].runId, semRunId);
  }
  // A deterministic check that also ran keeps the requirement deterministic; the ledger unit is still shown.
  const mixed = row(doc, R.mixed);
  assert.deepEqual([mixed.state, mixed.code, mixed.basis], ["examined", "EXAMINED", "deterministic"]);
  assert.deepEqual(checksOf(mixed), [
    ["capability", CAPABILITY, "ran", true, "deterministic", "RAN"],
    ["semantic-ledger", INJECTION, "ran", true, "ai-source-review", "RAN"],
  ]);

  // Counted apart: two requirements examined only by the AI review, one by a deterministic check.
  assert.deepEqual([doc.totals.examined, doc.totals.examinedDeterministic, doc.totals.examinedAiOnly], [3, 1, 2]);
  const v1 = doc.chapters.find((c) => c.id === "V1");
  assert.deepEqual([v1.totals.examinedDeterministic, v1.totals.examinedAiOnly], [1, 2]);

  const text = cli([]);
  assert.equal(text.code, 0, text.err);
  assert.ok(text.out.includes("1 by a deterministic check, 2 only by an AI review of the source"), text.out.slice(0, 800));
  const line = text.out.split("\n").find((l) => l.includes(R.injection));
  assert.ok(line && line.includes("examined") && !line.includes("unexamined"), line);
  const pt = cli([], { locale: "pt-BR" });
  assert.equal(pt.code, 0, pt.err);
  assert.ok(pt.out.includes("revisão do código por IA"), pt.out.slice(0, 800));
  assert.deepEqual(engineCalls(), [], "the map reads stored files only: no engine call");
});

test("V2-91: a block whose units are pending, unsupported or not applicable gives nothing", async () => {
  const { map } = await setup();
  const doc = map();
  for (const [id, block] of [
    [R.pending, BUSINESS],
    [R.unsupported, ACCESS],
    [R.na, CRYPTO],
  ]) {
    const r = row(doc, id);
    assert.notEqual(r.state, "examined", id);
    assert.deepEqual([r.state, r.code, r.basis], ["unexamined", "UNEXAMINED", null], id);
    assert.deepEqual(checksOf(r), [["semantic-ledger", block, "not-run", false, "ai-source-review", "BLOCK_NOT_EXAMINED"]], id);
    assert.equal(r.checks[0].reason, "the security audit examined no part of this attack class");
  }
  // The ledger's own "not applicable" is a model's proposal: only the user's recorded decision makes a requirement so.
  assert.equal(row(doc, R.na).decision, null);
  assert.equal(doc.totals.notApplicable, 0);
  assert.equal(doc.totals.unexamined, 3);
});

test("V2-91: --deterministic-only leaves the Semantic units out", async () => {
  const { map, engineCalls } = await setup();
  const doc = map(["--deterministic-only"]);
  assert.equal(doc.deterministicOnly, true);
  for (const id of [R.injection, R.injection2]) {
    const r = row(doc, id);
    assert.equal(r.state, "unexamined", id);
    assert.deepEqual(checksOf(r), [["semantic-ledger", INJECTION, "excluded", false, "ai-source-review", "DETERMINISTIC_ONLY"]], id);
  }
  const mixed = row(doc, R.mixed);
  assert.deepEqual([mixed.state, mixed.basis], ["examined", "deterministic"]);
  assert.deepEqual(mixed.checks.map((c) => [c.unit, c.status]), [["capability", "ran"], ["semantic-ledger", "excluded"]]);
  assert.deepEqual([doc.totals.examined, doc.totals.examinedDeterministic, doc.totals.examinedAiOnly], [1, 1, 0]);
  assert.deepEqual(engineCalls(), []);
});

test("V2-91: a Quality run and a Semantic run of different revisions produce the warning; the same revision does not", async () => {
  const { semRunId, map, cli, engineCalls } = await setup();
  assert.equal(map().warnings.some((w) => w.code === "REVISIONS_DIFFER"), false, "the Quality run of the same revision gives no warning");
  const differ = map(["--run", QUALITY_OTHER]);
  assert.equal(differ.runs.quality.runId, QUALITY_OTHER);
  const warning = differ.warnings.find((w) => w.code === "REVISIONS_DIFFER");
  assert.ok(warning, JSON.stringify(differ.warnings));
  assert.deepEqual([warning.params.qualityRun, warning.params.semanticRun], [QUALITY_OTHER, semRunId]);
  assert.ok(warning.params.qualityRevision.startsWith(OTHER_COMMIT));
  assert.notEqual(warning.params.semanticRevision, warning.params.qualityRevision);
  // The warning does not change what the runs examined.
  assert.equal(row(differ, R.injection).state, "examined");
  const en = cli(["--run", QUALITY_OTHER]);
  assert.ok(en.out.includes("different revisions") && en.out.includes(semRunId), en.out.slice(0, 800));
  const pt = cli(["--run", QUALITY_OTHER], { locale: "pt-BR" });
  assert.ok(pt.out.includes("revisões diferentes"), pt.out.slice(0, 800));
  assert.deepEqual(engineCalls(), []);
});
