import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Import Linter adapter: the forbidden-dependency rule of architecture.yml becomes a contract of Import
// Linter over the Python of the main fixture; the output parser is versioned and fail-closed; an import
// the tool cannot resolve is a gap in coverage, not the absence of a violation.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const HAS_TOOL = fs.existsSync(path.join(VENV_BIN, process.platform === "win32" ? "lint-imports.exe" : "lint-imports"));
const adapter = await import(pathToFileURL(path.join(dist, "adapters", "import-linter", "index.js")).href);
const manifests = await import(pathToFileURL(path.join(dist, "adapters", "manifests.js")).href);
const fixture = createRequire(import.meta.url)(path.join(repo, "tests", "fixtures", "jgates", "main-fixture.js"));
const FIXTURES = path.join(here, "fixtures", "parsers", "import-linter");

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const TOOLS = "schemaVersion: 1\ntools:\n  import-linter:\n    adapter: import-linter\n    capabilities: [architecture]\n";
const ARCHITECTURE = `schemaVersion: 1
architecture:
  layers:
    - id: domain
      paths: ["api/src/shop_api/domain/**"]
    - id: infrastructure
      paths: ["api/src/shop_api/infrastructure/**"]
  rules:
    - id: domain-independent
      kind: forbidden-dependency
      from: domain
      to: [infrastructure]
      enabled: true
      severity: high
      blocking: true
      owner: generated
`;

function setup(fix, { architecture = ARCHITECTURE, tools = TOOLS, extraEnv = {} } = {}) {
  assert.ok(HAS_TOOL, "import-linter is not installed in the repository .venv: run `npm --prefix jgates run setup:dev-tools`");
  const dir = fix.dir;
  const home = tmp("jgates-il-home-");
  const emptyBin = tmp("jgates-il-bin-");
  const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON, JGATES_NO_CACHE: "1", PATH: emptyBin, ...extraEnv };
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input: "", timeout: 240_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  const init = cli(["init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), tools);
  if (architecture !== null) fs.writeFileSync(path.join(dir, ".jgates", "architecture.yml"), architecture);
  return {
    dir,
    cli,
    plan: () => cli(["plan", "--cwd", dir, "--only", "tool:import-linter", "--json"]),
    run: () => cli(["run", "--cwd", dir, "--only", "tool:import-linter", "--no-interactive", "--json"]),
    item: (planned) => planned.doc.plan.groups.willRun.find((i) => i.id === "import-linter#architecture"),
    cleanup: () => {
      for (const d of [home, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
      fixture.removeFixture(dir);
    },
  };
}

const found = (result) => result.findings.filter((f) => f.tool === "import-linter");
const outputsOf = (result) => path.join(result.runDir, "outputs", "import-linter", "import-linter");
const stageOf = (result) => result.stages.find((s) => s.id === "import-linter#architecture");

test("the manifest is registered with the architecture capability and the Python language", () => {
  const manifest = manifests.builtinManifests().find((m) => m.id === "import-linter");
  assert.ok(manifest);
  assert.deepEqual(manifest.capabilities, ["architecture"]);
  assert.deepEqual(manifest.languages, ["python"]);
  assert.equal(manifest.toolName, "import-linter");
});

test("the domain importing the infrastructure is a finding of the declared rule, at the file of the import [proves: import-linter#architecture]", () => {
  const fix = fixture.createMainFixture();
  const p = setup(fix);
  try {
    const planned = p.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = p.item(planned);
    assert.ok(item, JSON.stringify(planned.doc.plan.groups.willRun.map((i) => i.id)));
    assert.equal(item.adapter, "import-linter");
    assert.match(item.versions.toolVersion, /^2\.15/);
    assert.ok(item.command.args.includes("--no-cache"), "no cache directory in the workspace");
    assert.ok(item.command.args.includes("{runDir}/outputs/import-linter/import-linter/importlinter.ini"));
    assert.ok(item.configFiles.some((f) => f.file === ".jgates/architecture.yml" && /^sha256:/.test(f.sha256)));
    assert.equal(item.network, false);

    const before = fs.readdirSync(p.dir).sort();
    const ran = p.run();
    assert.equal(ran.code, 1, ran.out + ran.err);
    assert.equal(ran.doc.decision, "failed");
    const list = found(ran.doc);
    assert.deepEqual(list.map((f) => f.ruleId), ["domain-independent"]);
    assert.equal(list[0].location.path, "api/src/shop_api/domain/order.py");
    assert.equal(list[0].location.line, 1);
    assert.equal(list[0].blocking, true);
    assert.equal(list[0].severity, "high");
    assert.equal(list[0].origin, ".jgates/architecture.yml");
    assert.match(list[0].message, /shop_api\.domain\.order -> shop_api\.infrastructure\.repository/);
    assert.equal(stageOf(ran.doc).state, "completed");
    assert.deepEqual(fs.readdirSync(p.dir).sort(), before, "nothing is left in the workspace");
    assert.deepEqual(ran.doc.workspaceChanges.added, []);
    // The configuration is generated in the run folder, says so, and uses the declared id as the contract.
    const config = fs.readFileSync(path.join(outputsOf(ran.doc), "importlinter.ini"), "utf8");
    assert.match(config, /Generated by JGates/);
    assert.match(config, /\[importlinter:contract:domain-independent\]/);
    // The graph handed to the evaluator is on disk with its coverage.
    const coverage = JSON.parse(fs.readFileSync(path.join(outputsOf(ran.doc), "coverage.json"), "utf8"));
    assert.equal(coverage.coverage.status, "complete");
    const graph = JSON.parse(fs.readFileSync(path.join(outputsOf(ran.doc), "normalized-graph.json"), "utf8"));
    assert.ok(graph.edges.some((e) => e.from === "shop_api.domain.order" && e.to === "shop_api.infrastructure.repository" && e.origin === "api/src/shop_api/domain/order.py:1"));
  } finally {
    p.cleanup();
  }
});

test("the corrected fixture: the same plan has no finding and the stage is completed", () => {
  const fix = fixture.createMainFixture();
  fixture.fixMainFixture(fix.dir);
  const p = setup(fix);
  try {
    const ran = p.run();
    assert.equal(ran.code, 0, ran.out + ran.err);
    assert.equal(ran.doc.decision, "passed");
    assert.deepEqual(found(ran.doc), []);
    const stage = stageOf(ran.doc);
    assert.equal(stage.state, "completed");
    assert.equal(stage.blockingViolations, 0);
    const coverage = JSON.parse(fs.readFileSync(path.join(outputsOf(ran.doc), "coverage.json"), "utf8"));
    assert.equal(coverage.verified, true);
  } finally {
    p.cleanup();
  }
});

test("an import that does not resolve is a gap in coverage: the required check is not passed, never 'no violation'", () => {
  const fix = fixture.createMainFixture();
  fixture.fixMainFixture(fix.dir);
  fs.writeFileSync(path.join(fix.dir, "api", "src", "shop_api", "application", "ghost.py"), "from shop_api.nothing_here import value\n\nOTHER = value\n");
  const p = setup(fix);
  try {
    const ran = p.run();
    assert.equal(ran.code, 2, ran.out + ran.err);
    assert.equal(ran.doc.decision, "incomplete");
    assert.deepEqual(found(ran.doc), []);
    const stage = stageOf(ran.doc);
    assert.notEqual(stage.state, "passed");
    assert.match(stage.reason, /não provada/);
    const coverage = JSON.parse(fs.readFileSync(path.join(outputsOf(ran.doc), "coverage.json"), "utf8"));
    assert.equal(coverage.verified, false);
    assert.equal(coverage.coverage.status, "partial");
    assert.ok(coverage.coverage.unresolvedSample.some((u) => u.specifier === "shop_api.nothing_here" && u.from === "shop_api.application.ghost"), JSON.stringify(coverage.coverage.unresolvedSample));
  } finally {
    p.cleanup();
  }
});

test("a violation is still reported when the graph is partial (failed wins over incomplete)", () => {
  const fix = fixture.createMainFixture();
  fs.writeFileSync(path.join(fix.dir, "api", "src", "shop_api", "application", "ghost.py"), "import shop_api.domain.nowhere\n");
  const p = setup(fix);
  try {
    const ran = p.run();
    assert.equal(ran.code, 1, ran.out + ran.err);
    assert.equal(ran.doc.decision, "failed");
    assert.deepEqual(found(ran.doc).map((f) => f.ruleId), ["domain-independent"]);
  } finally {
    p.cleanup();
  }
});

test("without a contract (no architecture.yml, no native configuration) the plan says why and the stage is not passed", () => {
  const fix = fixture.createMainFixture();
  const p = setup(fix, { architecture: null });
  try {
    const planned = p.plan();
    const item = p.item(planned);
    assert.ok(item);
    assert.equal(item.availability.status, "unavailable");
    assert.match(item.availability.reason, /não tem contratos/);
    const ran = p.run();
    assert.notEqual(ran.doc.decision, "passed");
    assert.equal(stageOf(ran.doc).state, "blocked");
  } finally {
    p.cleanup();
  }
});

test("a native configuration runs as it is, in its own dialect, and the contract name is the rule id", () => {
  const fix = fixture.createMainFixture();
  fs.writeFileSync(
    path.join(fix.dir, ".importlinter"),
    "[importlinter]\nroot_packages =\n    shop_api\n\n[importlinter:contract:native-domain]\nname = native-domain\ntype = forbidden\nsource_modules =\n    shop_api.domain\nforbidden_modules =\n    shop_api.infrastructure\n",
  );
  const p = setup(fix, { architecture: null });
  try {
    const planned = p.plan();
    const item = p.item(planned);
    assert.equal(item.availability.status, "available");
    assert.ok(item.command.args.includes("{workspace}/.importlinter"));
    assert.ok(item.configFiles.some((f) => f.file === ".importlinter"));
    const ran = p.run();
    assert.equal(ran.code, 1, ran.out + ran.err);
    const list = found(ran.doc);
    assert.deepEqual(list.map((f) => f.ruleId), ["native-domain"]);
    assert.equal(list[0].location.path, "api/src/shop_api/domain/order.py");
    assert.equal(list[0].origin, ".importlinter");
    assert.ok(!fs.existsSync(path.join(outputsOf(ran.doc), "importlinter.ini")), "nothing is generated over the user's configuration");
  } finally {
    p.cleanup();
  }
});

// --- parser ---------------------------------------------------------------------------------------------------

const sample = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

test("parser 2.15: a kept report", () => {
  const r = adapter.parseImportLinterOutput(sample("v2.15-kept.txt"));
  assert.equal(r.ok, true, r.problem);
  assert.deepEqual(r.analyzed, { files: 8, dependencies: 1 });
  assert.deepEqual(r.contracts.map((c) => [c.name, c.status]), [["domain-independent", "kept"], ["layers", "kept"]]);
  assert.equal(r.broken, 0);
});

test("parser 2.15: broken contracts of several types, with names that have spaces, groups and multi-line imports", () => {
  const r = adapter.parseImportLinterOutput(sample("v2.15-broken-multi.txt"));
  assert.equal(r.ok, true, r.problem);
  assert.deepEqual(r.contracts.map((c) => [c.name, c.status]), [["domain-independent", "broken"], ["layers", "broken"], ["Independent things", "broken"]]);
  const forbidden = r.contracts[0];
  assert.deepEqual(forbidden.groups.map((g) => g.header), ["shop_api.domain is not allowed to import shop_api.application", "shop_api.domain is not allowed to import shop_api.infrastructure"]);
  assert.deepEqual(forbidden.groups[1].chains.map((c) => c.map((l) => [l.from, l.to, l.lines])), [
    [["shop_api.domain.order", "shop_api.infrastructure.repository", [1]]],
    [["shop_api.domain.sub.deep", "shop_api.infrastructure.repository", [2, 3]]],
  ]);
  assert.equal(r.contracts[1].groups[0].chains.length, 2, "the layers contract uses a shorter bullet");
});

test("parser 2.15: an indirect chain keeps every link", () => {
  const r = adapter.parseImportLinterOutput(sample("v2.15-broken-chain.txt"));
  assert.equal(r.ok, true, r.problem);
  const chain = r.contracts[0].groups[0].chains[0];
  assert.deepEqual(chain.map((l) => `${l.from} -> ${l.to}`), [
    "shop_api.domain.viaapp -> shop_api.application.place_order",
    "shop_api.application.place_order -> shop_api.domain.order",
    "shop_api.domain.order -> shop_api.infrastructure.repository",
  ]);
});

test("parser 2.15: a report with no contract is a valid, empty report", () => {
  const r = adapter.parseImportLinterOutput(sample("v2.15-no-contracts.txt"));
  assert.equal(r.ok, true, r.problem);
  assert.deepEqual(r.contracts, []);
});

test("parser: truncated output is an error, never zero findings", () => {
  for (const name of ["v2.15-truncated-details.txt", "v2.15-truncated-summary.txt"]) {
    const r = adapter.parseImportLinterOutput(sample(name));
    assert.equal(r.ok, false, name);
    assert.ok(r.problem && r.problem.length > 0, name);
  }
  // Cut at every point of a broken report: nothing short of the whole text parses as ok with fewer findings.
  const whole = sample("v2.15-broken-multi.txt");
  const full = adapter.parseImportLinterOutput(whole);
  assert.equal(full.ok, true);
  for (let cut = 1; cut < whole.length; cut++) {
    const r = adapter.parseImportLinterOutput(whole.slice(0, cut));
    // The text alone cannot tell a cut exactly between two groups from the end; it never loses a whole contract.
    if (r.ok) {
      assert.ok(whole.slice(0, cut).endsWith("\n\n\n"), `cut at ${cut} parsed as ok without the end of the report`);
      assert.deepEqual(r.contracts.map((c) => c.name), full.contracts.map((c) => c.name), `cut at ${cut} lost a contract`);
    }
  }
});

test("parser: errors and unknown shapes are problems", () => {
  for (const name of ["v2.15-config-error.txt", "v2.15-contract-misconfigured.txt", "v2.15-missing-package.txt"]) {
    const r = adapter.parseImportLinterOutput(sample(name));
    assert.equal(r.ok, false, name);
  }
  assert.equal(adapter.parseImportLinterOutput("").ok, false);
  assert.equal(adapter.parseImportLinterOutput("hello\n").ok, false);
  // Totals that do not add up.
  assert.equal(adapter.parseImportLinterOutput(sample("v2.15-kept.txt").replace("2 kept, 0 broken", "1 kept, 1 broken")).ok, false);
  // A line the grammar does not know inside the details.
  assert.equal(adapter.parseImportLinterOutput(sample("v2.15-broken-chain.txt").replace("place_order (l.1)\n    shop_api.application", "place_order (line 1)\n    shop_api.application")).ok, false);
});
