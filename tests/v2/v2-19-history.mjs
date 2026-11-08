import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-19: the Quality and the Semantic histories are separate, and a finished Semantic run opened again (CLI status or
// the API) is settled: not live, with its final result and events, nothing that implies a new execution.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = path.join(root, "jgates", "dist");
const MAIN = path.join(DIST, "cli", "main.js");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v2-19-ws-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "v2-19-home-"));
  const aux = fs.mkdtempSync(path.join(os.tmpdir(), "v2-19-aux-"));
  const script = path.join(aux, "fake-provider.mjs");
  fs.writeFileSync(
    script,
    [`for await (const c of process.stdin) {}`, `process.stdout.write(JSON.stringify({ status: "NEEDS_CHANGES", score: 70, findings: [{ severity: "important", category: "tests", path: "app.js", message: "Add a test." }] }));`].join("\n"),
  );
  // A plain folder (the Quality run uses the option-driven bridge with nothing enabled: no tool is needed).
  fs.writeFileSync(
    path.join(dir, "jgates.yml"),
    ["extensions:", "  semantic-gate:", "    provider: command", `    command: ${JSON.stringify(process.execPath)}`, `    commandArgs: [${JSON.stringify(script)}]`, ""].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "app.js"), "exports.answer = () => 42;\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
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
  return { dir, home, cli, cleanup: () => [dir, home, aux].forEach((d) => fs.rmSync(d, { recursive: true, force: true })) };
}

/** A Quality run written by the real Quality run service (core/run executeRun) with one trivial step. */
async function qualityRun(dir, home) {
  const { executeRun } = await import(pathToFileURL(path.join(DIST, "core", "run", "index.js")).href);
  return executeRun({
    workspacePath: dir,
    home,
    version: "test",
    adapter: "v2-19-check",
    options: {},
    cache: false,
    waivers: [],
    execute: async () => ({ stages: [{ id: "v2-19-check", state: "completed", blockingViolations: 0 }], requirements: [{ id: "v2-19-check", required: true }], disabled: [], findings: [], logs: [], outputs: [] }),
  });
}

test("V2-19: Quality and Semantic histories are separate and a reopened finished Semantic run is settled", async () => {
  const p = setup();
  try {
    const quality = await qualityRun(p.dir, p.home);
    assert.match(quality.runId, /^run_/);
    const sem = p.cli("semantic", "run", "--cwd", p.dir, "--json");
    assert.ok(sem.doc, sem.out + sem.err);
    assert.match(sem.doc.runId, /^sem_/);
    assert.equal(sem.doc.decision, "failed", "NEEDS_CHANGES never passes");
    assert.equal(sem.code, 1);

    // Separate histories: each lists only its own gate's runs.
    const qh = p.cli("history", "--cwd", p.dir, "--json");
    assert.deepEqual(qh.doc.runs.map((r) => r.runId), [quality.runId]);
    const sh = p.cli("semantic", "history", "--cwd", p.dir, "--json");
    assert.deepEqual(sh.doc.runs.map((r) => r.runId), [sem.doc.runId]);
    assert.ok(sh.doc.runs.every((r) => r.gate === "semantic"));

    // Reopened through the CLI: settled, not live, the final result.
    const status = p.cli("semantic", "status", sem.doc.runId, "--cwd", p.dir, "--json");
    assert.equal(status.code, 0, status.out + status.err);
    assert.equal(status.doc.run.lifecycle, "settled");
    assert.equal(status.doc.run.live, false);
    assert.equal(status.doc.run.partial, false);
    assert.equal(status.doc.run.result.decision, "failed");
    assert.equal(status.doc.run.identity.gate, "semantic");
    assert.equal(status.doc.run.identity.outcome.partial, false);
    // A Quality run ID is not a Semantic run, and the reverse.
    const wrong = p.cli("semantic", "status", quality.runId, "--cwd", p.dir, "--json");
    assert.equal(wrong.doc.code, "BAD_RUN_ID");

    // Reopened through the API: the same settled state, and its event stream is complete (done, ends with run-finished).
    const { routes } = await import(pathToFileURL(path.join(DIST, "server", "routes", "semantic-runs.js")).href);
    const server = { home: p.home, workspace: { id: sem.doc.workspace.id, path: sem.doc.workspace.path, name: "v2-19" }, log: () => undefined };
    const route = (method, routePath) => routes.find((r) => r.method === method && r.path === routePath);
    const one = await route("GET", "/api/semantic/runs/:id").handler({ params: { id: sem.doc.runId }, query: {}, server });
    assert.equal(one.json.run.lifecycle, "settled");
    assert.equal(one.json.run.live, false);
    const events = await route("GET", "/api/semantic/runs/:id/events").handler({ params: { id: sem.doc.runId }, query: { cursor: "0", wait: "2000" }, server });
    assert.equal(events.json.done, true);
    assert.equal(events.json.live, false);
    assert.equal(events.json.events.at(-1).type, "run-finished");
    const list = await route("GET", "/api/semantic/runs").handler({ query: {}, server });
    assert.deepEqual(list.json.runs.map((r) => r.runId), [sem.doc.runId]);
  } finally {
    p.cleanup();
  }
});
