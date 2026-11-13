import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-60 (real engine): the whole journey on a copy of a real test project, through the server API only, with the local
// development image jgates-tools:dev.
//
// The project is JGATES_E2E_PROJECT, by default the maintainer's test project on Windows. It is never used in place:
// the test copies it first (only its repository folder `product/` when it is a project container with a `_work/`
// folder, so the container's private folders are never copied), into JGATES_E2E_TMP, by default the `_work/00-tmp`
// folder of the container that holds this repository when there is one, else the system temporary folder. The copy is
// deleted at the end. The source project is only read (copied and hashed).
//
// The journey, as the first-run wizard drives it (`jgates ui`):
//   1 Docker: the engine answers;
//   2 Ferramentas: the tools image is there; the setup job (engine, disk, image, shared volumes) ends ready and the
//     advisory data job it chains ends with every database fetched;
//   3 Projeto: discovery finds the Python component and its pip dependencies;
//   4 Perfil: the project keeps its own configuration (nothing is written);
//   5 Dependências: the dependencies are installed into the workspace's dependency volume;
//   6 Revisão: the reviewed plan is approvable and "Executar" starts the first run, which ends with a decision.
// Then the result is read through the results API (stages, findings, the sync and dependency phases), and the tree hash
// of the copy (every path, size, mtime and content, .git included) is the same as right after the copy. The source
// project's own hash is unchanged too. Every engine object the test leaves for its workspace is removed by label.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "jgates", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const IMAGE = "jgates-tools:dev";
const DEFAULT_PROJECT = "C:/Users/Rodrigo/Desktop/projeto-teste-jgates";
const STEPS = ["docker", "tools", "project", "profile", "dependencies", "review"];

const docker = (args) => {
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};
const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** Where the copy goes: JGATES_E2E_TMP, else the container's `_work/00-tmp` next to this repository, else the system temp. */
function scratchBase() {
  if (process.env.JGATES_E2E_TMP) return path.resolve(process.env.JGATES_E2E_TMP);
  const container = path.join(root, "..", "_work", "00-tmp");
  return fs.existsSync(container) ? container : os.tmpdir();
}

/** The folder JGates analyzes: the repository `product/` of a project container, else the folder itself. */
function analyzedFolder(source) {
  const product = path.join(source, "product");
  const isContainer = fs.existsSync(path.join(source, "_work")) && fs.existsSync(path.join(product, ".git"));
  return isContainer ? product : source;
}

/** Hash of the whole tree: relative paths, kinds, sizes, mtimes and contents, in a stable order. */
function treeHash(dir) {
  const hash = crypto.createHash("sha256");
  const walk = (d, rel) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(full);
      if (entry.isDirectory()) {
        hash.update(`d:${next}\0`);
        walk(full, next);
      } else if (entry.isSymbolicLink()) hash.update(`l:${next}:${fs.readlinkSync(full)}\0`);
      else hash.update(`f:${next}:${stat.size}:${stat.mtimeMs}\0`).update(fs.readFileSync(full));
    }
  };
  walk(dir, "");
  return hash.digest("hex");
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
async function jobEnd(call, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let after = 0;
  const events = [];
  while (Date.now() < deadline) {
    const page = await call("GET", `/api/environment/jobs/${id}?after=${after}&wait=10000`);
    assert.equal(page.status, 200, page.text);
    events.push(...page.json.events);
    after = page.json.next;
    if (page.json.job.state !== "running") return { job: page.json.job, events };
  }
  throw new Error(`job ${id} did not end in ${timeoutMs} ms: ${JSON.stringify(events.slice(-5))}`);
}

async function until(what, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

let scratch = "";
let workspace = "";
test.after(() => {
  if (workspace) {
    const filters = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${workspace}`];
    for (const id of lines(docker(["ps", "-aq", ...filters]).out)) docker(["rm", "-f", id]);
    for (const id of lines(docker(["network", "ls", "-q", ...filters]).out)) docker(["network", "rm", id]);
    for (const name of lines(docker(["volume", "ls", "-q", ...filters]).out)) docker(["volume", "rm", "-f", name]);
  }
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

test("V2-60 (real engine): setup and a first run of a copy of the real test project through the wizard's server API, the result read back, and the copy's tree hash unchanged", { timeout: 3_600_000 }, async () => {
  assert.equal(docker(["version", "--format", "{{.Server.Version}}"]).code, 0, "Docker is required for the real-engine acceptance cases (the daemon did not answer)");
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is missing; build it with npm --prefix jgates run image:build`);
  const sourceRoot = path.resolve(process.env.JGATES_E2E_PROJECT || DEFAULT_PROJECT);
  assert.ok(fs.existsSync(sourceRoot), `the test project ${sourceRoot} does not exist (set JGATES_E2E_PROJECT to a project folder)`);
  const source = analyzedFolder(sourceRoot);
  const { workspaceId } = await import(pathToFileURL(path.join(dist, "core", "ids", "index.js")).href);

  // The copy, in a fresh scratch folder; the source is only read.
  const sourceBefore = treeHash(source);
  fs.mkdirSync(scratchBase(), { recursive: true });
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(scratchBase(), "v2-60-e2e-")));
  const project = path.join(scratch, path.basename(source));
  const home = path.join(scratch, "home");
  fs.cpSync(source, project, { recursive: true, verbatimSymlinks: true });
  fs.mkdirSync(home);
  workspace = workspaceId(project);
  const before = treeHash(project);

  const env = { ...process.env, JGATES_HOME: home, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" };
  // The real engine (the node test runs name a missing engine client by default, tests/setup/in-image.mjs).
  if (env.JGATES_CONTAINER_RUNTIME === "jgates-test-no-engine") delete env.JGATES_CONTAINER_RUNTIME;

  let ui = null;
  try {
    ui = await startUi(env, project);
    const call = await session(ui);

    // The project already has its configuration: the wizard is closed until "Refazer a configuração guiada".
    const initial = await call("GET", "/api/setup");
    assert.equal(initial.status, 200, initial.text);
    assert.equal(initial.json.configured, true, "the test project brings its jgates.yml");
    const reopened = await call("POST", "/api/setup/reopen", {});
    assert.equal(reopened.status, 200, reopened.text);
    // Reopened on purpose: it runs on #/setup and does not take over the overview (D13).
    assert.equal(reopened.json.open, false);
    assert.equal(reopened.json.reopened, true);
    assert.equal(reopened.json.setup.completed, false);
    assert.deepEqual(reopened.json.setup.steps.map((s) => s.id), STEPS);
    assert.equal(reopened.json.setup.step, "docker");

    // 1 Docker: the real engine answers.
    const engine = await call("GET", "/api/setup/docker?locale=en");
    assert.equal(engine.status, 200, engine.text);
    assert.equal(engine.json.ready, true, engine.text);
    let step = await call("POST", "/api/setup/advance", { step: "docker", locale: "en" });
    assert.equal(step.status, 200, step.text);
    assert.equal(step.json.setup.step, "tools");

    // 2 Ferramentas: the image is there; Continuar runs the setup job, which chains the advisory data.
    const tools = await call("GET", "/api/setup/tools?locale=en");
    assert.equal(tools.status, 200, tools.text);
    assert.equal(tools.json.mode, "container", tools.text);
    assert.equal(tools.json.image.state, "ready", tools.text);
    step = await call("POST", "/api/setup/advance", { step: "tools", locale: "en" });
    assert.equal(step.status, 200, step.text);
    assert.equal(step.json.setup.step, "project");
    const pullId = step.json.setup.jobs.pull?.id;
    assert.ok(pullId, JSON.stringify(step.json.setup.jobs));
    const setupJob = await jobEnd(call, pullId, 600_000);
    assert.equal(setupJob.job.state, "done", `the setup job ended ready: ${JSON.stringify(setupJob.events.slice(-3))}`);
    for (const volume of ["jgates-cache", "jgates-toolchains"]) assert.equal(docker(["volume", "inspect", volume]).code, 0, `setup created or kept ${volume}`);

    // 3 Projeto: the Python component and its pip dependencies.
    const projectInfo = await call("GET", "/api/setup/project");
    assert.equal(projectInfo.status, 200, projectInfo.text);
    const components = projectInfo.json.components.filter((c) => c.language);
    assert.ok(components.length > 0, JSON.stringify(projectInfo.json.components));
    step = await call("POST", "/api/setup/advance", { step: "project", services: { use: false } });
    assert.equal(step.status, 200, step.text);
    assert.equal(step.json.setup.step, "profile");
    assert.deepEqual(step.json.written, [], "no correction was asked for, so nothing is written");

    // 4 Perfil: the project's own profile is kept; nothing is written.
    const profiles = await call("GET", "/api/setup/profiles");
    assert.equal(profiles.status, 200, profiles.text);
    assert.equal(profiles.json.toolsReady, true);
    assert.ok(profiles.json.selected, "the project's jgates.yml selects a profile");
    for (const p of profiles.json.profiles) assert.equal(p.error, null, `${p.id}: ${p.error}`);
    step = await call("POST", "/api/setup/advance", { step: "profile" });
    assert.equal(step.status, 200, step.text);
    assert.equal(step.json.setup.step, "dependencies");
    assert.deepEqual(step.json.written, [], "keeping the configuration writes nothing");
    assert.equal(step.json.setup.choices.profile, profiles.json.selected);

    // 5 Dependências: installed into the workspace's dependency volume.
    const units = await call("GET", "/api/setup/dependencies?locale=en");
    assert.equal(units.status, 200, units.text);
    assert.equal(units.json.imageReady, true);
    assert.ok(units.json.units.length > 0, JSON.stringify(units.json));
    step = await call("POST", "/api/setup/advance", { step: "dependencies" });
    assert.equal(step.status, 200, step.text);
    assert.equal(step.json.setup.step, "review");
    const depsId = step.json.setup.jobs.dependencies?.id;
    assert.ok(depsId, JSON.stringify(step.json.setup.jobs));
    const deps = await jobEnd(call, depsId, 1_200_000);
    assert.equal(deps.job.state, "done", `the dependencies were installed: ${JSON.stringify(deps.events.slice(-3))}`);
    const depVolumes = lines(docker(["volume", "ls", "-q", "--filter", "label=org.jgates.managed=true", "--filter", "label=org.jgates.kind=deps", "--filter", `label=org.jgates.workspace=${workspace}`]).out);
    assert.ok(depVolumes.length > 0, "a labelled dependency volume of the workspace exists");

    // The advisory data the setup job chained ends before the run reads it.
    const dataJob = await until("the advisory data job", async () => {
      const s = await call("GET", "/api/setup");
      const data = s.json.setup.jobs.data;
      return data && data.state !== "running" ? data : null;
    }, 1_800_000);
    assert.equal(dataJob.state, "done", JSON.stringify(dataJob));
    const toolsAfter = await call("GET", "/api/setup/tools?locale=en");
    assert.equal(toolsAfter.json.data.state, "fresh", JSON.stringify(toolsAfter.json.data));

    // 6 Revisão: the reviewed plan, then the first run.
    const plan = await call("POST", "/api/plans", {});
    assert.equal(plan.status, 201, plan.text);
    assert.equal(plan.json.approvable, true, JSON.stringify(plan.json.plan.blockers ?? plan.json.plan.blocked));
    const started = await call("POST", "/api/setup/advance", { step: "review", planHash: plan.json.planHash });
    assert.equal(started.status, 200, started.text);
    assert.equal(started.json.setup.completed, true);
    assert.equal(started.json.open, false, "the overview turns into the dashboard");
    const jobId = started.json.run.id;
    let cursor = 0;
    const runEvents = [];
    await until("the first run to end", async () => {
      const r = await call("GET", `/api/runs/${jobId}/events?cursor=${cursor}&wait=10000`);
      assert.equal(r.status, 200, r.text);
      runEvents.push(...r.json.events);
      cursor = r.json.cursor;
      return r.json.done ? r : null;
    }, 1_800_000);
    const job = await call("GET", `/api/runs/${jobId}`);
    assert.equal(job.status, 200, job.text);
    assert.equal(job.json.run.state, "finished", JSON.stringify({ ...job.json.run, result: undefined }));
    const runId = job.json.run.runId;
    assert.ok(runId, JSON.stringify(job.json.run).slice(0, 800));

    // The result, read back as the Resultado screen reads it.
    const read = await call("GET", `/api/results/${runId}`);
    assert.equal(read.status, 200, read.text.slice(0, 800));
    const result = read.json.result;
    assert.equal(result.runId, runId);
    assert.equal(result.partial === true, false, "the result is final");
    assert.ok(["passed", "failed"].includes(result.decision), `the run reached a decision: ${result.decision} ${JSON.stringify(result.stages.filter((s) => s.state !== "completed").map((s) => [s.id, s.state, s.reason]))}`);
    assert.ok(result.stages.length > 0);
    assert.ok(result.stages.some((s) => s.state === "completed"), "stages completed");
    const progress = await call("GET", `/api/runs/${runId}/progress?cursor=0`);
    assert.equal(progress.status, 200, progress.text.slice(0, 400));
    const logs = await call("GET", `/api/results/${runId}/logs`);
    assert.equal(logs.status, 200, logs.text.slice(0, 400));

    // The run's own record: the project went through the sync phase and the steps ran in containers of the image.
    const runDir = path.join(home, "workspaces", workspace, "runs", runId);
    const events = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const synced = events.find((e) => e.type === "phase-finished" && e.data.phase === "sync");
    assert.equal(synced?.data.status, "succeeded", JSON.stringify(synced));
    assert.equal(synced.data.details.volume, `jgates-${workspace}-src`);
    const stepLogs = fs.readdirSync(path.join(runDir, "logs")).filter((f) => f.endsWith(".stderr.log"));
    assert.ok(stepLogs.length > 0, "the steps wrote their logs");
    const sourceMount = `--mount type=volume,src=jgates-${workspace}-src,dst=/workspace`;
    const headers = stepLogs.map((f) => fs.readFileSync(path.join(runDir, "logs", f), "utf8").split("\n---\n")[0]).filter((h) => h.includes(sourceMount));
    assert.ok(headers.length > 0, `a step log shows its docker run line with the source volume: ${stepLogs.join(", ")}`);
    for (const header of headers) assert.ok(!header.includes(project), "the project folder is not in a docker run line");

    // The copy is untouched, and so is the source.
    assert.equal(treeHash(project), before, "the copy of the project is byte for byte the same after setup and the first run");
    assert.equal(treeHash(source), sourceBefore, "the source project was only read");

    // No container of the workspace is left behind.
    assert.deepEqual(lines(docker(["ps", "-aq", "--filter", `label=org.jgates.workspace=${workspace}`]).out), []);
  } finally {
    await stopUi(ui);
  }
});
