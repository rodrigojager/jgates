import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-64 (fake engine): profile actions answer at once while the engine is slow (PLAN-performance.md P2-P5, ADR-0010).
// The fake engine sleeps 3 s before every call (the delay switch of jgates/tests/server-responsive.test.js). With screens
// waiting on it (the overview and the plan part of the Perfil screen), each profile action (create, rename, make default,
// delete) answers within 500 ms with the updated Perfil view and the updated list in its answer, and a cheap request sent
// together with each action answers within 200 ms.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const PINNED = `registry.example.test/jgates/jgates-tools@sha256:${"ef".repeat(32)}`;
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

test("V2-64: with a 3 s engine, profile create, rename, make default and delete answer within 500 ms with the updated view, and a cheap request within 200 ms", { timeout: 300_000 }, async (t) => {
  const dir = tmp("v2-64-");
  const home = path.join(dir, "home");
  const project = path.join(dir, "project");
  const engine = path.join(dir, "engine");
  const runtime = path.join(engine, "docker.cjs");
  for (const d of [home, project, engine]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(runtime, wrapper(engine));
  fs.writeFileSync(path.join(engine, "objects.json"), JSON.stringify({ containers: [], volumes: [], networks: [], images: [] }));
  const env = {
    ...process.env,
    JGATES_HOME: home,
    JGATES_CONTAINER_RUNTIME: runtime,
    JGATES_IMAGE_JSON: "",
    JGATES_TOOLS_IMAGE: PINNED,
    JGATES_LOCALE: "en",
    NO_COLOR: "1",
    JGATES_POLICY_DIR: "",
    JGATES_POLICY_SHA256: "",
  };
  fs.writeFileSync(path.join(project, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(project, "app.py"), "def add(a, b):\n    return a + b\n");
  const init = spawnSync(process.execPath, [MAIN, "init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"], { env, encoding: "utf8", timeout: 120_000 });
  assert.equal(init.status, 0, init.stdout + init.stderr);

  let ui = null;
  try {
    ui = await startUi(env, project);
    const call = await session(ui);
    // The code of the screens is loaded once before the measures (the engine answers at once here).
    for (const p of ["/api/config/profile", "/api/profiles", "/api/tools"]) assert.equal((await call("GET", p)).status, 200, p);

    // The engine now takes 3 s for every call: the screens that need it wait.
    fs.writeFileSync(path.join(engine, "delay-ms"), String(DELAY_MS));
    const settled = new Set();
    const slow = ["/api/overview", "/api/config/profile/plan"].map((p) => {
      const pending = call("GET", p).then(
        (r) => (settled.add(p), r),
        (error) => (settled.add(p), { status: 0, text: String(error) }),
      );
      return [p, pending];
    });
    const asked = path.join(engine, "asked.jsonl");
    const startedAt = performance.now();
    while (!fs.existsSync(asked) && performance.now() - startedAt < DELAY_MS) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(asked), "the screens asked the engine");

    const measured = [];
    /** One profile action sent together with a cheap request; both are timed. */
    const act = async (label, method, p, body, check) => {
      const [write, cheap] = await Promise.all([call(method, p, body), call("GET", "/api/tools")]);
      measured.push({ label, write: Math.round(write.ms), cheap: Math.round(cheap.ms), waiting: ["/api/overview", "/api/config/profile/plan"].filter((s) => !settled.has(s)) });
      assert.ok(write.status === 200 || write.status === 201, `${label}: ${write.text}`);
      assert.equal(cheap.status, 200, cheap.text);
      assert.ok(write.ms < WRITE_MS, `${label} took ${Math.round(write.ms)} ms while the engine was slow: ${JSON.stringify(measured)}`);
      assert.ok(cheap.ms < CHEAP_MS, `a cheap request sent with ${label} took ${Math.round(cheap.ms)} ms: ${JSON.stringify(measured)}`);
      assert.ok(write.json.view, `${label} answers with the updated view: ${write.text}`);
      assert.ok(write.json.profiles, `${label} answers with the updated list: ${write.text}`);
      check(write.json);
    };
    const ids = (json) => json.profiles.profiles.map((p) => p.id).sort();

    await act("create", "POST", "/api/profiles", { id: "fast", from: "builtin:minimal" }, (json) => {
      assert.equal(json.view.profile.ref, "fast");
      assert.equal(json.view.profile.editable, true);
      assert.ok(ids(json).includes("fast"), JSON.stringify(ids(json)));
    });
    await act("rename", "PUT", "/api/profiles/fast/rename", { to: "quick" }, (json) => {
      assert.equal(json.view.profile.ref, "quick");
      assert.ok(ids(json).includes("quick") && !ids(json).includes("fast"), JSON.stringify(ids(json)));
    });
    await act("make default", "PUT", "/api/profiles/quick/default", {}, (json) => {
      assert.equal(json.view.profile.ref, "quick");
      assert.equal(json.view.profile.isDefault, true);
      assert.equal(json.profiles.default, "quick");
    });
    await act("delete", "DELETE", "/api/profiles/minimal", undefined, (json) => {
      assert.equal(json.view.profile.ref, "quick", "without ?view the answer is the default profile's view");
      assert.ok(!ids(json).includes("minimal"), JSON.stringify(ids(json)));
    });
    t.diagnostic(`profile actions while the engine took ${DELAY_MS} ms per call: ${JSON.stringify(measured)}`);
    // The engine was really slow during the actions: the screens that need it were still waiting at the first one.
    assert.ok(measured[0].waiting.length > 0, `the screens were waiting on the engine during the actions: ${JSON.stringify(measured)}`);

    // What the actions answered is what the screens read next.
    const view = await call("GET", "/api/config/profile");
    assert.equal(view.json.profile.ref, "quick");
    const list = await call("GET", "/api/profiles");
    assert.deepEqual(list.json.profiles.map((p) => p.id).sort(), ["quick", "standard", "strict"]);
    for (const [p, pending] of slow) {
      const r = await pending;
      assert.equal(r.status, 200, `${p}: ${r.text}`);
    }
  } finally {
    if (ui && ui.proc.exitCode === null) {
      const exited = once(ui.proc, "exit");
      ui.proc.kill("SIGTERM");
      await exited;
    }
  }
});
