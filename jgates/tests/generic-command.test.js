import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Generic command: an explicit executable with args and declared effects, a contract that says what the
// result proves, project templates, and the partial Go and Rust templates. Nothing here uses a real Go toolchain.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const MAIN = path.join(here, "..", "dist", "cli", "main.js");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const { imageJsonWithout } = await import(pathToFileURL(path.join(here, "setup", "image-json.mjs")).href);

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
  const profiles = "  so-sast:\n    label: So SAST\n    checks:\n      capability:sast: { enabled: true }\n      tool:quality-bridge.semgrep: { enabled: false }\n      tool:semgrep: { enabled: false }\n      capability:unit: { enabled: false }\n      capability:coverage: { enabled: false }\n";
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
  const profiles = "  so-sast:\n    label: So SAST\n    checks:\n      capability:sast: { enabled: true }\n      tool:quality-bridge.semgrep: { enabled: false }\n      tool:semgrep: { enabled: false }\n      capability:unit: { enabled: false }\n      capability:coverage: { enabled: false }\n";
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

// --- report formats (sarif, junit, checkstyle): the report is the evidence ---

const REPORT_WRITER = [
  "const fs = require('node:fs'); const path = require('node:path');",
  "const [out, content, code] = process.argv.slice(2);",
  "if (content !== '-') { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, content); }",
  "process.exit(Number(code));",
  "",
].join("\n");

const sarifDoc = (results) => JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "my-linter", version: "0.9.1", rules: [] } }, results }] });
const sarifResult = (ruleId, level, file = "src/a.py", line = 3) => ({ ruleId, level, message: { text: `${ruleId} message` }, locations: [{ physicalLocation: { artifactLocation: { uri: file }, region: { startLine: line } } }] });

/** One generic check whose command writes `content` as the report and exits with `code`; `content` "-" writes nothing. */
function reportProject({ kind, file, content, code = 0, failOn, successExitCodes }) {
  const evidence = `{ kind: ${kind}, file: ${file}${failOn ? `, failOn: ${failOn}` : ""} }`;
  let template = genericTemplate({ args: ["{workspace}/report.js", `{outputDir}/${file}`, content, String(code)], evidence });
  if (successExitCodes) template = template.replace("        effects:", `        successExitCodes: ${JSON.stringify(successExitCodes)}\n        effects:`);
  return project({ "report.js": REPORT_WRITER, ".jgates/templates/gen.yml": template }, { templates: [["gen", ".jgates/templates/gen.yml"]] });
}
const stageOf = (r) => r.doc.stages.find((s) => s.id === "gen-check#lint");

test("sarif report: the findings reach the result tagged as own tool, failOn decides, and the SARIF export carries the tag", () => {
  const content = sarifDoc([sarifResult("L001", "warning"), sarifResult("L002", "note", "src/b.py", 8)]);
  const warnOnly = reportProject({ kind: "sarif", file: "out.sarif", content, code: 0 });
  try {
    // Default failOn is error: a warning and a note do not fail.
    const ok = warnOnly.run("--only", "tool:gen-check");
    assert.equal(ok.code, 0, ok.out + ok.err);
    assert.equal(ok.doc.decision, "passed");
    assert.equal(stageOf(ok).findings, 2);
    assert.equal(stageOf(ok).blockingViolations, 0);
    const mine = ok.doc.findings.filter((f) => f.tool === "gen-check");
    assert.deepEqual(mine.map((f) => f.ruleId).sort(), ["L001", "L002"]);
    assert.ok(mine.every((f) => f.origin === "own-tool" && f.blocking === false));
    assert.deepEqual(mine.find((f) => f.ruleId === "L001").location, { path: "src/a.py", line: 3 });
    // The SARIF export marks them.
    const exported = spawnSync(process.execPath, [MAIN, "report", ok.doc.runId, "--cwd", warnOnly.dir, "--format", "sarif"], { encoding: "utf8", env: { ...process.env, JGATES_HOME: warnOnly.home } });
    assert.equal(exported.status, 0, exported.stderr);
    const sarif = JSON.parse(exported.stdout);
    const res = sarif.runs[0].results.find((x) => x.ruleId === "gen-check/L001");
    assert.ok(res, exported.stdout);
    assert.equal(res.properties.ownTool, true);
    assert.equal(sarif.runs[0].tool.driver.rules.find((x) => x.id === "gen-check/L001").properties.ownTool, true);
  } finally {
    warnOnly.cleanup();
  }
  // The same report with failOn: warning fails the run.
  const strict = reportProject({ kind: "sarif", file: "out.sarif", content, code: 0, failOn: "warning" });
  try {
    const bad = strict.run("--only", "tool:gen-check");
    assert.equal(bad.code, 1, bad.out + bad.err);
    assert.equal(bad.doc.decision, "failed");
    assert.equal(stageOf(bad).blockingViolations, 1);
    const flags = Object.fromEntries(bad.doc.findings.filter((f) => f.tool === "gen-check").map((f) => [f.ruleId, f.blocking]));
    assert.deepEqual(flags, { L001: true, L002: false });
  } finally {
    strict.cleanup();
  }
});

test("sarif report: a security-severity finding blocks at the default failOn, and exit code 1 with findings is decided by the report", () => {
  const result = { ...sarifResult("S001", "warning"), properties: { "security-severity": "8.8" } };
  const p = reportProject({ kind: "sarif", file: "out.sarif", content: sarifDoc([result]), code: 1 });
  try {
    const r = p.run("--only", "tool:gen-check");
    assert.equal(r.doc.decision, "failed");
    const f = r.doc.findings.find((x) => x.ruleId === "S001");
    assert.equal(f.normalizedSeverity, "high");
    assert.equal(f.blocking, true);
    assert.equal(stageOf(r).nativeStatus, "exit 1");
  } finally {
    p.cleanup();
  }
});

test("a missing or unreadable report is invalid, never passed", () => {
  for (const [kind, file, content] of [
    ["sarif", "out.sarif", "-"],
    ["sarif", "out.sarif", "this is not json"],
    ["junit", "out.xml", "<html/>"],
    ["checkstyle", "out.xml", "-"],
  ]) {
    const p = reportProject({ kind, file, content, code: 0 });
    try {
      const r = p.run("--only", "tool:gen-check");
      // The platform's word for evidence that cannot be trusted is "incomplete" (fail-closed), as for a json-file contract.
      assert.equal(r.doc.decision, "incomplete", `${kind} ${content}: ${r.out}`);
      assert.notEqual(r.code, 0);
      const stage = stageOf(r);
      assert.notEqual(stage.state, "passed");
      assert.equal(stage.interpreted, false);
      assert.match(stage.reason, /relatório/);
    } finally {
      p.cleanup();
    }
  }
});

test("an empty report passes only when the exit code agrees", () => {
  const empty = sarifDoc([]);
  const agree = reportProject({ kind: "sarif", file: "out.sarif", content: empty, code: 0 });
  const disagree = reportProject({ kind: "sarif", file: "out.sarif", content: empty, code: 2 });
  const declared = reportProject({ kind: "sarif", file: "out.sarif", content: empty, code: 2, successExitCodes: [0, 2] });
  try {
    const a = agree.run("--only", "tool:gen-check");
    assert.equal(a.doc.decision, "passed", a.out);
    assert.equal(stageOf(a).findings, 0);
    const d = disagree.run("--only", "tool:gen-check");
    assert.equal(d.doc.decision, "failed", d.out);
    assert.match(stageOf(d).reason, /relatório vazio/);
    const s = declared.run("--only", "tool:gen-check");
    assert.equal(s.doc.decision, "passed", s.out);
  } finally {
    agree.cleanup();
    disagree.cleanup();
    declared.cleanup();
  }
});

test("junit report: a failure or an error fails the run, with file and line, and failOn error ignores plain failures", () => {
  const xml = '<testsuites><testsuite name="s"><testcase classname="m.C" name="ok"/><testcase classname="m.C" name="bad" file="tests/c.js" line="12"><failure message="nope">trace</failure></testcase></testsuite></testsuites>';
  const p = reportProject({ kind: "junit", file: "out.xml", content: xml, code: 1 });
  const lenient = reportProject({ kind: "junit", file: "out.xml", content: xml, code: 1, failOn: "error" });
  try {
    const r = p.run("--only", "tool:gen-check");
    assert.equal(r.doc.decision, "failed");
    const f = r.doc.findings.find((x) => x.tool === "gen-check");
    assert.equal(f.ruleId, "test-failed");
    assert.equal(f.origin, "own-tool");
    assert.deepEqual(f.location, { path: "tests/c.js", line: 12 });
    const l = lenient.run("--only", "tool:gen-check");
    assert.equal(l.doc.decision, "passed", l.out);
    assert.equal(l.doc.findings.find((x) => x.tool === "gen-check").blocking, false);
  } finally {
    p.cleanup();
    lenient.cleanup();
  }
});

test("checkstyle report: errors fail by default and warnings only when failOn is warning", () => {
  const xml = '<checkstyle><file name="src/A.java"><error line="2" severity="warning" message="w" source="Rule"/></file></checkstyle>';
  const byDefault = reportProject({ kind: "checkstyle", file: "out.xml", content: xml, code: 0 });
  const strict = reportProject({ kind: "checkstyle", file: "out.xml", content: xml, code: 0, failOn: "warning" });
  try {
    const ok = byDefault.run("--only", "tool:gen-check");
    assert.equal(ok.doc.decision, "passed", ok.out);
    assert.equal(ok.doc.findings.find((x) => x.tool === "gen-check").location.path, "src/A.java");
    const bad = strict.run("--only", "tool:gen-check");
    assert.equal(bad.doc.decision, "failed", bad.out);
  } finally {
    byDefault.cleanup();
    strict.cleanup();
  }
});

test("failOn that does not fit the report format blocks the plan", () => {
  const p = reportProject({ kind: "junit", file: "out.xml", content: "-", failOn: "warning" });
  try {
    const planned = p.plan("--only", "tool:gen-check");
    assert.equal(planned.doc.plan.approvable, false);
  } finally {
    p.cleanup();
  }
});

const GO_MOD = "module example.com/mini\n\ngo 1.22\n";
const GO_MAIN = "package main\n\nfunc main() {}\n";

test("the Go template runs go test through its own adapter, and without go in the tools image the step is blocked, never passed", () => {
  const p = project({ "go.mod": GO_MOD, "main.go": GO_MAIN }, { extra: { JGATES_IMAGE_JSON: imageJsonWithout("go") } });
  try {
    fs.appendFileSync(path.join(p.dir, "jgates.yml"), "  - id: go\n    source: builtin:go\n    activation: detected\n    match:\n      languages: [go]\n");
    const planned = p.plan("--only", "tool:go-test");
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = p.item(planned, "go-test#unit");
    assert.ok(item, JSON.stringify(planned.doc.plan.groups.willRun.map((i) => i.id)));
    assert.equal(item.adapter, "go-test");
    assert.deepEqual(item.command.args.slice(0, 3), ["test", "-json", "-count=1"]);
    assert.equal(item.effects.executesProjectCode, true);
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

test("the Rust test template uses the cargo-test adapter (its target folder is in the run folder, not the workspace)", () => {
  const p = project({ "Cargo.toml": '[package]\nname = "mini"\nversion = "0.1.0"\nedition = "2021"\n', "src/main.rs": "fn main() {}\n" });
  try {
    // jgates init already added rust-cargo-test for the Rust component.
    const planned = p.plan("--only", "tool:cargo-test");
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = p.item(planned, "cargo-test#unit");
    assert.ok(item);
    assert.equal(item.adapter, "cargo-test");
    assert.match(item.command.env.CARGO_TARGET_DIR, /^\{runDir\}\//);
    assert.equal(item.effects.executesProjectCode, true);
  } finally {
    p.cleanup();
  }
});
