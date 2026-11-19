import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-86 (fake engine): the languages of the bundled Semgrep pack are named honestly. A Java-only project and a PHP-only
// project (no stack in JGates) get `jgates init` and, under Balanced, a plan whose Semgrep step is in "will run" with
// the pack and a condition that names the pack's languages; a project with a Kotlin file carries the limitation naming
// Kotlin. The fake engine replays a recorded Semgrep output (a hand-built Semgrep-shaped document: Semgrep did not run in
// this case): the findings come back with jgates.java.* and jgates.php.* ids, a file and a line, and the stage records
// how many files of each language the scan covered. `jgates tools matrix --units` shows sast validated for the Java and
// the PHP unit; `jgates discover` and the workspace vocabulary say which checks run instead of "no check runs"; under
// Essential the step is off with the profile's reason.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "jgates", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const TOOLS_ID = `sha256:${"a".repeat(64)}`;

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const JAVA = "class App {\n  String q(String id) { return stmt.executeQuery(\"select * from t where id = \" + id); }\n}\n";
const PHP = "<?php\n$id = $_GET['id'];\nmysqli_query($db, \"select * from t where id = \" . $id);\n";

const finding = (id, file, line, message) => ({
  check_id: id,
  path: file,
  start: { line, col: 3, offset: 0 },
  end: { line, col: 40, offset: 0 },
  extra: { message, metadata: { category: "injection", cwe: "CWE-89" }, severity: "ERROR", fingerprint: "requires login", lines: "requires login", validation_state: "NO_VALIDATOR", engine_kind: "OSS" },
});
const recorded = (results, scanned) => JSON.stringify({ version: "1.184.0", results, errors: [], paths: { scanned }, skipped_rules: [] });

const SEMGREP_OUT = "outputs/semgrep/semgrep/semgrep.json";

function setup(files) {
  const project = tmp("v2-86-project-");
  const home = tmp("v2-86-home-");
  const engine = tmp("v2-86-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(
    runtime,
    `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))};\nprocess.env.FAKE_DOCKER_IMAGE_ID = ${JSON.stringify(TOOLS_ID)};\ntry { Object.assign(process.env, JSON.parse(require("node:fs").readFileSync(${JSON.stringify(path.join(engine, "env.json"))}, "utf8"))); } catch {}\nrequire(${JSON.stringify(FAKE)});\n`,
  );
  const base = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  const cli = (args, engineEnv = {}) => {
    fs.writeFileSync(path.join(engine, "env.json"), JSON.stringify(engineEnv));
    return spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env: base, input: "", timeout: 240_000 });
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), text);
  }
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  return { project, cli };
}

const init = (p, profile) => {
  const r = p.cli(["init", "--cwd", p.project, "--profile", profile, "--no-interactive", "--json"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  spawnSync("git", ["add", "-A"], { cwd: p.project });
};
// `--only` turns the selected step on for that run (it overrides the profile), so a case about what the profile
// leaves off plans the whole project instead.
const planOf = (p, { only = true } = {}) => {
  const r = p.cli(["plan", "--cwd", p.project, ...(only ? ["--only", "tool:semgrep"] : []), "--json"]);
  const doc = JSON.parse(r.stdout);
  return doc.plan ?? doc;
};
const semgrepItem = (plan) => plan.groups.willRun.find((i) => i.id === "semgrep#sast");

test("V2-86: a Java-only and a PHP-only project plan the Semgrep step with the pack under Balanced, and the plan names the pack's languages", () => {
  for (const [files, language] of [
    [{ "pom.xml": "<project><modelVersion>4.0.0</modelVersion></project>\n", "src/main/java/App.java": JAVA }, "java"],
    [{ "composer.json": '{"name":"acme/site"}\n', "index.php": PHP }, "php"],
  ]) {
    const p = setup(files);
    init(p, "standard");
    const item = semgrepItem(planOf(p));
    assert.ok(item, `${language}: the Semgrep step will run`);
    const args = item.command.args;
    assert.ok(args.some((a) => /jgates-semgrep[\\/]rules$/.test(a)), `${language}: the plan uses the bundled pack`);
    const conditions = item.conditions.join("\n");
    for (const name of ["JavaScript/TypeScript", "Python", "Go", "C#", "Rust", "Java", "PHP"]) assert.ok(conditions.includes(name), `${language}: the condition names ${name}: ${conditions}`);
    assert.deepEqual(item.limitations, [], `${language}: the pack has rules for the language, so no limitation`);
  }
});

test("V2-86: a project with a Kotlin file carries the limitation naming Kotlin", () => {
  const p = setup({ "build.gradle.kts": "plugins {}\n", "src/Main.kt": "fun main() {}\n" });
  init(p, "standard");
  const item = semgrepItem(planOf(p));
  assert.ok(item, "the Semgrep step will run");
  assert.ok(item.limitations.some((l) => /no rule for: .*Kotlin/.test(l)), JSON.stringify(item.limitations));
});

test("V2-86: a replayed Semgrep output comes back with jgates.java.* and jgates.php.* ids, a file and a line, and the stage records the scanned files per language", () => {
  const p = setup({ "pom.xml": "<project><modelVersion>4.0.0</modelVersion></project>\n", "src/main/java/App.java": JAVA, "web/composer.json": '{"name":"acme/web"}\n', "web/index.php": PHP, "src/Main.kt": "fun main() {}\n" });
  init(p, "standard");
  const out = recorded(
    [finding("jgates.java.sql-string-building", "src/main/java/App.java", 2, "SQL text is built by concatenation."), finding("jgates.php.sql-string-building", "web/index.php", 3, "SQL text is built by concatenation.")],
    ["pom.xml", "src/main/java/App.java", "web/composer.json", "web/index.php", "src/Main.kt"],
  );
  const run = p.cli(["run", "--cwd", p.project, "--no-interactive", "--json", "--only", "tool:semgrep"], { FAKE_DOCKER_OUTPUT_FILES: JSON.stringify({ semgrep: { [SEMGREP_OUT]: out } }) });
  const doc = JSON.parse(run.stdout);
  const found = doc.findings.filter((f) => f.tool === "semgrep");
  assert.deepEqual(found.map((f) => f.ruleId).sort(), ["jgates.java.sql-string-building", "jgates.php.sql-string-building"], run.stdout.slice(0, 600));
  const java = found.find((f) => f.ruleId.startsWith("jgates.java."));
  const php = found.find((f) => f.ruleId.startsWith("jgates.php."));
  assert.deepEqual([java.location.path, java.location.line], ["src/main/java/App.java", 2]);
  assert.deepEqual([php.location.path, php.location.line], ["web/index.php", 3]);
  const stage = doc.stages.find((s) => s.id === "semgrep#sast");
  assert.equal(stage.state, "completed");
  assert.equal(stage.scannedLanguages.java, 1);
  assert.equal(stage.scannedLanguages.php, 1);
  assert.equal(stage.scannedLanguages.kotlin, 1);
  assert.equal(stage.scannedLanguages.go, 0, "a pack language with no file is recorded as 0");
  // The scan covered no Go, Rust, C#, Python or JavaScript file: the stage says so.
  assert.match(stage.reason, /no file of: .*Go/);
  assert.ok(!/no file of: .*Java,/.test(stage.reason) && !/no file of: .*PHP/.test(stage.reason), stage.reason);
});

test("V2-86: tools matrix --units shows sast validated for the Java unit and the PHP unit", () => {
  const p = setup({ "svc/pom.xml": "<project><modelVersion>4.0.0</modelVersion></project>\n", "svc/src/Main.java": JAVA, "site/composer.json": '{"name":"acme/site"}\n', "site/index.php": PHP });
  const r = p.cli(["tools", "matrix", "--units", "--json", "--cwd", p.project]);
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  for (const [root, language] of [["svc", "java"], ["site", "php"]]) {
    const unit = doc.applicability.find((u) => u.componentRoot === root);
    assert.ok(unit, JSON.stringify(doc.applicability.map((u) => [u.componentRoot, u.language])));
    assert.equal(unit.language, language);
    assert.ok(unit.validated.includes("sast"), `${language}: sast is validated`);
    assert.ok(unit.rows.some((x) => x.key === `semgrep#sast@${language}` && x.state === "validated"));
  }
});

test("V2-86: jgates discover and the workspace vocabulary say which checks run on Java and PHP, and no longer that no check runs", async () => {
  const p = setup({ "svc/pom.xml": "<project><modelVersion>4.0.0</modelVersion></project>\n", "svc/src/Main.java": JAVA, "site/composer.json": '{"name":"acme/site"}\n', "site/index.php": PHP, "legacy/main.rb": "puts 1\n" });
  const text = p.cli(["discover", "--cwd", p.project]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Java is recognized/);
  assert.match(text.stdout, /JGates Semgrep rules for Java run when SAST is on/);
  assert.match(text.stdout, /JGates Semgrep rules for PHP run when SAST is on/);
  assert.match(text.stdout, /Ruby is recognized/);
  assert.ok(!/JGates Semgrep rules for Ruby/.test(text.stdout), "the pack has no Ruby rule: the note says only what runs on any project");
  assert.ok(!/no check runs/i.test(text.stdout), text.stdout);
  const json = JSON.parse(p.cli(["discover", "--cwd", p.project, "--json"]).stdout);
  assert.ok(json.packLanguages.includes("java") && json.packLanguages.includes("php") && !json.packLanguages.includes("ruby"));

  // The workspace answer (the data of the screen) marks the languages the pack has rules for.
  const { routes } = await import(pathToFileURL(path.join(dist, "server", "routes", "workspace.js")).href);
  const route = routes.find((r) => r.method === "GET" && r.path === "/api/workspace/vocabulary");
  assert.ok(route, "GET /api/workspace/vocabulary exists");
  const res = await route.handler({ server: { projectDir: p.project, log() {} }, params: {}, query: {}, body: undefined });
  assert.equal(res.status, 200);
  const language = (id) => res.json.languages.find((l) => l.id === id);
  assert.equal(language("java").supported, false);
  assert.equal(language("java").packRules, true);
  assert.equal(language("php").packRules, true);
  assert.equal(language("ruby").packRules, false);
  assert.equal(language("go").packRules, true);
});

test("V2-86: under Essential the Semgrep step is off, with the profile as the reason", () => {
  const p = setup({ "pom.xml": "<project><modelVersion>4.0.0</modelVersion></project>\n", "src/main/java/App.java": JAVA });
  init(p, "minimal");
  const plan = planOf(p, { only: false });
  assert.equal(semgrepItem(plan), undefined, "the step does not run");
  const item = plan.groups.notApplicableOrDisabled.find((i) => i.id === "semgrep#sast");
  assert.ok(item, JSON.stringify(plan.groups.notApplicableOrDisabled.map((i) => i.id)));
  assert.equal(item.state.enabled, false);
  assert.match(JSON.stringify(item.state) + item.reason.message, /minimal/);
});
