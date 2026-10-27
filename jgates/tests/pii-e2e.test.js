import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// PII end to end: pii.yml per entity, the pii:<entity> selector in the file, in a profile
// and for one run only, masking, observation-only behavior and options the detector cannot honor.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const MAIN = path.join(repo, "jgates", "dist", "cli", "main.js");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const require = createRequire(import.meta.url);
const { createPiiFixture, removePiiFixture, PII_FILE } = require(path.join(repo, "tests", "fixtures", "jgates", "pii-fixture.js"));

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function walk(dir) {
  const out = [];
  const visit = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) visit(p);
      else out.push(p);
    }
  };
  visit(dir);
  return out.sort();
}

/** Every file of the workspace with its bytes' hash (byte for byte comparison). */
const snapshot = (dir) => Object.fromEntries(walk(dir).map((f) => [path.relative(dir, f), crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")]));

function project({ profile = "minimal", piiYml } = {}) {
  const fixture = createPiiFixture();
  const home = tmp("jgates-pii-e2e-home-");
  const emptyBin = tmp("jgates-pii-e2e-bin-");
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
  const init = cli(["init", "--cwd", fixture.dir, "--profile", profile, "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  const piiFile = path.join(fixture.dir, ".jgates", "pii.yml");
  if (piiYml !== undefined) fs.writeFileSync(piiFile, piiYml);
  return {
    ...fixture,
    home,
    cli,
    piiFile,
    plan: (...more) => cli(["plan", "--cwd", fixture.dir, "--json", ...more]),
    // Only the PII instance runs: the other stages need tools the test machine does not have.
    run: (...more) => cli(["run", "--cwd", fixture.dir, "--no-interactive", "--json", "--only", "tool:builtin-pii", ...more]),
    cleanup() {
      removePiiFixture(fixture.dir);
      for (const d of [home, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

const entities = (result) => result.findings.filter((f) => f.tool === "builtin-pii").map((f) => `${f.ruleId.replace("pii.", "")}:${f.location.line}`).sort();

test("switching one entity off in pii.yml removes only its findings; switching phone on adds only its own", () => {
  const p = project();
  try {
    const base = p.run();
    assert.equal(base.code, 1, base.out + base.err);
    const baseline = entities(base.doc);
    assert.deepEqual(baseline, [`cnpj:${p.lines.cnpj}`, `cpf:${p.lines.cpf}`, `credit-card:${p.lines.card}`].sort());

    fs.writeFileSync(p.piiFile, "schemaVersion: 1\nentities:\n  cpf:\n    enabled: false\n");
    const noCpf = p.run();
    assert.deepEqual(entities(noCpf.doc), baseline.filter((e) => !e.startsWith("cpf:")));

    fs.writeFileSync(p.piiFile, "schemaVersion: 1\nentities:\n  phone:\n    enabled: true\n");
    const withPhone = p.run();
    assert.deepEqual(entities(withPhone.doc), [...baseline, `phone:${p.lines.phone}`].sort());
    // The coverage of the run says which entities ran and which did not.
    const output = JSON.parse(fs.readFileSync(path.join(withPhone.doc.runDir, "outputs", "builtin-pii", "builtin-pii", "pii.json"), "utf8"));
    assert.deepEqual(Object.fromEntries(output.coverage.map((c) => [c.entity, c.status])), { cpf: "run", cnpj: "run", phone: "run", "credit-card": "run" });
  } finally {
    p.cleanup();
  }
});

test("the pii:<entity> selector works in a profile and for one run, and a run-only switch-off leaves pii.yml byte for byte", () => {
  const p = project({ piiYml: "schemaVersion: 1\nentities:\n  phone:\n    enabled: true\n" });
  try {
    const before = fs.readFileSync(p.piiFile);
    const ran = p.run("--skip", "pii:phone");
    assert.equal(ran.code, 1, ran.out + ran.err);
    assert.deepEqual(entities(ran.doc).filter((e) => e.startsWith("phone:")), []);
    assert.equal(ran.doc.reduced, true, JSON.stringify(ran.doc.selection));
    assert.deepEqual(fs.readFileSync(p.piiFile), before);

    // The same entity skipped when it was already off does not reduce the run: the result is as reduced as the same run
    // without the skip (--only tool:builtin-pii already leaves the bridge out for this run, and the result says so),
    // and the skip adds no run-only switch-off of its own.
    fs.writeFileSync(p.piiFile, "schemaVersion: 1\n");
    const plain = p.run().doc;
    const skippedOff = p.run("--skip", "pii:phone").doc;
    assert.equal(skippedOff.reduced, plain.reduced);
    assert.deepEqual(skippedOff.disabled.filter((d) => d.origin === "run").map((d) => d.id), plain.disabled.filter((d) => d.origin === "run").map((d) => d.id));
    assert.ok(!skippedOff.disabled.some((d) => d.origin === "run" && d.id.startsWith("builtin-pii")), JSON.stringify(skippedOff.disabled));
    const phoneSkip = skippedOff.selection.planOverrides.find((o) => o.source === "--skip" && o.selector === "pii:phone");
    assert.deepEqual(phoneSkip?.items, [], JSON.stringify(skippedOff.selection.planOverrides));

    // In a profile: pii:phone on turns the entity on without pii.yml.
    fs.writeFileSync(
      path.join(p.dir, ".jgates", "profiles.yml"),
      "schemaVersion: 1\nprofiles:\n  minimal:\n    extends: builtin:minimal\n  withphone:\n    extends: builtin:minimal\n    checks:\n      pii:phone:\n        enabled: true\n",
    );
    const viaProfile = p.run("--profile", "withphone");
    assert.ok(entities(viaProfile.doc).includes(`phone:${p.lines.phone}`), viaProfile.out + viaProfile.err);
    // A broader selector (capability:pii) leaves the new entity at its default: off.
    const broad = p.run("--only", "capability:pii");
    assert.deepEqual(entities(broad.doc).filter((e) => e.startsWith("phone:")), []);
  } finally {
    p.cleanup();
  }
});

test("with the CPF detector off and masking on, no raw value is in result.json, the run folder or the output", () => {
  const p = project({ piiYml: "schemaVersion: 1\nentities:\n  cpf:\n    enabled: false\n  phone:\n    enabled: true\nreporting:\n  redactMatchedValues: true\n" });
  try {
    const ran = p.run();
    assert.equal(ran.code, 1, ran.out + ran.err);
    assert.ok(!entities(ran.doc).some((e) => e.startsWith("cpf:")));
    const digits = (v) => v.replace(/\D/g, "");
    const raw = [...Object.values(p.values), ...Object.values(p.values).map(digits)];
    for (const file of walk(ran.doc.runDir)) {
      const text = fs.readFileSync(file, "utf8");
      for (const value of raw) assert.ok(!text.includes(value), `${path.relative(ran.doc.runDir, file)} holds a raw value`);
    }
    for (const value of raw) assert.ok(!ran.out.includes(value) && !ran.err.includes(value));
    assert.ok(fs.existsSync(path.join(ran.doc.runDir, "result.json")));
  } finally {
    p.cleanup();
  }
});

test("observation only: the finding exists and no analyzed file changes, with remediation off in the file as well", () => {
  const p = project({ piiYml: "schemaVersion: 1\nremediation:\n  mode: none\n" });
  try {
    const before = snapshot(p.dir);
    const ran = p.run();
    assert.equal(ran.code, 1, ran.out + ran.err);
    assert.ok(entities(ran.doc).length >= 3);
    assert.deepEqual(snapshot(p.dir), before);
    assert.deepEqual(ran.doc.workspaceChanges.added, []);
    assert.deepEqual(ran.doc.workspaceChanges.modified ?? [], []);
  } finally {
    p.cleanup();
  }
});

test("an option the detector cannot honor is refused, never dropped", () => {
  const cases = [
    ["schemaVersion: 1\ndetection:\n  locale: en-US\n", /unsupported-option.*locale/s],
    ["schemaVersion: 1\nreporting:\n  redactMatchedValues: false\n", /unsupported-option.*redactMatchedValues/s],
  ];
  for (const [yml, pattern] of cases) {
    const p = project({ piiYml: yml });
    try {
      const ran = p.run();
      const stage = ran.doc.stages.find((s) => s.id === "builtin-pii#pii");
      assert.equal(stage.state, "error", JSON.stringify(stage));
      assert.match(stage.reason, pattern);
      assert.deepEqual(entities(ran.doc), []);
    } finally {
      p.cleanup();
    }
  }
  // Remediation and unknown entities are schema errors: `config validate` stops before any run.
  for (const yml of ["schemaVersion: 1\nremediation:\n  mode: apply\n", "schemaVersion: 1\nentities:\n  email:\n    enabled: true\n"]) {
    const p = project({ piiYml: yml });
    try {
      const validated = p.cli(["config", "validate", "--cwd", p.dir, "--json"]);
      assert.notEqual(validated.code, 0, yml);
    } finally {
      p.cleanup();
    }
  }
});

test("the PII stage enters the plan only when the profile selects capability:pii", () => {
  const p = project({ profile: "standard" });
  try {
    const inPlan = (planned) => planned.doc.plan.groups.willRun.some((i) => i.adapter === "builtin-pii");
    assert.equal(inPlan(p.plan("--profile", "minimal")), false);
    assert.equal(inPlan(p.plan("--profile", "standard")), true);
    assert.equal(inPlan(p.plan("--profile", "strict")), true);
    // pii.yml alone does not force the run: only enabled: true does.
    fs.writeFileSync(p.piiFile, "schemaVersion: 1\nentities:\n  cpf:\n    severity: high\n");
    assert.equal(inPlan(p.plan("--profile", "minimal")), false);
    fs.writeFileSync(p.piiFile, "schemaVersion: 1\nenabled: true\n");
    assert.equal(inPlan(p.plan("--profile", "minimal")), true);
  } finally {
    p.cleanup();
  }
});

test("PII (PII_FILE) is the only file with values: the fixture keeps its path", () => {
  assert.equal(PII_FILE, "customers/sample.txt");
});
