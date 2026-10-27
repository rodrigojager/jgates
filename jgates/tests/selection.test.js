import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const { resolveConfig } = await import(pathToFileURL(path.join(dist, "core", "config", "resolve", "index.js")).href);
const selection = await import(pathToFileURL(path.join(dist, "core", "selection", "index.js")).href);

const NO_STACK = { languages: [], classifications: [] };
const yaml = (lines) => `${lines.join("\n")}\n`;

function withProject(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jg-sel-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ROOT = (profile = "rapido", extra = []) => yaml(["schemaVersion: 1", "selection:", `  profile: ${profile}`, ...extra]);
const TOOLS = yaml(["schemaVersion: 1", "tools:", "  pytest-api:", "    adapter: pytest", "    capabilities: [unit, coverage]", "  ruff-api:", "    adapter: ruff", "    capabilities: [lint]", "    component: api"]);

/** A project whose profile `rapido` carries the given checks lines. */
function project(checks, extra = {}) {
  return {
    "jgates.yml": ROOT(),
    ".jgates/tools.yml": TOOLS,
    ".jgates/profiles.yml": yaml(["schemaVersion: 1", "profiles:", "  rapido:", "    extends: builtin:minimal", ...(checks.length > 0 ? ["    checks:", ...checks.map((c) => `      ${c}`)] : [])]),
    ...extra,
  };
}

function select(dir, options = {}) {
  const result = resolveConfig(dir, { inventory: NO_STACK, ...options });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return selection.resolveSelection(result, { inventory: { classifications: [{ id: "api" }, { id: "web" }] } });
}

const item = (sel, selector) => sel.items.find((i) => i.selector === selector);

test("capability:unit off and tool:<instance> on in the same layer: the instance stays on, and the origin says why", () => {
  withProject(project(["capability:unit: { enabled: false }", "tool:pytest-api: { enabled: true }"]), (dir) => {
    const sel = select(dir);
    assert.equal(sel.ok, true);
    const tool = item(sel, "tool:pytest-api");
    assert.equal(tool.enabled, true);
    assert.equal(tool.decision.selector, "tool:pytest-api");
    assert.equal(tool.decision.layer, "profile");
    assert.equal(tool.decision.source, "profile:rapido");
    assert.equal(tool.decision.file, ".jgates/profiles.yml");
    assert.equal(tool.decision.path, "profiles.rapido.checks.tool:pytest-api.enabled");
    assert.equal(tool.capabilities.find((c) => c.capability === "unit").enabled, true);
    assert.equal(tool.capabilities.find((c) => c.capability === "unit").overridden[0].selector, "capability:unit");
    // The capability itself stays as declared, and the instance running it is listed.
    assert.equal(item(sel, "capability:unit").enabled, false);
    assert.deepEqual(item(sel, "capability:unit").activeTools, ["pytest-api"]);
  });
});

test("turning one check off turns no other off: capability:unit off leaves coverage of the same tool, and lint, running", () => {
  withProject(project(["capability:unit: { enabled: false }", "capability:coverage: { enabled: true }", "capability:lint: { enabled: true }"]), (dir) => {
    const sel = select(dir);
    const tool = item(sel, "tool:pytest-api");
    assert.deepEqual(
      tool.capabilities.map((c) => [c.capability, c.enabled]),
      [
        ["unit", false],
        ["coverage", true],
      ],
    );
    assert.equal(tool.enabled, true, "the tool runs for the capability that is still on");
    assert.equal(item(sel, "tool:ruff-api").enabled, true);
    assert.equal(item(sel, "capability:lint").enabled, true);
  });
});

test("the strongest layer wins over specificity: a call that turns the capabilities off beats the profile that turned the instance on", () => {
  withProject(project(["tool:pytest-api: { enabled: true }"]), (dir) => {
    const sel = select(dir, { overrides: selection.skipOverrides(["capability:unit", "capability:coverage"]) });
    const tool = item(sel, "tool:pytest-api");
    assert.equal(tool.enabled, false);
    assert.equal(tool.decision.layer, "call");
    assert.equal(tool.decision.source, "--skip");
    assert.equal(tool.overridden[0].selector, "tool:pytest-api");
    assert.equal(tool.overridden[0].layer, "profile");
    // The same call aimed at the instance is just as strong.
    const off = select(dir, { overrides: selection.skipOverrides(["tool:pytest-api"]) });
    assert.equal(item(off, "tool:pytest-api").enabled, false);
    assert.equal(item(off, "tool:ruff-api").enabled, true, "no other check goes off");
  });
});

test("category and component selectors reach what they cover; the specific one wins in the same layer", () => {
  withProject(project(["category:quality: { enabled: false }", "capability:lint: { enabled: true }", "component:api: { enabled: false }"]), (dir) => {
    const sel = select(dir);
    // lint is on by the more specific capability, but ruff-api belongs to component api, which is off in the same layer
    // with the same specificity: the tie goes to "enabled" and is flagged.
    const ruff = item(sel, "tool:ruff-api");
    assert.equal(ruff.enabled, true);
    assert.equal(ruff.tie, true);
    const perf = item(sel, "capability:performance");
    assert.equal(perf.enabled, false, "category:quality off reaches the capability nothing else selected");
    assert.equal(perf.reason, "EXPLICIT");
    assert.equal(perf.decision.selector, "category:quality");
    assert.equal(item(sel, "capability:file-size").enabled, true, "the capability the starter profile turned on is more specific than the category");
    assert.equal(item(sel, "component:web").enabled, true, "components are on unless turned off");
    assert.equal(item(sel, "component:api").enabled, false);
  });
});

test("nothing selected means off, with the reason; a category is derived from what runs under it", () => {
  withProject(project([]), (dir) => {
    const sel = select(dir);
    const e2e = item(sel, "capability:e2e");
    assert.equal(e2e.enabled, false);
    assert.equal(e2e.reason, "NOT_SELECTED");
    assert.equal(e2e.decision, null);
    assert.equal(item(sel, "capability:lint").reason, "EXPLICIT");
    assert.equal(item(sel, "category:quality").enabled, true);
    assert.equal(item(sel, "category:quality").reason, "DERIVED");
    assert.equal(item(sel, "pii:cpf").enabled, false);
  });
});

test("the bridge sub-checks are instances of the quality-bridge adapter and answer to capability and parent selectors", () => {
  withProject(project(["tool:quality-bridge: { enabled: false }", "capability:lint: { enabled: true }"]), (dir) => {
    const sel = select(dir);
    // tool:quality-bridge (parent, 2.5) beats capability:lint (2) in the same layer.
    assert.equal(item(sel, "tool:quality-bridge.file-size").enabled, false);
    assert.equal(item(sel, "tool:quality-bridge.megalinter").enabled, false);
  });
  withProject(project([]), (dir) => {
    const sel = select(dir);
    const lint = sel.items.filter((i) => i.kind === "tool" && i.id.startsWith("quality-bridge.") && i.capabilities.some((c) => c.capability === "lint"));
    assert.ok(lint.length > 0);
    assert.ok(lint.every((i) => i.enabled), "the minimal profile selects capability:lint");
  });
});

test("a selector that names nothing is an error with a suggestion, wherever it was written", () => {
  withProject(project(["capability:unti: { enabled: false }", "tool:pytst-api: { enabled: true }", "rule:pytest-api/no-eval: { enabled: false }"]), (dir) => {
    const sel = select(dir);
    assert.equal(sel.ok, false);
    const by = Object.fromEntries(sel.errors.map((e) => [e.selector, e]));
    assert.equal(by["capability:unti"].code, "SELECTOR_UNMATCHED");
    assert.equal(by["capability:unti"].suggestion, "capability:unit");
    assert.match(by["capability:unti"].fix, /capability:unit/);
    assert.equal(by["capability:unti"].file, ".jgates/profiles.yml");
    assert.equal(by["tool:pytst-api"].suggestion, "tool:pytest-api");
    assert.equal(by["rule:pytest-api/no-eval"].code, "RULE_UNSUPPORTED", "the instance exists but exposes no such rule");
    const bad = select(dir, { overrides: selection.skipOverrides(["banana:split"]) }).errors.find((e) => e.selector === "banana:split");
    assert.equal(bad.code, "SELECTOR_INVALID");
    assert.equal(bad.source, "--skip");
  });
});

test("a rule the adapter can turn off is a check of its own, below the instance's decision", () => {
  withProject(project(["tool:pytest-api: { enabled: true }", "rule:pytest-api/no-eval: { enabled: false }"]), (dir) => {
    const result = resolveConfig(dir, { inventory: NO_STACK });
    const sel = selection.resolveSelection(result, { rules: { "pytest-api": ["no-eval", "no-exec"] } });
    assert.equal(sel.ok, true, JSON.stringify(sel.errors));
    assert.equal(item(sel, "rule:pytest-api/no-eval").enabled, false);
    assert.equal(item(sel, "rule:pytest-api/no-exec").enabled, true, "inherits the instance");
    assert.equal(item(sel, "rule:pytest-api/no-exec").decision.selector, "tool:pytest-api");
  });
});

const LOCK = yaml(["schemaVersion: 1", "requiredEvidence:", "  - check: capability:secrets", "    locked: true", "    reason: Segredos não podem ser pulados.", "  - check: capability:e2e", "    locked: true"]);

test("a locked requirement cannot be turned off by a profile or by the call: error with the reason", () => {
  withProject(project(["capability:secrets: { enabled: false }"], { ".jgates/policy.yml": LOCK }), (dir) => {
    const sel = select(dir);
    assert.equal(sel.ok, false);
    const err = sel.errors.find((e) => e.code === "LOCKED_REQUIREMENT");
    assert.equal(err.selector, "capability:secrets");
    assert.match(err.message, /Segredos não podem ser pulados/);
    assert.equal(err.disabledBy.layer, "profile");
    assert.ok(err.items.includes("capability:secrets"));
    assert.equal(item(sel, "capability:secrets").lockViolation, true);
  });
  withProject(project([], { ".jgates/policy.yml": LOCK }), (dir) => {
    assert.equal(select(dir).ok, true);
    const viaCall = select(dir, { overrides: selection.skipOverrides(["category:security"]) });
    assert.equal(viaCall.ok, false);
    const err = viaCall.errors.find((e) => e.code === "LOCKED_REQUIREMENT");
    assert.equal(err.disabledBy.source, "--skip");
    assert.match(err.message, /--skip/);
  });
});

test("a locked requirement nothing selected is turned on, with the lock as the origin", () => {
  withProject(project([], { ".jgates/policy.yml": LOCK }), (dir) => {
    const sel = select(dir);
    const e2e = item(sel, "capability:e2e");
    assert.equal(e2e.enabled, true);
    assert.equal(e2e.reason, "LOCKED_REQUIRED");
    assert.equal(e2e.decision.source, "policy");
    assert.equal(e2e.locked[0].reason, "requisito obrigatório da política");
  });
});

test("a lock on a capability locks only that capability of a multi-capability tool", () => {
  const lockUnit = yaml(["schemaVersion: 1", "requiredEvidence:", "  - check: capability:unit", "    locked: true"]);
  withProject(project(["capability:unit: { enabled: true }", "capability:coverage: { enabled: false }"], { ".jgates/policy.yml": lockUnit }), (dir) => {
    assert.equal(select(dir).ok, true, "coverage of the same tool may be off");
  });
  withProject(project(["capability:unit: { enabled: false }"], { ".jgates/policy.yml": lockUnit }), (dir) => {
    assert.equal(select(dir).ok, false);
  });
});

test("config resolve --explain shows the origin of each decision; selection errors exit 3", () => {
  withProject(project(["capability:unit: { enabled: false }", "tool:pytest-api: { enabled: true }"]), (dir) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jg-sel-home-"));
    try {
      const run = (...args) => spawnSync(process.execPath, [MAIN, "config", "resolve", ...args, "--cwd", dir], { encoding: "utf8", env: { ...process.env, JGATES_HOME: home }, timeout: 30000 });
      const text = run("--explain");
      assert.equal(text.status, 0, text.stderr);
      const line = text.stdout.split("\n").find((l) => l.startsWith("tool:pytest-api: "));
      assert.match(line, /ligada/);
      assert.match(line, /tool:pytest-api=true/);
      assert.match(line, /profile\/profile:rapido \.jgates\/profiles\.yml#profiles\.rapido\.checks\.tool:pytest-api\.enabled/);
      const json = JSON.parse(run("--explain", "--json").stdout);
      assert.equal(json.selection.items.find((i) => i.selector === "tool:pytest-api").decision.layer, "profile");
      const skip = JSON.parse(run("--skip", "capability:unti", "--json").stdout);
      assert.equal(skip.code, "SELECTOR_UNMATCHED");
      assert.equal(skip.errors[0].suggestion, "capability:unit");
      assert.equal(run("--skip", "capability:unti").status, 3);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
