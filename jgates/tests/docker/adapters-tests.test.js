import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { docker, dockerAvailable } from "./dev-docker.mjs";

// Stack test runners with the real engine (npm run test:docker; never part of npm test): go test, dotnet test (coverlet,
// FsCheck), cargo test / cargo llvm-cov, Jest, pytest and Vitest run through `jgates run` in step containers of the local
// development image jgates-tools:dev, with the project's dependencies installed into their volumes by the deps phase.
// Per stack: a known-bad fixture (a failing test and a coverage below the policy minimum) fails with both findings, and
// the clean fixture passes; its unit step runs only the unit tests and its integration step only the integration
// selection (the counts are asserted), and the properties capability is present (Hypothesis, fast-check, rapid,
// proptest, FsCheck). The project folder is byte for byte the same afterwards.
//
// With JGATES_TEST_STACKS_RECORD=1 the suite also writes, for every step, the command the plan gave, the exit code, the
// standard output and the files the runner wrote into tests/fixtures/test-stacks/recorded/: that is how the recordings
// the default suite replays (tests/adapter-test-stacks.test.js) are made.

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const dist = path.join(packageRoot, "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FIXTURES = path.join(packageRoot, "tests", "fixtures", "test-stacks");
const RECORDED = path.join(FIXTURES, "recorded");
const RECORD = process.env.JGATES_TEST_STACKS_RECORD === "1";
const MINIMUM = 80;
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const engine = await load("core", "engine", "index.js");
const { workspaceId } = await load("core", "ids", "index.js");
const IMAGE = engine.DEV_TOOLS_IMAGE;

const made = [];
const workspaces = new Set();
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};

/** Everything this suite created in the engine carries its workspace id (and the JGates labels); the cleanup selects by them only. */
function cleanup() {
  for (const ws of workspaces) {
    const filters = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${ws}`];
    for (const id of docker(["ps", "-aq", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["rm", "-f", id]);
    for (const name of docker(["volume", "ls", "-q", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["volume", "rm", "-f", name]);
  }
}

before(() => {
  assert.ok(dockerAvailable(), "Docker is required for npm run test:docker (the daemon did not answer)");
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is missing; build it with npm --prefix jgates run image:build`);
});

after(() => {
  try {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } finally {
    cleanup();
  }
});

function treeHash(root) {
  const h = crypto.createHash("sha256");
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === ".git") continue;
      if (e.isDirectory()) {
        h.update(`d:${next}\0`);
        walk(p, next);
      } else h.update(`f:${next}\0`).update(fs.readFileSync(p));
    }
  };
  walk(root, "");
  return h.digest("hex");
}

/** A project in its own folder: the fixture copied, git and JGates initialized (the test templates come in by the evidence), the policy minimum set. */
function makeProject(stack, kind) {
  const project = tmp(`jgates-adapters-tests-${stack}-${kind}-`);
  const home = tmp("jgates-adapters-tests-home-");
  fs.cpSync(path.join(FIXTURES, stack, kind), project, { recursive: true });
  const env = { ...process.env, JGATES_HOME: home, JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  delete env.JGATES_IMAGE_JSON;
  const cli = (args, timeout = 1_800_000) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  const init = cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  fs.writeFileSync(path.join(project, ".jgates", "policy.yml"), `schemaVersion: 1\nrules:\n  coverage.minimum:\n    threshold: ${MINIMUM}\n`);
  spawnSync("git", ["add", "-A"], { cwd: project });
  const ws = workspaceId(project);
  workspaces.add(ws);
  const only = (tools) => tools.flatMap((t) => ["--only", `tool:${t}`]);
  return {
    project,
    ws,
    plan: (tools) => {
      const planned = cli(["plan", "--cwd", project, "--json", ...only(tools)]);
      assert.equal(planned.status, 0, planned.stdout.slice(0, 3000) + planned.stderr.slice(0, 3000));
      return JSON.parse(planned.stdout).plan;
    },
    run: (tools) => {
      const ran = cli(["run", "--cwd", project, "--no-interactive", "--json", ...only(tools)]);
      let doc = null;
      try {
        doc = JSON.parse(ran.stdout);
      } catch {
        doc = null;
      }
      assert.ok(doc?.stages, `${tools.join(", ")}: no result document\n${ran.stdout.slice(0, 3000)}\n${ran.stderr.slice(0, 3000)}`);
      return doc;
    },
  };
}

const summary = (doc) => JSON.stringify({ decision: doc.decision, stages: doc.stages.map((s) => [s.id, s.state, s.reason]), findings: doc.findings.map((f) => [f.tool, f.ruleId, f.location?.path]) }).slice(0, 5000);

function logsOf(doc) {
  const dir = path.join(doc.runDir, "logs");
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => `== ${n}\n${fs.readFileSync(path.join(dir, n), "utf8")}`).join("\n").slice(-6000) : "";
}

const metric = (doc, id, origin) => doc.metrics?.find((m) => m.id === id && (!origin || m.origin === origin));
const stage = (doc, id) => doc.stages.find((s) => s.id === id);

/** The step went through the engine: a step container of the image with the contract's flags, and none is left. */
function assertRanInContainers(doc, ws) {
  const logs = logsOf(doc);
  for (const part of ["run --rm --init --pull never --name", "--read-only", "--cap-drop ALL"]) assert.ok(logs.includes(part), `a step log holds the docker run flag ${part}`);
  assert.ok(!/HOST_EXECUTION_REFUSED/.test(JSON.stringify(doc.stages)), "no step was refused");
  assert.equal(docker(["ps", "-aq", "--filter", `label=org.jgates.workspace=${ws}`]).out.trim(), "", "no container of the run is left");
}

const TEXT_OUTPUT = /\.(?:json|xml|trx|out)$/;

/** Writes what each runner printed and wrote, for the replay of the default suite (JGATES_TEST_STACKS_RECORD=1). */
function record(stack, kind, plan, doc) {
  if (!RECORD) return;
  fs.mkdirSync(RECORDED, { recursive: true });
  for (const invocation of plan.invocations) {
    const tool = invocation.id;
    const st = doc.stages.find((s) => s.adapter === invocation.adapter && s.id.startsWith(`${tool}#`) && /^exit /.test(s.nativeStatus ?? ""));
    if (!st) continue;
    const outDir = path.join(doc.runDir, "outputs", invocation.adapter, tool);
    const files = {};
    const walk = (abs, rel) => {
      if (!fs.existsSync(abs)) return;
      for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const nextAbs = path.join(abs, e.name);
        const nextRel = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(nextAbs, nextRel);
        else if (TEXT_OUTPUT.test(e.name)) files[nextRel] = fs.readFileSync(nextAbs, "utf8");
      }
    };
    walk(outDir, `outputs/${invocation.adapter}/${tool}`);
    const stdout = fs.readFileSync(path.join(doc.runDir, "logs", `${tool}.stdout.log`), "utf8");
    const doc2 = { stack, kind, tool, adapter: invocation.adapter, args: invocation.command.args, exit: Number(st.nativeStatus.slice(5)), stdout, files };
    fs.writeFileSync(path.join(RECORDED, `${stack}.${kind}.${tool}.json`), JSON.stringify(doc2, null, 1) + "\n");
  }
}

/** The known-bad fixture: a failing test (a finding of the runner) and a coverage below the minimum; the run fails. */
function proveBad(stack, { tool, adapter, test: failing }) {
  const p = makeProject(stack, "bad");
  const before = treeHash(p.project);
  const plan = p.plan([tool]);
  const doc = p.run([tool]);
  assert.equal(treeHash(p.project), before, "the project folder is identical after the run");
  assertRanInContainers(doc, p.ws);
  const unit = stage(doc, `${tool}#unit`);
  assert.equal(unit?.state, "completed", `${summary(doc)}\n${logsOf(doc)}`);
  assert.notEqual(unit.interpreted, false, summary(doc));
  const failed = doc.findings.filter((f) => f.origin === adapter && /test-failed$/.test(f.ruleId));
  assert.ok(failed.some((f) => failing.test(f.message)), `the failing test is a finding: ${summary(doc)}`);
  const coverage = stage(doc, `${tool}#coverage`);
  assert.equal(coverage?.state, "completed", `${summary(doc)}\n${logsOf(doc)}`);
  const cov = metric(doc, "coverage.lines", adapter);
  assert.ok(cov && cov.measured !== false && cov.value < MINIMUM, `coverage is measured below ${MINIMUM}%: ${JSON.stringify(cov)}`);
  assert.ok(doc.findings.some((f) => f.origin === adapter && /coverage-below-minimum$/.test(f.ruleId)), `the low coverage is a finding: ${summary(doc)}`);
  assert.equal(doc.decision, "failed", summary(doc));
  record(stack, "bad", plan, doc);
}

/** The clean fixture: unit (without the integration tests), coverage over the minimum, properties present, and the integration selection alone. */
function proveClean(stack, { tool, adapter, unit, integration, properties, coverage = true }) {
  const p = makeProject(stack, "clean");
  const before = treeHash(p.project);
  const tools = [tool, `${tool}-integration`];
  const plan = p.plan(tools);
  const doc = p.run(tools);
  assert.equal(treeHash(p.project), before, "the project folder is identical after the run");
  assertRanInContainers(doc, p.ws);
  assert.equal(stage(doc, `${tool}#unit`)?.state, "completed", `${summary(doc)}\n${logsOf(doc)}`);
  assert.equal(stage(doc, `${tool}-integration#integration`)?.state, "completed", `${summary(doc)}\n${logsOf(doc)}`);
  const executed = (prefix) => metric(doc, `${prefix}.executed`, adapter)?.value ?? metric(doc, `${prefix}.total`, adapter)?.value;
  assert.equal(executed("tests"), unit, `the unit step ran only the unit tests: ${JSON.stringify(doc.metrics)}`);
  assert.equal(executed("tests.integration"), integration, `the integration step ran only the integration selection: ${JSON.stringify(doc.metrics)}`);
  const prop = stage(doc, `${tool}#properties`);
  assert.equal(prop?.state, "completed", `the properties capability is present: ${summary(doc)}`);
  assert.equal(metric(doc, "tests.property.total", adapter)?.value, properties, JSON.stringify(doc.metrics));
  if (coverage) {
    assert.equal(stage(doc, `${tool}#coverage`)?.state, "completed", summary(doc));
    const cov = metric(doc, "coverage.lines", adapter);
    assert.ok(cov && cov.value >= MINIMUM, `coverage is measured over ${MINIMUM}%: ${JSON.stringify(cov)}`);
  }
  assert.equal(doc.findings.filter((f) => f.origin === adapter).length, 0, summary(doc));
  assert.equal(doc.decision, "passed", `${summary(doc)}\n${logsOf(doc)}`);
  record(stack, "clean", plan, doc);
}

test("tests go: go test reports the failing test and the low coverage; the clean module passes with rapid properties and the tagged integration tests apart", () => {
  proveBad("go", { tool: "go-test", adapter: "go-test", test: /TestAdd\b/ });
  proveClean("go", { tool: "go-test", adapter: "go-test", unit: 3, integration: 2, properties: 1 });
});

test("tests rust: cargo llvm-cov reports the failing test and the low coverage; the clean crate passes with proptest properties and the tests/ targets apart", () => {
  proveBad("rust", { tool: "cargo-test", adapter: "cargo-test", test: /adds_two_numbers/ });
  proveClean("rust", { tool: "cargo-test", adapter: "cargo-test", unit: 3, integration: 2, properties: 1 });
});

test("tests csharp: dotnet test with coverlet reports the failing test and the low coverage; the clean project passes with FsCheck properties and Category=Integration apart", () => {
  proveBad("csharp", { tool: "dotnet-test", adapter: "dotnet-test", test: /AddsTwoNumbers/ });
  proveClean("csharp", { tool: "dotnet-test", adapter: "dotnet-test", unit: 3, integration: 2, properties: 1 });
});

test("tests javascript: Jest reports the failing test and the low coverage; the clean project passes with fast-check properties and the integration files apart", () => {
  proveBad("jest", { tool: "jest", adapter: "jest", test: /adds two numbers/ });
  proveClean("jest", { tool: "jest", adapter: "jest", unit: 3, integration: 2, properties: 1 });
});

test("tests python: pytest runs the unit tests with Hypothesis properties and tests/integration apart", () => {
  proveClean("python", { tool: "pytest", adapter: "pytest", unit: 3, integration: 2, properties: 1 });
});

test("tests typescript: Vitest runs the unit tests with fast-check properties and the integration files apart", () => {
  proveClean("vitest", { tool: "vitest", adapter: "vitest", unit: 3, integration: 2, properties: 1 });
});
