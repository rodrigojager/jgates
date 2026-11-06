import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// A partial run is either working or dead; heartbeat.json tells which, wherever the run was started. These cases use
// real processes (this one and a child that exits) and real files; no Docker and no tool is needed.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (...p) => pathToFileURL(path.resolve(here, "..", "dist", ...p)).href;
const { startHeartbeat, readLiveness, processExists, lastActivity, HEARTBEAT_FILE } = await import(dist("core", "run", "heartbeat.js"));
const { listRuns } = await import(dist("core", "artifacts", "index.js"));

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("a beating run is alive; once it stops, the file is gone and the run is not alive", () => {
  const dir = tmp("jg-hb-");
  const beat = startHeartbeat(dir, { intervalMs: 50 });
  const doc = JSON.parse(fs.readFileSync(path.join(dir, HEARTBEAT_FILE), "utf8"));
  assert.equal(doc.pid, process.pid);
  assert.equal(readLiveness(dir).alive, true);
  beat.stop();
  assert.equal(fs.existsSync(path.join(dir, HEARTBEAT_FILE)), false);
  assert.deepEqual(readLiveness(dir), { alive: false, beatAt: null, pid: null });
});

test("a heartbeat whose process is gone, or that stopped beating, is dead", async () => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(processExists(pid), false);
  assert.equal(processExists(process.pid), true);

  const gone = tmp("jg-hb-gone-");
  fs.writeFileSync(path.join(gone, HEARTBEAT_FILE), JSON.stringify({ schemaVersion: 1, pid, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  assert.equal(readLiveness(gone).alive, false, "fresh heartbeat of a dead process");

  const stale = tmp("jg-hb-stale-");
  const old = new Date(Date.now() - 120_000).toISOString();
  fs.writeFileSync(path.join(stale, HEARTBEAT_FILE), JSON.stringify({ schemaVersion: 1, pid: process.pid, startedAt: old, updatedAt: old }));
  assert.equal(readLiveness(stale).alive, false, "living process that stopped beating");
});

test("the last activity is the newest file the run wrote, never the heartbeat itself", () => {
  const dir = tmp("jg-hb-act-");
  fs.mkdirSync(path.join(dir, "outputs", "bridge", "linters_logs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.json"), "{}");
  const older = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dir, "plan.json"), older, older);
  fs.writeFileSync(path.join(dir, "outputs", "bridge", "linters_logs", "YAML_YAMLLINT-SUCCESS.log"), "ok");
  const beat = startHeartbeat(dir, { intervalMs: 10_000 });
  const activity = lastActivity(dir);
  beat.stop();
  assert.equal(activity.file, "outputs/bridge/linters_logs/YAML_YAMLLINT-SUCCESS.log");
  assert.ok(activity.at);
  assert.deepEqual(lastActivity(tmp("jg-hb-empty-")), { file: null, at: null });
});

test("the history marks a partial run as alive only while it beats", () => {
  const home = tmp("jg-hb-home-");
  const runs = path.join(home, "workspaces", "ws_0123456789abcdef", "runs");
  const live = path.join(runs, "run_20261106T120000Z_aaaaaaaa");
  const dead = path.join(runs, "run_20261106T110000Z_bbbbbbbb");
  for (const [dir, at] of [[live, "2026-11-06T12:00:00Z"], [dead, "2026-11-06T11:00:00Z"]]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ runId: path.basename(dir), startedAt: at, decision: "incomplete", partial: true }));
  }
  const beat = startHeartbeat(live, { intervalMs: 10_000 });
  try {
    const list = listRuns(home, "ws_0123456789abcdef");
    assert.deepEqual(list.map((r) => [r.runId, r.partial, r.alive]), [
      ["run_20261106T120000Z_aaaaaaaa", true, true],
      ["run_20261106T110000Z_bbbbbbbb", true, false],
    ]);
  } finally {
    beat.stop();
  }
});
