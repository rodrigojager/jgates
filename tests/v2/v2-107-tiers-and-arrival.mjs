import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importDist } from "./fixtures/sequence/helpers.mjs";

// V2-107 (fake engine): tiers and arrival (ADR-0022, PLAN-engine.md sections 6 and 7). On a project with a file of
// every group: Strict's plan has every tool whose files exist, each "where it applies" and never blocking; Balanced's
// has the core and main tools and lists the extended ones off with their reason; Essential's has the core tools only;
// a tool that does not apply here says why and never blocks; `--only tool:<id>` and the profile toggle switch one on;
// switching one off under Strict removes it and marks nothing as reduced. A project whose jgates.yml predates the
// linter engine and is not changed gets the same plans as one that lists every implicit template (they are implicit),
// its file stays byte-identical, and the plan names the tools that are new since its last run; a project that switches
// a group off in its file does not get that group.
//
// The groups are the real implicit templates of the build (the linter engine's descriptor groups) plus one fake group
// registered for this case, so the case proves the mechanics whatever the number of descriptors. Only plans are built:
// no engine, no tool runs.

const { buildPlan, validatePlanDocument } = await importDist("core", "plan", "index.js");
const { registerTemplateProvider, listImplicitTemplates } = await importDist("builtin", "index.js");

const QUIET = { effects: { readsCode: false, writesOutputs: false, mayChangeCode: false, executesProjectCode: false, usesNetwork: false }, evidence: { kind: "exit-code" } };
const fakeTool = (capability, tier) => ({ adapter: "generic-command", enabled: true, tier, capabilities: [capability], command: process.execPath, args: ["-e", "process.exit(0)"], config: QUIET });
const FAKE = {
  id: "lint-v107",
  value: {
    schemaVersion: 1,
    id: "lint-v107",
    label: "V2-107 fake group",
    implicit: true,
    extends: ["builtin:base"],
    match: { files: ["*.v107"] },
    config: { tools: { "v107-main": fakeTool("lint", "main"), "v107-ext": fakeTool("spelling", "extended") } },
  },
};

/** A file name that one evidence pattern of a template selects (`**` folders become `deep/`, `*` becomes `sample`). */
function sampleFor(pattern) {
  if (typeof pattern !== "string") return null;
  // Only file-type patterns: a configuration file name would also switch on the tools that need one.
  const leaf = pattern.split("/").pop();
  if (!leaf.startsWith("*.")) return null;
  return pattern.replace(/\*\*\//g, "deep/").replace(/\*/g, "sample");
}

const OLD_ROOT = "schemaVersion: 1\ntemplates:\n  - id: base\n    source: builtin:base\n    activation: always\n";

function workspace(root = OLD_ROOT) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v2-107-"));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write("jgates.yml", root);
  for (const t of listImplicitTemplates()) {
    const files = t.value.match?.files ?? [];
    const sample = files.map(sampleFor).find((s) => s !== null);
    if (sample) write(sample, "x\n");
  }
  return { dir, write };
}

function planOf(dir, home, options = {}) {
  const r = buildPlan(dir, { home, env: { ...process.env, JGATES_HOME: home }, compare: false, ...options });
  assert.equal(r.ok, true, JSON.stringify(r.error ?? null));
  assert.deepEqual(validatePlanDocument(r.plan), []);
  return r.plan;
}

const all = (p) => [...p.groups.willRun, ...p.groups.notApplicableOrDisabled];
const itemsOf = (p, tool) => all(p).filter((i) => i.tool === tool);
/** On by the selection: it runs, or it is on "when available" and does not apply here (it says why). */
const selectedOn = (i) => i.state.enabled || i.reason.code === "NOT_AVAILABLE_HERE";
const blocking = (p, tool) => p.blockers.some((b) => (b.items ?? []).some((x) => x === `tool:${tool}` || x.startsWith(`${tool}#`)));
/** The tool instances of the active implicit templates, with their tier. */
function tieredTools(p) {
  const out = new Map();
  for (const i of all(p)) if (i.tier && i.includedBy.some((inc) => inc.kind === "template")) out.set(i.tool, i.tier);
  return out;
}

test("V2-107: three tiers over the implicit templates, explicit switches, and the tools that are new since the last run", () => {
  registerTemplateProvider("v2-107", () => [FAKE]);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "v2-107-home-"));
  const { dir, write } = workspace();
  write("notes.v107", "x\n");
  try {
    const yml = path.join(dir, "jgates.yml");
    const before = fs.readFileSync(yml);
    const strict = planOf(dir, home, { profile: "builtin:strict" });
    const balanced = planOf(dir, home, { profile: "builtin:standard" });
    const essential = planOf(dir, home, { profile: "builtin:minimal" });
    assert.ok(fs.readFileSync(yml).equals(before), "jgates.yml is never written");

    // Every group with a file is active, by the census, without being listed.
    for (const t of listImplicitTemplates()) {
      const files = t.value.match?.files ?? [];
      if (!files.map(sampleFor).some((s) => s !== null) && files.length > 0) continue;
      assert.ok(strict.templates.active.some((a) => a.id === t.id), `${t.id} is active: ${JSON.stringify(strict.templates.inactive.find((x) => x.id === t.id))}`);
    }
    const tiers = tieredTools(strict);
    assert.equal(tiers.get("v107-main"), "main");
    assert.equal(tiers.get("v107-ext"), "extended");

    // Strict: every tool, each one "where it applies"; none blocks; what does not apply here says why.
    for (const [tool] of tiers) {
      for (const i of itemsOf(strict, tool)) {
        assert.ok(selectedOn(i), `${tool} under Strict: ${i.reason.code} ${i.reason.message}`);
        assert.equal(i.state.when, "available", tool);
        if (!i.state.enabled) assert.ok(i.reason.message.length > 0, tool);
      }
      assert.ok(!blocking(strict, tool), `${tool} blocks Strict`);
    }
    // A tool whose configuration is required and absent (descriptor activation `requires`) does not apply here and
    // names the file it needs.
    for (const i of all(strict).filter((x) => tiers.has(x.tool) && x.reason.code === "NOT_AVAILABLE_HERE")) assert.ok(i.reason.message.length > 0, i.tool);

    // Balanced: core and main tools; the extended ones are off with the profile that runs them.
    for (const [tool, tier] of tiers) {
      for (const i of itemsOf(balanced, tool)) {
        if (tier === "main") assert.ok(selectedOn(i), `${tool} under Balanced: ${i.reason.code}`);
        else {
          assert.equal(i.reason.code, "ABOVE_PROFILE_TIER", tool);
          assert.match(i.reason.message, /Strict|Rigoroso/);
        }
      }
      assert.ok(!blocking(balanced, tool), `${tool} blocks Balanced`);
    }

    // Essential: nothing of a tier above core runs; each says from which profile it runs.
    assert.ok(essential.groups.willRun.every((i) => i.tier === undefined), JSON.stringify(essential.groups.willRun.filter((i) => i.tier).map((i) => i.id)));
    for (const [tool] of tiers) for (const i of itemsOf(essential, tool)) assert.equal(i.reason.code, "ABOVE_PROFILE_TIER", tool);

    // Implicit means the same plans as a project that lists every implicit template itself.
    const listed = workspace(OLD_ROOT + listImplicitTemplates().map((t) => `  - id: ${t.id}\n    source: ${t.ref}\n`).join(""));
    listed.write("notes.v107", "x\n");
    try {
      const ids = (p) => p.groups.willRun.map((i) => i.id).sort();
      assert.deepEqual(ids(planOf(listed.dir, home, { profile: "builtin:strict" })), ids(strict));
      assert.deepEqual(ids(planOf(listed.dir, home, { profile: "builtin:standard" })), ids(balanced));
    } finally {
      fs.rmSync(listed.dir, { recursive: true, force: true });
    }

    // What is new since the last run: the last run was made under Essential.
    const runDir = path.join(home, "workspaces", strict.workspace.id, "runs", "run-before-upgrade");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify({ startedAt: "2026-11-01T00:00:00.000Z", partial: false }));
    fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify(essential));
    const after = planOf(dir, home, { profile: "builtin:strict", compare: true });
    const ranBefore = new Set(essential.groups.willRun.map((i) => i.tool));
    assert.equal(after.newSinceLastRun.runId, "run-before-upgrade");
    assert.deepEqual(after.newSinceLastRun.tools, [...new Set(after.groups.willRun.map((i) => i.tool).filter((t) => !ranBefore.has(t)))].sort());
    if (after.groups.willRun.some((i) => i.tool === "v107-main")) assert.ok(after.newSinceLastRun.tools.includes("v107-main"));
    assert.equal(after.planHash, strict.planHash, "the run history is not part of the plan's hash");
    assert.ok(fs.readFileSync(yml).equals(before), "jgates.yml is never written");
  } finally {
    registerTemplateProvider("v2-107", null);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("V2-107: the profile toggle and --only switch a tool on above the tier; off under Strict is not reduced; a group listed off stays off", () => {
  registerTemplateProvider("v2-107", () => [FAKE]);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "v2-107-home-"));
  const { dir, write } = workspace("schemaVersion: 1\nselection:\n  profile: mine\n");
  write("notes.v107", "x\n");
  const profiles = (body) => write(".jgates/profiles.yml", JSON.stringify({ schemaVersion: 1, profiles: { mine: body } }, null, 2) + "\n");
  try {
    // Balanced with the extended tool switched on in the project's profile (what the profile editor writes).
    profiles({ extends: "builtin:standard", checks: { "tool:v107-ext": { enabled: true } } });
    let p = planOf(dir, home);
    const on = itemsOf(p, "v107-ext")[0];
    assert.ok(on.state.enabled || on.reason.code !== "ABOVE_PROFILE_TIER", JSON.stringify(on.reason));
    assert.equal(on.state.reason, "EXPLICIT");
    assert.equal(on.state.decision.selector, "tool:v107-ext");

    // Balanced, and --only tool:<id> for one run.
    profiles({ extends: "builtin:standard" });
    p = planOf(dir, home, { only: ["tool:v107-ext"] });
    const only = itemsOf(p, "v107-ext")[0];
    assert.equal(only.state.reason, "EXPLICIT");
    assert.equal(only.state.decision.source, "--only");
    assert.equal(itemsOf(planOf(dir, home), "v107-ext")[0].reason.code, "ABOVE_PROFILE_TIER", "--only wrote nothing");

    // Strict with one tool switched off: removed, and the plan is not "reduced".
    profiles({ extends: "builtin:strict", checks: { "tool:v107-main": { enabled: false } } });
    p = planOf(dir, home);
    const off = itemsOf(p, "v107-main")[0];
    assert.equal(off.state.enabled, false);
    assert.equal(off.reason.code, "DISABLED");
    assert.equal(p.selection.reduced, false);
    assert.ok(!blocking(p, "v107-main"));

    // A project that switches the group off in its file does not get it (its profile no longer names the tool: a
    // selector that names nothing is an error).
    profiles({ extends: "builtin:strict" });
    fs.writeFileSync(path.join(dir, "jgates.yml"), "schemaVersion: 1\nselection:\n  profile: mine\ntemplates:\n  - id: lint-v107\n    source: builtin:lint-v107\n    activation: manual\n");
    p = planOf(dir, home);
    assert.equal(itemsOf(p, "v107-main").length, 0);
    assert.equal(itemsOf(p, "v107-ext").length, 0);
    assert.ok(p.templates.inactive.some((t) => t.id === "lint-v107" && t.reason === "MANUAL"));
  } finally {
    registerTemplateProvider("v2-107", null);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
