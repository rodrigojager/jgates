import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// builtin-pii adapter: today's detector through the PII-only bridge request, configured by .jgates/pii.yml.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const require = createRequire(import.meta.url);
const { createPiiFixture, removePiiFixture, PII_FILE } = require(path.join(repo, "tests", "fixtures", "jgates", "pii-fixture.js"));
const adapter = await import(pathToFileURL(path.join(dist, "adapters", "builtin-pii", "index.js")).href);
const catalog = await import(pathToFileURL(path.join(dist, "core", "catalog", "index.js")).href);
const loader = await import(pathToFileURL(path.join(dist, "core", "config", "load", "index.js")).href);

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function walkFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

function project(piiYml) {
  const fixture = createPiiFixture();
  const home = tmp("jgates-pii-home-");
  const emptyBin = tmp("jgates-pii-bin-");
  const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON, PATH: emptyBin };
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input: "", timeout: 120_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  const init = cli(["init", "--cwd", fixture.dir, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  if (piiYml !== undefined) fs.writeFileSync(path.join(fixture.dir, ".jgates", "pii.yml"), piiYml);
  return {
    ...fixture,
    home,
    cli,
    plan: (...more) => cli(["plan", "--cwd", fixture.dir, "--json", ...more]),
    run: (...more) => cli(["run", "--cwd", fixture.dir, "--no-interactive", "--json", ...more]),
    cleanup() {
      removePiiFixture(fixture.dir);
      for (const d of [home, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

const piiFindings = (result) => result.findings.filter((f) => f.tool === "builtin-pii");

test("the manifest is valid and the adapter is registered in the plan", () => {
  assert.equal(catalog.validateManifest(adapter.builtinPiiManifest).ok, true);
  assert.equal(adapter.builtinPiiManifest.id, "builtin-pii");
  assert.deepEqual(adapter.builtinPiiManifest.capabilities, ["pii"]);
});

test("on the PII fixture the run reports CPF, CNPJ and credit-card with rule, file and line, and no raw value anywhere [proves: builtin-pii#pii]", () => {
  const p = project();
  try {
    const before = walkFiles(p.dir);
    const planned = p.plan("--only", "tool:builtin-pii");
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = planned.doc.plan.groups.willRun.find((i) => i.id === "builtin-pii#pii");
    assert.ok(item, "builtin-pii#pii will run: " + JSON.stringify(planned.doc.plan.groups.notApplicableOrDisabled.map((i) => i.id)));
    assert.equal(item.adapter, "builtin-pii");
    assert.deepEqual(item.command.args, ["-m", "quality_sidecar", "bridge"]);
    assert.equal(item.command.stdin.operation, "pii");
    assert.equal(item.command.stdin.target, "{workspace}");

    const ran = p.run("--only", "tool:builtin-pii");
    assert.equal(ran.code, 1, ran.out + ran.err);
    const result = ran.doc;
    assert.equal(result.decision, "failed");
    const stage = result.stages.find((s) => s.id === "builtin-pii#pii");
    assert.equal(stage.state, "completed");
    const found = piiFindings(result);
    const at = (rule) => found.filter((f) => f.ruleId === rule).map((f) => `${f.location.path}:${f.location.line}`);
    assert.ok(at("pii.cpf").includes(`${PII_FILE}:${p.lines.cpf}`), JSON.stringify(found.map((f) => [f.ruleId, f.location])));
    assert.ok(at("pii.cnpj").includes(`${PII_FILE}:${p.lines.cnpj}`));
    assert.ok(at("pii.credit-card").includes(`${PII_FILE}:${p.lines.card}`));
    assert.equal(found.find((f) => f.ruleId === "pii.credit-card").severity, "high");
    assert.equal(found.find((f) => f.ruleId === "pii.cpf").severity, "medium");
    assert.ok(found.every((f) => f.category === "pii" && f.blocking === true));

    // No raw value in the result, the run folder (logs, outputs, plan) or the workspace.
    const rawValues = [p.values.cpf, p.values.cnpj, p.values.card, p.values.cpf.replace(/\D/g, ""), p.values.cnpj.replace(/\D/g, ""), p.values.card.replace(/\D/g, "")];
    for (const file of walkFiles(result.runDir)) {
      const text = fs.readFileSync(file, "utf8");
      for (const value of rawValues) assert.ok(!text.includes(value), `${path.relative(result.runDir, file)} holds a raw value`);
    }
    for (const value of rawValues) assert.ok(!ran.out.includes(value) && !ran.err.includes(value), "stdout/stderr hold a raw value");
    assert.ok(fs.existsSync(path.join(result.runDir, "result.json")));
    assert.ok(result.artifacts.logs.some((l) => l.includes("builtin-pii")));
    // The workspace is untouched.
    assert.deepEqual(walkFiles(p.dir), before);
    assert.deepEqual(result.workspaceChanges.added, []);
  } finally {
    p.cleanup();
  }
});

test("pii.yml enabled: false takes the stage out of the plan, in the disabled group, with the origin", () => {
  const p = project("schemaVersion: 1\nenabled: false\n");
  try {
    const planned = p.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const { groups } = planned.doc.plan;
    assert.equal(groups.willRun.some((i) => i.id === "builtin-pii#pii"), false);
    const off = groups.notApplicableOrDisabled.find((i) => i.id === "builtin-pii#pii");
    assert.ok(off, "builtin-pii#pii is in the not applicable or disabled group");
    assert.equal(off.state.enabled, false);
    assert.equal(off.state.origin, "project");
    assert.match(off.state.originLabel, /pii\.yml/);
    assert.match(off.reason.message, /pii\.yml/);

    const ran = p.run();
    assert.equal(piiFindings(ran.doc).length, 0);
    assert.ok(ran.doc.disabled.some((d) => d.id === "builtin-pii#pii"), JSON.stringify(ran.doc.disabled));
    assert.equal(ran.doc.stages.some((s) => s.id === "builtin-pii#pii"), false);
  } finally {
    p.cleanup();
  }
});

test("pii.yml severity changes every finding and the plan hash; the file is a plan input", () => {
  const p = project();
  try {
    const first = p.plan("--only", "tool:builtin-pii").doc.plan;
    fs.writeFileSync(path.join(p.dir, ".jgates", "pii.yml"), "schemaVersion: 1\nenabled: true\nseverity: low\n");
    const second = p.plan("--only", "tool:builtin-pii").doc.plan;
    assert.notEqual(second.planHash, first.planHash);
    const item = second.groups.willRun.find((i) => i.id === "builtin-pii#pii");
    assert.equal(item.command.stdin.config.entities.cpf.severity, "low");
    assert.equal(item.command.stdin.config.entities["credit-card"].severity, "low");
    assert.ok(item.configFiles.some((f) => f.file === ".jgates/pii.yml" && /^sha256:/.test(f.sha256)));
    const found = piiFindings(p.run("--only", "tool:builtin-pii").doc);
    assert.ok(found.length >= 3);
    assert.ok(found.every((f) => f.severity === "low" && f.normalizedSeverity === "low"));
  } finally {
    p.cleanup();
  }
});

test("pii.yml is validated now: unknown keys and bad values are schema diagnostics, and pii is no longer schemaPending", () => {
  const p = project("schemaVersion: 1\nenabled: yes-please\nseverety: low\nseverity: loud\n");
  try {
    const loaded = loader.loadProjectConfig(p.dir);
    const doc = loaded.documents.find((d) => d.kind === "pii");
    assert.ok(doc);
    assert.equal(doc.schemaPending, false);
    const codes = loaded.diagnostics.filter((d) => d.file.endsWith("pii.yml")).map((d) => d.code);
    assert.ok(codes.includes("TYPE"), codes.join());
    assert.ok(codes.includes("UNKNOWN_KEY"), codes.join());
    assert.ok(codes.includes("ENUM"), codes.join());
    const cli = p.cli(["config", "validate", "--cwd", p.dir, "--json"]);
    assert.notEqual(cli.code, 0);
  } finally {
    p.cleanup();
  }
});
