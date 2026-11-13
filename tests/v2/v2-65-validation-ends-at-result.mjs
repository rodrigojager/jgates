import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-65 (fake engine): a validation ends at its result, and the Perfil data agree (PLAN-defects.md D7, D8, D14, D15, D23,
// D30, D31, D33). Through the API: deleting the profile in edition answers the default profile's view (no PROFILE_UNKNOWN)
// and the default profile cannot be deleted; the number of checks of a profile is the same number under the same name
// ("steps") in /api/setup/profiles and /api/config/profile/plan and the plan, while /api/config/profile names its own
// unit ("capabilities"); one invalid key leaves diagnostics with file, key and line; `ready` of /api/environment/state is
// false whenever a section it lists is not ready; the tool page gets the effective limits and their origin. The UI flows
// are in jgates/tests/ui/result-reachable.spec.ts.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const PINNED = `registry.example.test/jgates/jgates-tools@sha256:${"ef".repeat(32)}`;

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

test("V2-65: delete in edition, counts with their unit, one ready, diagnostics with lines and the effective limits", { timeout: 300_000 }, async () => {
  const dir = tmp("v2-65-");
  const home = path.join(dir, "home");
  const project = path.join(dir, "project");
  const engine = path.join(dir, "engine");
  const runtime = path.join(engine, "docker.cjs");
  for (const d of [home, project, engine]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    runtime,
    `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(path.join(engine, "calls.jsonl"))};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": VERSION }))};\nrequire(${JSON.stringify(FAKE)});\n`,
  );
  fs.writeFileSync(path.join(engine, "objects.json"), JSON.stringify({ containers: [], volumes: [], networks: [], images: [] }));
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: PINNED, JGATES_LOCALE: "en", NO_COLOR: "1", JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" };
  fs.writeFileSync(path.join(project, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(project, "app.py"), "def add(a, b):\n    return a + b\n");
  const init = spawnSync(process.execPath, [MAIN, "init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"], { env, encoding: "utf8", timeout: 120_000 });
  assert.equal(init.status, 0, init.stdout + init.stderr);

  let ui = null;
  try {
    ui = await startUi(env, project);
    const call = await session(ui);

    // Deleting the profile in edition: the answer is the default profile's view, never PROFILE_UNKNOWN.
    const created = await call("POST", "/api/profiles", { id: "fast", from: "builtin:minimal" });
    assert.equal(created.status, 201, created.text);
    const deleted = await call("DELETE", "/api/profiles/fast");
    assert.equal(deleted.status, 200, deleted.text);
    assert.equal(deleted.json.viewError, null, deleted.text);
    assert.equal(deleted.json.view.profile.ref, "minimal", "the view moves to the default profile");
    assert.ok(!deleted.json.profiles.profiles.some((p) => p.id === "fast"));
    assert.ok(deleted.json.profiles.profiles.find((p) => p.id === "minimal").isDefault, "the card of the default profile says so (the UI disables its delete action)");
    const refused = await call("DELETE", "/api/profiles/minimal");
    assert.ok(refused.status >= 400 && refused.status < 500, refused.text);
    assert.ok(refused.json.code && refused.json.message, "the refusal has a code and a reason");

    // The number of checks of one profile: one unit, one name.
    const setup = await call("GET", "/api/setup/profiles");
    assert.equal(setup.status, 200, setup.text);
    const starter = setup.json.profiles.find((p) => p.id === "minimal");
    assert.equal(starter.unit, "steps");
    const planned = await call("POST", "/api/plans", { profile: "minimal", preview: true });
    assert.equal(planned.status, 201, planned.text);
    const willRun = planned.json.plan.groups.willRun.length;
    const availability = await call("GET", "/api/config/profile/plan?profile=minimal");
    assert.equal(availability.status, 200, availability.text);
    assert.equal(availability.json.plan.counts.unit, "steps");
    assert.equal(starter.total, willRun, "/api/setup/profiles counts the steps of the plan");
    assert.equal(availability.json.plan.counts.steps, willRun, "/api/config/profile/plan counts the steps of the plan");
    const view = await call("GET", "/api/config/profile?profile=minimal");
    assert.equal(view.status, 200, view.text);
    assert.equal(view.json.counts.unit, "capabilities", "the profile view names its own unit");
    assert.equal(typeof view.json.counts.capabilities, "number");

    // One definition of ready.
    const state = await call("GET", "/api/environment/state");
    assert.equal(state.status, 200, state.text);
    assert.ok(Array.isArray(state.json.notReady));
    assert.equal(state.json.ready, state.json.notReady.length === 0 && state.json.reasons.length === 0, "ready is true only when no section is listed as not ready");
    const deps = state.json.sections.dependencies.state;
    if (deps !== "ready" && deps !== "none") {
      assert.ok(state.json.notReady.includes("dependencies"), `dependencies are ${deps}`);
      assert.equal(state.json.ready, false, `ready: true with dependencies: ${deps}`);
    }

    // The doctor card (/api/prerequisites) uses the same definition: never ready where the environment is not.
    const doctor = await call("GET", "/api/prerequisites");
    assert.equal(doctor.status, 200, doctor.text);
    assert.deepEqual(doctor.json.notReady, state.json.notReady, "the doctor lists the same sections as not ready");
    if (!state.json.ready) assert.equal(doctor.json.ready, false, "the doctor card is not ready when the environment state is not");
    if (doctor.json.ready) assert.equal(state.json.ready, true);
    if (doctor.json.items.length === 0) assert.equal(doctor.json.ready, state.json.ready, "no doctor item: ready is the environment's");

    // The effective limits of a tool instance and where they come from.
    const made = await call("POST", "/api/tools", { id: "ruff-api", adapter: "ruff" });
    assert.equal(made.status, 201, made.text);
    const tools = await call("GET", "/api/tools");
    assert.equal(tools.status, 200, tools.text);
    const withProcess = [];
    for (const instance of tools.json.instances) {
      const r = await call("GET", `/api/tools/${encodeURIComponent(instance.id)}/execution`);
      if (r.status === 200 && r.json.execution.planned) withProcess.push(r.json.execution);
    }
    assert.ok(withProcess.length > 0, "an instance with a process of its own: " + JSON.stringify(tools.json.instances.map((i) => i.id)));
    for (const e of withProcess) {
      assert.deepEqual(Object.keys(e.limits.origin).sort(), ["cpus", "memoryMb", "timeoutSeconds"]);
      assert.equal(e.limits.timeoutSeconds, 1800, "the default time limit is named as the default");
      assert.equal(e.limits.origin.timeoutSeconds, "default");
    }
    const rootFile = path.join(project, "jgates.yml");
    const original = fs.readFileSync(rootFile, "utf8");
    fs.writeFileSync(rootFile, `${original.trimEnd()}\nexecution:\n  timeoutSeconds: 600\n`);
    const timed = await call("GET", `/api/tools/${encodeURIComponent(tools.json.instances.find((i) => withProcess.some((e) => e.instance === i.id)).id)}/execution`);
    assert.equal(timed.status, 200, timed.text);
    assert.equal(timed.json.execution.limits.timeoutSeconds, 600);
    assert.equal(timed.json.execution.limits.origin.timeoutSeconds, "configuration");

    // One invalid key: the view still answers with what the files hold (ADR-0009, V2-66) and carries the diagnostics
    // with file, key and line.
    fs.writeFileSync(rootFile, `${original.trimEnd()}\nnot_a_real_key: true\n`);
    const broken = await call("GET", "/api/config/profile");
    assert.equal(broken.status, 200, broken.text);
    assert.ok(Array.isArray(broken.json.diagnostics) && broken.json.diagnostics.length > 0, broken.text);
    const diagnostic = broken.json.diagnostics[0];
    assert.equal(diagnostic.file, "jgates.yml");
    assert.ok(diagnostic.path.includes("not_a_real_key"), JSON.stringify(diagnostic));
    assert.ok(Number.isInteger(diagnostic.line) && diagnostic.line > 0, JSON.stringify(diagnostic));
    const brokenList = await call("GET", "/api/profiles");
    assert.ok(Array.isArray(brokenList.json.diagnostics) && brokenList.json.diagnostics.length > 0, brokenList.text);
  } finally {
    if (ui && ui.proc.exitCode === null) {
      const exited = once(ui.proc, "exit");
      ui.proc.kill("SIGTERM");
      await exited;
    }
  }
});
