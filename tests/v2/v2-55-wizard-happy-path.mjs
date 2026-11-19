import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { fakeHostDiskEnv } from "../../jgates/tests/setup/fake-host-disk.mjs";

// V2-55 (fake engine): the first-run wizard's happy path, through the server API only.
//   - the six steps run in order (Docker, Ferramentas, Projeto, Perfil, Dependências, Revisão): a step that is not the
//     current one is refused, and each "Continuar" moves to the next;
//   - the tools image download started in step 2 goes on in the background (the fake engine holds the pull until the
//     test lets it go) while steps 3 to 5 complete: the profile writes jgates.yml, the dependencies are queued, and they
//     start by themselves, after the advisory data, once the pull ends;
//   - the wizard state survives a restart of the UI server: the new server resumes at the same step with the same choices;
//   - step 6 starts the first run of the reviewed plan, and the overview then stops showing the wizard.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const PINNED = `registry.example.test/jgates/jgates-tools@sha256:${"ab".repeat(32)}`;
const STEPS = ["docker", "tools", "project", "profile", "dependencies", "review"];

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

async function stopUi(ui) {
  if (!ui || ui.proc.exitCode !== null) return;
  const exited = once(ui.proc, "exit");
  ui.proc.kill("SIGTERM");
  await exited;
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

/** Follows an environment job to its end by long polling, as the screen does. */
async function jobEnd(call, id) {
  let after = 0;
  const events = [];
  for (let i = 0; i < 40; i++) {
    const page = await call("GET", `/api/environment/jobs/${id}?after=${after}&wait=10000`);
    assert.equal(page.status, 200, page.text);
    events.push(...page.json.events);
    after = page.json.next;
    if (page.json.job.state !== "running") return { job: page.json.job, events };
  }
  throw new Error(`job ${id} did not end`);
}

async function until(what, check, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

test("V2-55: the wizard's six steps in order, the pull in the background while steps 3-5 complete, the state across a server restart, and step 6 starts the first run", async () => {
  const home = tmp("v2-55-home-");
  const project = tmp("v2-55-project-");
  const engine = tmp("v2-55-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const gate = path.join(engine, "pull.gate");
  const runtime = path.join(engine, "docker.cjs");
  // The image exists only once it was pulled; a pull waits for the test's gate file, so it is still going on while the
  // wizard moves through the next steps.
  fs.writeFileSync(
    runtime,
    [
      `const fs = require("node:fs");`,
      `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};`,
      `process.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};`,
      `if (process.argv[2] === "pull") {`,
      `  const deadline = Date.now() + 180000;`,
      `  while (!fs.existsSync(${JSON.stringify(gate)}) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);`,
      `}`,
      `const present = fs.existsSync(${JSON.stringify(path.join(engine, "pull-attempts"))});`,
      `process.env.FAKE_DOCKER_LABELS = present ? ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))} : "none";`,
      `require(${JSON.stringify(FAKE)});`,
      ``,
    ].join("\n"),
  );
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: PINNED, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" };
  fs.writeFileSync(path.join(project, "mod.py"), "import os\n\n\ndef check(value):\n    return value is None\n");
  fs.writeFileSync(path.join(project, "requirements.txt"), "requests==2.32.3\n");
  const dockerCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const depsRuns = () => dockerCalls().filter((c) => c[0] === "run" && c.includes("org.jgates.kind=deps"));

  let ui = null;
  try {
    ui = await startUi(fakeHostDiskEnv(env), project);
    let call = await session(ui);

    // The wizard is open at step 1, with the six steps in order; only step 1 can be shown.
    const first = await call("GET", "/api/setup");
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.open, true);
    assert.equal(first.json.configured, false);
    assert.equal(first.json.setup.step, "docker");
    assert.deepEqual(first.json.setup.steps.map((s) => [s.index, s.id]), STEPS.map((id, i) => [i + 1, id]));
    assert.deepEqual(first.json.setup.steps.filter((s) => s.reachable).map((s) => s.id), ["docker"]);
    const outOfOrder = await call("POST", "/api/setup/advance", { step: "tools" });
    assert.equal(outOfOrder.status, 409, outOfOrder.text);
    assert.equal(outOfOrder.json.code, "SETUP_STEP_MISMATCH");
    assert.equal(outOfOrder.json.step, "docker");

    // 1 Docker: the engine runs.
    const docker = await call("GET", "/api/setup/docker?locale=en");
    assert.equal(docker.json.ready, true, docker.text);
    assert.equal(docker.json.command, "jgates setup");
    let step = await call("POST", "/api/setup/advance", { step: "docker" });
    assert.equal(step.status, 200, step.text);
    assert.equal(step.json.setup.step, "tools");

    // 2 Ferramentas: the image is missing; the download starts and the wizard goes on without waiting for it.
    const tools = await call("GET", "/api/setup/tools?locale=en");
    assert.equal(tools.status, 200, tools.text);
    assert.equal(tools.json.image.state, "missing");
    assert.ok(tools.json.image.sizeBytes > 0, "the size comes from the pin file");
    assert.ok(tools.json.disk.requiredMb > 0);
    const downloads = await call("POST", "/api/setup/downloads", { locale: "en" });
    assert.equal(downloads.status, 200, downloads.text);
    const pullId = downloads.json.setup.jobs.pull.id;
    assert.equal(downloads.json.setup.jobs.pull.state, "running");
    step = await call("POST", "/api/setup/advance", { step: "tools", locale: "en" });
    assert.equal(step.status, 200, step.text);
    assert.equal(step.json.setup.step, "project");
    assert.equal(step.json.setup.jobs.pull.id, pullId, "Continuar joined the running download instead of starting another");

    // 3 Projeto: the component discovery found, with its dependencies; no compose file here.
    const projectInfo = await call("GET", "/api/setup/project");
    assert.equal(projectInfo.status, 200, projectInfo.text);
    const python = projectInfo.json.components.find((c) => c.language === "python");
    assert.ok(python, JSON.stringify(projectInfo.json.components));
    assert.equal(python.dependencies.manager, "pip");
    assert.ok(projectInfo.json.vocabulary.some((l) => l.id === "python"), "the language select has its vocabulary");
    assert.deepEqual(projectInfo.json.compose.files, []);
    assert.equal(projectInfo.json.servicesDefault, false);
    step = await call("POST", "/api/setup/advance", { step: "project", services: { use: false } });
    assert.equal(step.status, 200, step.text);
    assert.equal(step.json.setup.step, "profile");

    // 4 Perfil: the starter profiles with what each one runs here; the preview writes nothing; Continuar writes jgates.yml.
    const profiles = await call("GET", "/api/setup/profiles");
    assert.equal(profiles.status, 200, profiles.text);
    assert.deepEqual(profiles.json.profiles.map((p) => p.id), ["minimal", "standard", "strict"]);
    assert.equal(profiles.json.toolsReady, false);
    assert.equal(profiles.json.recommended, "standard", "Rigoroso is recommended only once the tools are there");
    for (const p of profiles.json.profiles) {
      assert.equal(p.error, null, `${p.id}: ${p.error}`);
      assert.ok(p.total > 0, `${p.id} runs something`);
      assert.equal(p.categories.reduce((n, c) => n + c.count, 0), p.total, `${p.id}: the categories add up`);
    }
    const byId = Object.fromEntries(profiles.json.profiles.map((p) => [p.id, p.total]));
    assert.ok(byId.strict >= byId.minimal, JSON.stringify(byId));
    const preview = await call("POST", "/api/setup/config/preview", { profile: "minimal" });
    assert.equal(preview.status, 200, preview.text);
    const rootFile = preview.json.files.find((f) => f.file === "jgates.yml");
    assert.ok(rootFile && /profile: minimal/.test(rootFile.text), JSON.stringify(preview.json.files));
    assert.equal(fs.existsSync(path.join(project, "jgates.yml")), false, "the preview writes nothing");
    step = await call("POST", "/api/setup/advance", { step: "profile", profile: "minimal" });
    assert.equal(step.status, 200, step.text);
    assert.equal(step.json.setup.step, "dependencies");
    assert.ok(step.json.written.includes("jgates.yml"), JSON.stringify(step.json.written));
    assert.match(fs.readFileSync(path.join(project, "jgates.yml"), "utf8"), /profile: minimal/);
    assert.equal(step.json.open, true, "the wizard stays open after the configuration exists, until it ends");

    // 5 Dependências: the image is still downloading, so they are queued to start after it.
    const units = await call("GET", "/api/setup/dependencies?locale=en");
    assert.equal(units.status, 200, units.text);
    assert.equal(units.json.imageReady, false);
    assert.ok(units.json.units.some((u) => u.manager === "pip"), JSON.stringify(units.json.units));
    const queued = await call("POST", "/api/setup/dependencies", { locale: "en" });
    assert.equal(queued.status, 200, queued.text);
    assert.equal(queued.json.setup.dependencies, "queued");
    step = await call("POST", "/api/setup/advance", { step: "dependencies" });
    assert.equal(step.status, 200, step.text);
    assert.equal(step.json.setup.step, "review");

    // Steps 3 to 5 completed while the pull was still going on, and nothing of the dependencies ran yet.
    const meanwhile = await call("GET", `/api/environment/jobs/${pullId}`);
    assert.equal(meanwhile.json.job.state, "running", "the pull is still going on in the background");
    assert.equal(fs.existsSync(path.join(engine, "pull-attempts")), false, "the fake engine still holds the pull");
    assert.deepEqual(depsRuns(), [], "the dependencies wait for the image");

    // The download ends: the advisory data and the queued dependencies start by themselves.
    fs.writeFileSync(gate, "");
    const pulled = await jobEnd(call, pullId);
    assert.equal(pulled.job.state, "done", JSON.stringify(pulled.events.at(-1)));
    assert.ok(pulled.events.some((e) => e.type === "image-pull"), "the pull reported its progress");
    const chained = await until("the chained jobs", async () => {
      const s = await call("GET", "/api/setup");
      const { data, dependencies } = s.json.setup.jobs;
      return data && dependencies && data.state !== "running" && dependencies.state !== "running" ? s.json.setup.jobs : null;
    });
    assert.equal(chained.dependencies.state, "done", JSON.stringify(chained));
    assert.equal(chained.data.state, "done", JSON.stringify(chained));
    const order = dockerCalls().map((c) => c[0]);
    assert.ok(order.indexOf("pull") >= 0 && depsRuns().length > 0, "the dependencies were installed in a container");
    const lastPull = order.lastIndexOf("pull");
    const firstDeps = dockerCalls().findIndex((c) => c[0] === "run" && c.includes("org.jgates.kind=deps"));
    assert.ok(firstDeps > lastPull, "the dependencies ran after the pull");

    // The UI server restarts: the wizard resumes at the same step, with the same choices.
    await stopUi(ui);
    ui = await startUi(fakeHostDiskEnv(env), project);
    call = await session(ui);
    const resumed = await call("GET", "/api/setup");
    assert.equal(resumed.status, 200, resumed.text);
    assert.equal(resumed.json.open, true);
    assert.equal(resumed.json.configured, true);
    assert.equal(resumed.json.setup.step, "review");
    assert.deepEqual(resumed.json.setup.steps.map((s) => s.state), ["done", "done", "done", "done", "done", "current"]);
    assert.equal(resumed.json.setup.choices.profile, "minimal");
    assert.deepEqual(resumed.json.setup.choices.services, { use: false, compose: [] });
    // Jobs live in the memory of the server that ran them: the new one says it does not know them.
    assert.equal(resumed.json.setup.jobs.pull.known, false);
    // "Voltar" works on the new server too, and Continuar brings the wizard back.
    const back = await call("PUT", "/api/setup", { step: "dependencies" });
    assert.equal(back.json.setup.step, "dependencies");
    step = await call("POST", "/api/setup/advance", { step: "dependencies" });
    assert.equal(step.json.setup.step, "review", step.text);

    // 6 Revisão: the reviewed plan; "Executar a primeira validação" starts its run and ends the wizard.
    const plan = await call("POST", "/api/plans", {});
    assert.equal(plan.status, 201, plan.text);
    assert.equal(plan.json.approvable, true, JSON.stringify(plan.json.plan.blockers ?? plan.json.plan.blocked));
    const started = await call("POST", "/api/setup/advance", { step: "review", planHash: plan.json.planHash });
    assert.equal(started.status, 200, started.text);
    assert.ok(started.json.run && /^job_[0-9a-f]{16}$/.test(started.json.run.id), JSON.stringify(started.json.run));
    assert.equal(started.json.setup.completed, true);
    assert.equal(started.json.setup.run, started.json.run.id);
    assert.equal(started.json.open, false, "the overview turns into the dashboard");
    const run = await call("GET", `/api/runs/${started.json.run.id}`);
    assert.equal(run.status, 200, run.text);
    // Let the run end before the folders go away.
    await until("the first run to end", async () => {
      const r = await call("GET", `/api/runs/${started.json.run.id}/events?cursor=0`);
      return r.json.done ? r : null;
    }, 180_000);
    assert.ok(dockerCalls().some((c) => c[0] === "run" && c.includes("org.jgates.kind=step")), "the first run ran its steps in containers");

    // "Refazer a configuração guiada" opens it again with the current values, on #/setup only: the overview stays the
    // overview (D13). It can start at a chosen step.
    const reopened = await call("POST", "/api/setup/reopen", {});
    assert.equal(reopened.status, 200, reopened.text);
    assert.equal(reopened.json.open, false);
    assert.equal(reopened.json.reopened, true);
    assert.equal(reopened.json.setup.completed, false);
    assert.equal(reopened.json.setup.step, "docker");
    const atProject = await call("POST", "/api/setup/reopen", { step: "project" });
    assert.equal(atProject.status, 200, atProject.text);
    assert.equal(atProject.json.setup.step, "project");
    assert.equal(reopened.json.setup.choices.profile, "minimal");
    const closed = await call("POST", "/api/setup/close", {});
    assert.equal(closed.json.open, false);
  } finally {
    fs.writeFileSync(gate, "");
    await stopUi(ui);
  }
});
