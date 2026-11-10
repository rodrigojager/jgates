import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The environment routes of the guided UI: GET /api/environment/state (every section with its state and reasons, read
// fresh at every call), POST /api/environment/jobs + GET /api/environment/jobs/:id (the progress events of the image pull,
// by cursor) and GET /api/reasons (the states catalogue). The engine is the fake one (tests/docker/fake-docker.cjs), and
// it is switched from absent to running between two calls to the same server, without restarting it.

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(here, "..", "dist", "cli", "main.js");
const FAKE = path.join(here, "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.resolve(here, "..", "..", "package.json"), "utf8")).version;
const PINNED = `registry.example.test/jgates/jgates-tools@sha256:${"ab".repeat(32)}`;

const dirs = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const made = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

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
    const timer = setTimeout(() => reject(new Error(`jgates ui did not start:\n${ui.out}\n${ui.err}`)), 30_000);
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

test("the environment routes report each section, stream the pull, and see the engine appear without a restart", async () => {
  const home = made("jg-env-home-");
  const project = made("jg-env-proj-");
  const engine = made("jg-env-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: PINNED, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" };
  const init = spawnSync(process.execPath, [MAIN, "init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"], { env, encoding: "utf8", timeout: 120_000 });
  assert.equal(init.status, 0, init.stdout + init.stderr);

  // The engine is the fake one from the start; it is "stopped" while daemon.lost exists in its state folder.
  fs.writeFileSync(
    runtime,
    `const fs = require("node:fs");\nconst path = require("node:path");\nprocess.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nconst present = fs.existsSync(path.join(${JSON.stringify(engine)}, "pull-attempts"));\nprocess.env.FAKE_DOCKER_LABELS = present ? ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))} : "none";\nrequire(${JSON.stringify(FAKE)});\n`,
  );
  fs.writeFileSync(path.join(engine, "daemon.lost"), "");

  let ui = null;
  try {
    ui = await startUi(env, project);
    const call = await session(ui);

    // 1. Docker installed but stopped (the daemon does not answer).
    const absent = await call("GET", "/api/environment/state");
    assert.equal(absent.status, 200, absent.text);
    assert.equal(absent.json.ready, false);
    assert.equal(absent.json.sections.engine.state, "stopped");
    assert.equal(absent.json.sections.engine.reasons[0].code, "ENGINE_STOPPED");
    assert.match(absent.json.sections.engine.reasons[0].message, /Docker is installed, but it is stopped/);
    assert.equal(absent.json.sections.image.state, "unknown");
    for (const name of ["engine", "image", "data", "dependencies", "services", "extension", "codeql"]) assert.ok(absent.json.sections[name], `section ${name}`);
    const portuguese = await call("GET", "/api/environment/state?locale=pt-BR");
    assert.match(portuguese.json.sections.engine.reasons[0].message, /O Docker está instalado, mas parado/);
    assert.equal((await call("GET", "/api/environment/state?locale=xx")).status, 400);

    // 2. The engine starts (running, no image yet): the same server sees it on the next check. The image exists in the
    // fake engine only once it was pulled, as the wrapper decides at every call.
    fs.rmSync(path.join(engine, "daemon.lost"));
    const running = await call("GET", "/api/environment/state");
    assert.equal(running.json.sections.engine.state, "ready", running.text);
    assert.deepEqual(running.json.sections.engine.reasons, []);
    assert.equal(running.json.sections.image.state, "missing");
    assert.equal(running.json.sections.image.reasons[0].code, "IMAGE_MISSING");
    assert.equal(running.json.ready, false);

    // 3. The pull is a job whose events come by cursor: steps, then the layer progress, then the end.
    const started = await call("POST", "/api/environment/jobs", { kind: "pull" });
    assert.equal(started.status, 200, started.text);
    const id = started.json.job.id;
    const events = [];
    let after = 0;
    let state = "running";
    const deadline = Date.now() + 120_000;
    while (state === "running" && Date.now() < deadline) {
      const page = await call("GET", `/api/environment/jobs/${id}?after=${after}&wait=5000`);
      assert.equal(page.status, 200, page.text);
      events.push(...page.json.events);
      after = page.json.next;
      state = page.json.job.state;
    }
    assert.equal(state, "done", JSON.stringify(events));
    assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), "events are numbered without gaps");
    const pulls = events.filter((e) => e.type === "image-pull");
    assert.ok(pulls.length > 0, "the pull streamed progress events");
    assert.ok(pulls.every((e) => typeof e.downloaded === "number" && typeof e.total === "number"));
    assert.ok(pulls.some((e) => e.downloaded > 0), JSON.stringify(pulls));
    assert.ok(events.some((e) => e.type === "setup-step" && e.step === "image" && e.state === "started"));
    assert.equal(events.at(-1).type, "end");
    assert.equal(events.at(-1).ok, true);
    assert.equal(events.at(-1).pulled, true);
    // The cursor resumes: nothing new after the last event.
    const tail = await call("GET", `/api/environment/jobs/${id}?after=${after}`);
    assert.deepEqual(tail.json.events, []);
    // The engine saw one pull of the pinned reference.
    const used = fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(used.filter((c) => c[0] === "pull").length, 1, JSON.stringify(used.filter((c) => c[0] === "pull")));

    // 4. After the pull the image section is ready and the machine can run.
    const after_ = await call("GET", "/api/environment/state");
    assert.equal(after_.json.sections.image.state, "ready", after_.text);
    assert.equal(after_.json.ready, true);

    // 5. A job that does not exist, and a kind that is not one.
    assert.equal((await call("GET", "/api/environment/jobs/job_000000000000")).status, 404);
    assert.equal((await call("POST", "/api/environment/jobs", { kind: "format-disk" })).status, 400);
  } finally {
    if (ui && ui.proc.exitCode === null) {
      const exited = once(ui.proc, "exit");
      ui.proc.kill("SIGTERM");
      await exited;
    }
  }
});

test("with no engine on the machine the engine section is not-installed with the official link", async () => {
  const home = made("jg-env-home-");
  const project = made("jg-env-proj-");
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: path.join(home, "no-such-container-engine"), JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: PINNED, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" };
  const init = spawnSync(process.execPath, [MAIN, "init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"], { env, encoding: "utf8", timeout: 120_000 });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  let ui = null;
  try {
    ui = await startUi(env, project);
    const call = await session(ui);
    const r = await call("GET", "/api/environment/state");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ready, false);
    assert.equal(r.json.sections.engine.state, "not-installed");
    assert.equal(r.json.sections.engine.reasons[0].code, "ENGINE_NOT_INSTALLED");
    assert.equal(r.json.sections.engine.reasons[0].action.kind, "link");
    assert.match(r.json.sections.engine.reasons[0].action.url, /^https:\/\/.*docker\.com\//);
    assert.equal(r.json.sections.image.state, "unknown");
  } finally {
    if (ui && ui.proc.exitCode === null) {
      const exited = once(ui.proc, "exit");
      ui.proc.kill("SIGTERM");
      await exited;
    }
  }
});

test("GET /api/reasons gives every code text and an action in both languages", async () => {
  const home = made("jg-env-home-");
  const project = made("jg-env-proj-");
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: path.join(home, "none"), JGATES_IMAGE_JSON: "", JGATES_NO_CACHE: "1", NO_COLOR: "1", JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" };
  const init = spawnSync(process.execPath, [MAIN, "init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"], { env, encoding: "utf8", timeout: 120_000 });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  let ui = null;
  try {
    ui = await startUi(env, project);
    const call = await session(ui);
    const r = await call("GET", "/api/reasons");
    assert.equal(r.status, 200, r.text);
    const codes = r.json.reasons.map((x) => x.code);
    for (const code of ["ENGINE_NOT_INSTALLED", "ENGINE_STOPPED", "IMAGE_MISSING", "DATA_STALE", "CUSTOMER_SUPPLIED", "HOST_EXECUTION_REFUSED", "SERVICES_NOT_READY"]) assert.ok(codes.includes(code), code);
    for (const reason of r.json.reasons) {
      for (const locale of ["en", "pt-BR"]) {
        assert.ok(reason.text[locale]?.length > 0, `${reason.code} text ${locale}`);
        assert.ok(reason.action.label[locale]?.length > 0, `${reason.code} action ${locale}`);
      }
    }
  } finally {
    if (ui && ui.proc.exitCode === null) {
      const exited = once(ui.proc, "exit");
      ui.proc.kill("SIGTERM");
      await exited;
    }
  }
});
