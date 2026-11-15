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

// V2-75 (real engine): the sample project of the demonstrations, both branches, through the wizard's server API with the
// local development image jgates-tools:dev.
//
// The sample is JGATES_SAMPLE_PROJECT, by default the maintainer's `D:/projeto-teste-jgates` (a Git repository with the
// branches `master`, one deliberate problem per category, and `correcoes`, every problem fixed; the expected results are
// in its README). It is never used in place: the test clones it (`git clone --no-hardlinks`) into JGATES_E2E_TMP, by
// default the `_work/00-tmp` folder of the container that holds this repository when there is one, else the system
// temporary folder. The clone is deleted at the end; the sample is only read (cloned and hashed).
//
//   master: the first-run wizard (Docker, Ferramentas, Projeto, Perfil "strict", Dependências, Revisão) writes the
//     configuration into the clone and starts the first run. The result reports the twelve problems of the README, each
//     by its tool, rule and file (the personal data included); mutation testing is not applicable because the project's
//     own tests fail (MUTATION_TESTS_FAILING); no stage ends in `error`.
//   correcoes: the branch is switched in the clone (the configuration is not committed, so it stays) and a run is
//     started as the Revisar screen starts one. The only finding left is the Stripe key of master's history (gitleaks
//     history scan); no stage ends in `error`.
// Around each run the clone's tree hash (every path, size, mtime and content, .git included) does not change, and the
// sample's own hash is unchanged at the end. Every engine object the test leaves for its workspace is removed by label.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "jgates", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const IMAGE = "jgates-tools:dev";
const DEFAULT_SAMPLE = "D:/projeto-teste-jgates";
const STEPS = ["docker", "tools", "project", "profile", "dependencies", "review"];

// The problems of the sample's README ("The problems on master"): each one is reported by every finding it lists.
const MASTER_PROBLEMS = [
  { n: 1, what: "lint (ruff F401, F841)", findings: [{ tool: /ruff/i, rule: /^F401$/, file: /hello\/cli\.py$/ }, { tool: /ruff/i, rule: /^F841$/, file: /hello\/cli\.py$/ }] },
  { n: 2, what: "secret (gitleaks stripe-access-token)", findings: [{ tool: /gitleaks/i, rule: /stripe-access-token/, file: /hello\/infrastructure\/config\.py$/ }] },
  { n: 3, what: "SAST (semgrep command injection)", findings: [{ tool: /semgrep/i, rule: /./, file: /hello\/infrastructure\/system\.py$/ }] },
  { n: 4, what: "personal data (builtin-pii pii.cpf)", findings: [{ tool: /pii/i, rule: /^pii\.cpf$/, file: /tests\/fixtures\/customers\.csv$/ }] },
  { n: 5, what: "tests (pytest test-failed)", findings: [{ tool: /pytest/i, rule: /test-failed/, file: /./ }] },
  { n: 6, what: "coverage (pytest coverage-below-minimum)", findings: [{ tool: /pytest/i, rule: /coverage-below-minimum/, file: null }] },
  { n: 7, what: "duplication (jscpd)", findings: [{ tool: /jscpd/i, rule: /./, file: /hello\/report\.py$/ }] },
  { n: 8, what: "dependency (osv-scanner PYSEC-2021-142, trivy CVE-2020-14343)", findings: [{ tool: /osv/i, rule: /PYSEC-2021-142/, file: /requirements\.txt$/ }, { tool: /trivy/i, rule: /CVE-2020-14343/, file: /requirements\.txt$/ }] },
  { n: 9, what: "formatting (ruff format)", findings: [{ tool: /ruff|format/i, rule: /format/i, file: /hello\/domain\/translations\.py$/ }] },
  { n: 10, what: "architecture (import-linter)", findings: [{ tool: /import-linter|lint-imports/i, rule: /./, file: null }] },
  { n: 11, what: "IaC (checkov CKV_DOCKER_3, trivy DS-0002)", findings: [{ tool: /checkov/i, rule: /^CKV_DOCKER_3$/, file: /Dockerfile$/ }, { tool: /trivy/i, rule: /DS-?0*2$/, file: /Dockerfile$/ }] },
  { n: 12, what: "types (mypy)", findings: [{ tool: /mypy/i, rule: /./, file: /hello\/__init__\.py$/ }] },
];
// What stays on correcoes: the Stripe key of master's history.
const HISTORY_SECRET = { tool: /gitleaks/i, rule: /stripe-access-token/, file: /hello\/infrastructure\/config\.py$/ };

const docker = (args) => {
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};
const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};
const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** Where the clone goes: JGATES_E2E_TMP, else the container's `_work/00-tmp` next to this repository, else the system temp. */
function scratchBase() {
  if (process.env.JGATES_E2E_TMP) return path.resolve(process.env.JGATES_E2E_TMP);
  const container = path.join(root, "..", "_work", "00-tmp");
  return fs.existsSync(container) ? container : os.tmpdir();
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

/** Follows a run job to its end and reads its result as the Resultado screen does. */
async function runToResult(call, jobId) {
  let cursor = 0;
  await until(`the run ${jobId} to end`, async () => {
    const r = await call("GET", `/api/runs/${jobId}/events?cursor=${cursor}&wait=10000`);
    assert.equal(r.status, 200, r.text);
    cursor = r.json.cursor;
    return r.json.done ? r : null;
  }, 2_400_000);
  const job = await call("GET", `/api/runs/${jobId}`);
  assert.equal(job.status, 200, job.text);
  assert.equal(job.json.run.state, "finished", JSON.stringify({ ...job.json.run, result: undefined }));
  const runId = job.json.run.runId;
  assert.ok(runId, JSON.stringify(job.json.run).slice(0, 800));
  const read = await call("GET", `/api/results/${runId}`);
  assert.equal(read.status, 200, read.text.slice(0, 800));
  assert.equal(read.json.result.partial === true, false, "the result is final");
  return read.json.result;
}

const fileOf = (f) => (f.location?.path ?? "").replace(/\\/g, "/");
const matches = (f, m) => m.tool.test(f.tool) && m.rule.test(f.ruleId) && (m.file === null || m.file.test(fileOf(f)));
/** A compact view of a result for the assertion messages. */
function summary(result) {
  return JSON.stringify({
    decision: result.decision,
    stages: result.stages.filter((s) => s.state !== "completed").map((s) => `${s.id}=${s.state}${s.reason ? `: ${String(s.reason).slice(0, 160)}` : ""}`),
    findings: result.findings.map((f) => `${f.tool} ${f.ruleId} ${fileOf(f)}${f.location?.line ? `:${f.location.line}` : ""}`),
  }, null, 1);
}

let scratch = "";
let workspace = "";
// Registered per test with t.after, so it runs after the case even when the case runs alone with --test-name-pattern.
const cleanupCase = () => {
  if (workspace) {
    const filters = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${workspace}`];
    for (const id of lines(docker(["ps", "-aq", ...filters]).out)) docker(["rm", "-f", id]);
    for (const id of lines(docker(["network", "ls", "-q", ...filters]).out)) docker(["network", "rm", id]);
    for (const name of lines(docker(["volume", "ls", "-q", ...filters]).out)) docker(["volume", "rm", "-f", name]);
  }
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
};

test("V2-75 (real engine): the sample project end to end, master reports the twelve problems of its README and correcoes only the secret in the history, with no error stage and the clone unchanged", { timeout: 7_200_000 }, async (t) => {
  t.after(cleanupCase);
  assert.equal(docker(["version", "--format", "{{.Server.Version}}"]).code, 0, "Docker is required for the real-engine acceptance cases (the daemon did not answer)");
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is missing; build it with npm --prefix jgates run image:build`);
  const source = path.resolve(process.env.JGATES_SAMPLE_PROJECT || DEFAULT_SAMPLE);
  assert.ok(fs.existsSync(path.join(source, ".git")), `the sample project ${source} is not a Git repository (set JGATES_SAMPLE_PROJECT to a clone of it)`);
  const { workspaceId } = await import(pathToFileURL(path.join(dist, "core", "ids", "index.js")).href);
  const { resolveReason } = await import(pathToFileURL(path.join(dist, "core", "reasons", "index.js")).href);

  // The clone, in a fresh scratch folder; the sample is only read.
  const sourceBefore = treeHash(source);
  fs.mkdirSync(scratchBase(), { recursive: true });
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(scratchBase(), "v2-75-sample-")));
  const project = path.join(scratch, "projeto-teste-jgates");
  const home = path.join(scratch, "home");
  git(scratch, ["clone", "--quiet", "--no-hardlinks", source, project]);
  git(project, ["checkout", "--quiet", "master"]);
  fs.mkdirSync(home);
  workspace = workspaceId(project);
  assert.equal(fs.existsSync(path.join(project, "jgates.yml")), false, "the sample commits no JGates configuration");

  const env = { ...process.env, JGATES_HOME: home, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" };
  // The real engine (the node test runs name a missing engine client by default, tests/setup/in-image.mjs).
  if (env.JGATES_CONTAINER_RUNTIME === "jgates-test-no-engine") delete env.JGATES_CONTAINER_RUNTIME;

  let ui = null;
  try {
    ui = await startUi(env, project);
    const call = await session(ui);

    // ---- master: the first-run wizard ----
    const initial = await call("GET", "/api/setup");
    assert.equal(initial.status, 200, initial.text);
    assert.equal(initial.json.configured, false, "without jgates.yml the wizard is the overview");
    assert.deepEqual(initial.json.setup.steps.map((s) => s.id), STEPS);

    // 1 Docker.
    const engine = await call("GET", "/api/setup/docker?locale=en");
    assert.equal(engine.json.ready, true, engine.text);
    let step = await call("POST", "/api/setup/advance", { step: "docker", locale: "en" });
    assert.equal(step.status, 200, step.text);
    // 2 Ferramentas: the setup job and the advisory data it chains.
    const tools = await call("GET", "/api/setup/tools?locale=en");
    assert.equal(tools.json.image.state, "ready", tools.text);
    step = await call("POST", "/api/setup/advance", { step: "tools", locale: "en" });
    assert.equal(step.status, 200, step.text);
    const pullId = step.json.setup.jobs.pull?.id;
    assert.ok(pullId, JSON.stringify(step.json.setup.jobs));
    const setupJob = await jobEnd(call, pullId, 600_000);
    assert.equal(setupJob.job.state, "done", JSON.stringify(setupJob.events.slice(-3)));
    // 3 Projeto: the Python component at the root.
    const projectInfo = await call("GET", "/api/setup/project");
    assert.ok(projectInfo.json.components.some((c) => c.language === "python"), JSON.stringify(projectInfo.json.components));
    step = await call("POST", "/api/setup/advance", { step: "project", services: { use: false } });
    assert.equal(step.status, 200, step.text);
    assert.deepEqual(step.json.written, []);
    // 4 Perfil: Rigoroso (strict), as the README's expected results.
    const profiles = await call("GET", "/api/setup/profiles");
    assert.equal(profiles.status, 200, profiles.text);
    assert.ok(profiles.json.profiles.some((p) => p.id === "strict"), JSON.stringify(profiles.json.profiles.map((p) => p.id)));
    const chosen = await call("PUT", "/api/setup/profile/choice", { profile: "strict" });
    assert.equal(chosen.status, 200, chosen.text);
    step = await call("POST", "/api/setup/advance", { step: "profile", locale: "en" });
    assert.equal(step.status, 200, step.text);
    assert.deepEqual([...step.json.written].map((f) => f.replace(/\\/g, "/")).sort(), [".jgates/profiles.yml", "jgates.yml"], "the wizard writes only the configuration");
    assert.equal(step.json.setup.choices.profile, "strict");
    // From here the clone must not change: the configuration is written, the rest only reads it.
    const configured = treeHash(project);
    // 5 Dependências.
    step = await call("POST", "/api/setup/advance", { step: "dependencies" });
    assert.equal(step.status, 200, step.text);
    const depsId = step.json.setup.jobs.dependencies?.id;
    assert.ok(depsId, JSON.stringify(step.json.setup.jobs));
    const deps = await jobEnd(call, depsId, 1_200_000);
    assert.equal(deps.job.state, "done", JSON.stringify(deps.events.slice(-3)));
    const dataJob = await until("the advisory data job", async () => {
      const s = await call("GET", "/api/setup");
      const data = s.json.setup.jobs.data;
      return data && data.state !== "running" ? data : null;
    }, 1_800_000);
    assert.equal(dataJob.state, "done", JSON.stringify(dataJob));
    // 6 Revisão: the reviewed plan, then the first run.
    const plan = await call("POST", "/api/plans", {});
    assert.equal(plan.status, 201, plan.text);
    assert.equal(plan.json.approvable, true, JSON.stringify(plan.json.plan.blockers ?? plan.json.plan.blocked));
    const started = await call("POST", "/api/setup/advance", { step: "review", planHash: plan.json.planHash });
    assert.equal(started.status, 200, started.text);
    assert.equal(started.json.setup.completed, true);
    const master = await runToResult(call, started.json.run.id);
    const masterSummary = summary(master);

    assert.equal(master.decision, "failed", masterSummary);
    assert.deepEqual(master.stages.filter((s) => s.state === "error").map((s) => s.id), [], `no stage ends in error on master: ${masterSummary}`);
    for (const problem of MASTER_PROBLEMS) {
      for (const expected of problem.findings) {
        assert.ok(master.findings.some((f) => matches(f, expected)), `problem ${problem.n}, ${problem.what}: no finding ${expected.tool} ${expected.rule} ${expected.file ?? ""} in ${masterSummary}`);
      }
    }
    const mutation = master.stages.filter((s) => /mutation|mutmut/.test(`${s.id} ${s.adapter ?? ""}`));
    assert.ok(mutation.length > 0, `the strict profile has a mutation stage: ${masterSummary}`);
    const failingTests = resolveReason("MUTATION_TESTS_FAILING", {}, "en").message;
    for (const s of mutation) {
      assert.equal(s.state, "not_applicable", `mutation testing is not applicable while the tests fail: ${s.id} ${s.state} ${s.reason}`);
      assert.ok(String(s.reason ?? "").startsWith(failingTests), `the stage gives the reason MUTATION_TESTS_FAILING: ${s.reason}`);
    }
    assert.equal(treeHash(project), configured, "the clone is byte for byte the same after the run on master");

    // ---- correcoes: the branch switched in the clone, a run started as Revisar starts it ----
    git(project, ["checkout", "--quiet", "correcoes"]);
    assert.equal(fs.existsSync(path.join(project, "jgates.yml")), true, "the configuration is not committed, so the switch keeps it");
    const switched = treeHash(project);
    const plan2 = await call("POST", "/api/plans", {});
    assert.equal(plan2.status, 201, plan2.text);
    assert.equal(plan2.json.approvable, true, JSON.stringify(plan2.json.plan.blockers ?? plan2.json.plan.blocked));
    const run2 = await call("POST", "/api/runs", { planHash: plan2.json.planHash });
    assert.equal(run2.status, 202, run2.text);
    const fixed = await runToResult(call, run2.json.run.id);
    const fixedSummary = summary(fixed);
    assert.deepEqual(fixed.stages.filter((s) => s.state === "error").map((s) => s.id), [], `no stage ends in error on correcoes: ${fixedSummary}`);
    assert.ok(fixed.findings.length > 0 && fixed.findings.every((f) => matches(f, HISTORY_SECRET)), `only the Stripe key of the history remains on correcoes: ${fixedSummary}`);
    assert.ok(fixed.stages.some((s) => /gitleaks/.test(`${s.id} ${s.adapter ?? ""}`) && s.state === "completed"), fixedSummary);
    for (const s of fixed.stages.filter((x) => /mutation|mutmut/.test(`${x.id} ${x.adapter ?? ""}`))) assert.equal(s.state, "completed", `mutation testing runs once the tests pass: ${s.id} ${s.state} ${s.reason}`);
    assert.equal(treeHash(project), switched, "the clone is byte for byte the same after the run on correcoes");

    const report = process.env.JGATES_V2_75_REPORT;
    if (report) fs.writeFileSync(report, JSON.stringify({ master: JSON.parse(masterSummary), correcoes: JSON.parse(fixedSummary) }, null, 2));

    // The sample was only read, and no container of the workspace is left behind.
    assert.equal(treeHash(source), sourceBefore, "the sample project was only read");
    assert.deepEqual(lines(docker(["ps", "-aq", "--filter", `label=org.jgates.workspace=${workspace}`]).out), []);
  } finally {
    await stopUi(ui);
  }
});
