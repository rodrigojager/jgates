import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// The checks that came with the services and the budgets: Playwright e2e (Playwright Test, pytest-playwright), migration
// drift (Alembic, Prisma, EF Core) and the SQL migration linter (squawk), Stryker.NET mutation testing, the performance
// budgets of every stack (pytest-benchmark, vitest bench, go test -bench, criterion, BenchmarkDotNet) and dotnet list
// package --vulnerable, each on a known-bad and a clean fixture, through the real init, plan and run services. The tools
// are not on every machine that runs the default suite, so the overrides of the tools image (JGATES_PLAYWRIGHT,
// JGATES_MIGRATION_TOOL, JGATES_BENCHMARK, JGATES_DOTNET_STRYKER, JGATES_DOTNET) point at
// tests/fixtures/e2e-migration-performance/replay.mjs, which replays what the REAL tools printed and wrote for the
// fixture, recorded by tests/docker/adapters-services-checks.test.js through the real engine and the fixtures' compose
// services (recorded/<case>.<kind>.<tool>.json, chosen by the content of the working folder and checked against the
// plan's commands). Also: without services, e2e and migration are SERVICES_REQUIRED (the action sets the services up,
// never a blocker); a tool the image lacks is the shared TOOL_MISSING cause; the parsers are fail-closed.

process.env.JGATES_LOCALE = "en";
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const FIXTURES = path.join(here, "fixtures", "e2e-migration-performance");
const REPLAY = path.join(FIXTURES, "replay.mjs");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const { planInit, writeInit } = await load("core", "init", "index.js");
const { buildPlan, validatePlanDocument } = await load("core", "plan", "index.js");
const { executeRun } = await load("core", "run", "index.js");
const { planSteps, planDisabled } = await load("core", "run", "plan-run.js");
const { withLocale } = await load("i18n", "index.js");
const playwright = await load("adapters", "playwright", "index.js");
const migration = await load("adapters", "migration-drift", "index.js");
const performance = await load("adapters", "performance", "index.js");
const vulnerable = await load("adapters", "dotnet-vulnerable", "index.js");
const mutation = await load("adapters", "mutation", "index.js");
const { imageJsonWithout } = await import(pathToFileURL(path.join(here, "setup", "image-json.mjs")).href);

const WEB = "services:\n  compose: [compose.yaml]\n  target:\n    service: web\n    port: 8080\n    path: /\n    health: /\n";
const DB = "services:\n  compose: [compose.yaml]\n  timeoutSeconds: 180\n";
// The solution is one component, so one dependency unit restores both of its projects (discovery alone sees one
// component per project folder).
const SOLUTION = "schemaVersion: 1\ndiscovery:\n  mode: explicit\ncomponents:\n  - id: calc\n    path: .\n    language: csharp\n    dependencies:\n      manager: dotnet\n";

/** The same instances and services sections as the real-engine suite (the recordings answer exactly these commands). */
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
const tmp = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const home = tmp("jgates-services-checks-home-");
const baseEnv = {
  ...process.env,
  JGATES_HOME: home,
  JGATES_NO_CACHE: "1",
  NO_COLOR: "1",
  JGATES_LOCALE: "en",
  JGATES_PLAYWRIGHT: REPLAY,
  JGATES_MIGRATION_TOOL: REPLAY,
  JGATES_BENCHMARK: REPLAY,
  JGATES_DOTNET_STRYKER: REPLAY,
  JGATES_DOTNET: REPLAY,
};

function treeHash(root) {
  const h = crypto.createHash("sha256");
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === ".git" || e.name === ".jgates") continue;
      if (e.isDirectory()) {
        h.update(`d:${next}\0`);
        walk(p, next);
      } else h.update(`f:${next}\0`).update(fs.readFileSync(p));
    }
  };
  walk(root, "");
  return h.digest("hex");
}

/** A workspace with one fixture, initialized by the real init service, the instance declared and (by default) the services section. */
function workspace(name, kind, { services = true } = {}) {
  const spec = CASES[name];
  const dir = tmp(`jgates-services-checks-${name}-${kind}-`);
  fs.cpSync(path.join(FIXTURES, name, kind), dir, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  writeInit(dir, planInit(dir, "minimal"));
  if (spec.workspace) fs.writeFileSync(path.join(dir, ".jgates", "workspace.yml"), spec.workspace);
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), `schemaVersion: 1\ntools:\n  ${spec.tool}:\n    adapter: ${spec.adapter}\n    capabilities: [${spec.capability}]\n${spec.body}`);
  if (services && spec.services) fs.appendFileSync(path.join(dir, "jgates.yml"), spec.services);
  return dir;
}

function plan(dir, { only = [], env = baseEnv, profile } = {}) {
  const built = buildPlan(dir, { only: only.map((t) => `tool:${t}`), env, home, compare: false, version: "test", ...(profile ? { profile } : {}) });
  assert.equal(built.ok, true, JSON.stringify(built.errors ?? built.error));
  return built.plan;
}

function execute(dir, builtPlan, env = baseEnv) {
  return executeRun({
    workspacePath: dir,
    home,
    version: "test",
    adapter: "quality-bridge",
    options: { planHash: builtPlan.planHash, planSource: "built", profile: "minimal", scope: "full" },
    plan: builtPlan,
    steps: (context) => planSteps(context, builtPlan),
    disabled: planDisabled(builtPlan),
    env,
    cache: false,
  });
}

const stage = (doc, id) => doc.stages.find((s) => s.id === id);
const metric = (doc, id, origin) => (doc.metrics ?? []).find((m) => m.id === id && (!origin || m.origin === origin));
const summary = (doc) => JSON.stringify({ decision: doc.decision, stages: doc.stages.map((s) => [s.id, s.state, s.reason]), findings: doc.findings.map((f) => [f.ruleId, f.location?.path, f.message]) }).slice(0, 4000);

/** Plans and runs one fixture with its instance alone; the stage completed and was interpreted; the fixture is untouched. */
async function runFixture(name, kind) {
  const spec = CASES[name];
  const dir = workspace(name, kind);
  const before = treeHash(dir);
  const built = plan(dir, { only: [spec.tool] });
  const item = built.groups.willRun.find((i) => i.id === `${spec.tool}#${spec.capability}`);
  assert.ok(item, `${spec.tool}#${spec.capability} is planned: ${built.groups.willRun.map((i) => i.id).join(", ")}`);
  assert.equal(item.adapter, spec.adapter);
  assert.equal(item.availability.status, "available", item.availability.reason ?? "");
  assert.deepEqual(validatePlanDocument(built), []);
  const doc = await execute(dir, built);
  const st = stage(doc, item.id);
  assert.equal(st?.state, "completed", summary(doc));
  assert.notEqual(st.interpreted, false, summary(doc));
  assert.equal(treeHash(dir), before, "the fixture is byte for byte the same");
  return { doc, built, st, origin: spec.adapter };
}

async function proveBad(name, ruleId, message) {
  const r = await runFixture(name, "bad");
  const hits = r.doc.findings.filter((f) => f.origin === r.origin && ruleId.test(f.ruleId) && message.test(f.message));
  assert.ok(hits.length > 0, `the known-bad fixture has the finding: ${summary(r.doc)}`);
  assert.ok(hits.every((f) => f.blocking === true), summary(r.doc));
  assert.equal(r.doc.decision, "failed", summary(r.doc));
  return { ...r, hits };
}

async function proveClean(name) {
  const r = await runFixture(name, "clean");
  assert.equal(r.doc.findings.filter((f) => f.origin === r.origin).length, 0, summary(r.doc));
  assert.equal(r.doc.decision, "passed", summary(r.doc));
  return r;
}

test("e2e typescript (Playwright Test): the failing e2e test is a located finding and the clean twin passes [proves: playwright#e2e, playwright#e2e@typescript, playwright#e2e@javascript]", async () => {
  const bad = await proveBad("e2e-ts", /^playwright\.e2e-failed$/, /the home page shows the store name.*toHaveText/s);
  assert.deepEqual(bad.hits.map((f) => [f.location?.path, f.location?.line]), [["e2e/home.spec.ts", 5]]);
  assert.equal(metric(bad.doc, "tests.e2e.failed", "playwright")?.value, 1);
  // The application under test is the services target, handed over as BASE_URL.
  const invocation = bad.built.invocations.find((i) => i.id === "playwright");
  assert.equal(invocation.command.env.BASE_URL, "http://web:8080");
  assert.deepEqual(invocation.contract.service, { name: "web", port: 8080, path: "" });
  const clean = await proveClean("e2e-ts");
  assert.equal(metric(clean.doc, "tests.e2e.passed", "playwright")?.value, 1);
  assert.match(clean.st.reason, /Playwright Test 1\.65\.0 against http:\/\/web:8080: 1 test executed, 0 failed/);
});

test("e2e python (pytest-playwright): the failing e2e test is a finding and the clean twin passes [proves: playwright#e2e@python]", async () => {
  const bad = await proveBad("e2e-py", /^playwright\.e2e-failed$/, /test_home_shows_store_name/);
  assert.equal(bad.hits[0].location?.path, "tests/test_home.py");
  const invocation = bad.built.invocations.find((i) => i.id === "pytest-playwright");
  assert.deepEqual(invocation.command.args.slice(-2), ["--base-url", "http://web:8080"]);
  const clean = await proveClean("e2e-py");
  assert.equal(metric(clean.doc, "tests.e2e.passed", "playwright")?.value, 1);
});

test("migration python (Alembic): the column without a migration is a drift finding and the clean twin agrees [proves: migration-drift#migration, migration-drift#migration@python]", async () => {
  const bad = await proveBad("migration-alembic", /^migration-drift\.alembic$/, /New upgrade operations detected.*email/s);
  assert.equal(bad.hits[0].location?.path, "alembic.ini");
  // alembic upgrade head first, then alembic check, with the services database in DATABASE_URL.
  const invocation = bad.built.invocations.find((i) => i.id === "alembic-drift");
  assert.deepEqual([invocation.command.args.slice(-2), invocation.contract.more.map((c) => c.args.slice(-1))], [["upgrade", "head"], [["check"]]]);
  assert.equal(invocation.command.env.DATABASE_URL, "postgresql+pg8000://app:app@db:5432/app");
  await proveClean("migration-alembic");
});

test("migration typescript (Prisma): the field without a migration is a drift finding and the clean twin agrees [proves: migration-drift#migration@typescript, migration-drift#migration@javascript]", async () => {
  const bad = await proveBad("migration-prisma", /^migration-drift\.prisma$/, /email/);
  assert.equal(bad.hits[0].location?.path, "prisma/migrations");
  await proveClean("migration-prisma");
});

test("migration csharp (EF Core): the property without a migration is a drift finding and the clean twin agrees [proves: migration-drift#migration@csharp]", async () => {
  const bad = await proveBad("migration-efcore", /^migration-drift\.efcore$/, /Changes have been made to the model since the last migration/);
  assert.equal(bad.hits[0].location?.path, "App.csproj");
  await proveClean("migration-efcore");
});

test("migration any (squawk): the risky SQL migration is a located finding and the safe twin is clean [proves: migration-drift#migration@any]", async () => {
  const bad = await proveBad("migration-squawk", /^squawk\./, /./);
  assert.ok(bad.hits.some((f) => f.ruleId === "squawk.adding-required-field" && f.location?.path === "migrations/0002_email.sql" && f.location.line === 3), summary(bad.doc));
  await proveClean("migration-squawk");
});

test("mutation csharp (Stryker.NET): the weak tests leave survivors and a score below the minimum, the strong tests reach it [proves: mutation#mutation@csharp]", async () => {
  const bad = await proveBad("mutation-dotnet", /^mutation\.score-below-minimum$/, /below the minimum of 80%/);
  assert.ok(bad.doc.findings.some((f) => f.ruleId === "mutation.survived" && f.location?.path === "src/Calc/Age.cs" && typeof f.location.line === "number"), summary(bad.doc));
  assert.ok(metric(bad.doc, "mutation.score", "mutation")?.value < 80);
  const clean = await runFixture("mutation-dotnet", "clean");
  assert.ok(metric(clean.doc, "mutation.score", "mutation")?.value >= 80, JSON.stringify(clean.doc.metrics));
  assert.equal(clean.doc.findings.filter((f) => f.blocking).length, 0, summary(clean.doc));
  assert.equal(clean.doc.decision, "passed", summary(clean.doc));
});

/** The slow fixture breaks its budget of 5 ms and leaves a baseline candidate; the fast twin stays within it. */
async function provePerformance(name, benchmark) {
  const bad = await proveBad(name, /^performance\.budget-exceeded$/, benchmark);
  const mean = bad.doc.metrics.find((m) => m.origin === "performance" && m.id.startsWith("performance.mean."));
  assert.ok(mean && mean.unit === "ms" && mean.value > 5, JSON.stringify(bad.doc.metrics));
  const candidate = JSON.parse(fs.readFileSync(path.join(bad.doc.runDir, "outputs", "performance", CASES[name].tool, "baseline-candidate.json"), "utf8"));
  assert.ok(Object.keys(candidate.benchmarks).some((k) => benchmark.test(k)), JSON.stringify(candidate));
  const clean = await proveClean(name);
  assert.ok(clean.doc.metrics.some((m) => m.origin === "performance" && m.id.startsWith("performance.mean.") && m.value < 5), JSON.stringify(clean.doc.metrics));
}

test("performance python (pytest-benchmark): a benchmark over its budget is a finding and the fast twin passes [proves: performance#performance, performance#performance@python]", async () => {
  await provePerformance("perf-python", /test_fib_bench/);
});

test("performance typescript (vitest bench): a benchmark over its budget is a finding and the fast twin passes [proves: performance#performance@typescript, performance#performance@javascript]", async () => {
  await provePerformance("perf-ts", /fib\(20\)/);
});

test("performance go (go test -bench): a benchmark over its budget is a finding and the fast twin passes [proves: performance#performance@go]", async () => {
  await provePerformance("perf-go", /BenchmarkFib20/);
});

test("performance rust (criterion): a benchmark over its budget is a finding and the fast twin passes [proves: performance#performance@rust]", async () => {
  await provePerformance("perf-rust", /fib_20/);
});

test("performance csharp (BenchmarkDotNet): a benchmark over its budget is a finding and the fast twin passes [proves: performance#performance@csharp]", async () => {
  await provePerformance("perf-dotnet", /Fib20/);
});

test("dependencies csharp (dotnet list package --vulnerable): the vulnerable Newtonsoft.Json is a finding and the patched twin is clean [proves: dotnet-vulnerable#dependencies, dotnet-vulnerable#dependencies@csharp]", async () => {
  const bad = await proveBad("dotnet-vulnerable", /^GHSA-/, /Newtonsoft\.Json 12\.0\.1/);
  assert.equal(bad.hits[0].location?.path, "App.csproj");
  assert.equal(bad.hits[0].normalizedSeverity, "high");
  const item = bad.built.groups.willRun.find((i) => i.id === "dotnet-vulnerable#dependencies");
  assert.equal(item.network, true, "the vulnerability data needs the package sources");
  await proveClean("dotnet-vulnerable");
});

test("services checks: without services, e2e and migration are SERVICES_REQUIRED with the action to set the services up, never blockers", async () => {
  for (const [name, capability, tool] of [["e2e-ts", "e2e", "playwright"], ["migration-alembic", "migration", "alembic-drift"]]) {
    const dir = workspace(name, "clean", { services: false });
    for (const [locale, label] of [["pt-BR", "Configurar serviços"], ["en", "Set up the services"]]) {
      const p = withLocale(locale, () => plan(dir, { profile: "strict" }));
      assert.ok(!p.groups.willRun.some((i) => i.tool === tool), `${tool} does not run: ${p.groups.willRun.map((i) => i.id).join(", ")}`);
      const na = p.groups.notApplicableRequirements.find((n) => n.selector === `capability:${capability}`);
      assert.ok(na, `${capability} is not applicable here: ${JSON.stringify(p.groups.notApplicableRequirements.map((n) => n.selector))}`);
      assert.equal(na.reasonCode, "SERVICES_REQUIRED");
      assert.equal(na.action.kind, "configure-services");
      assert.equal(na.action.label, label);
      assert.equal(na.action.route, "environment");
      assert.deepEqual(na.action.tools, [tool]);
      assert.ok(!p.blockers.some((b) => JSON.stringify(b).includes(tool)), JSON.stringify(p.blockers));
      assert.ok(!p.groups.uncoveredRequirements.some((u) => u.selector === `capability:${capability}`));
      // Nothing else blocks the plan: the only gaps are the unit tests and coverage this fixture has no runner for.
      assert.ok(p.blockers.every((b) => (b.items ?? []).every((i) => ["capability:unit", "capability:coverage"].includes(i))), JSON.stringify(p.blockers));
      assert.deepEqual(validatePlanDocument(p), []);
    }
    // Asked for explicitly, the check is blocked with the shared cause: it never starts and never passes.
    const only = plan(dir, { only: [tool] });
    const doc = await execute(dir, only);
    const st = stage(doc, `${tool}#${capability}`);
    assert.equal(st.state, "blocked", summary(doc));
    assert.match(st.reason, /needs the project services.*jgates\.yml has no services section/s);
  }
});

test("services checks: a tool the image lacks is the shared TOOL_MISSING cause, never a pass", () => {
  const env = { ...baseEnv, JGATES_IMAGE_JSON: imageJsonWithout("dotnet-stryker", "dotnet-ef"), JGATES_DOTNET_STRYKER: "", JGATES_MIGRATION_TOOL: "" };
  const mut = plan(workspace("mutation-dotnet", "clean"), { env, profile: "strict" });
  const na = mut.groups.notApplicableRequirements.find((n) => n.selector === "capability:mutation");
  assert.equal(na?.reasonCode, "TOOL_MISSING", JSON.stringify(na));
  assert.equal(na.action.kind, "prepare-image");
  const ef = plan(workspace("migration-efcore", "clean"), { env, only: ["efcore-drift"] });
  const item = ef.groups.willRun.find((i) => i.id === "efcore-drift#migration");
  assert.equal(item.availability.status, "unavailable");
  assert.match(item.availability.reason, /dotnet-ef/);
});

test("services checks parsers: each report gives its tests, drift, benchmarks or packages, and anything else is a problem", () => {
  // Playwright Test JSON: a failing spec with its error location; a document that is not the report is not one.
  const report = JSON.stringify({
    config: { rootDir: "/w/app" },
    suites: [{ title: "home.spec.ts", file: "home.spec.ts", specs: [{ title: "shows", file: "home.spec.ts", line: 3, tests: [{ projectName: "chromium", status: "unexpected", results: [{ status: "failed", error: { message: "Error: boom\nmore" }, errorLocation: { file: "/w/app/home.spec.ts", line: 4 } }] }] }] }],
    errors: [],
    stats: { expected: 0, unexpected: 1 },
  });
  const pw = playwright.parsePlaywrightReport(report, (abs) => (abs.startsWith("/w/") ? abs.slice(3) : null));
  assert.deepEqual(pw.cases, [{ name: "[chromium] shows", file: "app/home.spec.ts", line: 4, status: "failed", message: "Error: boom" }]);
  assert.equal(playwright.parsePlaywrightReport('{"suites":[]}', () => null).ok, false);
  assert.equal(playwright.parsePlaywrightReport(null, () => null).ok, false);
  // Migration outputs: drift, clean, and what the exit code does not explain.
  assert.equal(migration.readDrift("alembic", 255, "", "FAILED: New upgrade operations detected: [('add_column', ...)]").state, "drift");
  assert.equal(migration.readDrift("alembic", 0, "No new upgrade operations detected.", "").state, "clean");
  assert.equal(migration.readDrift("alembic", 1, "", "sqlalchemy.exc.OperationalError").state, "unknown");
  assert.equal(migration.readDrift("prisma", 2, "[+] Added column email", "").state, "drift");
  assert.equal(migration.readDrift("prisma", 1, "", "P1001 Can't reach database").state, "unknown");
  assert.equal(migration.readDrift("django", 1, "Migrations for 'shop':\n  shop/migrations/0002.py", "").state, "drift");
  assert.equal(migration.readDrift("efcore", 1, "", "Build failed.").state, "unknown");
  assert.deepEqual(migration.parseSquawk('[{"file":"m.sql","line":0,"column":2,"level":"Warning","message":"x","rule_name":"r","help":null}]'), [{ file: "m.sql", line: 1, column: 3, level: "Warning", rule: "r", message: "x", help: null }]);
  assert.equal(migration.parseSquawk("Failed to find files"), null);
  // Benchmarks: each harness's report as milliseconds, and the comparisons.
  assert.deepEqual(performance.parsePytestBenchmark('{"benchmarks":[{"fullname":"t.py::b","stats":{"mean":0.002}}]}').benchmarks, [{ name: "t.py::b", meanMs: 2 }]);
  assert.equal(performance.parsePytestBenchmark('{"benchmarks":[{"fullname":"x"}]}').ok, false);
  assert.deepEqual(performance.parseVitestBench('{"files":[{"groups":[{"fullName":"a.bench.ts > g","benchmarks":[{"name":"b","mean":1.5}]}]}]}').benchmarks, [{ name: "a.bench.ts > g > b", meanMs: 1.5 }]);
  assert.deepEqual(performance.parseVitestBench('{"testResults":[{"status":"passed","assertionResults":[{"fullName":"fib","status":"passed","benchmarks":[{"name":"fib","tasks":[{"name":"b","latency":{"mean":2.5}}]}]}]}]}').benchmarks, [{ name: "fib > b", meanMs: 2.5 }]);
  assert.equal(performance.parseVitestBench('{"testResults":[{"status":"failed","message":"bench is not a function","assertionResults":[]}]}').ok, false);
  assert.deepEqual(performance.parseGoBench("pkg: example.com/x\nBenchmarkF-2   \t 100\t  2000000 ns/op\nPASS\n").benchmarks, [{ name: "example.com/x/BenchmarkF", meanMs: 2 }]);
  assert.equal(performance.parseGoBench("build failed").ok, false);
  assert.deepEqual(performance.parseBencher("test fib_20 ... bench:       1,500,000 ns/iter (+/- 3)\n").benchmarks, [{ name: "fib_20", meanMs: 1.5 }]);
  assert.deepEqual(performance.parseBenchmarkDotNet(['{"Benchmarks":[{"FullName":"A.B","Statistics":{"Mean":3000000}}]}']).benchmarks, [{ name: "A.B", meanMs: 3 }]);
  assert.equal(performance.parseBenchmarkDotNet(['{"Benchmarks":[{"FullName":"A.B","Statistics":null}]}']).ok, false);
  const checks = performance.compareBenchmarks([{ name: "a", meanMs: 10 }, { name: "b", meanMs: 1 }], { a: 5, "z*": 1 }, { b: 0.5 }, 20);
  assert.deepEqual(checks.map((c) => [c.kind, c.name]), [["budget", "a"], ["unmatched", "z*"], ["regression", "b"]]);
  // dotnet list package: the vulnerable packages; an error problem or no source is not a clean report.
  const listed = vulnerable.parseVulnerableReport(JSON.stringify({ version: 1, sources: ["https://api.nuget.org/v3/index.json"], projects: [{ path: "/w/App.csproj", frameworks: [{ framework: "net10.0", topLevelPackages: [{ id: "P", resolvedVersion: "1.0.0", vulnerabilities: [{ severity: "Critical", advisoryurl: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" }] }], transitivePackages: [] }] }] }));
  assert.deepEqual(listed.packages.map((p) => [p.id, p.severity, p.transitive]), [["P", "Critical", false]]);
  assert.equal(vulnerable.normalizeNugetSeverity("Moderate"), "medium");
  assert.equal(vulnerable.parseVulnerableReport(JSON.stringify({ version: 1, sources: [], projects: [] })).ok, false);
  assert.equal(vulnerable.parseVulnerableReport(JSON.stringify({ version: 1, sources: ["s"], projects: [], problems: [{ level: "error", text: "No assets file" }] })).ok, false);
  // Stryker.NET names the files by their path in the copy.
  const rel = mutation.relativizeReport({ ok: true, survivors: [{ file: "/output/work/mutation/x/src/A.cs", line: 1, column: 1, mutator: "m", replacement: "r", kind: "survived" }] }, ["/output/work/mutation/x"]);
  assert.equal(rel.survivors[0].file, "src/A.cs");
});
