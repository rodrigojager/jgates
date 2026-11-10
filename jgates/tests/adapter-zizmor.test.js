import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// zizmor adapter: a workflow with a template injection (an issue title expression interpolated in a run: step) is a
// normalized finding, the clean workflow none; the plan lists the check under the infrastructure domain only for a repo
// with .github/workflows; the settings (persona, minimum severity, offline) reach the command; a missing tool is
// reported with the way to prepare it, never installed during a run. The real zizmor runs when it is installed;
// otherwise the test says so and the parser reads the recorded real output of zizmor 1.32.0.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FIXTURES = path.join(here, "fixtures", "zizmor");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const adapter = await load("adapters", "zizmor", "index.js");
const install = await load("core", "install", "index.js");
const manifests = await load("adapters", "manifests.js");

const { imageJsonWithout } = await import(pathToFileURL(path.join(here, "setup", "image-json.mjs")).href);
const prerequisites = await load("core", "prerequisites", "index.js");

// In-image mode (tests/setup/in-image.mjs): a zizmor on this machine's PATH stands for the image's.
const probe = adapter.probeZizmor(process.env);
const REAL = probe.executable !== null && path.isAbsolute(probe.executable) && probe.version !== null;

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const recorded = (name) => fs.readFileSync(path.join(FIXTURES, "recorded", name), "utf8");

function copyWorkflows(from, to) {
  fs.cpSync(path.join(FIXTURES, from, ".github"), path.join(to, ".github"), { recursive: true });
}

/** A workspace initialized by the real CLI; `fixture` names the folder of tests/fixtures/zizmor whose workflows it gets. */
function setup(fixture, { env = {}, tools = null } = {}) {
  const dir = tmp("jgates-zz-ws-");
  const home = tmp("jgates-zz-home-");
  if (fixture) copyWorkflows(fixture, dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  const runEnv = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1", NO_COLOR: "1", JGATES_ZIZMOR: probe.executable ?? path.join(home, "no-zizmor"), ...env };
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
    run: () => cli(["run", "--cwd", dir, "--only", "tool:zizmor", "--no-interactive", "--json"]),
    cleanup: () => [dir, home].forEach((d) => fs.rmSync(d, { recursive: true, force: true })),
  };
}

const itemOf = (planned) => planned.doc.plan.groups.willRun.find((i) => i.id === "zizmor#ci-cd");

test("zizmor: a template injection in a workflow is a normalized finding and the clean workflow none [proves: zizmor#ci-cd]", async (t) => {
  // The recorded real output of zizmor 1.32.0 (tests/fixtures/zizmor/recorded): always parsed.
  const bad = adapter.parseZizmorOutput(recorded("template-injection.json"), { stageId: "zizmor#ci-cd", version: "1.32.0", root: "." });
  assert.equal(bad.ok, true, bad.problem);
  assert.equal(bad.findings.length, 1);
  const [finding] = bad.findings;
  assert.equal(finding.tool, "zizmor");
  assert.equal(finding.ruleId, "template-injection");
  assert.equal(finding.category, "ci-cd");
  assert.equal(finding.severity, "High");
  assert.equal(finding.normalizedSeverity, "high");
  assert.equal(finding.blocking, true);
  assert.equal(finding.location.path, ".github/workflows/triage.yml");
  assert.equal(finding.location.line, 16);
  assert.match(finding.message, /code injection via template expansion/);
  assert.equal(finding.docsUrl, "https://docs.zizmor.sh/audits/#template-injection");
  const clean = adapter.parseZizmorOutput(recorded("clean.json"), { stageId: "zizmor#ci-cd", version: "1.32.0", root: "." });
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.findings, []);

  if (!REAL) {
    t.diagnostic(`zizmor is not installed (${probe.detail}): the live scan did not run; only the recorded zizmor 1.32.0 output was parsed. It is in the tools image; put zizmor on the PATH to run it here.`);
    return;
  }
  // The real tool through the real plan and run: the injection fixture fails with the finding, the clean one passes.
  const injection = setup("injection");
  const cleanWs = setup("clean");
  try {
    const failed = injection.run();
    assert.equal(failed.doc.decision, "failed", failed.out + failed.err);
    const live = failed.doc.findings.filter((f) => f.tool === "zizmor");
    assert.equal(live.length, 1);
    assert.equal(live[0].ruleId, "template-injection");
    assert.equal(live[0].location.path, ".github/workflows/triage.yml");
    assert.equal(live[0].blocking, true);
    const passed = cleanWs.run();
    assert.equal(passed.doc.decision, "passed", passed.out + passed.err);
    assert.equal(passed.doc.findings.filter((f) => f.tool === "zizmor").length, 0);
    const stage = passed.doc.stages.find((s) => s.id === "zizmor#ci-cd");
    assert.equal(stage.state, "completed");
    assert.equal(stage.interpreted, true);
  } finally {
    injection.cleanup();
    cleanWs.cleanup();
  }
});

test("zizmor parser: fail-closed on a document that is not the json-v1 list, and ignored findings are not reported", () => {
  const opts = { stageId: "zizmor#ci-cd", version: "1.32.0", root: "." };
  for (const bad of ["", "not json", "{}", '"x"', "[1]", '[{"ident":"x"}]', '[{"ident":"x","determinations":{"severity":"High"},"locations":[]}]']) {
    const parsed = adapter.parseZizmorOutput(bad, opts);
    assert.equal(parsed.ok, false, `accepted: ${bad}`);
    assert.deepEqual(parsed.findings, []);
  }
  // A finding zizmor itself marked as ignored is a scanner exception: counted, not reported.
  const doc = JSON.parse(recorded("template-injection.json"));
  doc[0].ignored = true;
  const ignored = adapter.parseZizmorOutput(JSON.stringify(doc), opts);
  assert.equal(ignored.ok, true);
  assert.equal(ignored.findings.length, 0);
  assert.equal(ignored.ignored, 1);
  // An unknown severity blocks; a low one does not.
  doc[0].ignored = false;
  doc[0].determinations.severity = "Surprising";
  assert.equal(adapter.parseZizmorOutput(JSON.stringify(doc), opts).findings[0].blocking, true);
  doc[0].determinations.severity = "Low";
  const low = adapter.parseZizmorOutput(JSON.stringify(doc), opts).findings[0];
  assert.equal(low.blocking, false);
  assert.equal(low.normalizedSeverity, "low");
  // A scan root inside a component prefixes the path.
  assert.equal(adapter.parseZizmorOutput(recorded("template-injection.json"), { ...opts, root: "services/api" }).findings[0].location.path, "services/api/.github/workflows/triage.yml");
});

test("zizmor plan: a repo with .github/workflows lists the check under the infrastructure domain", () => {
  const ws = setup("injection");
  try {
    const planned = ws.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = itemOf(planned);
    assert.ok(item, "zizmor#ci-cd is in the plan");
    assert.equal(item.category, "infrastructure");
    assert.equal(item.adapter, "zizmor");
    assert.equal(item.state.enabled, true);
    assert.deepEqual(item.capabilities, ["ci-cd"]);
    assert.equal(item.network, false);
    assert.equal(item.effects.mayChangeCode, false);
    const args = item.command.args;
    assert.ok(args.includes("json-v1") && args.includes("--no-exit-codes") && args.includes("--offline"), args.join(" "));
    assert.equal(args[args.indexOf("--persona") + 1], "regular");
    assert.ok(planned.doc.plan.templates.active.some((a) => a.id === "github-actions-zizmor" && a.reason === "DETECTED"));
  } finally {
    ws.cleanup();
  }
});

test("zizmor plan: without workflows the check is not applicable (the template stays undetected and zizmor is not in the plan)", () => {
  const ws = setup(null);
  try {
    // A project that lists the template (as init does for a repo that has workflows) but has none now.
    const root = fs.readFileSync(path.join(ws.dir, "jgates.yml"), "utf8");
    fs.writeFileSync(path.join(ws.dir, "jgates.yml"), `${root.trimEnd()}\n  - id: github-actions-zizmor\n    source: builtin:github-actions-zizmor\n    activation: detected\n`);
    const planned = ws.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const all = [...planned.doc.plan.groups.willRun, ...planned.doc.plan.groups.notApplicableOrDisabled];
    assert.equal(all.some((i) => i.adapter === "zizmor"), false);
    const inactive = planned.doc.plan.templates.inactive.find((a) => a.id === "github-actions-zizmor");
    assert.equal(inactive?.reason, "NOT_DETECTED");
    // An empty .github/workflows folder is no evidence either, and neither is a non-YAML file.
    fs.mkdirSync(path.join(ws.dir, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(ws.dir, ".github", "workflows", "notes.txt"), "not a workflow\n");
    assert.equal(ws.plan().doc.plan.templates.inactive.find((a) => a.id === "github-actions-zizmor")?.reason, "NOT_DETECTED");
    // A .yaml workflow is evidence.
    fs.writeFileSync(path.join(ws.dir, ".github", "workflows", "ci.yaml"), "name: ci\non: push\njobs: {}\n");
    assert.equal(itemOf(ws.plan())?.category, "infrastructure");
  } finally {
    ws.cleanup();
  }
});

test("zizmor init: the template is written only for a repo that has workflows", () => {
  const withFlows = setup("clean");
  const without = setup(null);
  try {
    assert.match(fs.readFileSync(path.join(withFlows.dir, "jgates.yml"), "utf8"), /builtin:github-actions-zizmor/);
    assert.doesNotMatch(fs.readFileSync(path.join(without.dir, "jgates.yml"), "utf8"), /zizmor/);
  } finally {
    withFlows.cleanup();
    without.cleanup();
  }
});

test("zizmor settings: persona, minimum severity and offline reach the command; an invalid one refuses the plan", () => {
  const tools = "schemaVersion: 1\ntools:\n  zizmor:\n    adapter: zizmor\n    capabilities: [ci-cd]\n    persona: auditor\n    minSeverity: medium\n    offline: false\n";
  const ws = setup("injection", { tools });
  try {
    const item = itemOf(ws.plan());
    assert.ok(item, "the instance of tools.yml is planned");
    const args = item.command.args;
    assert.equal(args[args.indexOf("--persona") + 1], "auditor");
    assert.equal(args[args.indexOf("--min-severity") + 1], "medium");
    assert.equal(args.includes("--offline"), false);
    assert.equal(item.network, true);
  } finally {
    ws.cleanup();
  }
  const bad = adapter.zizmorSettings({ tool: "zizmor", config: { tools: { zizmor: { persona: "paranoid", minSeverity: "urgent", offline: "no" } } } });
  assert.equal(bad.problems.length, 3);
  assert.match(bad.problems.join(" "), /paranoid/);
  const defaults = adapter.zizmorSettings({ tool: "zizmor", config: { tools: { zizmor: {} } } });
  assert.deepEqual({ persona: defaults.persona, minSeverity: defaults.minSeverity, offline: defaults.offline, problems: defaults.problems }, { persona: "regular", minSeverity: null, offline: true, problems: [] });
});

test("zizmor prerequisites: a tool the tools image lacks is unavailable with the image's cause, and nothing is offered to install on the host", () => {
  const imageJson = imageJsonWithout("zizmor");
  const ws = setup("injection", { env: { JGATES_ZIZMOR: "", JGATES_IMAGE_JSON: imageJson } });
  try {
    const item = itemOf(ws.plan());
    assert.equal(item.availability.status, "unavailable");
    assert.match(item.availability.reason, /jgates setup/);
    assert.doesNotMatch(item.availability.reason, /pip install|doctor --fix/);
    // The doctor diagnoses it as missing, with no recipe: a tool is never installed on the host.
    const env = { ...ws.env, PATH: os.tmpdir() };
    const assessment = install.assessEnvironment(ws.dir, { env });
    const tool = assessment.report.tools.find((x) => x.adapter === "zizmor");
    assert.ok(tool, "the instance is diagnosed");
    assert.equal(tool.missing, true);
    assert.equal(tool.recipe, null);
    assert.equal(assessment.recipes.has("tool:zizmor"), false);
    assert.equal(tool.fix, "jgates setup");
    const report = prerequisites.listPrerequisites(ws.dir, { env, assessment });
    assert.ok(report.items.every((i) => ["docker-install", "docker-start", "image-pull", "git-trust", "data-prepare", "manual"].includes(i.kind)), JSON.stringify(report.items));
    assert.equal(report.items.find((i) => i.names.includes(tool.instance))?.kind, "manual");
  } finally {
    ws.cleanup();
  }
});

test("zizmor manifest: infrastructure domain, ci-cd capability, distribution from an authorized source and a matrix row", () => {
  const manifest = manifests.builtinManifests().find((m) => m.id === "zizmor");
  assert.ok(manifest);
  assert.deepEqual(manifest.categories, ["infrastructure"]);
  assert.deepEqual(manifest.capabilities, ["ci-cd"]);
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.distribution.mode, "prepared-from-authorized-source");
  assert.equal(manifest.distribution.spdx, "MIT");
  assert.ok(manifest.distribution.acquisition.length > 0 && manifest.distribution.setup.length > 0);
  assert.equal(manifest.effects.mayChangeCode, false);
  assert.equal(manifest.stackSupport.find((r) => r.capability === "ci-cd")?.state, "validated");
});
