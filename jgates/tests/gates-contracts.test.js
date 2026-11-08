import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Gate contracts (V2): the schemas of run identity, source identity, sequence, scope and evidence binding, their
// validators and versioned readers, source identity taken from a real Git checkout, a result.json written before V2
// read as a Quality run, and the V2 acceptance harness importing case modules.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const HARNESS = path.join(repo, "tests", "v2.acceptance.test.js");
const gates = await import(pathToFileURL(path.join(dist, "core", "gates", "index.js")).href);
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const HASH = (c) => "sha256:" + c.repeat(64);
const git = (dir, args) => {
  const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

/** The gate schemas compiled on their own, without the module's validator: what the schema files alone accept. */
function rawSchemaValidator(kind) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const k of gates.GATE_RECORD_KINDS) ajv.addSchema(JSON.parse(fs.readFileSync(gates.gateSchemaFile(k), "utf8")));
  return ajv.getSchema(JSON.parse(fs.readFileSync(gates.gateSchemaFile(kind), "utf8")).$id);
}

function sequence(over = {}) {
  return {
    schemaVersion: 1,
    sequenceId: gates.newSequenceId(),
    createdAt: "2026-11-08T12:00:00Z",
    selectedGates: ["quality", "semantic"],
    runs: [
      { gate: "quality", runId: gates.newGateRunId("quality") },
      { gate: "semantic", runId: gates.newGateRunId("semantic") },
    ],
    advancement: { condition: "quality-approved", sourceId: HASH("a") },
    status: "advanced",
    ...over,
  };
}

function scope(over = {}) {
  return {
    schemaVersion: 1,
    mode: "full",
    subjects: [],
    exclusions: ["vendor/"],
    resolved: { base: null, target: { ref: "HEAD", commit: "a".repeat(40), sourceId: HASH("b") }, dirtyInputs: [{ path: "src/new.ts", change: "untracked", sha256: HASH("c") }] },
    baselineRunId: null,
    context: { allowed: [{ kind: "path", value: "src/auth/", reason: "imported by the subjects" }], expansion: { maxFiles: 40, maxDepth: 2 } },
    units: {
      effective: [{ id: "src/app.ts", reason: "requested" }],
      examined: [{ id: "src/app.ts", reason: "requested" }],
      reused: [],
      omitted: [{ id: "src/big.bin", reason: "binary" }],
    },
    ...over,
  };
}

function gitRepo() {
  const dir = tmp("jgates-gates-src-");
  git(dir, ["init", "-q"]);
  fs.writeFileSync(path.join(dir, "app.js"), "export const x = 1;\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.log\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

test("the sequence schema rejects a record that reuses one run ID for both gates", () => {
  const valid = sequence();
  assert.deepEqual(gates.validateSequence(valid), []);
  const quality = valid.runs[0].runId;
  const reused = { ...valid, runs: [{ gate: "quality", runId: quality }, { gate: "semantic", runId: quality }] };
  const problems = gates.validateSequence(reused);
  assert.ok(problems.length > 0, "a reused run ID must be refused");
  assert.ok(problems.some((p) => p.startsWith("/runs/1")), problems.join("\n"));
  // The schema file on its own refuses it too (each gate has its own run ID namespace).
  const raw = rawSchemaValidator("sequence");
  assert.equal(raw(valid), true, JSON.stringify(raw.errors));
  assert.equal(raw(reused), false);
  // Both refs in the Semantic namespace, or a Semantic run ahead of Quality, are refused as well.
  const sem = valid.runs[1].runId;
  assert.equal(raw({ ...valid, runs: [{ gate: "quality", runId: sem }, { gate: "semantic", runId: sem }] }), false);
  assert.equal(raw({ ...valid, runs: [valid.runs[1], valid.runs[0]] }), false);
  // The reader refuses it with the problems.
  assert.throws(() => gates.readGateRecord("sequence", reused), (e) => e.code === "GATE_RECORD_INVALID" && e.problems.length > 0);
  // A sequence carries no decision: a decision field on a run reference is not part of the record.
  assert.ok(gates.validateSequence({ ...valid, runs: [{ ...valid.runs[0], decision: "passed" }, valid.runs[1]] }).length > 0);
  // Paused needs a reason; advanced needs both runs.
  assert.ok(gates.validateSequence({ ...valid, status: "paused" }).length > 0);
  assert.deepEqual(gates.validateSequence({ ...valid, status: "paused", reason: { code: "QUALITY_NOT_PASSED", message: "Quality failed." } }), []);
  assert.ok(gates.validateSequence({ ...valid, runs: [valid.runs[0]] }).length > 0);
  assert.deepEqual(gates.validateSequence({ ...valid, runs: [valid.runs[0]], status: "awaiting-advancement" }), []);
});

test("a scope spec without mode is rejected, and each mode keeps its own requirements", () => {
  const valid = scope();
  assert.deepEqual(gates.validateScope(valid), []);
  const { mode, ...withoutMode } = valid;
  assert.equal(mode, "full");
  const problems = gates.validateScope(withoutMode);
  assert.ok(problems.some((p) => p.includes("mode")), problems.join("\n"));
  assert.equal(rawSchemaValidator("scope")(withoutMode), false);
  assert.throws(() => gates.readGateRecord("scope", withoutMode), (e) => e.code === "GATE_RECORD_INVALID");
  assert.ok(gates.validateScope({ ...valid, mode: "everything" }).length > 0);
  // selected needs subjects; incremental needs a resolved base.
  assert.ok(gates.validateScope({ ...valid, mode: "selected" }).length > 0);
  assert.deepEqual(gates.validateScope({ ...valid, mode: "selected", subjects: [{ kind: "path", value: "src/" }] }), []);
  assert.ok(gates.validateScope({ ...valid, mode: "incremental" }).length > 0);
  const base = { ref: "main", commit: "b".repeat(40), sourceId: HASH("d") };
  assert.deepEqual(gates.validateScope({ ...valid, mode: "incremental", resolved: { ...valid.resolved, base } }), []);
  // A reused unit always names the run its evidence came from.
  assert.ok(gates.validateScope({ ...valid, units: { ...valid.units, reused: [{ id: "src/a.ts", reason: "unchanged" }] } }).length > 0);
  const reused = [{ id: "src/a.ts", reason: "unchanged guard", evidence: { gate: "semantic", runId: gates.newGateRunId("semantic") } }];
  assert.deepEqual(gates.validateScope({ ...valid, units: { ...valid.units, reused } }), []);
});

test("source identity of a temp Git repo changes when an untracked file changes", () => {
  const dir = gitRepo();
  try {
    const clean = gates.computeSourceIdentity(dir);
    assert.deepEqual(gates.validateSourceIdentity(clean), []);
    assert.equal(clean.basis, "git-working-tree");
    assert.equal(clean.dirty, false);
    assert.equal(clean.dirtyContentHash, null);
    assert.match(clean.commit, /^[0-9a-f]{40}$/);
    assert.equal(clean.repository.idBasis, "root-commits");
    assert.equal(clean.traceable, true);

    // The clean working tree and its commit alone are the same source.
    const atHead = gates.commitSourceIdentity(dir, "HEAD");
    assert.deepEqual(gates.validateSourceIdentity(atHead), []);
    assert.deepEqual(gates.sourceMatch(clean, atHead), { same: true, code: "SAME_SOURCE" });

    fs.writeFileSync(path.join(dir, "notes.txt"), "first\n");
    const untracked = gates.computeSourceIdentity(dir);
    assert.deepEqual(gates.validateSourceIdentity(untracked), []);
    assert.equal(untracked.dirty, true);
    assert.equal(untracked.dirtyPaths, 1);
    assert.equal(untracked.commit, clean.commit);
    assert.notEqual(untracked.id, clean.id);

    fs.writeFileSync(path.join(dir, "notes.txt"), "second\n");
    const changed = gates.computeSourceIdentity(dir);
    assert.notEqual(changed.dirtyContentHash, untracked.dirtyContentHash, "the content of the untracked file is part of the identity");
    assert.notEqual(changed.id, untracked.id);
    assert.deepEqual(gates.sourceMatch(changed, untracked), { same: false, code: "DIFFERENT_SOURCE" });

    // The same content gives the same identity again; an ignored file is not part of the source.
    fs.writeFileSync(path.join(dir, "notes.txt"), "first\n");
    fs.writeFileSync(path.join(dir, "ignored.log"), "noise\n");
    const again = gates.computeSourceIdentity(dir);
    assert.equal(again.id, untracked.id);
    assert.deepEqual(gates.sourceMatch(again, untracked), { same: true, code: "SAME_SOURCE" });

    // A tracked modification also changes it; a folder without Git is identified by its inputs.
    fs.writeFileSync(path.join(dir, "app.js"), "export const x = 2;\n");
    assert.notEqual(gates.computeSourceIdentity(dir).id, again.id);
    const plain = tmp("jgates-gates-plain-");
    try {
      fs.writeFileSync(path.join(plain, "a.txt"), "a\n");
      const p = gates.computeSourceIdentity(plain);
      assert.deepEqual(gates.validateSourceIdentity(p), []);
      assert.equal(p.basis, "directory");
      assert.equal(p.repository, null);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a result.json written before V2 is read by the versioned reader as a Quality run", () => {
  const dir = gitRepo();
  const home = tmp("jgates-gates-home-");
  const emptyBin = tmp("jgates-gates-bin-");
  try {
    const env = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1", PATH: emptyBin };
    const cli = (args) => spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input: "", timeout: 120_000 });
    const init = cli(["init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"]);
    assert.equal(init.status, 0, init.stdout + init.stderr);
    const run = cli(["run", "--cwd", dir, "--no-interactive", "--json"]);
    const doc = JSON.parse(run.stdout);
    const file = path.join(doc.runDir, "result.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal("gate" in stored, false, "a result of the current Quality runner carries no gate field");

    const identity = gates.loadResultAsGateRun(file);
    assert.deepEqual(gates.validateRunIdentity(identity), []);
    assert.equal(identity.gate, "quality");
    assert.equal(identity.migratedFrom, "result-v1-without-gate");
    assert.equal(identity.runId, stored.runId);
    assert.equal(identity.outcome.decision, stored.decision);
    assert.equal(identity.outcome.exitCode, stored.exitCode);
    assert.equal(identity.stages.length, stored.stages.length);
    assert.equal(identity.plan.hash, stored.selection.planHash);
    assert.equal(identity.configHash, stored.analyzed.hashes.config);
    assert.equal(identity.source.basis, "legacy-analyzed");
    assert.equal(identity.source.commit, stored.analyzed.git.head);
    assert.equal(gates.gateOfResult(stored), "quality");
    // A legacy identity never counts as the current source, even for the unchanged checkout.
    assert.deepEqual(gates.sourceMatch(identity.source, gates.computeSourceIdentity(dir)), { same: false, code: "SOURCE_LEGACY" });

    // A minimal pre-V2 document (only the fields result.schema.json requires) reads as a Quality run too.
    const resultSchema = JSON.parse(fs.readFileSync(path.join(here, "..", "schemas", "result", "result.schema.json"), "utf8"));
    const validResult = new Ajv2020({ strict: true, allErrors: true }).compile(resultSchema);
    const minimal = { schemaVersion: 1, runId: "run_20250101T000000Z_0123abcd", decision: "failed", complete: true, reduced: false, exitCode: 1, stages: [{ id: "lint", state: "completed" }], disabled: [] };
    assert.equal(validResult(minimal), true, JSON.stringify(validResult.errors));
    const old = gates.readResultAsGateRun(minimal);
    assert.equal(old.gate, "quality");
    assert.equal(old.source.basis, "legacy-analyzed");
    assert.equal(old.artifacts.result, null);
    // The result schema accepts the new gate field, and a result with gate semantic reads as Semantic.
    assert.equal(validResult({ ...minimal, gate: "quality" }), true);
    assert.equal(validResult({ ...minimal, gate: "third" }), false);
    const semantic = gates.readResultAsGateRun({ ...minimal, gate: "semantic", runId: gates.newGateRunId("semantic") });
    assert.equal(semantic.gate, "semantic");
    assert.equal("migratedFrom" in semantic, false);
    assert.throws(() => gates.readResultAsGateRun({ ...minimal, gate: "semantic" }), (e) => e.code === "GATE_RECORD_INVALID");
    assert.throws(() => gates.readResultAsGateRun({ ...minimal, schemaVersion: 2 }), (e) => e.code === "GATE_RECORD_UNSUPPORTED_VERSION");
  } finally {
    for (const d of [dir, home, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("versioned readers migrate unversioned records, refuse newer versions and round-trip through the writer", () => {
  const { schemaVersion, ...legacy } = sequence({ status: "running", runs: [{ gate: "quality", runId: gates.newGateRunId("quality") }] });
  assert.equal(schemaVersion, 1);
  const migrated = gates.readGateRecord("sequence", legacy);
  assert.equal(migrated.schemaVersion, 1);
  assert.throws(() => gates.readGateRecord("sequence", { ...legacy, schemaVersion: 2 }), (e) => e.code === "GATE_RECORD_UNSUPPORTED_VERSION");
  assert.throws(() => gates.readGateRecord("scope", { ...scope(), schemaVersion: "1" }), (e) => e.code === "GATE_RECORD_UNSUPPORTED_VERSION");

  const dir = gitRepo();
  const out = tmp("jgates-gates-out-");
  try {
    const source = gates.computeSourceIdentity(dir);
    const identity = {
      schemaVersion: 1,
      gate: "semantic",
      runId: gates.newGateRunId("semantic"),
      configHash: HASH("e"),
      source,
      plan: { hash: HASH("f"), source: "built" },
      stages: [{ id: "general-review", state: "completed" }],
      outcome: { decision: "passed", complete: true, reduced: false, exitCode: 0, partial: false },
      artifacts: { result: "result.json", logs: [], outputs: [], events: "events.jsonl" },
    };
    const file = path.join(out, "run-identity.json");
    gates.writeGateRecord("run-identity", file, identity);
    assert.deepEqual(gates.loadGateRecord("run-identity", file), identity);
    // A run identity whose nested source identity predates versions still reads.
    const { schemaVersion: _v, ...oldSource } = source;
    assert.deepEqual(gates.readGateRecord("run-identity", { ...identity, source: oldSource }).source, source);
    // A Semantic run with a Quality run ID, or a passed outcome that is partial, is refused (also by the writer).
    assert.ok(gates.validateRunIdentity({ ...identity, runId: gates.newGateRunId("quality") }).length > 0);
    assert.ok(gates.validateRunIdentity({ ...identity, outcome: { ...identity.outcome, partial: true } }).length > 0);
    assert.throws(() => gates.writeGateRecord("run-identity", file, { ...identity, gate: "quality" }), (e) => e.code === "GATE_RECORD_INVALID");
    assert.equal(gates.gateOfRunId(identity.runId), "semantic");

    // Evidence binding: current needs a traceable non-legacy source; stale or unknown says why.
    const binding = {
      schemaVersion: 1,
      origin: { gate: "quality", runId: gates.newGateRunId("quality"), producedAt: "2026-11-08T12:00:00Z", kind: "result" },
      identities: { source, config: HASH("1"), dependency: null, method: null, backend: null, policy: HASH("2") },
      freshness: { state: "current", checkedAt: "2026-11-08T12:05:00Z" },
    };
    assert.deepEqual(gates.validateEvidenceBinding(binding), []);
    const legacySource = gates.sourceFromAnalyzed(null, null);
    assert.ok(gates.validateEvidenceBinding({ ...binding, identities: { ...binding.identities, source: legacySource } }).length > 0);
    assert.deepEqual(gates.validateEvidenceBinding({ ...binding, identities: { ...binding.identities, source: legacySource }, freshness: { state: "unknown", checkedAt: "2026-11-08T12:05:00Z", reason: "recorded before V2" } }), []);
    assert.ok(gates.validateEvidenceBinding({ ...binding, freshness: { state: "stale", checkedAt: "2026-11-08T12:05:00Z" } }).length > 0);
  } finally {
    for (const d of [dir, out]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("the V2 acceptance harness imports case modules and fails on one that cannot load", () => {
  const cases = tmp("jgates-v2-cases-");
  try {
    const nodeTest = JSON.stringify("node:test");
    fs.writeFileSync(path.join(cases, "a-sample.mjs"), `import test from ${nodeTest};\ntest("sample acceptance case runs", () => {});\n`);
    fs.writeFileSync(
      path.join(cases, "c-async.mjs"),
      `import test from ${nodeTest};\nawait new Promise((r) => setTimeout(r, 20));\ntest("async sample case runs", async () => { await new Promise((r) => setTimeout(r, 5)); });\n`,
    );
    fs.writeFileSync(path.join(cases, "helper.txt"), "not a module\n");
    // NODE_TEST_CONTEXT would make the child report to this runner instead of printing TAP.
    const { NODE_TEST_CONTEXT: _context, ...parentEnv } = process.env;
    const harness = (dir) =>
      spawnSync(process.execPath, ["--test", "--test-reporter=tap", HARNESS], { cwd: repo, encoding: "utf8", env: { ...parentEnv, JGATES_V2_CASES_DIR: dir }, timeout: 120_000 });
    const ok = harness(cases);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    // Case tests are top-level tests of the harness file (not nested under the harness test).
    assert.match(ok.stdout, /^ok \d+ - sample acceptance case runs$/m);
    assert.match(ok.stdout, /^ok \d+ - async sample case runs$/m);
    assert.match(ok.stdout, /^ok \d+ - acceptance harness imports every case module$/m);
    assert.match(ok.stdout, /case modules found: 2, imported: 2/);
    // No harness test title carries a case token: only case files may.
    const titles = ok.stdout.split(/\r?\n/).filter((l) => /^\s*(not )?ok \d+ - /.test(l));
    assert.ok(titles.length >= 2);
    for (const line of titles) assert.doesNotMatch(line, /V2-\d\d/);

    fs.writeFileSync(path.join(cases, "b-broken.mjs"), "throw new Error('case module exploded');\n");
    const broken = harness(cases);
    assert.notEqual(broken.status, 0);
    assert.match(broken.stdout, /^not ok \d+ - acceptance harness imports every case module$/m);
    assert.match(broken.stdout, /case module exploded/);
    assert.match(broken.stdout, /^ok \d+ - sample acceptance case runs$/m);
    assert.match(broken.stdout, /^ok \d+ - async sample case runs$/m);

    // With no case folder at all, the harness still runs and passes.
    const none = harness(path.join(cases, "missing"));
    assert.equal(none.status, 0, none.stdout + none.stderr);
    assert.match(none.stdout, /case modules found: 0, imported: 0/);
  } finally {
    fs.rmSync(cases, { recursive: true, force: true });
  }
});
