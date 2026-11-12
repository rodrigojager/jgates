import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-72 (fake engine): the result reads at a glance (PLAN-guided-flows.md sections 5 and 6). Through the API: after a
// validation that did not pass the overview's next step is to open the result (with the route that opens it), the
// tiles of the last validation carry the name, the tool, the state and the findings of each check, and the items of the
// doctor card carry the route that fixes them (CodeQL opens Ambiente at its section) instead of a command to copy. The
// screens are in jgates/tests/ui/result-cards.spec.ts.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const PINNED = `registry.example.test/jgates/jgates-tools@sha256:${"ef".repeat(32)}`;
const RUN_ID = "run_20261112T100000Z_aaaaaaaa";

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

/** A stored run with one check in each state, written the way the runner writes result.json. */
function storedResult(project, decision) {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    tool: "jgates",
    version: VERSION,
    startedAt: "2026-11-12T10:00:00.000Z",
    finishedAt: "2026-11-12T10:00:09.000Z",
    workspace: { id: "ws_x", path: project },
    runDir: path.join(project, "run"),
    selection: { adapter: "plan", options: {}, overrides: [], profile: "minimal", scope: "workspace" },
    decision,
    complete: decision === "passed",
    reduced: false,
    exitCode: decision === "passed" ? 0 : 1,
    requirements: [],
    stages: [
      { id: "ruff#lint", label: "Ruff", adapter: "ruff", state: "completed", findings: 0, execution: { step: "ruff", durationMs: 1200 } },
      { id: "mypy#types", label: "Mypy", adapter: "mypy", state: "completed", findings: 2, blockingViolations: 2, execution: { step: "mypy", durationMs: 3400 } },
      { id: "pytest#unit", label: "pytest", adapter: "pytest", state: "error", findings: 0, execution: { step: "pytest", durationMs: 800 } },
      { id: "codeql#sast", label: "CodeQL", adapter: "codeql", state: "blocked", reason: "CodeQL was not prepared" },
      { id: "cargo#audit", label: "cargo audit", adapter: "cargo-audit", state: "not_applicable" },
    ],
    findings: [],
    unsatisfied: [],
    warnings: [],
    blockingViolations: 2,
    disabled: [],
    workspaceChanges: { checked: true, added: [], modified: [], removed: [] },
    artifacts: { result: "result.json", logs: [], outputs: [] },
  };
}

test("V2-72: the next step opens the result, the tiles name the checks and the doctor items carry their route", { timeout: 300_000 }, async () => {
  const dir = tmp("v2-72-");
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
  const { workspaceId } = await import(pathToFileURL(path.join(root, "jgates", "dist", "core", "ids", "index.js")).href);
  const runDir = path.join(home, "workspaces", workspaceId(project), "runs", RUN_ID);


  let ui = null;
  try {
    ui = await startUi(env, project);
    const call = await session(ui);

    // No validation yet: nothing to read.
    const before = await call("GET", "/api/overview");
    assert.equal(before.status, 200, before.text);
    assert.equal(before.json.lastRun, null);
    assert.equal(before.json.nextStep, null);

    // An incomplete validation: the next step is to open its result.
    for (const decision of ["incomplete", "failed"]) {
      fs.mkdirSync(path.join(runDir, "logs"), { recursive: true });
      fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(storedResult(project, decision)));
      const overview = await call("GET", "/api/overview");
      assert.equal(overview.status, 200, overview.text);
      assert.equal(overview.json.lastRun.runId, RUN_ID);
      assert.equal(overview.json.lastRun.decision, decision);
      assert.deepEqual(overview.json.nextStep, { kind: "open-result", runId: RUN_ID, decision, route: `validations/result/${RUN_ID}` }, `after a ${decision} validation`);
    }

    // The tiles carry the name of the check, its tool, its state and its findings.
    const stages = (await call("GET", "/api/overview")).json.lastRun.stages;
    assert.deepEqual(
      stages.map((s) => [s.id, s.label, s.tool, s.state, s.findings]),
      [
        ["ruff#lint", "Ruff", "ruff", "completed", 0],
        ["mypy#types", "Mypy", "mypy", "completed", 2],
        ["pytest#unit", "pytest", "pytest", "error", 0],
        ["codeql#sast", "CodeQL", "codeql", "blocked", 0],
        ["cargo#audit", "cargo audit", "cargo-audit", "not_applicable", 0],
      ],
    );
    assert.ok(stages.every((s) => s.label && s.state), "no unlabeled tile");

    // A validation that passed leaves nothing to read.
    fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify({ ...storedResult(project, "passed"), blockingViolations: 0 }));
    const passed = await call("GET", "/api/overview");
    assert.equal(passed.json.lastRun.decision, "passed");
    assert.equal(passed.json.nextStep, null);

    // The doctor card: every item names the route that fixes it, or none when it is fixed in place; a route replaces the
    // command to copy.
    const prepared = await call("POST", "/api/tools", { id: "codeql", adapter: "codeql" });
    assert.ok(prepared.status === 201 || prepared.status === 200 || prepared.status === 409, prepared.text);
    const doctor = await call("GET", "/api/prerequisites");
    assert.equal(doctor.status, 200, doctor.text);
    assert.ok(Array.isArray(doctor.json.items));
    for (const item of doctor.json.items) {
      assert.ok(item.route === null || typeof item.route === "string", `item ${item.id} has a route field`);
      if (item.route !== null) {
        assert.notEqual(item.action, "copy", `item ${item.id} has a route, not a command to copy`);
        if (item.kind === "manual") assert.equal(item.fix, null, `item ${item.id}: the route replaces the command`);
      }
    }
    const codeql = doctor.json.items.find((i) => /codeql/i.test(i.id) || i.names.some((n) => /codeql/i.test(n)));
    if (codeql) assert.equal(codeql.route, "environment?section=codeql", JSON.stringify(codeql));

    // The mapping itself, for the items the fake engine does not produce.
    const { routeOf, withRoutes } = await import(pathToFileURL(path.join(root, "jgates", "dist", "server", "routes", "prerequisites.js")).href);
    const item = (extra) => ({ id: "x", kind: "manual", classification: "essential", names: [], commands: [], action: null, hosts: [], message: null, fix: null, ...extra });
    assert.equal(routeOf(item({ id: "manual:tool:codeql", names: ["codeql"], fix: "jgates tools prepare-codeql --accept-terms" })), "environment?section=codeql");
    assert.equal(routeOf(item({ id: "manual:tool:ruff", names: ["ruff"] })), "tools");
    assert.equal(routeOf(item({ id: "docker", kind: "docker-install", names: ["docker"], action: "copy", commands: ["sudo apt install docker"] })), "environment?section=engine");
    assert.equal(routeOf(item({ id: "image", kind: "image-pull" })), "environment?section=image");
    assert.equal(routeOf(item({ id: "data", kind: "data-prepare" })), "environment?section=data");
    assert.equal(routeOf(item({ id: "git", kind: "git-trust", action: "run" })), null);
    const routed = withRoutes({ items: [item({ id: "manual:tool:codeql", names: ["codeql"], fix: "jgates tools prepare-codeql --accept-terms" }), item({ id: "docker", kind: "docker-install", names: ["docker"], action: "copy", commands: ["sudo apt install docker"] })] }).items;
    assert.equal(routed[0].fix, null, "the CodeQL command is not shown to copy");
    assert.equal(routed[1].action, null, "a sudo command is read in Ambiente, not copied from the card");
    assert.deepEqual(routed[1].commands, ["sudo apt install docker"], "the commands stay available for Ambiente");
  } finally {
    if (ui && ui.proc.exitCode === null) {
      const exited = once(ui.proc, "exit");
      ui.proc.kill("SIGTERM");
      await exited;
    }
  }
});
