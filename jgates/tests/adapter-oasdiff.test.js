import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// oasdiff adapter: a required response field removed between the reference revision and the target is a breaking-change
// finding, an additive change none; a missing reference (not configured, unknown revision, spec absent from it, missing
// file) is a structured blocked stage, never passed; the settings reach the plan; a missing tool is unavailable with the
// way to get it, never installed during a run. The real oasdiff runs when it is installed (PATH or JGATES_OASDIFF);
// otherwise the test says so and the parser reads the recorded real output of oasdiff 1.36.0.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FIXTURES = path.join(here, "fixtures", "oasdiff");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const adapter = await load("adapters", "oasdiff", "index.js");
const manifests = await load("adapters", "manifests.js");

const probe = adapter.probeOasdiff(process.env);
const REAL = probe.executable !== null && probe.version !== null;

const recorded = (name) => fs.readFileSync(path.join(FIXTURES, "recorded", name), "utf8");
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name, "openapi.yaml"), "utf8");
const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};

/** A git workspace whose HEAD holds the base spec and whose working tree holds `target`; initialized by the real CLI. */
function setup(target, { env = {}, tools = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-oad-ws-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-oad-home-"));
  fs.writeFileSync(path.join(dir, "openapi.yaml"), fixture("base"));
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  fs.writeFileSync(path.join(dir, "openapi.yaml"), fixture(target));
  const runEnv = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1", NO_COLOR: "1", JGATES_OASDIFF: probe.executable ?? path.join(home, "no-oasdiff"), ...env };
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: runEnv, input: "", timeout: 240_000 });
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
  if (tools !== null) fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), tools);
  return {
    dir,
    home,
    env: runEnv,
    cli,
    plan: () => cli(["plan", "--cwd", dir, "--json"]),
    run: () => cli(["run", "--cwd", dir, "--only", "tool:oasdiff", "--no-interactive", "--json"]),
    cleanup: () => [dir, home].forEach((d) => fs.rmSync(d, { recursive: true, force: true })),
  };
}

const toolsYml = (extra = "") => `schemaVersion: 1\ntools:\n  oasdiff:\n    adapter: oasdiff\n    capabilities: [api-compatibility]\n${extra}`;
const itemOf = (planned) => planned.doc.plan.groups.willRun.find((i) => i.id === "oasdiff#api-compatibility");
const opts = { stageId: "oasdiff#api-compatibility", version: "1.36.0", specPath: "openapi.yaml", failOn: "ERR" };

test("oasdiff: a removed required response field is a breaking-change finding and an additive change none [proves: oasdiff#api-compatibility]", async (t) => {
  // The recorded real output of oasdiff 1.36.0 (tests/fixtures/oasdiff/recorded): always parsed.
  const bad = adapter.parseOasdiffOutput(recorded("removed.json"), opts);
  assert.equal(bad.ok, true, bad.problem);
  assert.equal(bad.findings.length, 1);
  const [finding] = bad.findings;
  assert.equal(finding.tool, "oasdiff");
  assert.equal(finding.ruleId, "response-required-property-removed");
  assert.equal(finding.category, "api-compatibility");
  assert.equal(finding.severity, "err");
  assert.equal(finding.normalizedSeverity, "high");
  assert.equal(finding.blocking, true);
  assert.equal(finding.location.path, "openapi.yaml");
  assert.match(finding.message, /removed the required property `email`/);
  assert.match(finding.message, /GET \/users\/\{id\}/);
  const additive = adapter.parseOasdiffOutput(recorded("additive.json"), opts);
  assert.equal(additive.ok, true);
  assert.deepEqual(additive.findings, []);

  if (!REAL) {
    t.diagnostic(`oasdiff is not installed (${probe.detail}): the live comparison did not run; only the recorded oasdiff 1.36.0 output was parsed. Get it from https://github.com/oasdiff/oasdiff/releases`);
    return;
  }
  // The real tool through the real plan and run: the reference is HEAD (base spec), the target is the working tree.
  const removed = setup("removed", { tools: toolsYml("    baseRef: HEAD\n") });
  const added = setup("additive", { tools: toolsYml("    baseRef: HEAD\n") });
  try {
    const failed = removed.run();
    assert.equal(failed.doc.decision, "failed", failed.out + failed.err);
    const live = failed.doc.findings.filter((f) => f.tool === "oasdiff");
    assert.equal(live.length, 1);
    assert.equal(live[0].ruleId, "response-required-property-removed");
    assert.equal(live[0].location.path, "openapi.yaml");
    assert.equal(live[0].blocking, true);
    const passed = added.run();
    assert.equal(passed.doc.decision, "passed", passed.out + passed.err);
    assert.equal(passed.doc.findings.filter((f) => f.tool === "oasdiff").length, 0);
    const stage = passed.doc.stages.find((s) => s.id === "oasdiff#api-compatibility");
    assert.equal(stage.state, "completed");
    assert.equal(stage.interpreted, true);
  } finally {
    removed.cleanup();
    added.cleanup();
  }
});

test("oasdiff parser: fail-closed on a document that is not the list of changes; failOn decides which levels block", () => {
  for (const bad of ["", "not json", "{}", '"x"', "[1]", '[{"id":"x"}]', '[{"id":"x","text":"t"}]']) {
    const parsed = adapter.parseOasdiffOutput(bad, opts);
    assert.equal(parsed.ok, false, `accepted: ${bad}`);
    assert.deepEqual(parsed.findings, []);
  }
  assert.equal(adapter.parseOasdiffOutput("null", opts).ok, true);
  const warn = JSON.stringify([{ id: "some-warning", text: "something to look at", level: 2, operation: "GET", path: "/x" }]);
  const err = adapter.parseOasdiffOutput(warn, opts).findings[0];
  assert.equal(err.blocking, false);
  assert.equal(err.normalizedSeverity, "medium");
  assert.equal(adapter.parseOasdiffOutput(warn, { ...opts, failOn: "WARN" }).findings[0].blocking, true);
  // An unknown level blocks: nothing the tool cannot qualify may count as favorable.
  const unknown = JSON.stringify([{ id: "x", text: "t", level: 9 }]);
  assert.equal(adapter.parseOasdiffOutput(unknown, opts).findings[0].blocking, true);
});

test("oasdiff reference: a missing reference revision or file is a structured blocked stage, never passed", async (t) => {
  if (!REAL) {
    t.diagnostic(`oasdiff is not installed (${probe.detail}): the run-time reference checks need the tool to reach the reference step; only the plan is checked`);
  }
  const cases = [
    // The reasons are localized; the names they carry are not.
    { name: "no reference configured", tools: toolsYml(), reason: /baseRef/ },
    { name: "unknown revision", tools: toolsYml("    baseRef: no-such-branch\n"), reason: /no-such-branch/ },
    { name: "spec absent from the revision", tools: toolsYml("    baseRef: HEAD\n    spec: other.yaml\n"), reason: /other\.yaml/ },
    { name: "reference file missing", tools: toolsYml("    baseSpec: missing-base.yaml\n"), reason: /missing-base\.yaml/ },
  ];
  for (const c of cases) {
    const ws = setup("removed", { tools: c.tools });
    try {
      if (c.name === "spec absent from the revision") fs.writeFileSync(path.join(ws.dir, "other.yaml"), fixture("removed"));
      const result = ws.run();
      const stage = result.doc.stages.find((s) => s.id === "oasdiff#api-compatibility");
      assert.ok(stage, `${c.name}: the stage exists: ${result.out}${result.err}`);
      assert.equal(stage.state, "blocked", c.name);
      assert.notEqual(result.doc.decision, "passed", c.name);
      assert.equal(result.doc.findings.filter((f) => f.tool === "oasdiff").length, 0);
      if (REAL) {
        assert.equal(stage.nativeStatus, "no-reference", c.name);
        assert.match(stage.reason, c.reason, c.name);
      }
    } finally {
      ws.cleanup();
    }
  }
});

test("oasdiff plan: the spec is found, the template comes in by evidence and the settings reach the plan", () => {
  const ws = setup("removed", { tools: toolsYml("    baseRef: HEAD~1\n    failOn: WARN\n") });
  try {
    const planned = ws.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = itemOf(planned);
    assert.ok(item, "oasdiff#api-compatibility is in the plan");
    assert.equal(item.category, "architecture");
    assert.equal(item.adapter, "oasdiff");
    assert.deepEqual(item.capabilities, ["api-compatibility"]);
    assert.equal(item.network, false);
    assert.equal(item.effects.mayChangeCode, false);
    assert.equal(item.command.args[0], "breaking");
    assert.ok(item.command.args.includes("openapi.yaml"), item.command.args.join(" "));
    assert.ok(item.conditions.some((c) => /HEAD~1/.test(c)) && item.conditions.some((c) => /WARN/.test(c)), item.conditions.join(" | "));
    assert.ok(planned.doc.plan.templates.active.some((a) => a.id === "openapi-oasdiff"));
  } finally {
    ws.cleanup();
  }
  const bad = adapter.oasdiffSettings({ tool: "oasdiff", config: { tools: { oasdiff: { spec: "../x.yaml", baseRef: "--upload-pack=x", failOn: "INFO", baseSpec: "/etc/passwd" } } } });
  assert.equal(bad.problems.length, 4);
  const both = adapter.oasdiffSettings({ tool: "oasdiff", config: { tools: { oasdiff: { baseRef: "main", baseSpec: "old.yaml" } } } });
  assert.equal(both.problems.length, 1);
  const defaults = adapter.oasdiffSettings({ tool: "oasdiff", config: { tools: { oasdiff: {} } } });
  assert.deepEqual({ spec: defaults.spec, baseRef: defaults.baseRef, baseSpec: defaults.baseSpec, failOn: defaults.failOn, problems: defaults.problems }, { spec: null, baseRef: null, baseSpec: null, failOn: "ERR", problems: [] });
});

test("oasdiff prerequisites: a missing tool is unavailable with the way to get it, and nothing is installed", () => {
  const ws = setup("removed", { tools: toolsYml("    baseRef: HEAD\n"), env: { JGATES_OASDIFF: path.join(os.tmpdir(), "jgates-no-such-oasdiff") } });
  try {
    const item = itemOf(ws.plan());
    assert.equal(item.availability.status, "unavailable");
    assert.match(item.availability.reason, /github\.com\/oasdiff\/oasdiff\/releases/);
    const run = ws.run();
    const stage = run.doc.stages.find((s) => s.id === "oasdiff#api-compatibility");
    assert.equal(stage.state, "blocked");
    assert.notEqual(run.doc.decision, "passed");
    assert.equal(fs.existsSync(path.join(ws.home, "tools", "bin")), false, "the run installed nothing");
  } finally {
    ws.cleanup();
  }
});

test("oasdiff manifest: architecture domain, api-compatibility capability, customer-supplied distribution and a matrix row", () => {
  const manifest = manifests.builtinManifests().find((m) => m.id === "oasdiff");
  assert.ok(manifest);
  assert.deepEqual(manifest.categories, ["architecture"]);
  assert.deepEqual(manifest.capabilities, ["api-compatibility"]);
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(manifest.distribution.mode, "customer-supplied");
  assert.equal(manifest.distribution.spdx, "Apache-2.0");
  assert.ok(manifest.distribution.acquisition.length > 0 && manifest.distribution.setup.length > 0);
  assert.equal(manifest.effects.mayChangeCode, false);
  assert.equal(manifest.stackSupport.find((r) => r.capability === "api-compatibility")?.state, "validated");
});
