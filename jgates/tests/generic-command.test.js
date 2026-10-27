import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Generic command: an explicit executable with args and declared effects, a contract that says what the
// result proves, project templates, and the partial Go and Rust templates. Nothing here uses a real Go toolchain.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const MAIN = path.join(here, "..", "dist", "cli", "main.js");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A workspace with its own data folder; the PATH holds nothing, so no tool of the machine is found. */
function project(files, { templates = [], profiles = "", extra = {} } = {}) {
  const dir = tmp("jgates-gen-ws-");
  const home = tmp("jgates-gen-home-");
  const emptyBin = tmp("jgates-gen-bin-");
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON, JGATES_NO_CACHE: "1", PATH: emptyBin, ...extra };
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
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const init = cli(["init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  if (templates.length > 0) {
    fs.appendFileSync(path.join(dir, "jgates.yml"), templates.map(([id, source]) => `  - id: ${id}\n    source: ${source}\n    activation: always\n`).join(""));
  }
  if (profiles) fs.appendFileSync(path.join(dir, ".jgates", "profiles.yml"), profiles);
  const plan = (...more) => cli(["plan", "--cwd", dir, "--json", ...more]);
  const run = (...more) => cli(["run", "--cwd", dir, "--no-interactive", "--json", ...more]);
  const item = (planned, id) => [...planned.doc.plan.groups.willRun, ...planned.doc.plan.groups.notApplicableOrDisabled].find((i) => i.id === id);
  const cleanup = () => {
    for (const d of [dir, home, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
  };
  return { dir, home, cli, plan, run, item, cleanup };
}

/** A project template (.jgates/templates/<id>.yml) with one generic-command check. */
function genericTemplate({ id = "gen", tool = "gen-check", capability = "lint", command = process.execPath, args = [], evidence = "{ kind: exit-code }", support = null }) {
  return [
    "schemaVersion: 1",
    `id: ${id}`,
    "extends: [builtin:base]",
    "config:",
    "  tools:",
    `    ${tool}:`,
    "      adapter: generic-command",
    "      enabled: true",
    `      capabilities: [${capability}]`,
    `      command: ${JSON.stringify(command)}`,
    `      args: ${JSON.stringify(args)}`,
    "      config:",
    ...(support ? [`        support: ${support}`] : []),
    "        effects: { readsCode: true, writesOutputs: false, mayChangeCode: false, executesProjectCode: true, usesNetwork: false }",
    `        evidence: ${evidence}`,
    "",
  ].join("\n");
}

const CHECK_JS = "const fs = require('node:fs'); process.exit(fs.existsSync('FAIL') ? 1 : 0);\n";

test("a project template with a generic check enters the plan with executable, rendered args and declared effects, and the run follows the exit code", () => {
  const p = project(
    { "check.js": CHECK_JS, ".jgates/templates/gen.yml": genericTemplate({ args: ["{workspace}/check.js"], support: "partial" }) },
    { templates: [["gen", ".jgates/templates/gen.yml"]] },
  );
  try {
    const planned = p.plan("--only", "tool:gen-check");
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = p.item(planned, "gen-check#lint");
    assert.ok(item, JSON.stringify(planned.doc.plan.groups.willRun.map((i) => i.id)));
    assert.equal(item.adapter, "generic-command");
    assert.equal(item.command.executable, process.execPath);
    assert.deepEqual(item.command.args, ["{workspace}/check.js"]);
    assert.equal(item.effects.executesProjectCode, true);
    assert.equal(item.effects.mayChangeCode, false);
    assert.equal(item.availability.status, "available");
    assert.ok(item.limitations.some((l) => /Suporte parcial/.test(l)));
    assert.equal(item.includedBy[0].entry, "gen");

    const ok = p.run("--only", "tool:gen-check");
    assert.equal(ok.code, 0, ok.out + ok.err);
    assert.equal(ok.doc.decision, "passed");
    const stage = ok.doc.stages.find((s) => s.id === "gen-check#lint");
    assert.equal(stage.state, "completed");
    assert.equal(stage.nativeStatus, "exit 0");

    fs.writeFileSync(path.join(p.dir, "FAIL"), "");
    const bad = p.run("--only", "tool:gen-check");
    assert.equal(bad.code, 1, bad.out + bad.err);
    assert.equal(bad.doc.decision, "failed");
    assert.equal(bad.doc.stages.find((s) => s.id === "gen-check#lint").nativeStatus, "exit 1");
  } finally {
    p.cleanup();
  }
});

test("shell characters in the args are passed as text: no shell interprets them", () => {
  const script = "process.exit(process.argv[2] === '; touch marcador' && process.argv[3] === '$(touch marcador)' ? 0 : 3);\n";
  const p = project(
    { "arg.js": script, ".jgates/templates/gen.yml": genericTemplate({ args: ["{workspace}/arg.js", "; touch marcador", "$(touch marcador)"] }) },
    { templates: [["gen", ".jgates/templates/gen.yml"]] },
  );
  try {
    const r = p.run("--only", "tool:gen-check");
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.doc.decision, "passed");
    assert.equal(fs.existsSync(path.join(p.dir, "marcador")), false);
  } finally {
    p.cleanup();
  }
});

test("a generic command that claims security without an evidence schema does not cover the category: the requirement is uncovered", () => {
  const profiles = "  so-sast:\n    label: So SAST\n    checks:\n      capability:sast: { enabled: true }\n      tool:quality-bridge.semgrep: { enabled: false }\n      capability:unit: { enabled: false }\n      capability:coverage: { enabled: false }\n";
  const files = {
    "check.js": CHECK_JS,
    ".jgates/templates/gen.yml": genericTemplate({ tool: "gen-sast", capability: "sast", args: ["{workspace}/check.js"] }),
  };
  const p = project(files, { templates: [["gen", ".jgates/templates/gen.yml"]], profiles });
  try {
    const planned = p.plan("--profile", "so-sast");
    assert.equal(planned.code, 0, planned.out + planned.err);
    const plan = planned.doc.plan;
    const uncovered = plan.groups.uncoveredRequirements.find((u) => u.selector === "capability:sast");
    assert.ok(uncovered, JSON.stringify(plan.groups.uncoveredRequirements));
    assert.equal(uncovered.reason, "EVIDENCE_MISSING");
    assert.match(uncovered.message, /contrato de evidência/);
    assert.equal(plan.approvable, false);
    // The check still runs and shows why it does not count.
    const item = p.item(planned, "gen-sast#sast");
    assert.equal(item.state.enabled, true);
    assert.ok(item.limitations.some((l) => /não cobre a categoria/.test(l)));
    const req = plan.requirements.find((r) => r.selector === "capability:sast");
    assert.deepEqual(req.coveredBy, []);
  } finally {
    p.cleanup();
  }
});

test("a security claim with a json-file contract covers the requirement, and invalid evidence is an error, never a pass", () => {
  const profiles = "  so-sast:\n    label: So SAST\n    checks:\n      capability:sast: { enabled: true }\n      tool:quality-bridge.semgrep: { enabled: false }\n      capability:unit: { enabled: false }\n      capability:coverage: { enabled: false }\n";
  const writer = [
    "const fs = require('node:fs'); const path = require('node:path');",
    "const out = process.argv[2]; fs.mkdirSync(path.dirname(out), { recursive: true });",
    "fs.writeFileSync(out, process.argv[3]);",
    "",
  ].join("\n");
  const schema = JSON.stringify({ type: "object", required: ["scanned", "issues"], properties: { scanned: { type: "integer", minimum: 1 }, issues: { const: 0 } } });
  const files = (payload) => ({
    "writer.js": writer,
    "schemas/sec.json": schema,
    ".jgates/templates/gen.yml": genericTemplate({
      tool: "gen-sast",
      capability: "sast",
      args: ["{workspace}/writer.js", "{outputDir}/sec.json", payload],
      evidence: "{ kind: json-file, file: sec.json, schema: schemas/sec.json }",
    }),
  });
  const good = project(files('{"scanned":3,"issues":0}'), { templates: [["gen", ".jgates/templates/gen.yml"]], profiles });
  try {
    const planned = good.plan("--profile", "so-sast");
    assert.equal(planned.code, 0, planned.out + planned.err);
    assert.equal(planned.doc.plan.groups.uncoveredRequirements.some((u) => u.selector === "capability:sast"), false);
    assert.deepEqual(planned.doc.plan.requirements.find((r) => r.selector === "capability:sast").coveredBy, ["gen-sast#sast"]);
    const r = good.run("--profile", "so-sast", "--only", "tool:gen-sast");
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.doc.stages.find((s) => s.id === "gen-sast#sast").state, "completed");
  } finally {
    good.cleanup();
  }
  const bad = project(files('{"scanned":0}'), { templates: [["gen", ".jgates/templates/gen.yml"]], profiles });
  try {
    const r = bad.run("--profile", "so-sast", "--only", "tool:gen-sast");
    assert.notEqual(r.doc.decision, "passed", r.out);
    assert.notEqual(r.code, 0);
    const stage = r.doc.stages.find((s) => s.id === "gen-sast#sast");
    assert.equal(stage.state, "error");
    assert.match(stage.reason, /não satisfaz o schema/);
  } finally {
    bad.cleanup();
  }
});

test("a generic command without declared effects makes the plan not approvable", () => {
  const noEffects = ["schemaVersion: 1", "id: gen", "extends: [builtin:base]", "config:", "  tools:", "    gen-check:", "      adapter: generic-command", "      capabilities: [lint]", "      command: node", "      args: []", "      config:", "        evidence: { kind: exit-code }", ""].join("\n");
  const p = project({ ".jgates/templates/gen.yml": noEffects }, { templates: [["gen", ".jgates/templates/gen.yml"]] });
  try {
    const planned = p.plan("--only", "tool:gen-check");
    assert.equal(planned.code, 0, planned.out + planned.err);
    assert.equal(planned.doc.plan.approvable, false);
    assert.match(planned.doc.plan.blockers[0].message, /fora do contrato.*effects/);
  } finally {
    p.cleanup();
  }
});

const GO_MOD = "module example.com/mini\n\ngo 1.22\n";
const GO_MAIN = "package main\n\nfunc main() {}\n";

test("the Go template enters the plan with partial support declared, and without go installed the step is blocked, never passed", () => {
  const p = project({ "go.mod": GO_MOD, "main.go": GO_MAIN });
  try {
    fs.appendFileSync(path.join(p.dir, "jgates.yml"), "  - id: go\n    source: builtin:go\n    activation: detected\n    match:\n      languages: [go]\n");
    const planned = p.plan("--only", "tool:go-test");
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = p.item(planned, "go-test#unit");
    assert.ok(item, JSON.stringify(planned.doc.plan.groups.willRun.map((i) => i.id)));
    assert.equal(item.adapter, "generic-command");
    assert.equal(item.command.executable, "go");
    assert.deepEqual(item.command.args, ["test", "./..."]);
    assert.ok(item.limitations.some((l) => /Suporte parcial/.test(l)), JSON.stringify(item.limitations));
    assert.equal(item.availability.status, "unavailable");
    assert.match(item.availability.reason, /go/);
    // go test is a recognised test runner: it covers the tests category without being a security claim.
    assert.deepEqual(planned.doc.plan.groups.uncoveredRequirements.filter((u) => u.reason === "EVIDENCE_MISSING"), []);

    const r = p.run("--only", "tool:go-test");
    const stage = r.doc.stages.find((s) => s.id === "go-test#unit");
    assert.equal(stage.state, "blocked");
    assert.notEqual(r.doc.decision, "passed");
    assert.notEqual(r.code, 0);
  } finally {
    p.cleanup();
  }
});

test("the Rust template declares cargo test with partial support and its target folder as a workspace write", () => {
  const p = project({ "Cargo.toml": '[package]\nname = "mini"\nversion = "0.1.0"\nedition = "2021"\n', "src/main.rs": "fn main() {}\n" });
  try {
    fs.appendFileSync(path.join(p.dir, "jgates.yml"), "  - id: rust\n    source: builtin:rust\n    activation: detected\n    match:\n      languages: [rust]\n");
    const planned = p.plan("--only", "tool:cargo-test");
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = p.item(planned, "cargo-test#unit");
    assert.ok(item);
    assert.equal(item.command.executable, "cargo");
    assert.deepEqual(item.effects.workspaceWrites, ["target"]);
    assert.ok(item.limitations.some((l) => /Suporte parcial/.test(l)));
    assert.equal(item.availability.status, "unavailable");
  } finally {
    p.cleanup();
  }
});
