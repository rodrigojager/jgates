import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-02: a Semantic-only run with an empty history. `jgates semantic run --json` creates a Semantic run with its own
// sem_ ID and folder (apart from the Quality runs), its run identity and ordered events; no Quality run is created or
// needed. The provider is a fake command that records each call, so no test spends model tokens.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const gates = () => import(pathToFileURL(path.join(root, "jgates", "dist", "core", "gates", "index.js")).href);

const APPROVED = JSON.stringify({ status: "APPROVED", score: 96, findings: [], hardBlockers: [], approvalNotes: "Fake provider approved." });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v2-02-ws-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "v2-02-home-"));
  const aux = fs.mkdtempSync(path.join(os.tmpdir(), "v2-02-aux-"));
  const calls = path.join(aux, "calls.log");
  const script = path.join(aux, "fake-provider.mjs");
  fs.writeFileSync(
    script,
    [
      `import fs from "node:fs";`,
      `const chunks = [];`,
      `for await (const c of process.stdin) chunks.push(c);`,
      `fs.appendFileSync(${JSON.stringify(calls)}, "CALL\\n");`,
      `process.stdout.write(${JSON.stringify(APPROVED)});`,
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "jgates.yml"),
    ["extensions:", "  semantic-gate:", "    provider: command", `    command: ${JSON.stringify(process.execPath)}`, `    commandArgs: [${JSON.stringify(script)}]`, "    model: fake-model", ""].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "app.js"), "exports.answer = () => 42;\n");
  const git = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  const env = { ...process.env, JGATES_HOME: home, NO_COLOR: "1" };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input: "", timeout: 120_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  const providerCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0);
  return { dir, home, cli, providerCalls, cleanup: () => [dir, home, aux].forEach((d) => fs.rmSync(d, { recursive: true, force: true })) };
}

test("V2-02: Semantic-only run with empty history gets its own sem_ ID and folder and creates no Quality run", async () => {
  const p = setup();
  try {
    const before = p.cli("history", "--cwd", p.dir, "--json");
    assert.equal(before.code, 0, before.out + before.err);
    assert.deepEqual(before.doc.runs, [], "the history starts empty");

    const r = p.cli("semantic", "run", "--cwd", p.dir, "--json");
    assert.ok(r.doc, r.out + r.err);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.doc.gate, "semantic");
    assert.match(r.doc.runId, /^sem_[0-9]{8}T[0-9]{6}Z_[0-9a-f]{8}$/);
    assert.equal(r.doc.decision, "passed");
    assert.equal(r.doc.semanticRun.outcome.state, "completed");
    assert.equal(r.doc.semanticRun.quality, null, "no Quality report is needed nor attached");
    assert.equal(p.providerCalls(), 1);

    // Its own folder, under semantic-runs, with result, run identity, plan and events.
    const wsId = r.doc.workspace.id;
    const expected = path.join(p.home, "workspaces", wsId, "semantic-runs", r.doc.runId);
    assert.equal(path.resolve(r.doc.runDir), path.resolve(expected));
    for (const f of ["result.json", "run.json", "plan.json", "events.jsonl", "outputs/review.json"]) assert.ok(fs.existsSync(path.join(expected, f)), `${f} is in the run folder`);
    const { loadGateRecord, gateOfRunId } = await gates();
    const identity = loadGateRecord("run-identity", path.join(expected, "run.json"));
    assert.equal(identity.gate, "semantic");
    assert.equal(identity.runId, r.doc.runId);
    assert.equal(gateOfRunId(identity.runId), "semantic");
    assert.equal(identity.source.basis, "git-working-tree");
    assert.equal(identity.outcome.decision, "passed");
    assert.equal(identity.outcome.partial, false);
    assert.equal(r.doc.semanticRun.source.id, identity.source.id);

    // Ordered JSONL events of this run only.
    const events = fs.readFileSync(path.join(expected, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(events[0].type, "run-started");
    assert.equal(events.at(-1).type, "run-finished");
    assert.equal(events.at(-1).data.decision, "passed");
    assert.deepEqual(events.map((e) => e.sequence), events.map((_, i) => i + 1));
    assert.ok(events.every((e) => e.runId === r.doc.runId));

    // No Quality run: the Quality history and its folder stay empty; the Semantic history has exactly this run.
    const after = p.cli("history", "--cwd", p.dir, "--json");
    assert.deepEqual(after.doc.runs, []);
    const runsDir = path.join(p.home, "workspaces", wsId, "runs");
    assert.deepEqual(fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : [], []);
    const semantic = p.cli("semantic", "history", "--cwd", p.dir, "--json");
    assert.equal(semantic.code, 0, semantic.out + semantic.err);
    assert.deepEqual(semantic.doc.runs.map((x) => x.runId), [r.doc.runId]);
    assert.equal(semantic.doc.runs[0].lifecycle, "settled");
  } finally {
    p.cleanup();
  }
});
