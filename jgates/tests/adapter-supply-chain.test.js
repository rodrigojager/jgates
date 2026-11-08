import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Supply-chain check: install scripts, missing integrity, untrusted registries and deprecated packages from npm and
// Python lockfiles, offline, with what it cannot decide reported as unknown (never clean).

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const FIXTURES = path.join(here, "fixtures", "supply-chain");
const { analyzeSupplyChain } = await import(pathToFileURL(path.join(dist, "adapters", "supply-chain", "index.js")).href);
const { translator } = await import(pathToFileURL(path.join(dist, "i18n", "index.js")).href);

const signals = (r) => r.findings.map((f) => `${f.signal}:${f.package}`).sort();

test("supply-chain: a postinstall dependency without integrity is a finding and a clean lockfile none [proves: supply-chain#supply-chain]", () => {
  const risky = analyzeSupplyChain(path.join(FIXTURES, "npm-risky"));
  assert.deepEqual(signals(risky), ["install-script:shady", "missing-integrity:shady"]);
  assert.equal(risky.network, false);
  assert.ok(risky.findings.every((f) => f.file === "package-lock.json" && f.ecosystem === "npm"));

  const clean = analyzeSupplyChain(path.join(FIXTURES, "npm-clean"));
  assert.deepEqual(clean.findings, []);
  assert.deepEqual(clean.unknown, []);
});

test("supply-chain: untrusted registries, git sources and deprecated packages are findings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-sc-"));
  fs.writeFileSync(
    path.join(dir, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/a": { version: "1.0.0", resolved: "https://evil.example/a.tgz", integrity: "sha512-x" },
        "node_modules/b": { version: "1.0.0", resolved: "git+ssh://git@github.com/x/b.git#main" },
        "node_modules/c": { version: "1.0.0", resolved: "https://registry.npmjs.org/c/-/c-1.0.0.tgz", integrity: "sha512-x", deprecated: "use d" },
      },
    }),
  );
  const r = analyzeSupplyChain(dir);
  assert.deepEqual(signals(r), ["deprecated:c", "missing-integrity:b", "unpinned-registry:a", "unpinned-registry:b"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("supply-chain: Python requirements without hashes or from an untrusted index are findings; deprecation is unknown", () => {
  const risky = analyzeSupplyChain(path.join(FIXTURES, "python-risky"));
  assert.deepEqual(signals(risky), ["missing-integrity:requests", "unpinned-registry:http://packages.internal.example/simple"]);
  assert.ok(risky.unknown.some((u) => u.signal === "deprecated"), "offline deprecation must be unknown, not clean");

  const clean = analyzeSupplyChain(path.join(FIXTURES, "python-clean"));
  assert.deepEqual(clean.findings, []);
  assert.ok(clean.unknown.some((u) => u.signal === "deprecated"));
});

test("supply-chain: no lockfile and an unreadable lockfile are unknown, never clean", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-sc-"));
  const none = analyzeSupplyChain(dir);
  assert.deepEqual(none.findings, []);
  assert.deepEqual(none.unknown.map((u) => u.signal), ["lockfile"]);
  fs.writeFileSync(path.join(dir, "package-lock.json"), "{ not json");
  const broken = analyzeSupplyChain(dir);
  assert.deepEqual(broken.findings, []);
  assert.equal(broken.unknown[0].signal, "lockfile");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("supply-chain: messages exist in both languages", () => {
  const en = translator("supply-chain", "en");
  const pt = translator("supply-chain", "pt-BR");
  assert.notEqual(en("sc_no_lockfile"), pt("sc_no_lockfile"));
  const keys = (l) => Object.keys(JSON.parse(fs.readFileSync(path.join(dist, "i18n", `supply-chain.${l}.json`), "utf8"))).sort();
  assert.deepEqual(keys("en"), keys("pt-BR"));
});

const MAIN = path.join(dist, "cli", "main.js");
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A workspace initialized by the real CLI; `files` maps relative paths to text or to a fixture file to copy. */
function setup(fixture, { tools = null, extra = {} } = {}) {
  const dir = tmp("jgates-sc-ws-");
  const home = tmp("jgates-sc-home-");
  if (fixture) fs.cpSync(path.join(FIXTURES, fixture), dir, { recursive: true });
  for (const [rel, text] of Object.entries(extra)) fs.writeFileSync(path.join(dir, rel), text);
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  const env = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1", NO_COLOR: "1" };
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
  if (tools !== null) fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), tools);
  return {
    dir,
    plan: () => cli(["plan", "--cwd", dir, "--json"]),
    run: () => cli(["run", "--cwd", dir, "--only", "tool:supply-chain", "--no-interactive", "--json"]),
    cleanup: () => [dir, home].forEach((d) => fs.rmSync(d, { recursive: true, force: true })),
  };
}

const itemOf = (planned) => planned.doc.plan.groups.willRun.find((i) => i.id === "supply-chain#supply-chain");

test("supply-chain plan and run: the risky lockfile is a normalized finding in the Dependencies domain and the clean one passes", () => {
  const risky = setup("npm-risky");
  const clean = setup("npm-clean");
  try {
    const planned = risky.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = itemOf(planned);
    assert.ok(item, "supply-chain#supply-chain is in the plan");
    assert.equal(item.category, "dependencies");
    assert.equal(item.adapter, "supply-chain");
    assert.deepEqual(item.capabilities, ["supply-chain"]);
    assert.equal(item.network, false);
    assert.equal(item.effects.mayChangeCode, false);
    assert.deepEqual(item.command.args.filter((a, i, all) => all[i - 1] === "--lockfile"), ["package-lock.json"]);
    assert.ok(planned.doc.plan.templates.active.some((a) => a.id === "supply-chain" && a.reason === "DETECTED"));

    const failed = risky.run();
    assert.equal(failed.doc.decision, "failed", failed.out + failed.err);
    const found = failed.doc.findings.filter((f) => f.tool === "supply-chain");
    const rules = found.map((f) => f.ruleId).sort();
    assert.deepEqual(rules.filter((r) => !r.includes("unknown")), ["supply-chain/install-script", "supply-chain/missing-integrity"]);
    // The install script is reported without blocking (allowInstallScripts default); the missing hash blocks.
    assert.equal(found.find((f) => f.ruleId === "supply-chain/install-script").blocking, false);
    assert.equal(found.find((f) => f.ruleId === "supply-chain/missing-integrity").blocking, true);
    assert.equal(found.find((f) => f.ruleId === "supply-chain/missing-integrity").location.path, "package-lock.json");

    const passed = clean.run();
    assert.equal(passed.doc.decision, "passed", passed.out + passed.err);
    assert.equal(passed.doc.findings.filter((f) => f.tool === "supply-chain").length, 0);
    const stage = passed.doc.stages.find((s) => s.id === "supply-chain#supply-chain");
    assert.equal(stage.state, "completed");
    assert.equal(stage.interpreted, true);
  } finally {
    risky.cleanup();
    clean.cleanup();
  }
});

test("supply-chain run: an unknown is never counted as clean", () => {
  // A lockfile that cannot be read leaves the stage not interpreted (incomplete), never passed.
  const broken = setup(null, { extra: { "package-lock.json": "{ not json" } });
  // A Python requirements file read through the setting: the deprecation signal needs a registry, so it stays an unknown
  // finding that does not block, and the pinned-with-hash requirement is otherwise clean.
  const python = setup("python-clean", { tools: "schemaVersion: 1\ntools:\n  supply-chain:\n    adapter: supply-chain\n    capabilities: [supply-chain]\n    lockfiles: [requirements.txt]\n", extra: { "package-lock.json": fs.readFileSync(path.join(FIXTURES, "npm-clean", "package-lock.json"), "utf8") } });
  try {
    const bad = broken.run();
    const stage = bad.doc.stages.find((s) => s.id === "supply-chain#supply-chain");
    assert.equal(stage.interpreted, false, bad.out + bad.err);
    assert.notEqual(bad.doc.decision, "passed");
    const unknown = bad.doc.findings.find((f) => f.ruleId === "supply-chain/unknown-lockfile");
    assert.ok(unknown);
    assert.equal(unknown.normalizedSeverity, "unknown");
    assert.equal(unknown.blocking, false);

    const py = python.run();
    const note = py.doc.findings.find((f) => f.ruleId === "supply-chain/unknown-deprecated");
    assert.ok(note, py.out + py.err);
    assert.equal(note.blocking, false);
    assert.equal(note.normalizedSeverity, "unknown");
  } finally {
    broken.cleanup();
    python.cleanup();
  }
});

test("supply-chain settings: blockOn and allowInstallScripts reach the command and the result; an invalid one refuses the plan", () => {
  const strict = setup("npm-risky", { tools: "schemaVersion: 1\ntools:\n  supply-chain:\n    adapter: supply-chain\n    capabilities: [supply-chain]\n    blockOn: none\n" });
  const scripts = setup("npm-risky", { tools: "schemaVersion: 1\ntools:\n  supply-chain:\n    adapter: supply-chain\n    capabilities: [supply-chain]\n    allowInstallScripts: false\n" });
  const invalid = setup("npm-risky", { tools: "schemaVersion: 1\ntools:\n  supply-chain:\n    adapter: supply-chain\n    capabilities: [supply-chain]\n    blockOn: sometimes\n" });
  try {
    const none = strict.run();
    assert.equal(none.doc.decision, "passed", none.out + none.err);
    assert.ok(none.doc.findings.some((f) => f.ruleId === "supply-chain/missing-integrity" && f.blocking === false));
    const planned = itemOf(strict.plan());
    assert.ok(planned.command.args.includes("none"));
    const blocked = scripts.run();
    assert.equal(blocked.doc.findings.find((f) => f.ruleId === "supply-chain/install-script").blocking, true);
    // A value outside the schema is refused by the configuration validation, never replaced by a default.
    const refused = invalid.plan();
    assert.equal(refused.code, 3, refused.out + refused.err);
    assert.equal(refused.doc.code, "CONFIG_INVALID");
    assert.ok(refused.doc.diagnostics.some((d) => d.path === "tools.supply-chain.blockOn"));
  } finally {
    strict.cleanup();
    scripts.cleanup();
    invalid.cleanup();
  }
});

test("supply-chain catalog: the capability, the template and the settings are registered with labels in both languages", async () => {
  const { builtinManifests } = await import(pathToFileURL(path.join(dist, "adapters", "manifests.js")).href);
  const { externalAdapterIds } = await import(pathToFileURL(path.join(dist, "core", "plan", "adapters.js")).href);
  assert.ok(builtinManifests().some((m) => m.id === "supply-chain"));
  assert.ok(externalAdapterIds().includes("supply-chain"));
  for (const lang of ["en", "pt-BR"]) {
    const catalog = JSON.parse(fs.readFileSync(path.join(dist, "i18n", `catalog.${lang}.json`), "utf8"));
    assert.ok(catalog["capability_supply-chain_label"] && catalog["capability_supply-chain_description"] && catalog["template_supply-chain_label"], lang);
  }
  const schema = JSON.parse(fs.readFileSync(path.join(here, "..", "schemas", "config", "tools.schema.json"), "utf8"));
  const props = JSON.stringify(schema);
  for (const key of ["blockOn", "allowInstallScripts", "trustedHosts", "lockfiles"]) assert.ok(props.includes(`"${key}"`), key);
});