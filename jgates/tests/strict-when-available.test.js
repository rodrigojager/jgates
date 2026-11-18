import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Checks enabled "when available" (`when: available` in a profile check entry) and builtin:strict, which turns on every
// catalog capability: a capability with an applicable, executable check runs; without one it is reported apart as not
// applicable here, with the reason, and never blocks. A plain enabled check stays required (fail-closed). Below, the
// tiers of ADR-0022 (which profile runs which tool) and the implicit built-in templates.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const load = (rel) => import(pathToFileURL(path.join(dist, ...rel.split("/"))).href);
const { buildPlan, validatePlanDocument } = await load("core/plan/index.js");
const { validateDocument } = await load("core/config/load/schema.js");
const { getBuiltinProfile, builtinProfileBody } = await load("builtin/index.js");
const { CORE_CAPABILITIES } = await load("core/catalog/index.js");
const { translator } = await load("i18n/index.js");

/** A small Python project with its own profiles and tools, without templates (only what the test declares). */
function project({ profiles, tools = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-when-"));
  fs.mkdirSync(path.join(dir, ".jgates"));
  fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(dir, "app.py"), "def add(a, b):\n    return a + b\n");
  fs.writeFileSync(path.join(dir, "jgates.yml"), "schemaVersion: 1\nselection:\n  profile: p\ntemplates: []\n");
  // JSON is YAML: the files are written as JSON documents.
  fs.writeFileSync(path.join(dir, ".jgates", "profiles.yml"), JSON.stringify({ schemaVersion: 1, profiles }, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), JSON.stringify({ schemaVersion: 1, tools }, null, 2) + "\n");
  return dir;
}

function plan(dir, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-when-home-"));
  try {
    const result = buildPlan(dir, { compare: false, home, env: { ...process.env, JGATES_HOME: home }, ...options });
    assert.equal(result.ok, true, JSON.stringify(result.error ?? null));
    return result.plan;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const PII = { "builtin-pii": { adapter: "builtin-pii", capabilities: ["pii"] } };
const withDir = (spec, fn) => {
  const dir = project(spec);
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const notHere = (p) => p.groups.notApplicableRequirements ?? [];
const uncoveredBlocker = (p) => p.blockers.find((b) => b.code === "REQUIREMENT_UNCOVERED");

test("when available with an executable candidate: the check runs normally and covers the capability", () => {
  withDir({ profiles: { p: { checks: { "capability:pii": { enabled: true, when: "available" } } } }, tools: PII }, (dir) => {
    const p = plan(dir);
    const item = p.groups.willRun.find((i) => i.id === "builtin-pii#pii");
    assert.ok(item, "builtin-pii runs");
    assert.equal(item.state.when, "available");
    const req = p.requirements.find((r) => r.selector === "capability:pii");
    assert.equal(req.when, "available");
    assert.deepEqual(req.coveredBy, ["builtin-pii#pii"]);
    assert.equal(notHere(p).length, 0);
    assert.equal(p.groups.uncoveredRequirements.length, 0);
    assert.deepEqual(validatePlanDocument(p), []);
  });
});

test("when available without a candidate: not applicable here with a reason code, never a blocker, plan approvable and not reduced", () => {
  const checks = {
    "capability:pii": { enabled: true },
    "capability:mutation": { enabled: true, when: "available" },
    "capability:e2e": { enabled: true, when: "available" },
    "capability:properties": { enabled: true, when: "available" },
    "capability:tests": { enabled: true, when: "available" },
  };
  withDir({ profiles: { p: { checks } }, tools: PII }, (dir) => {
    const p = plan(dir);
    const by = Object.fromEntries(notHere(p).map((n) => [n.selector, n]));
    assert.deepEqual(Object.keys(by).sort(), ["capability:e2e", "capability:mutation", "capability:properties", "capability:tests"]);
    // End-to-end tests have an adapter for Python (pytest-playwright), but no instance is declared: it needs setup.
    assert.equal(by["capability:e2e"].reasonCode, "SETUP_REQUIRED");
    assert.equal(by["capability:e2e"].action.adapter, "playwright");
    assert.ok(by["capability:e2e"].adapters.some((a) => a.id === "playwright" && a.applicable));
    // The whole-suite tests capability exists only for Rust (cargo-test): not for this Python project.
    assert.equal(by["capability:tests"].reasonCode, "NO_TOOL_FOR_LANGUAGES");
    assert.deepEqual(by["capability:tests"].languages, ["python"]);
    assert.ok(by["capability:tests"].adapters.every((a) => !a.applicable));
    // Property tests have an adapter for Python (pytest, Hypothesis), but no instance is declared: it needs setup.
    assert.equal(by["capability:properties"].reasonCode, "SETUP_REQUIRED");
    assert.ok(by["capability:properties"].adapters.some((a) => a.id === "pytest" && a.applicable));
    // Mutation has an adapter for Python, but no instance is declared: it needs setup.
    const mutation = by["capability:mutation"];
    assert.equal(mutation.reasonCode, "SETUP_REQUIRED");
    assert.equal(mutation.when, "available");
    assert.equal(mutation.action.adapter, "mutation");
    assert.ok(mutation.adapters.some((a) => a.id === "mutation" && a.applicable && a.prerequisites.some((x) => /mutmut/.test(x))));
    assert.ok(mutation.message.length > 0 && mutation.label.length > 0);
    // Nothing of it blocks, nothing is "reduced".
    assert.equal(p.groups.uncoveredRequirements.length, 0);
    assert.equal(uncoveredBlocker(p), undefined);
    assert.equal(p.selection.reduced, false);
    assert.ok(!p.blockers.some((b) => (b.items ?? []).some((i) => /mutation|e2e|properties|tests/.test(i))));
    assert.equal(p.approvable, true, JSON.stringify(p.blockers));
    assert.deepEqual(validatePlanDocument(p), []);
  });
});

test("fail-closed unchanged: a capability enabled without `when` and with no executable check still blocks", () => {
  withDir({ profiles: { p: { checks: { "capability:pii": { enabled: true }, "capability:mutation": { enabled: true } } } }, tools: PII }, (dir) => {
    const p = plan(dir);
    const u = p.groups.uncoveredRequirements.find((x) => x.selector === "capability:mutation");
    assert.ok(u, "mutation is an uncovered requirement");
    assert.equal(u.reason, "NO_EXECUTABLE_CHECK");
    assert.equal(u.when, undefined);
    assert.deepEqual(uncoveredBlocker(p)?.items, ["capability:mutation"]);
    assert.equal(p.approvable, false);
    assert.equal(notHere(p).length, 0);
  });
});

test("a plain `enabled: true` of a child profile over a parent's `when: available` makes the check required again", () => {
  const profiles = {
    parent: { checks: { "capability:pii": { enabled: true }, "capability:mutation": { enabled: true, when: "available" } } },
    p: { extends: "parent", checks: { "capability:mutation": { enabled: true } } },
  };
  withDir({ profiles, tools: PII }, (dir) => {
    const p = plan(dir);
    assert.ok(p.groups.uncoveredRequirements.some((u) => u.selector === "capability:mutation"));
    assert.ok(uncoveredBlocker(p));
    assert.equal(p.approvable, false);
  });
});

test("when available with the tool missing: the item does not run, the capability is TOOL_MISSING and nothing blocks", () => {
  // oasdiff without an OpenAPI specification (and usually without the binary) is unavailable at planning.
  const tools = { ...PII, oasdiff: { adapter: "oasdiff", capabilities: ["api-compatibility"], baseRef: "main" } };
  const checks = (when) => ({ "capability:pii": { enabled: true }, "capability:api-compatibility": { enabled: true, ...(when ? { when: "available" } : {}) } });
  withDir({ profiles: { p: { checks: checks(true) } }, tools }, (dir) => {
    const p = plan(dir);
    assert.ok(!p.groups.willRun.some((i) => i.tool === "oasdiff"));
    const item = p.groups.notApplicableOrDisabled.find((i) => i.tool === "oasdiff");
    assert.equal(item.reason.code, "NOT_AVAILABLE_HERE");
    assert.equal(item.state.when, "available");
    const n = notHere(p).find((x) => x.selector === "capability:api-compatibility");
    assert.equal(n.reasonCode, "TOOL_MISSING");
    assert.equal(n.action.kind, "prepare-tool");
    assert.deepEqual(n.action.tools, ["oasdiff"]);
    assert.ok(!p.blockers.some((b) => (b.items ?? []).some((i) => /oasdiff|api-compatibility/.test(i))));
    assert.ok(!p.invocations.some((inv) => inv.id === "oasdiff"));
    assert.deepEqual(validatePlanDocument(p), []);
  });
  // The same tool, required: it stays planned and its unavailability is reported as before (never silently dropped).
  withDir({ profiles: { p: { checks: checks(false) } }, tools }, (dir) => {
    const p = plan(dir);
    assert.ok(p.groups.willRun.some((i) => i.tool === "oasdiff"));
    assert.equal(notHere(p).length, 0);
  });
});

test("when available, a declared instance without a required setting: configure first (the form), then prepare when the tool is missing too", () => {
  const checks = { "capability:pii": { enabled: true }, "capability:api-compatibility": { enabled: true, when: "available" } };
  const tools = { ...PII, oasdiff: { adapter: "oasdiff", capabilities: ["api-compatibility"] } };
  withDir({ profiles: { p: { checks } }, tools }, (dir) => {
    const p = plan(dir);
    const item = p.groups.notApplicableOrDisabled.find((i) => i.tool === "oasdiff");
    const n = notHere(p).find((x) => x.selector === "capability:api-compatibility");
    assert.equal(n.reasonCode, "SETUP_REQUIRED");
    assert.equal(n.action.kind, "configure-tool");
    assert.deepEqual(n.action.tools, ["oasdiff"], "the action points at the declared instance (its options form)");
    assert.deepEqual(n.action.settings, ["baseRef"]);
    const binaryMissing = item.runtime !== null && !item.runtime.available;
    assert.equal(n.action.prepareNext, binaryMissing);
    if (binaryMissing) assert.match(n.message, /then prepare the tool|depois prepare-a/);
    assert.ok(!p.blockers.some((b) => (b.items ?? []).some((i) => /oasdiff|api-compatibility/.test(i))));
    assert.deepEqual(validatePlanDocument(p), []);
  });
  // baseSpec stands in for baseRef: nothing left to configure, only the tool (when missing) to prepare.
  withDir({ profiles: { p: { checks } }, tools: { ...PII, oasdiff: { ...tools.oasdiff, baseSpec: "base.yaml" } } }, (dir) => {
    const n = notHere(plan(dir)).find((x) => x.selector === "capability:api-compatibility");
    assert.notEqual(n.action.kind, "configure-tool");
  });
});

test("a template tool on 'when available' and missing here is listed to prepare, as optional, never essential", async () => {
  const { listPrerequisites } = await load("core/prerequisites/index.js");
  const checks = { "capability:pii": { enabled: true }, "capability:mutation": { enabled: true, when: "available" } };
  withDir({ profiles: { p: { checks } }, tools: PII }, (dir) => {
    fs.writeFileSync(path.join(dir, "jgates.yml"), "schemaVersion: 1\nselection:\n  profile: p\ntemplates:\n  - id: python-mutmut\n    source: builtin:python-mutmut\n    activation: detected\n");
    const p = plan(dir);
    const item = p.groups.notApplicableOrDisabled.find((i) => i.adapter === "mutation");
    if (!item || item.reason.code !== "NOT_AVAILABLE_HERE") return; // mutmut installed on this machine: nothing to prepare
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-when-home-"));
    try {
      const report = listPrerequisites(dir, { env: { ...process.env, JGATES_HOME: home } });
      const mine = report.items.find((i) => i.names.includes(item.tool));
      assert.ok(mine, `the missing ${item.tool} is offered: ${JSON.stringify(report.items.map((i) => i.names))}`);
      assert.equal(mine.classification, "optional");
      assert.ok(!report.items.some((i) => i.classification === "essential" && i.names.includes(item.tool)));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

test("a new instance created through the tools route declares the adapter's capability, so a profile selects it", async () => {
  const { createInstance, defaultCapabilities } = await load("core/tools/instances.js");
  assert.deepEqual(defaultCapabilities("zap"), ["dast"]);
  assert.deepEqual(defaultCapabilities("gitleaks"), ["secrets"], "a mode adapter gets only its first capability");
  assert.deepEqual(defaultCapabilities("generic-command"), []);
  const checks = { "capability:pii": { enabled: true }, "capability:dast": { enabled: true, when: "available" } };
  withDir({ profiles: { p: { checks } }, tools: PII }, (dir) => {
    createInstance(dir, { id: "zap-web", adapter: "zap" });
    const yml = fs.readFileSync(path.join(dir, ".jgates", "tools.yml"), "utf8");
    assert.match(yml, /zap-web:[\s\S]*capabilities:[\s\S]*dast/);
    const p = plan(dir);
    const n = notHere(p).find((x) => x.selector === "capability:dast");
    // Selected by the profile: what is left is its target (the URL JGates cannot guess), on that instance.
    assert.equal(n.action.kind, "configure-tool");
    assert.deepEqual(n.action.tools, ["zap-web"]);
    assert.deepEqual(n.action.settings, ["target"]);
  });
});

test("profiles.schema.json accepts `when: available` and rejects any other value", () => {
  const doc = (when) => ({ schemaVersion: 1, profiles: { p: { checks: { "capability:mutation": { enabled: true, when } } } } });
  assert.deepEqual(validateDocument("profiles", doc("available"), ".jgates/profiles.yml"), []);
  assert.ok(validateDocument("profiles", doc("always"), ".jgates/profiles.yml").length > 0);
  assert.ok(validateDocument("profiles", doc(true), ".jgates/profiles.yml").length > 0);
});

test("builtin:strict: unit and coverage required, every other core capability not required by standard is on when available", () => {
  const strict = builtinProfileBody(getBuiltinProfile("builtin:strict")).checks;
  const standard = new Set(["file-size", "lint", "secrets", "sast", "dependencies", "duplication", "iac", "pii"]);
  assert.deepEqual(strict["capability:unit"], { enabled: true });
  assert.deepEqual(strict["capability:coverage"], { enabled: true });
  for (const cap of CORE_CAPABILITIES.map((c) => c.id)) {
    if (standard.has(cap) || cap === "unit" || cap === "coverage") continue;
    assert.deepEqual(strict[`capability:${cap}`], { enabled: true, when: "available" }, cap);
  }
});

test("builtin:strict on a Python project lists every extra capability as planned or not applicable, without uncovered blockers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-strict-"));
  try {
    fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
    fs.writeFileSync(path.join(dir, "app.py"), "def add(a, b):\n    return a + b\n");
    // No template list: the implicit templates of the detected stack apply.
    fs.writeFileSync(path.join(dir, "jgates.yml"), "schemaVersion: 1\n");
    const p = plan(dir, { profile: "builtin:strict" });
    const listed = new Set([...p.requirements.filter((r) => r.coveredBy.length > 0).map((r) => r.selector), ...notHere(p).map((n) => n.selector)]);
    for (const cap of ["format-check", "typecheck", "secrets-history", "dataflow", "dast", "integration", "e2e", "mutation", "tests", "properties", "api-contract", "api-compatibility", "licenses", "supply-chain", "migration", "performance", "ci-cd"]) {
      assert.ok(listed.has(`capability:${cap}`), cap);
    }
    const blocker = uncoveredBlocker(p);
    const whenAvailable = new Set(p.requirements.filter((r) => r.when === "available").map((r) => r.selector));
    assert.ok(!(blocker?.items ?? []).some((s) => whenAvailable.has(s)), JSON.stringify(blocker));
    for (const n of notHere(p)) assert.ok(n.message.length > 0 && n.reasonCode, n.selector);
    assert.deepEqual(validatePlanDocument(p), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Tiers (ADR-0022): a capability entry switches tools on up to the profile's tier, and the tools a tier adds
// never block. The instances are declared by the test with their tier (as the engine's derived templates declare
// theirs); none has its own `enabled`, so only the profile decides, as for a template's tools.

const { registerTemplateProvider, listImplicitTemplates } = await load("builtin/index.js");

const QUIET = { effects: { readsCode: false, writesOutputs: false, mayChangeCode: false, executesProjectCode: false, usesNetwork: false }, evidence: { kind: "exit-code" } };
const fake = (capability, tier) => ({
  adapter: "generic-command",
  capabilities: [capability],
  command: process.execPath,
  args: ["-e", "process.exit(0)"],
  config: QUIET,
  ...(tier ? { tier } : {}),
});
const TIERED = { "core-lint": fake("lint"), "main-lint": fake("lint", "main"), "ext-lint": fake("lint", "extended"), "ext-spell": fake("spelling", "extended") };

/** A project on a built-in profile (or its own `p`), with the tiered instances; `files` adds or replaces files. */
function tiered({ profile, profiles = {}, tools = TIERED, files = {} }) {
  const dir = project({ profiles: Object.keys(profiles).length > 0 ? profiles : { p: { extends: profile } }, tools });
  fs.writeFileSync(path.join(dir, "jgates.yml"), `schemaVersion: 1\nselection:\n  profile: ${Object.keys(profiles).length > 0 ? "p" : profile}\ntemplates: []\n`);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
const withTiered = (spec, fn) => {
  const dir = tiered(spec);
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const itemOf = (p, tool) => [...p.groups.willRun, ...p.groups.notApplicableOrDisabled].find((i) => i.tool === tool);
/** On by the selection: it runs, or it is on "when available" and its tool is missing here. */
const selectedOn = (i) => i.state.enabled || i.reason.code === "NOT_AVAILABLE_HERE";

test("built-in profiles carry their tier: Essential core, Balanced main, Strict extended", () => {
  assert.equal(builtinProfileBody(getBuiltinProfile("builtin:minimal")).tier, "core");
  assert.equal(builtinProfileBody(getBuiltinProfile("builtin:standard")).tier, "main");
  assert.equal(builtinProfileBody(getBuiltinProfile("builtin:strict")).tier, "extended");
  const strict = builtinProfileBody(getBuiltinProfile("builtin:strict")).checks;
  for (const cap of ["spelling", "links", "sbom"]) assert.deepEqual(strict[`capability:${cap}`], { enabled: true, when: "available" }, cap);
  assert.ok(validateDocument("profiles", { schemaVersion: 1, profiles: { p: { tier: "main" } } }, ".jgates/profiles.yml").length === 0);
  assert.ok(validateDocument("profiles", { schemaVersion: 1, profiles: { p: { tier: "all" } } }, ".jgates/profiles.yml").length > 0);
  assert.ok(validateDocument("tools", { schemaVersion: 1, tools: { x: { adapter: "generic-command", tier: "extended" } } }, ".jgates/tools.yml").length === 0);
  assert.ok(validateDocument("tools", { schemaVersion: 1, tools: { x: { adapter: "generic-command", tier: "max" } } }, ".jgates/tools.yml").length > 0);
});

test("the three new capabilities exist with their category, mascot placement and texts in both languages", async () => {
  const { MASCOT_DOMAINS } = await load("core/mascots/index.js");
  const byId = new Map(CORE_CAPABILITIES.map((c) => [c.id, c]));
  assert.equal(byId.get("spelling")?.category, "quality");
  assert.equal(byId.get("links")?.category, "quality");
  assert.equal(byId.get("sbom")?.category, "dependencies");
  assert.ok(MASCOT_DOMAINS.includes("quality"));
  for (const lang of ["en", "pt-BR"]) {
    const t = translator("catalog", lang);
    for (const cap of ["spelling", "links", "sbom"]) {
      assert.notEqual(t(`capability_${cap}_label`), `capability_${cap}_label`, `${lang} ${cap}`);
      assert.notEqual(t(`capability_${cap}_description`), `capability_${cap}_description`, `${lang} ${cap}`);
    }
  }
});

test("Essential runs the core tools only; the others are listed off with the profile that runs them", () => {
  withTiered({ profile: "builtin:minimal" }, (dir) => {
    const p = plan(dir);
    assert.equal(p.profile.tier, "core");
    assert.ok(selectedOn(itemOf(p, "core-lint")));
    const main = itemOf(p, "main-lint");
    assert.equal(main.state.enabled, false);
    assert.equal(main.state.reason, "ABOVE_TIER");
    assert.equal(main.reason.code, "ABOVE_PROFILE_TIER");
    assert.equal(main.tier, "main");
    assert.match(main.reason.message, /Balanced|Equilibrado/);
    for (const tool of ["ext-lint", "ext-spell"]) {
      const i = itemOf(p, tool);
      assert.equal(i.reason.code, "ABOVE_PROFILE_TIER", tool);
      assert.equal(i.tier, "extended");
      assert.match(i.reason.message, /Strict|Rigoroso/);
      assert.match(i.reason.message, new RegExp(`tool:${tool}`));
    }
    assert.equal(itemOf(p, "core-lint").tier, undefined, "a core instance carries no tier");
    assert.ok(!p.blockers.some((b) => (b.items ?? []).some((x) => /main-lint|ext-/.test(x))));
    assert.deepEqual(validatePlanDocument(p), []);
  });
});

test("Balanced runs the core and main tools, the main ones only where available; the extended ones stay off", () => {
  withTiered({ profile: "builtin:standard" }, (dir) => {
    const p = plan(dir);
    assert.equal(p.profile.tier, "main");
    assert.ok(selectedOn(itemOf(p, "core-lint")));
    const main = itemOf(p, "main-lint");
    assert.ok(selectedOn(main), JSON.stringify(main.reason));
    assert.equal(main.state.when, "available");
    for (const tool of ["ext-lint", "ext-spell"]) assert.equal(itemOf(p, tool).reason.code, "ABOVE_PROFILE_TIER", tool);
    assert.deepEqual(validatePlanDocument(p), []);
  });
});

test("Strict runs every tool, each added one only where available, and none of them blocks the plan", () => {
  withTiered({ profile: "builtin:strict" }, (dir) => {
    const p = plan(dir);
    assert.equal(p.profile.tier, "extended");
    for (const tool of ["core-lint", "main-lint", "ext-lint", "ext-spell"]) assert.ok(selectedOn(itemOf(p, tool)), tool);
    for (const tool of ["main-lint", "ext-lint", "ext-spell"]) assert.equal(itemOf(p, tool).state.when, "available", tool);
    assert.ok(!p.blockers.some((b) => (b.items ?? []).some((x) => /main-lint|ext-/.test(x))));
    assert.ok(!p.groups.notApplicableOrDisabled.some((i) => i.reason.code === "ABOVE_PROFILE_TIER"));
    assert.deepEqual(validatePlanDocument(p), []);
  });
});

test("a tool:<id> entry switches a tool on above the tier: from the profile, the tools file and --only", () => {
  // The profile toggle: an entry of the project's profile (required, as any plain enabled check).
  withTiered({ profiles: { p: { extends: "builtin:standard", checks: { "tool:ext-lint": { enabled: true } } } } }, (dir) => {
    const p = plan(dir);
    const i = itemOf(p, "ext-lint");
    assert.ok(selectedOn(i) || i.state.enabled === true, JSON.stringify(i.reason));
    assert.equal(i.state.reason, "EXPLICIT");
    assert.equal(i.state.decision.selector, "tool:ext-lint");
    assert.equal(i.state.when, undefined);
    assert.equal(itemOf(p, "ext-spell").reason.code, "ABOVE_PROFILE_TIER");
  });
  // The tools file: the instance's own switch written by the project.
  withTiered({ profile: "builtin:minimal", tools: { ...TIERED, "ext-lint": { ...TIERED["ext-lint"], enabled: true } } }, (dir) => {
    const i = itemOf(plan(dir), "ext-lint");
    assert.equal(i.state.reason, "EXPLICIT");
    assert.equal(i.state.decision.layer, "project");
  });
  // --only, for this run.
  withTiered({ profile: "builtin:standard" }, (dir) => {
    const p = plan(dir, { only: ["tool:ext-spell"] });
    const i = itemOf(p, "ext-spell");
    assert.equal(i.state.reason, "EXPLICIT");
    assert.equal(i.state.decision.source, "--only");
  });
});

test("switching a tool or a group off under Strict removes it and marks nothing as reduced", () => {
  const profiles = { p: { extends: "builtin:strict", checks: { "tool:ext-lint": { enabled: false }, "capability:spelling": { enabled: false } } } };
  withTiered({ profiles }, (dir) => {
    const p = plan(dir);
    assert.equal(itemOf(p, "ext-lint").state.enabled, false);
    assert.equal(itemOf(p, "ext-lint").reason.code, "DISABLED");
    assert.equal(itemOf(p, "ext-spell").state.enabled, false);
    assert.equal(itemOf(p, "ext-spell").reason.code, "DISABLED");
    assert.ok(selectedOn(itemOf(p, "main-lint")));
    assert.equal(p.selection.reduced, false);
    assert.ok(!p.blockers.some((b) => (b.items ?? []).some((x) => /ext-/.test(x))));
  });
});

test("neither a template's own default nor a capability lock switches a tool on above the tier", () => {
  const template = [
    "schemaVersion: 1",
    "id: mine",
    "config:",
    "  tools:",
    "    tpl-ext:",
    "      adapter: generic-command",
    "      enabled: true",
    "      tier: extended",
    "      capabilities: [lint]",
    `      command: ${JSON.stringify(process.execPath)}`,
    '      args: ["-e", "process.exit(0)"]',
    "      config:",
    "        effects: { readsCode: false, writesOutputs: false, mayChangeCode: false, executesProjectCode: false, usesNetwork: false }",
    "        evidence: { kind: exit-code }",
    "",
  ].join("\n");
  const files = {
    ".jgates/templates/mine.yml": template,
    ".jgates/policy.yml": 'schemaVersion: 1\nrequiredEvidence:\n  - check: "capability:lint"\n    locked: true\n',
  };
  for (const profile of ["builtin:minimal", "builtin:strict"]) {
    withTiered({ profile, files }, (dir) => {
      fs.writeFileSync(path.join(dir, "jgates.yml"), `schemaVersion: 1\nselection:\n  profile: ${profile}\ntemplates:\n  - id: mine\n    source: .jgates/templates/mine.yml\n    activation: always\n`);
      const p = plan(dir);
      const tpl = itemOf(p, "tpl-ext");
      const ext = itemOf(p, "ext-lint");
      if (profile === "builtin:minimal") {
        assert.equal(tpl.reason.code, "ABOVE_PROFILE_TIER", "the template's enabled: true is a default, not the user's switch");
        assert.equal(ext.reason.code, "ABOVE_PROFILE_TIER", "a capability lock is answered by the core tools");
        assert.ok(selectedOn(itemOf(p, "core-lint")));
      } else {
        assert.ok(selectedOn(tpl));
        assert.equal(tpl.state.when, "available");
        assert.ok(selectedOn(ext));
      }
    });
  }
});

// ---- Implicit templates (ADR-0022, PLAN-engine.md section 7): a built-in template marked implicit is part of every
// project's configuration, even one whose jgates.yml lists its templates, and the file is never touched.

const IMPLICIT = {
  id: "lint-tierfake",
  value: {
    schemaVersion: 1,
    id: "lint-tierfake",
    label: "Fake group for the tier tests",
    implicit: true,
    match: { files: ["*.tierfake"] },
    config: { tools: { "tierfake-main": fake("lint", "main"), "tierfake-ext": fake("lint", "extended") } },
  },
};

test("an implicit built-in template reaches a project whose jgates.yml lists its templates, without touching the file", () => {
  registerTemplateProvider("tier-test", () => [IMPLICIT]);
  try {
    assert.ok(listImplicitTemplates().some((t) => t.id === "lint-tierfake"));
    withTiered({ profile: "builtin:standard", tools: {}, files: { "a.tierfake": "x\n" } }, (dir) => {
      const yml = path.join(dir, "jgates.yml");
      const before = fs.readFileSync(yml);
      const p = plan(dir);
      const entry = p.templates.active.find((a) => a.id === "lint-tierfake");
      assert.ok(entry, JSON.stringify(p.templates));
      assert.equal(entry.reason, "DETECTED");
      assert.ok(selectedOn(itemOf(p, "tierfake-main")));
      assert.equal(itemOf(p, "tierfake-ext").reason.code, "ABOVE_PROFILE_TIER");
      assert.ok(fs.readFileSync(yml).equals(before), "jgates.yml unchanged");
      // Listed with enabled: false, the group is off.
      fs.writeFileSync(yml, "schemaVersion: 1\nselection:\n  profile: builtin:standard\ntemplates:\n  - id: lint-tierfake\n    source: builtin:lint-tierfake\n    enabled: false\n");
      const off = plan(dir);
      assert.equal(itemOf(off, "tierfake-main"), undefined);
      assert.ok(off.templates.inactive.some((t) => t.id === "lint-tierfake" && t.reason === "DISABLED"));
    });
    // Without its files the group is not detected.
    withTiered({ profile: "builtin:strict", tools: {} }, (dir) => {
      const p = plan(dir);
      assert.equal(itemOf(p, "tierfake-main"), undefined);
      assert.ok(p.templates.inactive.some((t) => t.id === "lint-tierfake" && t.reason === "NOT_DETECTED"));
    });
  } finally {
    registerTemplateProvider("tier-test", null);
  }
  assert.ok(!listImplicitTemplates().some((t) => t.id === "lint-tierfake"));
});

test("the plan names the tools that are new since the workspace's last run, outside the hash", async () => {
  const { computePlanHash } = await load("core/plan/index.js");
  withTiered({ profile: "builtin:strict" }, (dir) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-when-home-"));
    try {
      const make = () => {
        const r = buildPlan(dir, { home, env: { ...process.env, JGATES_HOME: home } });
        assert.equal(r.ok, true, JSON.stringify(r.error ?? null));
        return r.plan;
      };
      const first = make();
      assert.equal(first.newSinceLastRun, null, "no run yet: nothing to compare with");
      const runDir = path.join(home, "workspaces", first.workspace.id, "runs", "run-1");
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify({ startedAt: "2026-11-01T00:00:00.000Z", partial: false }));
      fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({ groups: { willRun: [{ id: "core-lint#lint", tool: "core-lint" }] } }));
      const next = make();
      const ran = new Set(next.groups.willRun.map((i) => i.tool));
      assert.equal(next.newSinceLastRun.runId, "run-1");
      assert.deepEqual(next.newSinceLastRun.tools, [...ran].filter((t) => t !== "core-lint").sort());
      assert.ok(!next.newSinceLastRun.tools.includes("core-lint"));
      assert.equal(computePlanHash(next), next.planHash);
      assert.equal(next.planHash, first.planHash, "the hash does not depend on the run history");
      assert.deepEqual(validatePlanDocument(next), []);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

test("the strict profile description says it turns on every available verification (en, pt-BR)", () => {
  assert.match(translator("profiles", "en")("builtin_profile_strict_description"), /every other available verification/);
  assert.match(translator("profiles", "pt-BR")("builtin_profile_strict_description"), /todas as outras verificações disponíveis/);
});
