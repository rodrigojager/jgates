import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-80 (fake engine, server): the project's waivers through the local server and through the terminal give the same
// answers (PLAN-waivers.md sections 5 and 6). GET /api/waivers and `jgates waivers list --json` return the same entries and
// states; POST /api/waivers with `preview: true` answers with the entry and the diff of .jgates/waivers.json and leaves the
// file byte for byte as it was; the write answers with the updated list and the undo data, and the undo restores the file
// byte for byte; DELETE /api/waivers/<id> removes one entry and its undo restores it. A run started by POST /api/runs and
// one started by `jgates run` on the same project give the same waived findings, the same `waivers` block and the same
// wording, and `review.waivers` of POST /api/plans is what that run then applies (live, expired and stale entries marked,
// and the problem of the file when there is one). The fake engine sleeps 3 s before every call (the delay switch of V2-64):
// no route of this case waits on it, so every answer arrives within the limits of V2-64.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = path.join(root, "jgates", "dist");
const MAIN = path.join(DIST, "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const { approvalWording } = await import(pathToFileURL(path.join(DIST, "core", "results", "index.js")).href);
const PINNED = `registry.example.test/jgates/jgates-tools@sha256:${"ef".repeat(32)}`;
const CPF = "529.982.247-25";
const FILE = ".jgates/waivers.json";
const DELAY_MS = 3000;
const WRITE_MS = 500;
const CHEAP_MS = 200;

const made = [];
const tmp = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function request(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
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
        resolve({ status: res.statusCode, text, json, ms: performance.now() - started });
      });
    });
    req.on("error", (error) => reject(new Error(`${method} ${p} after ${Math.round(performance.now() - started)} ms: ${error.message}`)));
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

async function session(ui) {
  assert.ok(ui.info.launcher, `jgates ui did not start: ${ui.out}\n${ui.err}`);
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
  return (method, p, body) => request(port, method, p, { headers: method === "GET" ? { Cookie: cookie } : { Cookie: cookie, Origin: origin, "X-JGates-CSRF": s.json.csrfToken }, body });
}

/** The fake engine behind the delay switch (the file delay-ms in its state folder, read at every call). */
function wrapper(engine) {
  return `const fs = require("node:fs");
const path = require("node:path");
const state = ${JSON.stringify(engine)};
process.env.FAKE_DOCKER_STATE = state;
process.env.FAKE_DOCKER_LOG = path.join(state, "calls.jsonl");
process.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": VERSION }))};
const file = path.join(state, "delay-ms");
const delay = Number(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : 0);
if (delay > 0) {
  fs.appendFileSync(path.join(state, "asked.jsonl"), JSON.stringify(process.argv.slice(2, 4)) + "\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}
require(${JSON.stringify(FAKE)});
`;
}

/** A git project with a formatted CPF (the fake engine "detects" it, as V2-61 and V2-78 do), initialised for JGates. */
function setup() {
  const dir = tmp("v2-80-");
  const home = path.join(dir, "home");
  const project = path.join(dir, "project");
  const engine = path.join(dir, "engine");
  const runtime = path.join(engine, "docker.cjs");
  for (const d of [home, project, engine, path.join(project, "src"), path.join(project, "data")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(runtime, wrapper(engine));
  fs.writeFileSync(path.join(engine, "objects.json"), JSON.stringify({ containers: [], volumes: [], networks: [], images: [] }));
  fs.writeFileSync(path.join(project, "src", "app.py"), "def add(a, b):\n    return a + b\n");
  fs.writeFileSync(path.join(project, "data", "customers.csv"), `name,cpf\nAna,${CPF}\n`);
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: PINNED, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" };
  delete env.JGATES_PYTHON;
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  const cli = (args) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout: 240_000 });
  const init = cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const json = (args) => {
    const r = cli(args);
    try {
      return { status: r.status, doc: JSON.parse(r.stdout), out: r.stdout, err: r.stderr };
    } catch {
      assert.fail(`no JSON from ${args.join(" ")}: ${r.stdout}\n${r.stderr}`);
    }
  };
  const run = (...extra) => json(["run", "--cwd", project, "--no-interactive", "--only", "tool:builtin-pii", "--json", ...extra]);
  return { dir, home, project, engine, env, cli, json, run, file: path.join(project, FILE) };
}

const text = (p) => (fs.existsSync(p.file) ? fs.readFileSync(p.file, "utf8") : null);
const waivedView = (result) =>
  result.findings
    .map((f) => ({ rule: f.ruleId, path: f.location?.path ?? null, waived: f.waived === true, reason: f.waiverReason ?? null, source: f.waiverSource ?? null, expires: f.waiverExpires ?? null, blocking: f.blocking }))
    .sort((a, b) => `${a.rule}${a.path}`.localeCompare(`${b.rule}${b.path}`));
const blockOf = (w) => structuredClone(w);

/** Starts a run through the routes (a plan, then POST /api/runs) and returns its stored result once it ended. */
async function serverRun(call) {
  const plan = await call("POST", "/api/plans", { only: ["tool:builtin-pii"] });
  assert.equal(plan.status, 201, plan.text);
  const start = await call("POST", "/api/runs", { planHash: plan.json.planHash });
  assert.equal(start.status, 202, start.text);
  const jobId = start.json.run.id;
  const deadline = Date.now() + 180_000;
  let job = start.json.run;
  while (job.state === "running" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    job = (await call("GET", `/api/runs/${jobId}`)).json.run;
  }
  assert.notEqual(job.state, "running", "the run through the server ended");
  assert.ok(job.runId, JSON.stringify(job));
  const stored = await call("GET", `/api/runs/${job.runId}`);
  assert.equal(stored.status, 200, stored.text);
  return { review: plan.json.review, result: stored.json.result, job };
}

test("V2-80: the routes and the CLI return the same list; the preview writes nothing; the write and the removal come with an undo; a run through the server equals a run of the CLI", { timeout: 900_000 }, async (t) => {
  const p = setup();
  const first = p.run();
  assert.equal(first.status, 1, first.out + first.err);
  const cpf = first.doc.findings.find((f) => f.ruleId === "pii.cpf");
  assert.ok(cpf, JSON.stringify(first.doc.findings));
  assert.equal(cpf.waived, false);
  const short = cpf.fingerprint.replace(/^jgf1:/, "").slice(0, 12);

  let ui = null;
  try {
    ui = await startUi(p.env, p.project);
    const call = await session(ui);

    // The list: the routes and `jgates waivers list --json` answer the same, with nothing in the file and with entries.
    const same = async (label) => {
      const api = await call("GET", "/api/waivers");
      assert.equal(api.status, 200, api.text);
      const cli = p.json(["waivers", "list", "--cwd", p.project, "--json"]);
      assert.equal(cli.status, 0, cli.out + cli.err);
      for (const key of ["file", "exists", "revision", "runId", "waivers"]) assert.deepEqual(api.json[key], cli.doc[key], `${label}: ${key}`);
      return api.json;
    };
    assert.equal((await same("no file")).exists, false);

    // Preview: the entry and the diff of the file; the file is byte for byte as it was (here: not there at all).
    const body = { runId: first.doc.runId, fingerprints: [short], until: "2999-12-31", reason: "sample data" };
    const preview = await call("POST", "/api/waivers", { ...body, preview: true });
    assert.equal(preview.status, 200, preview.text);
    assert.equal(preview.json.preview, true);
    assert.equal(preview.json.entries[0].rule, "pii.cpf");
    assert.match(preview.json.diff, /\+\+\+ b\/\.jgates\/waivers\.json/);
    assert.equal(text(p), null, "the preview created nothing");

    // Write: the updated list and the undo data; the undo restores the file byte for byte (it did not exist).
    const written = await call("POST", "/api/waivers", body);
    assert.equal(written.status, 200, written.text);
    assert.equal(written.json.waivers.waivers.length, 1);
    assert.equal(written.json.waivers.waivers[0].id, written.json.entries[0].id);
    assert.ok(written.json.undo);
    const afterWrite = text(p);
    assert.equal(JSON.parse(afterWrite).waivers.length, 1);
    assert.equal((await same("one entry")).waivers[0].state, "live");
    const undone = await call("POST", "/api/waivers/undo", { undo: written.json.undo });
    assert.equal(undone.status, 200, undone.text);
    assert.equal(text(p), null, "the undo restores the file byte for byte");

    // Write again: the same request writes the same bytes.
    const second = await call("POST", "/api/waivers", body);
    assert.equal(second.status, 200, second.text);
    const id = second.json.entries[0].id;
    assert.equal(text(p), afterWrite, "the same request writes the same bytes");

    // Removal: one entry out, the undo puts it back byte for byte.
    const removed = await call("DELETE", `/api/waivers/${id}`);
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual(JSON.parse(text(p)).waivers, []);
    assert.equal(removed.json.waivers.waivers.length, 0);
    const restored = await call("POST", "/api/waivers/undo", { undo: removed.json.undo });
    assert.equal(restored.status, 200, restored.text);
    assert.equal(text(p), afterWrite, "the undo of the removal restores the entry byte for byte");

    // The run: through the server and through the CLI on the same project, with a live entry, an expired one and a stale one.
    const doc = JSON.parse(text(p));
    doc.waivers.push({ ...doc.waivers[0], reason: "old decision", expires: "2020-01-01" });
    doc.waivers.push({ ...doc.waivers[0], reason: "count changed", occurrences: 5 });
    fs.writeFileSync(p.file, `${JSON.stringify(doc, null, 2)}\n`);
    const review = (await call("POST", "/api/plans", { only: ["tool:builtin-pii"], preview: true })).json.review.waivers;
    assert.deepEqual(
      review.waivers.map((w) => [w.state, w.reason]),
      [["live", "sample data"], ["expired", "old decision"], ["stale", "count changed"]],
      "the review marks live, expired and stale entries",
    );
    assert.equal(review.problem, undefined);

    const viaServer = await serverRun(call);
    const viaCli = p.run();
    const a = viaServer.result;
    const b = viaCli.doc;
    assert.deepEqual(waivedView(a), waivedView(b), "the same waived findings");
    assert.equal(waivedView(a).find((f) => f.rule === "pii.cpf").waived, true);
    assert.deepEqual(blockOf(a.waivers), blockOf(b.waivers), "the same waivers block");
    assert.equal(a.waivers.count, 1);
    // What the review listed is what the run applied: one live entry applied, one expired, one stale.
    assert.equal(a.waivers.count, review.waivers.filter((w) => w.state === "live" && w.matched).length);
    assert.equal(a.waivers.expired.length, review.waivers.filter((w) => w.state === "expired").length);
    assert.equal(a.waivers.stale.length, review.waivers.filter((w) => w.state === "stale").length);
    assert.deepEqual(approvalWording(a), approvalWording(b), "the same wording");
    assert.equal(approvalWording(a).kind, "with-waivers");
    assert.equal(a.decision, b.decision);
    const text80 = p.cli(["run", "--cwd", p.project, "--no-interactive", "--only", "tool:builtin-pii"]);
    assert.match(text80.stdout, /approved with 1 waiver/, text80.stdout);

    // A file that cannot be parsed: the review says so, the run says so, and the findings stay active.
    fs.writeFileSync(p.file, '{ "waivers": [ { "rule": "a.b" ');
    const reviewBad = (await call("POST", "/api/plans", { only: ["tool:builtin-pii"], preview: true })).json.review.waivers;
    assert.ok(reviewBad.problem, "the review reports the file problem");
    const badServer = await serverRun(call);
    const badCli = p.run();
    assert.ok(badServer.result.waivers.problem && badCli.doc.waivers.problem, "both runs report the file problem");
    assert.deepEqual(waivedView(badServer.result), waivedView(badCli.doc));
    assert.equal(waivedView(badCli.doc).find((f) => f.rule === "pii.cpf").waived, false);
    fs.writeFileSync(p.file, afterWrite);

    // The engine is now slow (3 s per call): the screens that need it wait, and no waiver route does.
    fs.writeFileSync(path.join(p.engine, "delay-ms"), String(DELAY_MS));
    const slow = call("GET", "/api/overview").then(
      (r) => r,
      (error) => ({ status: 0, text: String(error) }),
    );
    const asked = path.join(p.engine, "asked.jsonl");
    const startedAt = performance.now();
    while (!fs.existsSync(asked) && performance.now() - startedAt < DELAY_MS) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(asked), "the overview asked the engine");

    const timed = [];
    const within = (label, r, limit) => {
      timed.push({ label, ms: Math.round(r.ms) });
      assert.ok(r.ms < limit, `${label} took ${Math.round(r.ms)} ms while the engine was slow: ${JSON.stringify(timed)}`);
    };
    const list = await call("GET", "/api/waivers");
    within("list", list, CHEAP_MS);
    assert.equal(list.status, 200, list.text);
    const pv = await call("POST", "/api/waivers", { ...body, reason: "another reason", preview: true });
    within("preview", pv, WRITE_MS);
    // The entry is already in the file: the preview says so, quickly, and writes nothing.
    assert.equal(pv.status, 409, pv.text);
    assert.equal(pv.json.code, "WAIVER_ALREADY_EXISTS");
    const del = await call("DELETE", `/api/waivers/${id}`);
    within("delete", del, WRITE_MS);
    assert.equal(del.status, 200, del.text);
    const undo = await call("POST", "/api/waivers/undo", { undo: del.json.undo });
    within("undo", undo, WRITE_MS);
    assert.equal(undo.status, 200, undo.text);
    assert.equal(text(p), afterWrite);
    const add = await call("POST", "/api/waivers", { ...body, runId: first.doc.runId, fingerprints: [short], reason: "x".repeat(10) });
    within("write", add, WRITE_MS);
    // The entry is already in the file, so the write is refused (still quickly, and with nothing changed).
    assert.equal(add.status, 409, add.text);
    assert.equal(add.json.code, "WAIVER_ALREADY_EXISTS");
    assert.equal(text(p), afterWrite);
    t.diagnostic(`waiver routes while the engine took ${DELAY_MS} ms per call: ${JSON.stringify(timed)}`);
    // The screens that need the engine were still waiting while every waiver route answered.
    const settled = await Promise.race([slow.then(() => true), new Promise((r) => setTimeout(() => r(false), 0))]);
    assert.equal(settled, false, "the overview was still waiting on the engine");
  } finally {
    if (ui && ui.proc.exitCode === null) {
      const exited = once(ui.proc, "exit");
      ui.proc.kill("SIGTERM");
      await exited;
    }
  }
});
