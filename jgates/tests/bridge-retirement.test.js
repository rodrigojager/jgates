import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The quality bridge is retired from the interactive plans (PLAN-completeness.md section 4): the reader of tools.yml turns
// its instance into individual ones, the universe of selectors has no bridge subcheck unless an instance still declares
// one, the governed CI path keeps reading the base template with the bridge, and no code path starts the sidecar image.

process.env.JGATES_LOCALE = "en";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (...p) => pathToFileURL(path.resolve(here, "..", "dist", ...p)).href;
const { migrateDocument } = await import(dist("core", "config", "load", "migrate.js"));
const { buildUniverse } = await import(dist("core", "selection", "selectors.js"));
const { legacyBridgeLayers, BASE_INSTANCES_OF_BRIDGE } = await import(dist("adapters", "quality-bridge", "governed.js"));
const bridgeApi = await import(dist("adapters", "quality-bridge", "index.js"));
const { templateOps } = await import(dist("core", "config", "resolve", "layers.js"));

const FILE = ".jgates/tools.yml";
const tools = (body) => ({ schemaVersion: 1, tools: body });

test("a quality-bridge instance becomes the individual instances of the capabilities it declared", () => {
  const out = migrateDocument("tools", tools({ qb: { adapter: "quality-bridge", capabilities: ["sast", "secrets", "dependencies", "iac", "duplication", "file-size", "lint", "unit"] } }), FILE);
  assert.equal(out.value.tools.qb, undefined, "the bridge entry is gone");
  assert.deepEqual(Object.keys(out.value.tools).sort(), ["checkov", "file-size", "gitleaks", "jscpd", "osv-scanner", "semgrep", "trivy"]);
  assert.deepEqual(out.value.tools.trivy, { adapter: "trivy", capabilities: ["dependencies", "iac"] });
  assert.deepEqual(out.value.tools.semgrep, { adapter: "semgrep", capabilities: ["sast"] });
  assert.equal(out.notices.length, 1);
  const [notice] = out.notices;
  assert.equal(notice.code, "CONFIG_MIGRATED");
  assert.equal(notice.path, "tools.qb");
  assert.match(notice.message, /replaced by 7 individual instances/);
  assert.match(notice.message, /Lint, tests and coverage come from the templates of each stack/);
});

test("the notice uses the singular form for one instance, and a disabled bridge disables what replaces it", () => {
  const one = migrateDocument("tools", tools({ "quality-bridge": { adapter: "quality-bridge", capabilities: ["secrets"] } }), FILE);
  assert.match(one.notices[0].message, /replaced by the individual instance gitleaks\./);
  const off = migrateDocument("tools", tools({ "quality-bridge": { adapter: "quality-bridge", enabled: false, capabilities: ["secrets", "iac"] } }), FILE);
  assert.deepEqual(off.value.tools.gitleaks, { adapter: "gitleaks", enabled: false, capabilities: ["secrets"] });
  assert.deepEqual(off.value.tools.checkov, { adapter: "checkov", enabled: false, capabilities: ["iac"] });
  assert.equal(off.value.tools.trivy.enabled, false);
});

test("an instance the file already declares is kept, and a file without the bridge is returned untouched", () => {
  const mine = { adapter: "gitleaks", capabilities: ["secrets", "secrets-history"] };
  const out = migrateDocument("tools", tools({ gitleaks: mine, qb: { adapter: "quality-bridge", capabilities: ["secrets", "sast"] } }), FILE);
  assert.deepEqual(out.value.tools.gitleaks, mine);
  assert.deepEqual(out.value.tools.semgrep, { adapter: "semgrep", capabilities: ["sast"] });
  const untouched = tools({ ruff: { adapter: "ruff", capabilities: ["lint"] } });
  const same = migrateDocument("tools", untouched, FILE);
  assert.equal(same.value, untouched);
  assert.deepEqual(same.notices, []);
});

test("the checks of a profile that name bridge subchecks follow the instance that took each one over", () => {
  const doc = {
    schemaVersion: 1,
    profiles: {
      rapido: {
        extends: "builtin:standard",
        checks: {
          "capability:sast": { enabled: false },
          "tool:quality-bridge.gitleaks": { enabled: false },
          "tool:quality-bridge.megalinter": { enabled: false },
          "tool:quality-bridge": { enabled: false },
          "tool:jscpd": { enabled: true },
        },
      },
      lento: { checks: { "capability:lint": { enabled: true } } },
    },
  };
  const out = migrateDocument("profiles", doc, ".jgates/profiles.yml");
  assert.deepEqual(Object.keys(out.value.profiles.rapido.checks).sort(), ["capability:sast", "tool:gitleaks", "tool:jscpd"]);
  assert.deepEqual(out.value.profiles.rapido.checks["tool:gitleaks"], { enabled: false });
  assert.equal(out.value.profiles.lento, doc.profiles.lento, "a profile without bridge selectors is untouched");
  assert.deepEqual(out.notices.map((n) => n.path), ["profiles.rapido.checks.tool:quality-bridge.gitleaks", "profiles.rapido.checks.tool:quality-bridge.megalinter", "profiles.rapido.checks.tool:quality-bridge"]);
  assert.match(out.notices[0].message, /now applies to tool:gitleaks/);
  assert.match(out.notices[1].message, /no longer exists/);
  // A profile document without any bridge selector comes back as it came.
  const clean = { schemaVersion: 1, profiles: { x: { checks: { "capability:lint": { enabled: true } } } } };
  assert.equal(migrateDocument("profiles", clean, "p.yml").value, clean);
});

test("the bridge subchecks are selectors only for a configuration that still declares the adapter", () => {
  const without = buildUniverse({ tools: { ruff: { adapter: "ruff", capabilities: ["lint"] } } });
  assert.equal(without.tools.some((t) => t.parent === "quality-bridge"), false);
  assert.deepEqual(without.parents, []);
  const withBridge = buildUniverse({ tools: { "quality-bridge": { adapter: "quality-bridge", capabilities: ["lint"] } } });
  assert.ok(withBridge.tools.some((t) => t.id === "quality-bridge.file-size" && t.parent === "quality-bridge"));
  assert.deepEqual(withBridge.parents, ["quality-bridge"]);
});

test("the governed base layer swaps the individual scanners for the bridge and keeps the rest", () => {
  const base = { source: "builtin:base", file: "builtin:templates/base.json", ops: templateOps({ config: { workspace: { exclude: [".git/**"] }, tools: Object.fromEntries([...BASE_INSTANCES_OF_BRIDGE, "builtin-pii"].map((id) => [id, { adapter: id, enabled: true }])) } }) };
  const other = { source: "builtin:python", file: "builtin:templates/python.json", ops: templateOps({ config: { tools: { semgrep: { adapter: "semgrep" } } } }) };
  const [layer, untouched] = legacyBridgeLayers([base, other]);
  const touched = new Set(layer.ops.map((op) => op.segments.slice(0, 2).join("/")));
  for (const id of BASE_INSTANCES_OF_BRIDGE) assert.equal(touched.has(`tools/${id}`), false, `${id} is not declared by the governed base`);
  assert.ok(touched.has("tools/builtin-pii"));
  assert.ok(touched.has("tools/quality-bridge"));
  assert.ok(layer.ops.some((op) => op.pointer === "/checks/tool:quality-bridge.megalinter/enabled" && op.value === true));
  assert.ok(layer.ops.some((op) => op.pointer === "/workspace/exclude"));
  assert.equal(untouched, other, "another template is not changed");
});

const gates = await import(pathToFileURL(path.resolve(here, "..", "scripts", "image-gates.mjs")).href);
const matrixApi = await import(dist("core", "matrix", "index.js"));
const trustApi = await import(dist("core", "governed", "trust.js"));

test("the image smoke covers every validated row of the matrix: a group, a stated reason, or a policy refusal", () => {
  const coverage = gates.smokeCoverage({ rows: matrixApi.buildMatrix().rows, trust: trustApi.ADAPTER_TRUST });
  assert.deepEqual(coverage.missing, [], "a validated row without a smoke group and without a reason");
  assert.deepEqual(coverage.stale, [], "a row named by the smoke tables that is not a validated row");
  // The refusals are the adapters the trust table keeps out of jgates ci; nothing else hides there.
  for (const { key } of coverage.refused) assert.equal(trustApi.ADAPTER_TRUST[key.split("#")[0]].treatment, "excluded", key);
  for (const { reason } of coverage.exempt) assert.ok(reason.length > 20, "an exemption says why");
  // Every group has a known-bad and a clean project, and names the rows it proves.
  for (const group of gates.SMOKE_GROUPS) {
    assert.ok(group.bad && group.clean && group.covers.length > 0 && group.caps.length > 0, group.id);
  }
});

test("a validated row nobody covers is found, and an adapter the policy refuses is not a gap", () => {
  const rows = [
    { key: "ruff#lint@python", adapter: "ruff", state: "validated" },
    { key: "newtool#lint@go", adapter: "newtool", state: "validated" },
    { key: "gitleaks#secrets@any", adapter: "gitleaks", state: "validated" },
    { key: "newtool#lint@rust", adapter: "newtool", state: "customer-setup-required" },
  ];
  const trust = { gitleaks: { treatment: "excluded" }, ruff: { treatment: "trusted" } };
  const out = gates.smokeCoverage({ rows, trust, groups: [{ id: "ruff", covers: ["ruff#lint@python", "ghost#lint@go"] }], exempt: {} });
  assert.deepEqual(out.missing, ["newtool#lint@go"], "only validated rows count");
  assert.deepEqual(out.refused.map((r) => r.key), ["gitleaks#secrets@any"]);
  assert.deepEqual(out.stale, ["ghost#lint@go"]);
});

test("the bridge no longer has a container runner of its own: it runs only where the sidecar is", () => {
  for (const name of ["decideRunner", "chooseBridgeRunner", "callBridgeInContainer", "runnerSetting", "EXTERNAL_SUBCHECKS", "mergeResponses"]) {
    assert.equal(bridgeApi[name], undefined, `${name} is gone`);
  }
  assert.equal(typeof bridgeApi.executeBridge, "function");
});
