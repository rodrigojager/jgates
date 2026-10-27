import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// ESLint with the config of the project, jscpd with the config the user chose, and the MegaLinter of the bridge with
// its limitations declared: the finding of a rule comes out of the project's eslint.config, switching the rule
// off through the documents API removes it in the next run, the plan says the ESLint step executes project code, the
// bridge's jscpd is left out when the jscpd adapter runs, the duplicated ESLint inside MegaLinter is reported as
// intentional, and the governed mode keeps the trusted config with --no-inline-config.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const REPO_MODULES = path.join(repo, "node_modules");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const docs = await import(pathToFileURL(path.join(dist, "core", "documents", "index.js")).href);
const { jsCodec } = await import(pathToFileURL(path.join(dist, "core", "codecs", "js", "index.js")).href);
const { parseJscpdReport } = await import(pathToFileURL(path.join(dist, "adapters", "jscpd", "index.js")).href);
const { parseEslintOutput } = await import(pathToFileURL(path.join(dist, "adapters", "eslint", "index.js")).href);
const { builtinManifests } = await import(pathToFileURL(path.join(dist, "adapters", "manifests.js")).href);

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const itemOf = (plan, id) => [...plan.groups.willRun, ...plan.groups.notApplicableOrDisabled].find((i) => i.id === id);
const stageOf = (doc, id) => doc.stages.find((s) => s.id === id);

const ESLINT_CONFIG = 'export default [{ files: ["**/*.ts"], rules: { "no-var": "error", eqeqeq: "off" } }];\n';
const WITH_VAR = "var counter = 1;\nexport const next = counter + 1;\n";

const BLOCK = [
  "export function compute(values: number[]): number {",
  "  let total = 0;",
  "  for (const value of values) {",
  "    if (value > 10) {",
  "      total += value * 2;",
  "    } else {",
  "      total -= value;",
  "    }",
  "  }",
  "  const average = total / values.length;",
  '  console.log("average", average, total, values.length);',
  "  return average;",
  "}",
  "",
].join("\n");

/** A workspace with the repository's node_modules (ESLint, jscpd), JGates initialized and the given tools.yml. */
function project({ tools, files = {}, extraEnv = {}, profile = "minimal" }) {
  const dir = tmp("jgates-q-ws-");
  const home = tmp("jgates-q-home-");
  const emptyBin = tmp("jgates-q-bin-");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "q-fixture", private: true, type: "module" }, null, 2) + "\n");
  fs.symlinkSync(REPO_MODULES, path.join(dir, "node_modules"), "dir");
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  const env = { ...process.env, JGATES_HOME: home, PATH: emptyBin, JGATES_PYTHON: PYTHON, JGATES_NO_CACHE: "1", ...extraEnv };
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
  const init = cli(["init", "--cwd", dir, "--profile", profile, "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), tools);
  return {
    dir,
    cli,
    plan: (...extra) => cli(["plan", "--cwd", dir, ...extra, "--json"]),
    run: (...extra) => cli(["run", "--cwd", dir, ...extra, "--no-interactive", "--json"]),
    cleanup: () => {
      for (const d of [dir, home, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

const ESLINT_TOOLS = "schemaVersion: 1\ntools:\n  eslint:\n    adapter: eslint\n    capabilities: [lint]\n    config: eslint.config.mjs\n";

test("ESLint: the rule violation of the project's eslint.config comes out as a finding, and switching the rule off through the documents API removes it in the next run [proves: eslint#lint]", () => {
  const p = project({ tools: ESLINT_TOOLS, files: { "eslint.config.mjs": ESLINT_CONFIG, "src/index.ts": WITH_VAR } });
  try {
    const ran = p.run("--only", "tool:eslint");
    assert.equal(ran.code, 1, ran.out + ran.err);
    assert.equal(ran.doc.decision, "failed");
    const found = ran.doc.findings.filter((f) => f.tool === "eslint");
    assert.deepEqual(found.map((f) => [f.ruleId, f.location.path, f.location.line, f.blocking]), [["no-var", "src/index.ts", 1, true]]);
    assert.equal(stageOf(ran.doc, "eslint#lint").state, "completed");
    assert.equal(stageOf(ran.doc, "eslint#lint").blockingViolations, 1);
    // The report is in the run folder and nothing was left in the project.
    assert.ok(fs.existsSync(path.join(ran.doc.runDir, "outputs", "eslint", "eslint", "eslint.json")));
    assert.deepEqual(ran.doc.workspaceChanges.added, []);

    // The edit goes through the documents API (a validated, minimal change of the file) and the next run is clean.
    const doc = docs.openDocument(p.dir, "eslint", "config");
    const edited = jsCodec.apply(doc.text, [{ op: "set", path: [0, "rules", "no-var"], value: "off" }]);
    assert.equal(edited.changed, true);
    const saved = docs.saveDocument(p.dir, "eslint", "config", { expectedRevision: doc.revision, text: edited.text });
    assert.equal(saved.status, "saved");
    const again = p.run("--only", "tool:eslint");
    assert.equal(again.code, 0, again.out + again.err);
    assert.equal(again.doc.decision, "passed");
    assert.deepEqual(again.doc.findings.filter((f) => f.tool === "eslint"), []);
    assert.equal(stageOf(again.doc, "eslint#lint").state, "completed");
  } finally {
    p.cleanup();
  }
});

test("ESLint: the plan declares that the step executes project code, so the cache never reuses it", () => {
  const p = project({ tools: ESLINT_TOOLS, files: { "eslint.config.mjs": ESLINT_CONFIG, "src/index.ts": WITH_VAR } });
  try {
    const planned = p.plan("--only", "tool:eslint");
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = itemOf(planned.doc.plan, "eslint#lint");
    assert.ok(item, JSON.stringify(planned.doc.plan.groups.willRun.map((i) => i.id)));
    assert.equal(item.effects.executesProjectCode, true);
    assert.ok(item.conditions.some((c) => /Executa código do projeto/.test(c)), JSON.stringify(item.conditions));
    assert.ok(item.configFiles.some((f) => f.file === "eslint.config.mjs" && /^sha256:/.test(f.sha256)));
    assert.equal(item.availability.status, "available", item.availability.reason);
    assert.ok(item.command.args.includes("--config") && item.command.args.some((a) => a.endsWith("eslint.json") && a.includes("{runDir}/outputs/eslint/eslint")));
    // A second run with the cache on still executes: the step is uncacheable.
    const cached = project({ tools: ESLINT_TOOLS, files: { "eslint.config.mjs": ESLINT_CONFIG, "src/index.ts": WITH_VAR }, extraEnv: { JGATES_NO_CACHE: "" } });
    try {
      cached.run("--only", "tool:eslint");
      const second = cached.run("--only", "tool:eslint");
      const stage = stageOf(second.doc, "eslint#lint");
      assert.equal(stage.cache.status, "uncacheable", JSON.stringify(stage.cache));
      assert.equal(stage.cache.code, "EXECUTES_PROJECT_CODE");
    } finally {
      cached.cleanup();
    }
  } finally {
    p.cleanup();
  }
});

test("ESLint: without any eslint.config the stage is blocked with the instruction, never passed", () => {
  const p = project({ tools: "schemaVersion: 1\ntools:\n  eslint:\n    adapter: eslint\n    capabilities: [lint]\n", files: { "src/index.ts": WITH_VAR } });
  try {
    const ran = p.run("--only", "tool:eslint");
    assert.notEqual(ran.code, 0, ran.out + ran.err);
    assert.notEqual(ran.doc.decision, "passed");
    assert.equal(stageOf(ran.doc, "eslint#lint").state, "blocked");
    assert.match(stageOf(ran.doc, "eslint#lint").reason, /eslint\.config/);
  } finally {
    p.cleanup();
  }
});

test("ESLint inside MegaLinter: with the ESLint adapter on, the plan reports the duplication as intentional and the manifest declares the limitations", () => {
  const p = project({ tools: ESLINT_TOOLS, files: { "eslint.config.mjs": ESLINT_CONFIG, "src/index.ts": WITH_VAR } });
  try {
    const planned = p.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const plan = planned.doc.plan;
    const warning = plan.warnings.find((w) => w.code === "LINTER_RUNS_TWICE");
    assert.ok(warning, JSON.stringify(plan.warnings));
    assert.match(warning.message, /de propósito/);
    assert.match(warning.message, /eslint#lint/);
    assert.ok(plan.groups.willRun.some((i) => i.id === "quality-bridge.megalinter#lint"), "MegaLinter still runs through the bridge");
    assert.ok(plan.groups.willRun.some((i) => i.id === "eslint#lint"));
  } finally {
    p.cleanup();
  }
  const bridge = builtinManifests().find((m) => m.id === "quality-bridge");
  const mega = bridge.subchecks.find((s) => s.id === "megalinter");
  assert.ok(mega.limitations.some((l) => /trusted configuration/.test(l)));
  assert.ok(mega.limitations.some((l) => /--no-inline-config/.test(l)));
  // Without the ESLint adapter (the typescript template declares it; the project turns it off) there is nothing to duplicate.
  const alone = project({ tools: "schemaVersion: 1\ntools:\n  eslint:\n    adapter: eslint\n    enabled: false\n", files: { "src/index.ts": WITH_VAR } });
  try {
    const aloneRun = alone.plan();
    assert.equal(aloneRun.code, 0, aloneRun.out + aloneRun.err);
    const plan = aloneRun.doc.plan;
    assert.ok(!plan.warnings.some((w) => w.code === "LINTER_RUNS_TWICE"), JSON.stringify(plan.warnings));
  } finally {
    alone.cleanup();
  }
});

test("the bridge's MegaLinter still forces the trusted ESLint config with --no-inline-config", () => {
  const tools = fs.readFileSync(path.join(repo, "quality-gate", "sidecar", "quality_sidecar", "tools.py"), "utf8");
  assert.match(tools, /"JAVASCRIPT_ES_ARGUMENTS": f"--config \{ESLINT_TRUSTED_CONFIG\} --no-ignore --no-inline-config"/);
  assert.match(tools, /"JAVASCRIPT_ES_CONFIG_FILE": "eslint\.config\.mjs"/);
  // The ESLint adapter is local-only: its manifest says so and the bridge request carries no ESLint option.
  const eslint = builtinManifests().find((m) => m.id === "eslint");
  assert.ok(eslint.limitations.some((l) => /bridge's MegaLinter keeps the trusted config and --no-inline-config/.test(l)));
});

const JSCPD_TOOLS = "schemaVersion: 1\ntools:\n  jscpd:\n    adapter: jscpd\n    capabilities: [duplication]\n    config: jscpd.config.json\n";

test("jscpd: the duplications of a fixture come out with the config the user chose, and a different config changes the result [proves: jscpd#duplication]", () => {
  const files = {
    "src/a.ts": BLOCK,
    "src/b.ts": BLOCK,
    "jscpd.config.json": JSON.stringify({ minLines: 3, minTokens: 20 }) + "\n",
  };
  const p = project({ tools: JSCPD_TOOLS, files });
  try {
    const planned = p.plan("--only", "tool:jscpd");
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = itemOf(planned.doc.plan, "jscpd#duplication");
    assert.ok(item);
    assert.equal(item.availability.status, "available", item.availability.reason);
    assert.ok(item.configFiles.some((f) => f.file === "jscpd.config.json" && /^sha256:/.test(f.sha256)));
    assert.ok(item.command.args.includes("--config") && item.command.args.includes("{workspace}/jscpd.config.json"));
    assert.equal(item.effects.executesProjectCode, false);

    const ran = p.run("--only", "tool:jscpd");
    assert.equal(ran.code, 0, ran.out + ran.err);
    const found = ran.doc.findings.filter((f) => f.tool === "jscpd");
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.equal(found[0].ruleId, "jscpd.duplicate");
    assert.equal(found[0].location.path, "src/a.ts");
    assert.match(found[0].message, /src\/b\.ts:1/);
    assert.equal(stageOf(ran.doc, "jscpd#duplication").state, "completed");
    assert.deepEqual(ran.doc.workspaceChanges.added, []);

    // The same code with a config whose minimum is larger than the block: no duplication, so the config is the one used.
    fs.writeFileSync(path.join(p.dir, "jscpd.config.json"), JSON.stringify({ minLines: 50, minTokens: 400 }) + "\n");
    const quiet = p.run("--only", "tool:jscpd");
    assert.equal(quiet.code, 0, quiet.out + quiet.err);
    assert.deepEqual(quiet.doc.findings.filter((f) => f.tool === "jscpd"), []);
  } finally {
    p.cleanup();
  }
});

test("jscpd: the plan leaves the bridge's jscpd out, and says why", () => {
  const p = project({ tools: JSCPD_TOOLS, profile: "standard", files: { "src/a.ts": BLOCK, "src/b.ts": BLOCK, "jscpd.config.json": "{}\n" } });
  try {
    const plan = p.plan().doc.plan;
    const off = plan.groups.notApplicableOrDisabled.find((i) => i.id === "quality-bridge.jscpd#duplication");
    assert.ok(off, JSON.stringify(plan.groups.notApplicableOrDisabled.map((i) => i.id)));
    assert.equal(off.reason.code, "SUPERSEDED");
    assert.match(off.reason.message, /jscpd#duplication/);
    assert.ok(plan.groups.willRun.some((i) => i.id === "jscpd#duplication"));
    assert.ok(!plan.warnings.some((w) => w.code === "SCANNER_RUNS_TWICE"), JSON.stringify(plan.warnings));
    const bridge = plan.invocations.find((i) => i.adapter === "quality-bridge");
    assert.ok(!bridge || !bridge.subchecks.includes("jscpd"));
  } finally {
    p.cleanup();
  }
});

test("jscpd: a config that is not JSON refuses the plan with the file and line, and a broken report is an error, never zero duplications", () => {
  const p = project({ tools: JSCPD_TOOLS, files: { "src/a.ts": BLOCK, "jscpd.config.json": "{ nope" } });
  try {
    const ran = p.run("--only", "tool:jscpd");
    // The plan itself is refused (CONFIG_INVALID, file and line), so nothing runs on a config that does not parse.
    assert.equal(ran.code, 3, ran.out + ran.err);
    assert.equal(ran.doc.code, "PLAN_NOT_APPROVABLE");
    assert.ok(ran.doc.blockers.some((b) => b.code === "CONFIG_INVALID" && /jscpd\.config\.json:1/.test(b.message)), ran.out);
  } finally {
    p.cleanup();
  }
  assert.equal(parseJscpdReport("{ cut", { stageId: "s", version: "5.3.3", prefix: "" }).ok, false);
  assert.equal(parseJscpdReport('{"statistics":{}}', { stageId: "s", version: "5.3.3", prefix: "" }).ok, false);
  const ok = parseJscpdReport('{"duplicates":[],"statistics":{"total":{"percentage":0}}}', { stageId: "s", version: "5.3.3", prefix: "web/" });
  assert.deepEqual([ok.ok, ok.clones, ok.percentage], [true, 0, 0]);
});

test("ESLint report parser: severities, files relative to the workspace and a fatal message without rule", () => {
  const workspace = path.resolve("/ws");
  const report = JSON.stringify([
    { filePath: path.join(workspace, "src", "a.ts"), messages: [{ ruleId: "no-var", severity: 2, message: "Unexpected var", line: 3, column: 1 }, { ruleId: "semi", severity: 1, message: "Missing semicolon", line: 4, column: 9 }] },
    { filePath: path.join(workspace, "src", "b.ts"), messages: [{ ruleId: null, severity: 2, fatal: true, message: "Parsing error", line: 1, column: 2 }] },
  ]);
  const parsed = parseEslintOutput(report, { stageId: "eslint#lint", version: "10.13.0", workspace });
  assert.equal(parsed.ok, true, parsed.problem);
  assert.equal(parsed.filesLinted, 2);
  assert.deepEqual(parsed.findings.map((f) => [f.ruleId, f.location.path, f.blocking, f.normalizedSeverity]), [
    ["no-var", "src/a.ts", true, "high"],
    ["semi", "src/a.ts", false, "low"],
    ["eslint.fatal", "src/b.ts", true, "high"],
  ]);
  assert.equal(parseEslintOutput("{}", { stageId: "s", version: null, workspace }).ok, false);
  assert.equal(parseEslintOutput("[{}]", { stageId: "s", version: null, workspace }).ok, false);
});
