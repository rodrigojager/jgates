import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// The local server answers while the engine is slow (ADR-0010, PLAN-performance.md P1 and P6). The engine is the fake
// one (tests/docker/fake-docker.cjs) behind a wrapper that sleeps FAKE_DOCKER_DELAY_MS before every call. The server
// process loads a guard that wraps child_process.spawnSync / execFileSync / execSync (and records the asynchronous Git
// status runs): no GET of the screens may reach a synchronous `docker` or `git` process, and a cheap request answers
// within 200 ms while the slow ones wait on the engine.

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(here, "..", "dist", "cli", "main.js");
const FAKE = path.join(here, "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.resolve(here, "..", "..", "package.json"), "utf8")).version;
const PINNED = `registry.example.test/jgates/jgates-tools@sha256:${"ab".repeat(32)}`;
const DELAY_MS = 3000;
const CHEAP_MS = 200;

const dirs = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
const made = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

function request(port, method, p, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = http.request({ host: "127.0.0.1", port, method, path: p, agent: false, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
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
    req.end();
  });
}

function startUi(env, cwd, guard) {
  const proc = spawn(process.execPath, ["--import", pathToFileURL(guard).href, MAIN, "ui", "--cwd", cwd, "--no-open", "--port", "0", "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
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
  return (p) => request(port, "GET", p, { headers: { Cookie: cookie } });
}

/** Loaded with --import into the server: records every synchronous spawn, and every asynchronous `git status`. */
const GUARD = `import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const log = process.env.JG_SPAWN_LOG;
const record = (name, file, rest) => {
  const args = Array.isArray(rest[0]) ? rest[0].map(String) : [];
  fs.appendFileSync(log, JSON.stringify({ name, file: String(file), args: args.slice(0, 12), stack: new Error().stack.split("\\n").slice(2, 9).join("\\n") }) + "\\n");
};
for (const name of ["spawnSync", "execFileSync", "execSync"]) {
  const original = cp[name];
  cp[name] = function (file, ...rest) {
    record(name, file, rest);
    return original.call(this, file, ...rest);
  };
}
const spawnAsync = cp.spawn;
cp.spawn = function (file, ...rest) {
  if (Array.isArray(rest[0]) && rest[0].includes("status") && /git(\\.exe)?$/i.test(String(file))) record("spawn", file, rest);
  return spawnAsync.call(this, file, ...rest);
};
syncBuiltinESMExports();
`;

/**
 * The fake engine behind a switchable delay (the file delay-ms in its state folder, read at every call) and a switchable
 * daemon (the file stopped). The tools image of this version is there, so the plan and the status read everything.
 */
function wrapper(engine) {
  return `const fs = require("node:fs");
const path = require("node:path");
const state = ${JSON.stringify(engine)};
process.env.FAKE_DOCKER_STATE = state;
process.env.FAKE_DOCKER_LOG = path.join(state, "calls.jsonl");
process.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))};
if (fs.existsSync(path.join(state, "stopped"))) process.env.FAKE_DOCKER_DAEMON = "stopped";
const file = path.join(state, "delay-ms");
const delay = Number(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : process.env.FAKE_DOCKER_DELAY_MS || 0);
if (delay > 0) {
  fs.appendFileSync(path.join(state, "asked.jsonl"), JSON.stringify(process.argv.slice(2, 4)) + "\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}
require(${JSON.stringify(FAKE)});
`;
}

const entries = (file) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** The engine and Git processes among the recorded spawns: `git`, `docker`, or node running the engine script. */
function engineOrGit(record, runtime) {
  const base = path.basename(record.file).toLowerCase();
  if (/^git(\.exe)?$/.test(base) || /^docker(\.exe)?$/.test(base)) return true;
  return record.file === process.execPath && record.args[0] === runtime;
}

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "user.name=JGates Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

test("a slow engine never blocks the server: cheap requests answer at once and no GET spawns docker or git synchronously", { timeout: 300_000 }, async (t) => {
  const home = made("jg-resp-home-");
  const project = made("jg-resp-proj-");
  const engine = made("jg-resp-engine-");
  const runtime = path.join(engine, "docker.cjs");
  const guard = path.join(engine, "guard.mjs");
  const spawns = path.join(engine, "spawns.jsonl");
  fs.writeFileSync(runtime, wrapper(engine));
  fs.writeFileSync(guard, GUARD);
  const env = {
    ...process.env,
    JGATES_HOME: home,
    JGATES_CONTAINER_RUNTIME: runtime,
    JGATES_IMAGE_JSON: "",
    JGATES_TOOLS_IMAGE: PINNED,
    JGATES_NO_CACHE: "1",
    JGATES_LOCALE: "en",
    NO_COLOR: "1",
    JGATES_POLICY_DIR: "",
    JGATES_POLICY_SHA256: "",
    JG_SPAWN_LOG: spawns,
  };

  // A small Python project in a Git repository with one commit (a clean tree).
  fs.writeFileSync(path.join(project, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(project, "app.py"), "def add(a, b):\n    return a + b\n");
  const init = spawnSync(process.execPath, [MAIN, "init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"], { env, encoding: "utf8", timeout: 120_000 });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  git(project, "init", "-q", "-b", "main");
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "initial");
  // A prepared machine: the advisory data and CodeQL volumes exist with their status files (every engine read works).
  const now = new Date().toISOString();
  const managed = (kind) => ({ "org.jgates.managed": "true", "org.jgates.kind": kind, "org.jgates.version": CLI_VERSION });
  fs.writeFileSync(path.join(engine, "objects.json"), JSON.stringify({ containers: [], volumes: [{ name: "jgates-data", labels: managed("data") }, { name: "jgates-codeql", labels: managed("toolchain") }], networks: [], images: [] }));
  for (const [volume, file, doc] of [
    ["jgates-data", "jgates-data.json", { schemaVersion: 1, databases: Object.fromEntries(["trivy", "osv", "govulndb", "rustsec"].map((id) => [id, { fetchedAt: now, source: "test" }])) }],
    ["jgates-codeql", "jgates-codeql.json", { schemaVersion: 1, version: "2.18.4", sha256: "ab".repeat(32), bytes: 1, source: "test", termsAcceptedAt: now, preparedAt: now }],
  ]) {
    fs.mkdirSync(path.join(engine, "volumes", volume), { recursive: true });
    fs.writeFileSync(path.join(engine, "volumes", volume, file), JSON.stringify(doc));
  }

  // The server starts with the daemon stopped: the screens are computed once (nothing is kept from an engine that does
  // not answer), so the code is loaded before the measures.
  fs.writeFileSync(path.join(engine, "stopped"), "");
  let ui = null;
  try {
    ui = await startUi(env, project, guard);
    const get = await session(ui);
    const from = entries(spawns).length;
    const SLOW = ["/api/overview", "/api/environment/state", "/api/prerequisites", "/api/environment", "/api/config/profile", "/api/storage"];
    for (const p of [...SLOW, "/api/tools", "/api/shell"]) assert.equal((await get(p)).status, 200, p);
    const index = fs.readFileSync(path.resolve(here, "..", "dist", "ui", "index.html"), "utf8");
    const asset = /(?:src|href)="(\/assets\/[^"]+\.js)"/.exec(index)?.[1];
    assert.ok(asset, "the built UI names a script asset");
    assert.equal((await get(asset)).status, 200, asset);

    // 1. The daemon answers now, after DELAY_MS on every call. The screens' GETs wait on it; cheap requests do not.
    fs.rmSync(path.join(engine, "stopped"));
    fs.writeFileSync(path.join(engine, "delay-ms"), String(DELAY_MS));
    const settled = new Map();
    // Settled with the answer or the error (never an unhandled rejection that would hide the failing assertion).
    const slow = SLOW.map((p) => {
      const pending = get(p).then(
        (r) => {
          settled.set(p, r);
          return r;
        },
        (error) => {
          settled.set(p, { status: 0, text: String(error) });
          return settled.get(p);
        },
      );
      return [p, pending];
    });
    const sample = async (startedAt) => {
      const waiting = SLOW.filter((p) => !settled.has(p));
      const tools = await get("/api/tools");
      const file = await get(asset);
      assert.equal(tools.status, 200, tools.text);
      assert.equal(file.status, 200);
      return { at: Math.round(performance.now() - startedAt), tools: Math.round(tools.ms), asset: Math.round(file.ms), waiting };
    };
    const startedAt = performance.now();
    // a. Once every screen has asked the engine its first questions (the wrapper notes each question before it sleeps,
    // and no new one comes for 300 ms), the screens wait: no answer can come before DELAY_MS after the first question.
    // Meanwhile the server has nothing else to do, so cheap requests answer within CHEAP_MS. (Before ADR-0010 they
    // waited behind the first synchronous engine call, DELAY_MS.)
    const askedFile = path.join(engine, "asked.jsonl");
    let firstAsked = null;
    let lastCount = 0;
    let stableSince = performance.now();
    while (performance.now() - startedAt < DELAY_MS) {
      await new Promise((r) => setTimeout(r, 20));
      const count = entries(askedFile).length;
      if (count > 0 && firstAsked === null) firstAsked = performance.now();
      if (count !== lastCount) {
        lastCount = count;
        stableSince = performance.now();
      } else if (count > 0 && performance.now() - stableSince >= 300) break;
    }
    assert.ok(firstAsked !== null, "the screens asked the engine");
    const first = [];
    while (performance.now() - firstAsked < DELAY_MS - 400) {
      first.push(await sample(startedAt));
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(first.length >= 3, `cheap requests were measured while the screens waited: ${JSON.stringify(first)}`);
    for (const s of first) {
      for (const p of ["/api/overview", "/api/environment/state", "/api/prerequisites"]) assert.ok(s.waiting.includes(p), `${p} was in flight at ${s.at} ms: ${JSON.stringify(first)}`);
      assert.ok(s.tools < CHEAP_MS, `GET /api/tools took ${s.tools} ms while the screens waited on the engine: ${JSON.stringify(first)}`);
      assert.ok(s.asset < CHEAP_MS, `GET ${asset} took ${s.asset} ms while the screens waited on the engine: ${JSON.stringify(first)}`);
    }
    // b. Until the last screen is done, a cheap request never waits for an engine call: at most for one screen's own
    // computation, which takes turns with the other requests.
    const later = [];
    while (performance.now() - startedAt < 120_000 && SLOW.some((p) => !settled.has(p))) {
      await new Promise((r) => setTimeout(r, 400));
      later.push(await sample(startedAt));
    }
    for (const s of later) assert.ok(s.tools < DELAY_MS / 2 && s.asset < DELAY_MS / 2, `a cheap request waited on the engine: ${JSON.stringify(later)}`);
    const slowest = (list) => Math.max(0, ...list.flatMap((s) => [s.tools, s.asset]));
    t.diagnostic(`cheap requests: slowest ${slowest(first)} ms while every screen waited on the engine (${first.length} samples), ${slowest(later)} ms until the last screen answered (${later.length} samples)`);
    for (const [p, pending] of slow) {
      const r = await pending;
      assert.equal(r.status, 200, `${p}: ${r.text}`);
    }
    const overview = settled.get("/api/overview").json;
    assert.ok(overview.discovery && overview.plan, settled.get("/api/overview").text);
    const state = settled.get("/api/environment/state").json;
    assert.equal(state.sections.engine.state, "ready", JSON.stringify(state.sections.engine));
    assert.equal(state.sections.image.state, "ready", JSON.stringify(state.sections.image));

    // 2. Warm: the same screens answer from the facts the slow requests left, without waiting on the engine again.
    for (const p of SLOW) {
      const r = await get(p);
      assert.equal(r.status, 200, `${p}: ${r.text}`);
      assert.ok(r.ms < DELAY_MS, `warm ${p} took ${Math.round(r.ms)} ms: it waited on the engine`);
    }

    // 3. Git: the periodic shell read (git=cached) never starts Git; the read on load, focus and after an action asks
    // for a new status.
    const clean = await get("/api/shell");
    assert.equal(clean.status, 200, clean.text);
    assert.equal(clean.json.git.branch, "main");
    assert.equal(clean.json.git.dirty, false, clean.text);
    fs.writeFileSync(path.join(project, "new.py"), "x = 1\n");
    const statusRuns = () => entries(spawns).filter((e) => e.name === "spawn").length;
    const before = statusRuns();
    const polled = await get("/api/shell?git=cached");
    assert.equal(polled.json.git.dirty, false, "the periodic read shows the last status");
    assert.equal(statusRuns(), before, "the periodic read did not run git status");
    const refreshed = await get("/api/shell");
    assert.equal(refreshed.json.git.dirty, true, refreshed.text);
    assert.equal(statusRuns(), before + 1, "a refresh runs git status once, asynchronously");

    // 4. Not one synchronous docker or git process during all of it.
    const offending = entries(spawns)
      .slice(from)
      .filter((e) => e.name !== "spawn" && engineOrGit(e, runtime));
    assert.deepEqual(offending, [], `synchronous engine or Git processes in request handlers:\n${offending.map((e) => `${e.name} ${e.file} ${e.args.join(" ")}\n${e.stack}`).join("\n\n")}`);
    // The engine was asked (asynchronously) while the screens were computed.
    assert.ok(entries(path.join(engine, "calls.jsonl")).some((c) => c[0] === "info"), "the engine was asked");
  } finally {
    if (ui && ui.proc.exitCode === null) {
      const exited = once(ui.proc, "exit");
      ui.proc.kill("SIGTERM");
      await exited;
    }
  }
});

test("the engine facts: synchronous reads come from the cache, failures and stale answers are asked again, and the CLI path is unchanged", async () => {
  const engine = made("jg-facts-engine-");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(runtime, wrapper(engine));
  const managed = { "org.jgates.managed": "true", "org.jgates.kind": "data", "org.jgates.version": CLI_VERSION };
  fs.writeFileSync(path.join(engine, "objects.json"), JSON.stringify({ containers: [], volumes: [{ name: "jgates-data", labels: managed }], networks: [], images: [] }));
  fs.mkdirSync(path.join(engine, "volumes", "jgates-data"), { recursive: true });
  fs.writeFileSync(path.join(engine, "volumes", "jgates-data", "jgates-data.json"), JSON.stringify({ schemaVersion: 1, databases: { osv: { fetchedAt: "2026-11-01T00:00:00.000Z", source: "test" } } }));
  const env = { ...process.env, JGATES_IMAGE_JSON: "", JGATES_CONTAINER_RUNTIME: runtime, JGATES_TOOLS_IMAGE: PINNED };
  const context = { runnerOptions: { parentEnv: env } };

  // Every synchronous engine process of this test process is counted.
  const cp = (await import("node:child_process")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const original = cp.spawnSync;
  let syncCalls = 0;
  cp.spawnSync = function (file, args, ...rest) {
    if (Array.isArray(args) && args[0] === runtime) syncCalls++;
    return original.call(this, file, args, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const dist = (p) => pathToFileURL(path.resolve(here, "..", "dist", p)).href;
    const { withEngineFacts, invalidateEngineFacts } = await import(dist("core/engine/facts.js"));
    const { inspectImageSync, engineCommandSync, detectEngineSync } = await import(dist("core/engine/index.js"));
    const { readDataStatusSync } = await import(dist("core/data/index.js"));
    const asked = (verb) => entries(path.join(engine, "calls.jsonl")).filter((c) => c.slice(0, verb.length).join(" ") === verb.join(" ")).length;
    const inspect = () => inspectImageSync(PINNED, context);

    // The first read probes asynchronously (the computation runs again with the answer); the next one is cached.
    const first = await withEngineFacts(inspect);
    assert.equal(first.labels["org.jgates.version"], CLI_VERSION);
    assert.equal(asked(["image", "inspect"]), 1);
    assert.deepEqual(await withEngineFacts(inspect), first);
    assert.equal(asked(["image", "inspect"]), 1, "a fresh answer is not asked again");
    assert.equal(syncCalls, 0, "no synchronous engine process inside withEngineFacts");

    // A chain of reads (image, volume, helper container) settles in as many rounds as it needs.
    const data = await withEngineFacts(() => readDataStatusSync(env, CLI_VERSION));
    assert.equal(data.state, "ok", JSON.stringify(data));
    assert.equal(data.status.databases.osv.fetchedAt, "2026-11-01T00:00:00.000Z");
    assert.equal(syncCalls, 0);

    // A failure (a volume that is not there) is asked again at the next request: the person may create it meanwhile.
    const missing = () => engineCommandSync(["volume", "inspect", "--format", "{{.Name}}", "jgates-nothing"], context);
    const volumes = asked(["volume", "inspect"]);
    assert.notEqual((await withEngineFacts(missing)).exitCode, 0);
    assert.notEqual((await withEngineFacts(missing)).exitCode, 0);
    assert.equal(asked(["volume", "inspect"]) - volumes, 2, "the missing volume was asked twice");

    // "Check again" and an invalidation ask anew.
    let images = asked(["image", "inspect"]);
    await withEngineFacts(inspect, { fresh: true });
    assert.ok(asked(["image", "inspect"]) > images, "check again asks the engine");
    images = asked(["image", "inspect"]);
    invalidateEngineFacts();
    await withEngineFacts(inspect);
    assert.ok(asked(["image", "inspect"]) > images, "an invalidation makes the next read ask the engine");

    // A stopped engine drops every answer: once it answers again, the image is asked again.
    fs.writeFileSync(path.join(engine, "stopped"), "");
    assert.equal((await withEngineFacts(() => detectEngineSync({ requiredMemoryMb: 0, requiredDiskMb: 0 }, context))).code, "ENGINE_STOPPED");
    fs.rmSync(path.join(engine, "stopped"));
    assert.equal((await withEngineFacts(() => detectEngineSync({ requiredMemoryMb: 0, requiredDiskMb: 0 }, context))).code, null, "a started engine shows at the next read");
    images = asked(["image", "inspect"]);
    await withEngineFacts(inspect);
    assert.ok(asked(["image", "inspect"]) > images, "nothing the stopped engine said was kept");
    assert.equal(syncCalls, 0);

    // Outside withEngineFacts (the CLI) the read is the synchronous one, as before.
    assert.deepEqual(inspect(), first);
    assert.equal(syncCalls, 1);
  } finally {
    cp.spawnSync = original;
    syncBuiltinESMExports();
  }
});

test("the PATH refresh of the request handlers reads the registry asynchronously, once per window, one read at a time", async () => {
  const { refreshPathAsync, resetPathRefreshCache } = await import(pathToFileURL(path.resolve(here, "..", "dist", "core", "env-refresh", "index.js")).href);
  resetPathRefreshCache();
  const env = { Path: "C:\\old", SystemRoot: "C:\\Windows" };
  let reads = 0;
  const reader = async (hive) => {
    reads++;
    await new Promise((r) => setTimeout(r, 20));
    return hive === "machine" ? "%SystemRoot%\\system32" : "C:\\userbin";
  };
  const [a, b] = await Promise.all([refreshPathAsync({ platform: "win32", env, reader, now: () => 1 }), refreshPathAsync({ platform: "win32", env, reader, now: () => 2 })]);
  assert.equal(a, true);
  assert.equal(b, true, "a second request joins the read in progress");
  assert.equal(reads, 2, "one read of each hive");
  assert.equal(env.Path, "C:\\old;C:\\Windows\\system32;C:\\userbin");
  assert.equal(env.PATH, env.Path);
  assert.equal(await refreshPathAsync({ platform: "win32", env, reader, now: () => 3 }), false, "inside the cache window nothing is read");
  assert.equal(await refreshPathAsync({ platform: "win32", env, reader, now: () => 4, force: true }), true, "a check again reads it at once");
  assert.equal(reads, 4);
  assert.equal(await refreshPathAsync({ platform: "linux", env, reader }), false);
  resetPathRefreshCache();
});
