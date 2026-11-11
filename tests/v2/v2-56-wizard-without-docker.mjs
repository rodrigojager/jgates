import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-56 (fake engine): the first-run wizard on a machine without Docker, through the server API only.
//   - step 1 (Docker) reports `not-installed` with the install guidance: ENGINE_NOT_INSTALLED, the catalogue text in
//     English and in Portuguese, the official download link and the install recipe (shown, never run);
//   - "Continuar" is refused with the same code and the wizard stays at step 1, also after a reload of the state;
//   - the engine appears while the same UI server keeps running (the runtime file is created): the next check reports
//     the engine ready with its facts, and "Continuar" moves to step 2. Nothing was pulled, created or run meanwhile.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");

const made = [];
const tmp = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

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

test("V2-56: without an engine the wizard's step 1 gives the install guidance; once the engine appears the next check is ready, without restarting the UI server", async () => {
  const home = tmp("v2-56-home-");
  const project = tmp("v2-56-project-");
  const engine = tmp("v2-56-engine-");
  const calls = path.join(engine, "calls.jsonl");
  // The runtime file does not exist yet: the engine is not installed.
  const runtime = path.join(engine, "docker.cjs");
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" };
  fs.writeFileSync(path.join(project, "mod.py"), "import os\n");

  let ui = null;
  try {
    ui = await startUi(env, project);
    const pid = ui.proc.pid;
    const call = await session(ui);

    // A project without jgates.yml: the overview shows the wizard, at step 1.
    const opened = await call("GET", "/api/setup");
    assert.equal(opened.status, 200, opened.text);
    assert.equal(opened.json.open, true);
    assert.equal(opened.json.setup.step, "docker");
    assert.deepEqual(opened.json.setup.steps.map((s) => s.id), ["docker", "tools", "project", "profile", "dependencies", "review"]);

    // Step 1 without an engine: the guidance, in both languages.
    for (const [locale, text] of [["en", /Docker is not installed/], ["pt-BR", /O Docker não está instalado/]]) {
      const check = await call("GET", `/api/setup/docker?locale=${locale}`);
      assert.equal(check.status, 200, check.text);
      assert.equal(check.json.ready, false);
      assert.equal(check.json.state, "not-installed");
      assert.equal(check.json.reasons.length, 1, JSON.stringify(check.json.reasons));
      const [reason] = check.json.reasons;
      assert.equal(reason.code, "ENGINE_NOT_INSTALLED");
      assert.match(reason.message, text);
      assert.equal(reason.action.kind, "link");
      assert.match(reason.action.url, /^https:\/\/.*docker\.com\//);
      assert.ok(reason.action.label.length > 2);
      assert.equal(reason.recipe.id, "docker:install", "the install recipe is part of the guidance");
      assert.ok(reason.recipe.available ? reason.recipe.commands.length > 0 : reason.recipe.reason.length > 0, JSON.stringify(reason.recipe));
      assert.ok(!/Cannot connect|ENOENT|spawn/.test(reason.message), "the raw engine text is not the main message");
    }

    // "Continuar" is refused with the same code; the wizard stays at step 1.
    const refused = await call("POST", "/api/setup/advance", { step: "docker", locale: "pt-BR" });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.json.code, "ENGINE_NOT_INSTALLED");
    assert.match(refused.json.message, /O Docker não está instalado/);
    assert.equal(refused.json.reasons[0].action.kind, "link");
    const still = await call("GET", "/api/setup");
    assert.equal(still.json.setup.step, "docker");
    assert.deepEqual(still.json.setup.steps.filter((s) => s.state === "done"), []);
    // Steps after a step that is not done cannot be opened.
    const jump = await call("PUT", "/api/setup", { step: "project" });
    assert.equal(jump.status, 409, jump.text);
    assert.equal(jump.json.code, "SETUP_STEP_UNREACHABLE");

    // Docker gets installed and started while the UI server keeps running.
    fs.writeFileSync(runtime, `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nprocess.env.FAKE_DOCKER_LABELS = "none";\nrequire(${JSON.stringify(FAKE)});\n`);
    const ready = await call("GET", "/api/setup/docker?locale=en");
    assert.equal(ready.status, 200, ready.text);
    assert.equal(ready.json.ready, true, JSON.stringify(ready.json));
    assert.equal(ready.json.state, "ready");
    assert.deepEqual(ready.json.reasons, []);
    assert.equal(ready.json.facts.serverVersion, "27.0.1-fake");
    assert.equal(ui.proc.pid, pid);
    assert.equal(ui.proc.exitCode, null, "the same UI server answered");

    const next = await call("POST", "/api/setup/advance", { step: "docker", locale: "en" });
    assert.equal(next.status, 200, next.text);
    assert.equal(next.json.setup.step, "tools");
    assert.equal(next.json.setup.steps[0].state, "done");

    // Only the engine was asked about: nothing was pulled, created or run.
    const used = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    assert.ok(used.length > 0, "the fake engine was asked");
    assert.ok(!used.some((c) => ["pull", "run", "load"].includes(c[0]) || (c[0] === "volume" && c[1] === "create")), JSON.stringify(used));
    // The project was not touched.
    assert.deepEqual(fs.readdirSync(project), ["mod.py"]);
  } finally {
    if (ui && ui.proc.exitCode === null) {
      const exited = once(ui.proc, "exit");
      ui.proc.kill("SIGTERM");
      await exited;
    }
  }
});
