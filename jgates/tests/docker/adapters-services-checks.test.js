import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { docker, dockerAvailable } from "./dev-docker.mjs";

// The checks that came with the services and the budgets, through the real engine (npm run test:docker; never part of
// npm test): Playwright e2e (Playwright Test and pytest-playwright) against a web service of the fixture's compose file,
// migration drift (Alembic and Prisma against a PostgreSQL service, EF Core with the tools image's dotnet-ef), Stryker.NET
// mutation testing, the performance budgets of every stack (pytest-benchmark, vitest bench, go test -bench, criterion,
// BenchmarkDotNet) and dotnet list package --vulnerable. Each one runs through `jgates run` in step containers of the
// local development image jgates-tools:dev, with the project's dependencies installed into their volumes by the deps
// phase and the compose services started by the services phase. Per check: the known-bad fixture fails with the
// expected finding and the clean twin passes; the project folder is byte for byte the same afterwards.
//
// With JGATES_SERVICES_CHECKS_RECORD=1 the suite also writes, for every step, the commands the plan gave, their exit
// codes, their standard output and the files the tools wrote into the run folder, into
// tests/fixtures/e2e-migration-performance/recorded/: that is how the recordings the default suite replays
// (tests/adapter-e2e-migration-performance.test.js) are made.

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const dist = path.join(packageRoot, "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FIXTURES = path.join(packageRoot, "tests", "fixtures", "e2e-migration-performance");
const RECORDED = path.join(FIXTURES, "recorded");
const RECORD = process.env.JGATES_SERVICES_CHECKS_RECORD === "1";
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const engine = await load("core", "engine", "index.js");
const { workspaceId } = await load("core", "ids", "index.js");
const IMAGE = engine.DEV_TOOLS_IMAGE;

const WEB = "services:\n  compose: [compose.yaml]\n  target:\n    service: web\n    port: 8080\n    path: /\n    health: /\n";
const DB = "services:\n  compose: [compose.yaml]\n  timeoutSeconds: 180\n";
// The solution is one component, so one dependency unit restores both of its projects (discovery alone sees one
// component per project folder).
const SOLUTION = "schemaVersion: 1\ndiscovery:\n  mode: explicit\ncomponents:\n  - id: calc\n    path: .\n    language: csharp\n    dependencies:\n      manager: dotnet\n";

/** The fixtures: their tool instance (.jgates/tools.yml) and the services section of jgates.yml. */
const CASES = {
  "e2e-ts": { tool: "playwright", adapter: "playwright", services: WEB, body: "    e2eRunner: playwright-test\n    timeoutSeconds: 900\n", capability: "e2e" },
  "e2e-py": { tool: "pytest-playwright", adapter: "playwright", services: WEB, body: "    e2eRunner: pytest\n    timeoutSeconds: 900\n", capability: "e2e" },
  "migration-alembic": { tool: "alembic-drift", adapter: "migration-drift", services: DB, body: "    framework: alembic\n    databaseUrl: postgresql+pg8000://app:app@db:5432/app\n", capability: "migration" },
  "migration-prisma": { tool: "prisma-drift", adapter: "migration-drift", services: DB, body: "    framework: prisma\n    databaseUrl: postgresql://app:app@db:5432/app\n", capability: "migration" },
  "migration-efcore": { tool: "efcore-drift", adapter: "migration-drift", services: DB, body: "    framework: efcore\n    databaseUrl: Host=db;Database=app;Username=app;Password=app\n    timeoutSeconds: 900\n", capability: "migration" },
  "migration-squawk": { tool: "squawk", adapter: "migration-drift", services: null, body: "    framework: squawk\n", capability: "migration" },
  "mutation-dotnet": { tool: "stryker-net", adapter: "mutation", services: null, body: "    engine: stryker-net\n    minimumScore: 80\n    timeoutSeconds: 1800\n", capability: "mutation", workspace: SOLUTION },
  "perf-python": { tool: "pytest-benchmark", adapter: "performance", services: null, body: "    harness: pytest-benchmark\n    budgets:\n      \"*test_fib_bench\": 5\n", capability: "performance" },
  "perf-ts": { tool: "vitest-bench", adapter: "performance", services: null, body: "    harness: vitest-bench\n    budgets:\n      \"*fib(20)\": 5\n", capability: "performance" },
  "perf-go": { tool: "go-bench", adapter: "performance", services: null, body: "    harness: go-bench\n    budgets:\n      \"*BenchmarkFib20\": 5\n", capability: "performance" },
  "perf-rust": { tool: "criterion", adapter: "performance", services: null, body: "    harness: criterion\n    timeoutSeconds: 1800\n    budgets:\n      fib_20: 5\n", capability: "performance" },
  "perf-dotnet": { tool: "benchmarkdotnet", adapter: "performance", services: null, body: "    harness: benchmarkdotnet\n    timeoutSeconds: 1800\n    budgets:\n      \"*Fib20\": 5\n", capability: "performance" },
  "dotnet-vulnerable": { tool: "dotnet-vulnerable", adapter: "dotnet-vulnerable", services: null, body: "", capability: "dependencies" },
};

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
    for (const name of docker(["network", "ls", "-q", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["network", "rm", name]);
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

/** A project in its own folder: the fixture copied, git and JGates initialized, the instance declared, the services section added. */
function makeProject(name, kind) {
  const spec = CASES[name];
  const project = tmp(`jgates-services-checks-${name}-${kind}-`);
  const home = tmp("jgates-services-checks-home-");
  fs.cpSync(path.join(FIXTURES, name, kind), project, { recursive: true });
  const env = { ...process.env, JGATES_HOME: home, JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  delete env.JGATES_IMAGE_JSON;
  const cli = (args, timeout = 3_600_000) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  const init = cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  if (spec.workspace) fs.writeFileSync(path.join(project, ".jgates", "workspace.yml"), spec.workspace);
  fs.writeFileSync(path.join(project, ".jgates", "tools.yml"), `schemaVersion: 1\ntools:\n  ${spec.tool}:\n    adapter: ${spec.adapter}\n    capabilities: [${spec.capability}]\n${spec.body}`);
  if (spec.services) fs.appendFileSync(path.join(project, "jgates.yml"), spec.services);
  spawnSync("git", ["add", "-A"], { cwd: project });
  const ws = workspaceId(project);
  workspaces.add(ws);
  const only = ["--only", `tool:${spec.tool}`];
  return {
    project,
    ws,
    plan: () => {
      const planned = cli(["plan", "--cwd", project, "--json", ...only]);
      assert.equal(planned.status, 0, planned.stdout.slice(0, 3000) + planned.stderr.slice(0, 3000));
      return JSON.parse(planned.stdout).plan;
    },
    run: () => {
      const ran = cli(["run", "--cwd", project, "--no-interactive", "--json", ...only]);
      let doc = null;
      try {
        doc = JSON.parse(ran.stdout);
      } catch {
        doc = null;
      }
      assert.ok(doc?.stages, `${name}: no result document\n${ran.stdout.slice(0, 3000)}\n${ran.stderr.slice(0, 3000)}`);
      return doc;
    },
  };
}

const summary = (doc) => JSON.stringify({ decision: doc.decision, stages: doc.stages.map((s) => [s.id, s.state, s.reason]), findings: doc.findings.map((f) => [f.tool, f.ruleId, f.location?.path, f.message]) }).slice(0, 6000);

function logsOf(doc) {
  const dir = path.join(doc.runDir, "logs");
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => `== ${n}\n${fs.readFileSync(path.join(dir, n), "utf8")}`).join("\n").slice(-8000) : "";
}

const stage = (doc, id) => doc.stages.find((s) => s.id === id);
const metric = (doc, id, origin) => doc.metrics?.find((m) => m.id === id && (!origin || m.origin === origin));

/** The step went through the engine: a step container of the image with the contract's flags, and none is left. */
function assertRanInContainers(doc, ws) {
  // The header of a step's stderr log holds its docker run line (read whole: a tool's long output follows it).
  const dir = path.join(doc.runDir, "logs");
  const headers = fs.readdirSync(dir).filter((n) => n.endsWith(".stderr.log")).map((n) => fs.readFileSync(path.join(dir, n), "utf8").slice(0, 20_000));
  for (const part of ["run --rm --init --pull never --name", "--read-only", "--cap-drop ALL"]) assert.ok(headers.some((h) => h.includes(part)), `a step log holds the docker run flag ${part}`);
  assert.ok(!/HOST_EXECUTION_REFUSED/.test(JSON.stringify(doc.stages)), "no step was refused");
  assert.equal(docker(["ps", "-aq", "--filter", `label=org.jgates.workspace=${ws}`]).out.trim(), "", "no container of the run is left");
}

const RECORDED_FILE = /\.(?:json|xml)$/;

/** Writes what each tool printed and wrote, for the replay of the default suite (JGATES_SERVICES_CHECKS_RECORD=1). */
function record(name, kind, plan, doc) {
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
        // What the adapter itself writes there (the baseline candidate) is not the tool's.
        else if (RECORDED_FILE.test(e.name) && e.name !== "baseline-candidate.json") files[nextRel] = fs.readFileSync(nextAbs, "utf8");
      }
    };
    walk(outDir, `outputs/${invocation.adapter}/${tool}`);
    const commands = [invocation.command, ...(invocation.contract?.more ?? [])];
    // The migration and performance overrides receive the command's own name before its arguments.
    const named = invocation.adapter === "migration-drift" || invocation.adapter === "performance";
    const runs = commands.map((command, i) => {
      const suffix = i === 0 ? "" : `.${i + 1}`;
      const log = (stream) => {
        const file = path.join(doc.runDir, "logs", `${tool}${suffix}.${stream}.log`);
        return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      };
      const last = i === commands.length - 1;
      return {
        args: named ? [path.posix.basename(command.executable), ...command.args] : command.args,
        exit: last ? Number(st.nativeStatus.slice(5)) : 0,
        stdout: log("stdout"),
        files: last ? files : {},
      };
    });
    const out = { case: name, kind, tool, adapter: invocation.adapter, runs };
    fs.writeFileSync(path.join(RECORDED, `${name}.${kind}.${tool}.json`), JSON.stringify(out, null, 1) + "\n");
  }
}

/** Runs one fixture through plan and run; the project is untouched and every step ran in a container. */
function runFixture(name, kind) {
  const spec = CASES[name];
  const p = makeProject(name, kind);
  const before = treeHash(p.project);
  const plan = p.plan();
  const doc = p.run();
  assert.equal(treeHash(p.project), before, "the project folder is identical after the run");
  assertRanInContainers(doc, p.ws);
  const st = stage(doc, `${spec.tool}#${spec.capability}`);
  assert.equal(st?.state, "completed", `${summary(doc)}\n${logsOf(doc)}`);
  assert.notEqual(st.interpreted, false, `${summary(doc)}\n${logsOf(doc)}`);
  record(name, kind, plan, doc);
  return { doc, st, origin: spec.adapter };
}

function proveBad(name, ruleId, message) {
  const { doc, origin } = runFixture(name, "bad");
  const found = doc.findings.filter((f) => f.origin === origin && ruleId.test(f.ruleId));
  assert.ok(found.length > 0 && found.some((f) => message.test(f.message)), `the known-bad fixture has the finding: ${summary(doc)}`);
  assert.equal(doc.decision, "failed", summary(doc));
  return doc;
}

function proveClean(name) {
  const { doc, origin } = runFixture(name, "clean");
  assert.equal(doc.findings.filter((f) => f.origin === origin && f.blocking).length, 0, summary(doc));
  assert.equal(doc.decision, "passed", `${summary(doc)}\n${logsOf(doc)}`);
  return doc;
}

test("e2e typescript: Playwright Test against the compose web service reports the failing e2e test, and the clean twin passes [proves: playwright#e2e@typescript]", () => {
  const bad = proveBad("e2e-ts", /^playwright\.e2e-failed$/, /the home page shows the store name/);
  assert.equal(metric(bad, "tests.e2e.failed", "playwright")?.value, 1, JSON.stringify(bad.metrics));
  const clean = proveClean("e2e-ts");
  assert.equal(metric(clean, "tests.e2e.passed", "playwright")?.value, 1, JSON.stringify(clean.metrics));
  assert.match(stage(clean, "playwright#e2e").reason, /against http:\/\/web:8080/);
});

test("e2e python: pytest-playwright against the compose web service reports the failing e2e test, and the clean twin passes [proves: playwright#e2e@python]", () => {
  proveBad("e2e-py", /^playwright\.e2e-failed$/, /test_home_shows_store_name/);
  const clean = proveClean("e2e-py");
  assert.equal(metric(clean, "tests.e2e.passed", "playwright")?.value, 1, JSON.stringify(clean.metrics));
});

test("migration python: Alembic against the compose PostgreSQL reports the column without a migration, and the clean twin agrees [proves: migration-drift#migration@python]", () => {
  proveBad("migration-alembic", /^migration-drift\.alembic$/, /New upgrade operations detected/);
  proveClean("migration-alembic");
});

test("migration typescript: Prisma migrate diff with the compose PostgreSQL as the shadow database reports the field without a migration, and the clean twin agrees [proves: migration-drift#migration@typescript]", () => {
  proveBad("migration-prisma", /^migration-drift\.prisma$/, /email/i);
  proveClean("migration-prisma");
});

test("migration csharp: dotnet-ef has-pending-model-changes reports the property without a migration, and the clean twin agrees [proves: migration-drift#migration@csharp]", () => {
  proveBad("migration-efcore", /^migration-drift\.efcore$/, /Changes have been made to the model/);
  proveClean("migration-efcore");
});

test("migration any: squawk reports the risky SQL migration with its location, and the safe twin is clean [proves: migration-drift#migration@any]", () => {
  const bad = proveBad("migration-squawk", /^squawk\.adding-required-field$/, /not null/);
  assert.ok(bad.findings.some((f) => f.location?.path === "migrations/0002_email.sql" && f.location.line === 3), summary(bad));
  proveClean("migration-squawk");
});

test("mutation csharp: Stryker.NET reports the survivors and the score below the minimum of the weak tests, and the strong tests reach it [proves: mutation#mutation@csharp]", () => {
  const bad = proveBad("mutation-dotnet", /^mutation\.score-below-minimum$/, /below the minimum of 80%/);
  assert.ok(bad.findings.some((f) => f.ruleId === "mutation.survived" && /^src\/Calc\/Age\.cs$/.test(f.location?.path ?? "")), summary(bad));
  const clean = proveClean("mutation-dotnet");
  assert.ok(metric(clean, "mutation.score", "mutation")?.value >= 80, JSON.stringify(clean.metrics));
});

test("performance python: pytest-benchmark over its budget is a finding, and the fast twin is within it [proves: performance#performance@python]", () => {
  proveBad("perf-python", /^performance\.budget-exceeded$/, /test_fib_bench/);
  proveClean("perf-python");
});

test("performance typescript: vitest bench over its budget is a finding, and the fast twin is within it [proves: performance#performance@typescript]", () => {
  proveBad("perf-ts", /^performance\.budget-exceeded$/, /fib\(20\)/);
  proveClean("perf-ts");
});

test("performance go: go test -bench over its budget is a finding, and the fast twin is within it [proves: performance#performance@go]", () => {
  proveBad("perf-go", /^performance\.budget-exceeded$/, /BenchmarkFib20/);
  proveClean("perf-go");
});

test("performance rust: criterion over its budget is a finding, and the fast twin is within it [proves: performance#performance@rust]", () => {
  proveBad("perf-rust", /^performance\.budget-exceeded$/, /fib_20/);
  proveClean("perf-rust");
});

test("performance csharp: BenchmarkDotNet over its budget is a finding, and the fast twin is within it [proves: performance#performance@csharp]", () => {
  proveBad("perf-dotnet", /^performance\.budget-exceeded$/, /Fib20/);
  proveClean("perf-dotnet");
});

test("dependencies csharp: dotnet list package --vulnerable reports the vulnerable Newtonsoft.Json, and the patched twin is clean [proves: dotnet-vulnerable#dependencies@csharp]", () => {
  proveBad("dotnet-vulnerable", /^GHSA-/, /Newtonsoft\.Json 12\.0\.1/);
  proveClean("dotnet-vulnerable");
});
