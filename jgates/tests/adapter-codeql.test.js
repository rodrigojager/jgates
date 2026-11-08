import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// CodeQL adapter (customer-supplied). The real CodeQL CLI is NOT available here and is never downloaded: its terms
// restrict use and JGates does not ship or install it. So:
//   - the SARIF parser reads tests/fixtures/codeql/recorded/*.sarif, which were CONSTRUCTED strictly per the published
//     SARIF 2.1.0 shape of CodeQL's `--format=sarif-latest` (driver "CodeQL", rules with `security-severity`, path-problem
//     results with codeFlows); they were not captured from a real CodeQL run;
//   - the live plan/run goes through a STAND-IN executable (tests/fixtures/codeql/stand-in) that replays those SARIFs.
// Every CodeQL row of the support matrix is therefore customer-setup-required, never validated.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FIXTURES = path.join(here, "fixtures", "codeql");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const adapter = await load("adapters", "codeql", "index.js");
const manifests = await load("adapters", "manifests.js");
const { buildStandIn } = await import(pathToFileURL(path.join(FIXTURES, "stand-in", "build.mjs")).href);

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const recorded = (name) => fs.readFileSync(path.join(FIXTURES, "recorded", name), "utf8");
const opts = { stageId: "codeql#dataflow", version: "2.18.4", root: "." };
const standIn = buildStandIn(tmp("jgates-codeql-standin-"));

const toolsYml = (extra = "") => `schemaVersion: 1\ntools:\n  codeql:\n    adapter: codeql\n    enabled: true\n    capabilities: [dataflow]\n    language: python\n${extra}`;

/** A workspace with one fixture project, initialized by the real CLI; `exe` is the CodeQL executable (null: none anywhere). */
function setup(fixture, { exe = standIn, tools = toolsYml() } = {}) {
  const dir = tmp("jgates-codeql-ws-");
  const home = tmp("jgates-codeql-home-");
  fs.cpSync(path.join(FIXTURES, fixture), dir, { recursive: true });
  const env = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1", NO_COLOR: "1", JGATES_LOCALE: "en", JGATES_CODEQL: exe ?? path.join(home, "no-codeql") };
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
  return {
    dir,
    home,
    plan: () => cli(["plan", "--cwd", dir, "--json"]),
    run: () => cli(["run", "--cwd", dir, "--only", "tool:codeql", "--no-interactive", "--json"]),
  };
}
const itemOf = (planned) => planned.doc.plan.groups.willRun.find((i) => i.id === "codeql#dataflow");

test("codeql: a CodeQL SARIF with a path-problem is a normalized dataflow finding and a clean one none [proves: codeql#dataflow]", () => {
  const bad = adapter.parseCodeqlSarif(recorded("command-injection.sarif"), opts);
  assert.equal(bad.ok, true, bad.problem);
  assert.equal(bad.driverVersion, "2.18.4");
  assert.equal(bad.findings.length, 1);
  const [finding] = bad.findings;
  assert.equal(finding.tool, "codeql");
  assert.equal(finding.ruleId, "py/command-line-injection");
  assert.equal(finding.category, "dataflow");
  assert.equal(finding.normalizedSeverity, "critical", "security-severity 9.8 is critical");
  assert.equal(finding.blocking, true);
  assert.deepEqual(finding.location, { path: "app.py", line: 10, column: 15 });
  assert.match(finding.message, /user-provided value/);
  assert.match(finding.message, /CWE-078/);
  assert.equal(finding.nativeFingerprint, "5d1f2c0a8e3b7c41:1");
  assert.ok(finding.fingerprint);
  const clean = adapter.parseCodeqlSarif(recorded("clean.sarif"), opts);
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.findings, []);
  // A component root prefixes the paths so they stay relative to the workspace.
  assert.equal(adapter.parseCodeqlSarif(recorded("command-injection.sarif"), { ...opts, root: "services/api" }).findings[0].location.path, "services/api/app.py");
});

test("codeql parser: fail-closed on a document that is not a CodeQL SARIF; severity bands and unknown levels", () => {
  const doc = (patch = {}, result = {}) =>
    JSON.stringify({
      version: "2.1.0",
      runs: [{ tool: { driver: { name: "CodeQL", rules: [{ id: "r/x", properties: { "security-severity": "5.0" } }] } }, results: [{ ruleId: "r/x", message: { text: "m" }, locations: [{ physicalLocation: { artifactLocation: { uri: "a.py" }, region: { startLine: 3 } } }], ...result }], ...patch }],
    });
  for (const bad of ["", "not json", "{}", "[]", JSON.stringify({ version: "2.1.0", runs: [] }), JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "OtherTool" } }, results: [] }] }), JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "CodeQL" } } }] }), doc({}, { message: {} }), doc({}, { locations: [] }), doc({}, { ruleId: undefined })]) {
    const parsed = adapter.parseCodeqlSarif(bad, opts);
    assert.equal(parsed.ok, false, `accepted: ${bad.slice(0, 60)}`);
    assert.deepEqual(parsed.findings, []);
  }
  const medium = adapter.parseCodeqlSarif(doc(), opts).findings[0];
  assert.equal(medium.normalizedSeverity, "medium");
  assert.equal(medium.blocking, false);
  // An unknown level and no security-severity: nothing the tool cannot qualify may count as favorable.
  const unknown = adapter.parseCodeqlSarif(doc({}, { ruleId: "other/rule", level: "weird" }), opts).findings[0];
  assert.equal(unknown.normalizedSeverity, "unknown");
  assert.equal(unknown.blocking, true);
  assert.equal(adapter.parseCodeqlSarif(doc({}, { level: "error" }), opts).findings[0].blocking, true);
});

test("codeql live: the configured executable gives readiness, a database, the suite and normalized findings (stand-in, not a real CodeQL)", () => {
  const bad = setup("bad");
  const clean = setup("clean");
  const probe = adapter.probeCodeql({ ...process.env, JGATES_CODEQL: standIn });
  assert.equal(probe.version, "2.18.4");
  assert.equal(probe.executable, standIn);
  const planned = bad.plan();
  assert.equal(planned.code, 0, planned.out + planned.err);
  const item = itemOf(planned);
  assert.ok(item, "codeql#dataflow is in the plan");
  assert.equal(item.availability.status, "available");
  assert.equal(item.category, "security");
  assert.equal(item.network, false);
  assert.deepEqual(item.capabilities, ["dataflow"]);
  assert.deepEqual(item.command.args.slice(0, 2), ["database", "analyze"]);
  assert.ok(item.command.args.includes("codeql/python-queries:codeql-suites/python-security-extended.qls"), item.command.args.join(" "));
  assert.ok(item.command.args.includes("--no-download"));
  const failed = bad.run();
  assert.equal(failed.doc.decision, "failed", failed.out + failed.err);
  const live = failed.doc.findings.filter((f) => f.tool === "codeql");
  assert.equal(live.length, 1);
  assert.equal(live[0].ruleId, "py/command-line-injection");
  assert.equal(live[0].location.path, "app.py");
  assert.equal(live[0].blocking, true);
  const passed = clean.run();
  assert.equal(passed.doc.decision, "passed", passed.out + passed.err);
  assert.equal(passed.doc.findings.filter((f) => f.tool === "codeql").length, 0);
  const stage = passed.doc.stages.find((s) => s.id === "codeql#dataflow");
  assert.equal(stage.state, "completed");
  assert.equal(stage.interpreted, true);
});

test("codeql missing: the plan and the run give structured setup guidance, the stage is blocked and nothing is installed", () => {
  const ws = setup("bad", { exe: null });
  const planned = ws.plan();
  assert.equal(planned.code, 0, planned.out + planned.err);
  const item = itemOf(planned);
  assert.equal(item.availability.status, "unavailable");
  const reason = item.availability.reason;
  assert.match(reason, /CodeQL CLI/);
  assert.match(reason, /supported versions: >=2\.15\.0 <3\.0\.0/);
  assert.match(reason, /github\.com\/github\/codeql-action\/releases/);
  assert.match(reason, /docs\.github\.com\/en\/code-security\/codeql-cli/);
  assert.match(reason, /customer-supplied/);
  const run = ws.run();
  const stage = run.doc.stages.find((s) => s.id === "codeql#dataflow");
  assert.equal(stage.state, "blocked");
  assert.equal(stage.nativeStatus, "setup-required");
  assert.notEqual(run.doc.decision, "passed");
  assert.equal(run.doc.findings.filter((f) => f.tool === "codeql").length, 0);
  assert.equal(fs.existsSync(path.join(ws.home, "tools", "bin")), false, "nothing was installed");
});

test("codeql settings: language is required and every invalid value is a refused plan, never a default", () => {
  const ok = adapter.codeqlSettings({ tool: "codeql", config: { tools: { codeql: { language: "javascript-typescript", suite: "code-scanning", buildCommand: "npm run build" } } } });
  assert.deepEqual(ok, { language: "javascript-typescript", suite: "code-scanning", buildCommand: "npm run build", problems: [] });
  assert.equal(adapter.codeqlSettings({ tool: "codeql", config: { tools: { codeql: {} } } }).problems.length, 1);
  assert.equal(adapter.codeqlSettings({ tool: "codeql", config: { tools: { codeql: { language: "cobol", suite: "all", buildCommand: "a\nb" } } } }).problems.length, 3);
  assert.equal(adapter.suiteReference("java-kotlin", "security-extended"), "codeql/java-queries:codeql-suites/java-security-extended.qls");
  const ws = setup("bad", { tools: "schemaVersion: 1\ntools:\n  codeql:\n    adapter: codeql\n    enabled: true\n    capabilities: [dataflow]\n" });
  const item = itemOf(ws.plan());
  assert.equal(item.availability.status, "unavailable");
  assert.match(item.availability.reason, /language/);
});

test("codeql matrix: every CodeQL row is customer-setup-required and the distribution is customer-supplied", () => {
  const manifest = manifests.builtinManifests().find((m) => m.id === "codeql");
  assert.ok(manifest, "codeql is a registered built-in adapter");
  assert.equal(manifest.distribution.mode, "customer-supplied");
  assert.ok(manifest.distribution.acquisition.some((u) => /codeql-action\/releases/.test(u)));
  assert.ok(manifest.stackSupport.length > 0);
  assert.ok(manifest.stackSupport.every((r) => r.capability === "dataflow" && r.state === "customer-setup-required" && r.prerequisites.length > 0));
});
