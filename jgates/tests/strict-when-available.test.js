import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Checks enabled "when available" (`when: available` in a profile check entry) and builtin:strict, which turns on every
// catalog capability: a capability with an applicable, executable check runs; without one it is reported apart as not
// applicable here, with the reason, and never blocks. A plain enabled check stays required (fail-closed).

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
  };
  withDir({ profiles: { p: { checks } }, tools: PII }, (dir) => {
    const p = plan(dir);
    const by = Object.fromEntries(notHere(p).map((n) => [n.selector, n]));
    assert.deepEqual(Object.keys(by).sort(), ["capability:e2e", "capability:mutation", "capability:properties"]);
    // JGates has no tool for end-to-end tests at all.
    assert.equal(by["capability:e2e"].reasonCode, "NO_TOOL");
    assert.equal(by["capability:e2e"].action.kind, "none");
    // Property tests exist only for Rust: not for this Python project.
    assert.equal(by["capability:properties"].reasonCode, "NO_TOOL_FOR_LANGUAGES");
    assert.deepEqual(by["capability:properties"].languages, ["python"]);
    assert.ok(by["capability:properties"].adapters.every((a) => !a.applicable));
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
    assert.ok(!p.blockers.some((b) => (b.items ?? []).some((i) => /mutation|e2e|properties/.test(i))));
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
  const tools = { ...PII, oasdiff: { adapter: "oasdiff", capabilities: ["api-compatibility"] } };
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

test("the strict profile description says it turns on every available verification (en, pt-BR)", () => {
  assert.match(translator("profiles", "en")("builtin_profile_strict_description"), /every other available verification/);
  assert.match(translator("profiles", "pt-BR")("builtin_profile_strict_description"), /todas as outras verificações disponíveis/);
});
