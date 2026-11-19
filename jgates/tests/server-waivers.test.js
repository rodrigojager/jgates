import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// The project's waivers in the local server (PLAN-waivers.md section 6): GET /api/waivers lists the entries of
// .jgates/waivers.json with their state; POST /api/waivers with `preview: true` answers with the entry and the diff of the
// file and leaves it byte for byte as it was; the write answers with the updated list and the undo data; POST
// /api/waivers/undo puts the file back byte for byte; DELETE /api/waivers/<id> removes one entry and answers with its undo.
// A request with no date, a past date or a bad reason is refused with the message of the command, and in governed
// (read-only) mode every POST and DELETE is refused like the other project writes. `review.waivers` of POST /api/plans is
// the same list. The findings come from a result stored in the data folder of the workspace, so the routes never need the
// engine or git.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FAKE = path.join(here, "docker", "fake-docker.cjs");
const VERSION = JSON.parse(fs.readFileSync(path.resolve(here, "..", "..", "package.json"), "utf8")).version;
const { workspaceId } = await import(pathToFileURL(path.join(dist, "core", "ids", "index.js")).href);
const FILE = ".jgates/waivers.json";
const RUN_ID = "run_20261114T100000Z_aaaaaaaa";

const dirs = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
const made = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

const finding = (n) => ({
  stageId: "scan",
  tool: "scanner",
  ruleId: "scan.risky",
  severity: "high",
  fingerprint: `jgf1:${String(n).padStart(2, "0")}${"ab".repeat(15)}`,
  anchor: `jga1:${String(n).padStart(2, "0")}${"cd".repeat(15)}`,
  location: { path: "src/app.js", line: n * 10 },
  message: "a risky call",
  blocking: true,
  waived: false,
});
const FINDINGS = [finding(1), finding(2), finding(3)];
const short = (f) => f.fingerprint.replace(/^jgf1:/, "").slice(0, 12);

/** A project with the configuration `jgates init` writes, and a data folder holding one finished run. */
function setup() {
  const home = made("jg-waivers-home-");
  const engine = made("jg-waivers-engine-");
  const project = made("jg-waivers-project-");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(
    runtime,
    `process.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nprocess.env.FAKE_DOCKER_LOG = ${JSON.stringify(path.join(engine, "calls.jsonl"))};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": VERSION }))};\nrequire(${JSON.stringify(FAKE)});\n`,
  );
  fs.writeFileSync(path.join(engine, "objects.json"), JSON.stringify({ containers: [], volumes: [], networks: [], images: [] }));
  fs.writeFileSync(path.join(project, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(project, "app.py"), "def add(a, b):\n    return a + b\n");
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: `registry.example.test/jgates/jgates-tools@sha256:${"ef".repeat(32)}`, JGATES_LOCALE: "en", NO_COLOR: "1", JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" };
  const init = spawnSync(process.execPath, [MAIN, "init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"], { env, encoding: "utf8", timeout: 120_000 });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const runDir = path.join(home, "workspaces", workspaceId(project), "runs", RUN_ID);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "result.json"), `${JSON.stringify({ schemaVersion: 1, runId: RUN_ID, decision: "failed", startedAt: "2026-11-14T10:00:00.000Z", stages: [{ id: "scan", state: "completed" }], findings: FINDINGS })}\n`);
  return { home, project, env, engine };
}

function request(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port, method, path: p, agent: false, headers: { Host: `127.0.0.1:${port}`, ...(data ? { "Content-Type": "application/json", "Content-Length": String(data.length) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function startUi(env, cwd) {
  const proc = spawn(process.execPath, [MAIN, "ui", "--cwd", cwd, "--no-open", "--port", "0", "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const ui = { proc, info: null, out: "", err: "" };
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (d) => (ui.err += d));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`jgates ui did not start:\n${ui.out}\n${ui.err}`)), 60_000);
    proc.stdout.on("data", (d) => {
      ui.out += d;
      if (ui.info) return;
      try {
        ui.info = JSON.parse(ui.out);
        clearTimeout(timer);
        resolve(ui);
      } catch {
        // Not complete yet.
      }
    });
    proc.on("exit", (code) => {
      if (ui.info) return;
      clearTimeout(timer);
      reject(new Error(`jgates ui exited with ${code}:\n${ui.out}\n${ui.err}`));
    });
  });
}

async function withUi(env, project, fn) {
  const ui = await startUi(env, project);
  try {
    const html = fs.readFileSync(ui.info.launcher, "utf8");
    const href = /href="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
    assert.ok(href, "launcher has no bootstrap link");
    const url = new URL(href);
    const port = ui.info.port;
    const boot = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: url.pathname + url.search, agent: false }, (res) => {
        res.resume();
        res.on("end", () => resolve(res));
      }).on("error", reject);
    });
    const cookie = String(boot.headers["set-cookie"]?.[0] ?? "").split(";")[0];
    const s = await request(port, "GET", "/api/session", { headers: { Cookie: cookie } });
    assert.equal(s.status, 200, s.text);
    const origin = `http://127.0.0.1:${port}`;
    const call = (method, p, body) => request(port, method, p, { headers: method === "GET" ? { Cookie: cookie } : { Cookie: cookie, Origin: origin, "X-JGates-CSRF": s.json.csrfToken }, body });
    await fn(call);
  } finally {
    if (ui.proc.exitCode === null) {
      const exited = once(ui.proc, "exit");
      ui.proc.kill("SIGTERM");
      await exited;
    }
  }
}

const bytes = (project) => (fs.existsSync(path.join(project, FILE)) ? fs.readFileSync(path.join(project, FILE)) : null);
const ask = (f, extra = {}) => ({ runId: RUN_ID, fingerprints: [short(f)], until: "2999-12-31", reason: "false positive", ...extra });

test("preview writes nothing; the write answers with the list and the undo; undo and delete put the file back", async () => {
  const p = setup();
  const original = '{\n  "waivers": [\n    { "rule": "x.y", "path": "legacy/*", "reason": "legacy", "owner": "ana" }\n  ]\n}\n';
  fs.writeFileSync(path.join(p.project, FILE), original);
  await withUi(p.env, p.project, async (call) => {
    const before = await call("GET", "/api/waivers");
    assert.equal(before.status, 200, before.text);
    assert.equal(before.json.waivers.length, 1);
    assert.equal(before.json.waivers[0].kind, "handwritten");
    assert.equal(before.json.runId, RUN_ID);

    const preview = await call("POST", "/api/waivers", ask(FINDINGS[1], { preview: true }));
    assert.equal(preview.status, 200, preview.text);
    assert.equal(preview.json.preview, true);
    assert.equal(preview.json.entries.length, 1);
    assert.equal(preview.json.entries[0].rule, "scan.risky");
    assert.equal(preview.json.entries[0].line, 20);
    assert.match(preview.json.diff, /\+\+\+ b\/\.jgates\/waivers\.json/);
    assert.equal(bytes(p.project).toString("utf8"), original, "the preview leaves the file byte for byte as it was");

    const written = await call("POST", "/api/waivers", ask(FINDINGS[1]));
    assert.equal(written.status, 200, written.text);
    assert.equal(written.json.preview, false);
    assert.equal(written.json.waivers.waivers.length, 2, "the answer carries the updated list");
    const added = written.json.waivers.waivers.find((w) => w.kind === "occurrence");
    assert.equal(added.state, "live");
    assert.equal(added.id, written.json.entries[0].id);
    assert.ok(written.json.undo && typeof written.json.undo.expectedRevision === "string", "the answer carries what an undo needs");
    const afterWrite = bytes(p.project).toString("utf8");
    assert.notEqual(afterWrite, original);
    assert.equal(JSON.parse(afterWrite).waivers.length, 2);
    assert.equal((await call("GET", "/api/waivers")).json.waivers.length, 2, "the next read sees the new entry");

    const undone = await call("POST", "/api/waivers/undo", { undo: written.json.undo });
    assert.equal(undone.status, 200, undone.text);
    assert.equal(bytes(p.project).toString("utf8"), original, "undo restores the file byte for byte");
    assert.equal(undone.json.waivers.waivers.length, 1);

    // The same write once more, then removal of the new entry and the undo of the removal.
    const again = await call("POST", "/api/waivers", ask(FINDINGS[1]));
    assert.equal(again.status, 200, again.text);
    const id = again.json.entries[0].id;
    const withEntry = bytes(p.project).toString("utf8");
    const removed = await call("DELETE", `/api/waivers/${id}`);
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.json.removed.length, 1);
    assert.equal(removed.json.waivers.waivers.length, 1);
    assert.equal(bytes(p.project).toString("utf8"), original, "removing the entry gives the file back as it was");
    const restored = await call("POST", "/api/waivers/undo", { undo: removed.json.undo });
    assert.equal(restored.status, 200, restored.text);
    assert.equal(bytes(p.project).toString("utf8"), withEntry, "the undo of a removal restores the entry byte for byte");

    // A file that changed since the write is not overwritten by its undo.
    fs.appendFileSync(path.join(p.project, FILE), "\n");
    const stale = await call("POST", "/api/waivers/undo", { undo: removed.json.undo });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.json.code, "WAIVER_FILE_CHANGED");
  });
});

test("a missing file is created by the write and the undo removes it again", async () => {
  const p = setup();
  await withUi(p.env, p.project, async (call) => {
    assert.equal((await call("GET", "/api/waivers")).json.exists, false);
    const preview = await call("POST", "/api/waivers", ask(FINDINGS[0], { preview: true }));
    assert.equal(preview.json.created, true);
    assert.equal(bytes(p.project), null, "the preview creates nothing");
    const written = await call("POST", "/api/waivers", ask(FINDINGS[0]));
    assert.equal(written.status, 200, written.text);
    assert.deepEqual(Object.keys(JSON.parse(bytes(p.project).toString("utf8"))), ["waivers"]);
    const undone = await call("POST", "/api/waivers/undo", { undo: written.json.undo });
    assert.equal(undone.status, 200, undone.text);
    assert.equal(bytes(p.project), null, "the file did not exist before the write and does not after the undo");
  });
});

test("a missing date, a past date or a bad reason is refused with the message of the command, and nothing is written", async () => {
  const p = setup();
  const original = '{\n  "waivers": []\n}\n';
  fs.writeFileSync(path.join(p.project, FILE), original);
  await withUi(p.env, p.project, async (call) => {
    const cases = [
      ["no date", ask(FINDINGS[0], { until: undefined }), "WAIVER_UNTIL_REQUIRED", "An end date is required."],
      ["a past date", ask(FINDINGS[0], { until: "2020-01-01" }), "WAIVER_UNTIL_PAST", "2020-01-01 is in the past."],
      ["not a date", ask(FINDINGS[0], { until: "tomorrow" }), "WAIVER_UNTIL_INVALID", "tomorrow is not a date."],
      ["no reason", ask(FINDINGS[0], { reason: undefined }), "WAIVER_REASON_INVALID", "The reason is not valid"],
      ["a reason of 2 characters", ask(FINDINGS[0], { reason: "ab" }), "WAIVER_REASON_INVALID", "The reason is not valid"],
      ["a reason of 301 characters", ask(FINDINGS[0], { reason: "x".repeat(301) }), "WAIVER_REASON_INVALID", "The reason is not valid"],
      ["a reason with a control character", ask(FINDINGS[0], { reason: "bad\treason" }), "WAIVER_REASON_INVALID", "The reason is not valid"],
      ["no finding", ask(FINDINGS[0], { fingerprints: [] }), "WAIVER_FINDING_REQUIRED", "Name the finding to waive."],
      ["a finding that is not in the run", ask(FINDINGS[0], { fingerprints: ["0123456789ab"] }), "WAIVER_FINDING_NOT_FOUND", "no finding of the run"],
      ["a run that does not exist", ask(FINDINGS[0], { runId: "run_20200101T000000Z_00000000" }), "WAIVER_RUN_NOT_FOUND", "was not found"],
    ];
    for (const [name, body, code, text] of cases) {
      for (const preview of [true, false]) {
        const r = await call("POST", "/api/waivers", { ...body, preview });
        assert.ok(r.status >= 400 && r.status < 500, `${name}: ${r.status} ${r.text}`);
        assert.equal(r.json.status, "ERROR", name);
        assert.equal(r.json.code, code, name);
        assert.ok(r.json.message.includes(text), `${name}: ${r.json.message}`);
        assert.ok(r.json.fix, `${name}: the refusal says what to do`);
        assert.equal(bytes(p.project).toString("utf8"), original, `${name}: the file is untouched`);
      }
    }
    assert.equal((await call("DELETE", "/api/waivers/deadbeef")).json.code, "WAIVER_NOT_FOUND");
    assert.equal(bytes(p.project).toString("utf8"), original);
  });
});

test("a file that cannot be parsed is reported by the list and the review and is never rewritten", async () => {
  const p = setup();
  const bad = '{\n  "waivers": [\n    { "rule": "a.b", "reason": "broken"\n  ]\n}\n';
  fs.writeFileSync(path.join(p.project, FILE), bad);
  await withUi(p.env, p.project, async (call) => {
    const list = await call("GET", "/api/waivers");
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.json.waivers, []);
    assert.equal(list.json.problem.line, 4);
    const plan = await call("POST", "/api/plans", { preview: true });
    assert.equal(plan.status, 201, plan.text);
    assert.equal(plan.json.review.waivers.problem.line, 4, "the review reports the same problem");
    const write = await call("POST", "/api/waivers", ask(FINDINGS[0]));
    assert.equal(write.status, 422, write.text);
    assert.equal(write.json.code, "WAIVER_FILE_INVALID");
    assert.match(write.json.message, /line 4, column \d+/);
    assert.equal(bytes(p.project).toString("utf8"), bad);
  });
});

test("review.waivers of POST /api/plans is the list GET /api/waivers answers, with expired and stale entries marked", async () => {
  const p = setup();
  fs.writeFileSync(
    path.join(p.project, FILE),
    `${JSON.stringify({
      waivers: [
        { tool: "scanner", rule: "scan.risky", path: "src/app.js", fingerprint: FINDINGS[0].fingerprint, anchor: FINDINGS[0].anchor, occurrences: 3, line: 10, reason: "live one", created: "2026-11-01", expires: "2999-12-31" },
        { tool: "scanner", rule: "scan.risky", path: "src/app.js", fingerprint: FINDINGS[1].fingerprint, anchor: FINDINGS[1].anchor, occurrences: 3, line: 20, reason: "expired one", created: "2026-11-01", expires: "2020-01-01" },
        { tool: "scanner", rule: "scan.risky", path: "src/app.js", fingerprint: FINDINGS[2].fingerprint, anchor: `jga1:${"00".repeat(16)}`, occurrences: 3, line: 99, reason: "line moved", created: "2026-11-01", expires: "2999-12-31" },
        { rule: "hand.rule", path: "docs/*", reason: "hand written", expires: "2999-12-31" },
      ],
    }, null, 2)}\n`,
  );
  await withUi(p.env, p.project, async (call) => {
    const list = await call("GET", "/api/waivers");
    assert.deepEqual(
      list.json.waivers.map((w) => [w.state, w.matched, w.reason]),
      [
        ["live", true, "live one"],
        ["expired", false, "expired one"],
        ["stale", false, "line moved"],
        ["live", false, "hand written"],
      ],
    );
    const plan = await call("POST", "/api/plans", { preview: true });
    assert.equal(plan.status, 201, plan.text);
    const { schemaVersion, status, ...listing } = list.json;
    assert.deepEqual(plan.json.review.waivers, listing);
  });
});

test("in governed (read-only) mode POST and DELETE are refused with the reason and nothing is written; GET still answers", async () => {
  const p = setup();
  const original = '{\n  "waivers": [\n    { "rule": "x.y", "reason": "keep me" }\n  ]\n}\n';
  fs.writeFileSync(path.join(p.project, FILE), original);
  const outside = made("jg-waivers-policy-");
  const env = { ...p.env, JGATES_POLICY_DIR: outside, JGATES_POLICY_SHA256: "a".repeat(64) };
  await withUi(env, p.project, async (call) => {
    const id = (await call("GET", "/api/waivers")).json.waivers[0].id;
    const refused = [
      ["POST", "/api/waivers", ask(FINDINGS[0])],
      ["POST", "/api/waivers", ask(FINDINGS[0], { preview: true })],
      ["POST", "/api/waivers/undo", { undo: { file: FILE, expectedRevision: "0".repeat(64), previous: null } }],
      ["DELETE", `/api/waivers/${id}`],
    ];
    for (const [method, route, body] of refused) {
      const r = await call(method, route, body);
      assert.equal(r.status, 403, `${method} ${route}: ${r.text}`);
      assert.equal(r.json.code, "GOVERNED_LOCKED");
      assert.ok(r.json.message && r.json.fix, "the refusal gives the reason");
    }
    assert.equal(bytes(p.project).toString("utf8"), original);
    assert.equal((await call("GET", "/api/waivers")).status, 200);
  });
});

test("the routes call neither the engine nor git: the fake engine records no call for any of them", async () => {
  const p = setup();
  await withUi(p.env, p.project, async (call) => {
    const calls = path.join(p.engine, "calls.jsonl");
    const seen = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0);
    // The server may ask the engine for its own facts when it starts; only what the waiver routes add is measured.
    await call("GET", "/api/waivers");
    const baseline = seen();
    const written = await call("POST", "/api/waivers", ask(FINDINGS[2]));
    assert.equal(written.status, 200, written.text);
    await call("GET", "/api/waivers");
    await call("DELETE", `/api/waivers/${written.json.entries[0].id}`);
    assert.equal(seen(), baseline, "the waiver routes added no engine call");
  });
});
