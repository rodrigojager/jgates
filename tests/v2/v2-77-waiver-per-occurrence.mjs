import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-77 (fake engine): a waiver points at one occurrence (PLAN-waivers.md sections 2 and 4). A file with three findings
// of one rule: the third is dismissed, the first two are fixed, and the next run shows the third waived. A new finding
// of the rule added above a dismissed one stays active. When the flagged line itself changes the waiver no longer
// applies and the finding is active again. A finding of the secrets category has no anchor and uses the count guard:
// with the count changed the waiver is listed under waivers.stale and the finding is active. An unreadable
// .jgates/waivers.json is reported in waivers.problem and as a warning in the run output, in both languages, and the
// findings stay active.
//
// The occurrence scenarios run the core run service with a fake scanner step that reads the analyzed folder (one finding
// per line that calls risky(...), one secrets finding per line holding a test key), so the anchors are computed from the
// real files of the run. The unreadable file runs the CLI against the fake engine, with the built-in personal-data check
// (the fake engine "detects" a formatted CPF), as V2-61 does.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = path.join(root, "jgates", "dist");
const MAIN = path.join(DIST, "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const load = (...parts) => import(pathToFileURL(path.join(DIST, ...parts)).href);
const CPF = "529.982.247-25";

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const write = (dir, files) => {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
};

/** The fake scanner: reads every file of src/ in the analyzed folder, line by line. */
function scan(dir) {
  const findings = [];
  const src = path.join(dir, "src");
  if (!fs.existsSync(src)) return findings;
  for (const name of fs.readdirSync(src).sort()) {
    const rel = `src/${name}`;
    fs.readFileSync(path.join(src, name), "utf8")
      .split("\n")
      .forEach((text, index) => {
        const base = { stageId: "fake-scan", tool: "fake-scan", severity: "high", normalizedSeverity: "high", blocking: true, blockingReason: "blocking-category", waived: false, location: { path: rel, line: index + 1 } };
        if (/\brisky\(/.test(text)) findings.push({ ...base, ruleId: "fake.risky-call", category: "lint", message: "a risky call" });
        if (/sk_test_[A-Za-z0-9]+/.test(text)) findings.push({ ...base, ruleId: "fake.test-key", category: "secrets", message: "a key was found" });
      });
  }
  return findings;
}

async function project() {
  const { executeRun } = await load("core", "run", "index.js");
  const results = await load("core", "results", "index.js");
  const ws = tmp("v2-77-ws-");
  const home = tmp("v2-77-home-");
  const run = () =>
    executeRun({
      workspacePath: ws,
      home,
      version: "test",
      adapter: "fake-scan",
      options: {},
      env: { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1" },
      execute: async (context) => {
        const findings = scan(context.workspacePath);
        return {
          stages: [{ id: "fake-scan", kind: "step", adapter: "fake-scan", state: "completed", blockingViolations: findings.length }],
          requirements: [{ id: "fake-scan", required: true }],
          disabled: [],
          findings,
          logs: [],
          outputs: [],
        };
      },
    });
  const waive = (result, finding, reason = "false positive") => {
    const entry = results.occurrenceWaiver(result, finding, { reason, expires: "2999-12-31", created: "2026-11-14" });
    const file = path.join(ws, ".jgates", "waivers.json");
    const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { waivers: [] };
    doc.waivers.push(entry);
    write(ws, { ".jgates/waivers.json": `${JSON.stringify(doc, null, 2)}\n` });
    return entry;
  };
  return { ws, run, waive };
}

const at = (result, line, ruleId = "fake.risky-call") => {
  const f = result.findings.find((x) => x.ruleId === ruleId && x.location.line === line);
  assert.ok(f, `no ${ruleId} finding at line ${line}: ${JSON.stringify(result.findings.map((x) => [x.ruleId, x.location.line]))}`);
  return f;
};

test("V2-77: the third of three findings is dismissed, the first two are fixed, and the next run shows the third waived", async () => {
  const p = await project();
  write(p.ws, { "src/app.js": "risky(1);\nok();\nrisky(2);\nrisky(3);\n" });
  const first = await p.run();
  assert.equal(first.findings.length, 3);
  assert.equal(first.decision, "failed");
  const third = at(first, 4);
  assert.match(third.anchor, /^jga1:[0-9a-f]{32}$/);
  const entry = p.waive(first, third);
  assert.equal(entry.anchor, third.anchor);
  assert.equal(entry.occurrences, 3);

  // The real ones are fixed; the dismissed one moved up and is now the only finding of the rule (fingerprint position 0).
  write(p.ws, { "src/app.js": "ok();\nok();\nrisky(3);\n" });
  const second = await p.run();
  assert.equal(second.findings.length, 1);
  const waived = at(second, 3);
  assert.notEqual(waived.fingerprint, third.fingerprint, "the fingerprint v1 moved with the position");
  assert.equal(waived.anchor, third.anchor);
  assert.equal(waived.waived, true);
  assert.equal(waived.waiverSource, "project");
  assert.equal(waived.waiverExpires, "2999-12-31");
  assert.equal(waived.waiverReason, "false positive");
  assert.equal(second.decision, "passed");
  assert.equal(second.waivers.count, 1);
  assert.equal(second.waivers.findings, 1);
  assert.deepEqual(
    second.waivers.applied.map((e) => [e.source, e.rule, e.path, e.line, e.reason, e.expires, e.findings]),
    [["project", "fake.risky-call", "src/app.js", 3, "false positive", "2999-12-31", 1]],
  );
  const onDisk = JSON.parse(fs.readFileSync(path.join(second.runDir, "result.json"), "utf8"));
  assert.deepEqual(onDisk.waivers, second.waivers);
});

test("V2-77: a new finding of the rule added above a dismissed one stays active; changing the flagged line ends the waiver", async () => {
  const p = await project();
  write(p.ws, { "src/app.js": "risky(1);\nrisky(2);\n" });
  const first = await p.run();
  p.waive(first, at(first, 2));

  // A new call above the dismissed one: the new one is active, the dismissed one is still waived.
  write(p.ws, { "src/app.js": "risky(1);\nrisky(0);\nrisky(2);\n" });
  const added = await p.run();
  assert.equal(at(added, 1).waived, false);
  assert.equal(at(added, 2).waived, false, "the new finding is not dismissed in place of the old one");
  assert.equal(at(added, 3).waived, true);
  assert.equal(added.decision, "failed");

  // Indentation alone does not change the line (white space is collapsed).
  write(p.ws, { "src/app.js": "risky(1);\nrisky(0);\n    risky(2);\n" });
  assert.equal(at(await p.run(), 3).waived, true);

  // The flagged line itself changes: the waiver does not apply and the finding is active again.
  write(p.ws, { "src/app.js": "risky(1);\nrisky(0);\nrisky(2, more);\n" });
  const changed = await p.run();
  assert.ok(changed.findings.every((f) => f.waived === false), JSON.stringify(changed.findings));
  assert.equal(changed.waivers.count, 0);
  assert.deepEqual(changed.waivers.stale.map((e) => [e.rule, e.path, e.cause]), [["fake.risky-call", "src/app.js", "line-changed"]]);
});

test("V2-77: a finding of the secrets category has no anchor and uses the count guard: with the count changed the waiver is stale", async () => {
  const p = await project();
  write(p.ws, { "src/keys.js": 'const a = "sk_test_AAA";\nconst b = "sk_test_BBB";\n' });
  const first = await p.run();
  const keys = first.findings.filter((f) => f.ruleId === "fake.test-key");
  assert.equal(keys.length, 2);
  assert.ok(keys.every((f) => f.anchor === undefined), "a secret is never anchored on its line");
  assert.ok(!JSON.stringify(first.findings).includes("sk_test_"), "the key is not in the result");
  const entry = p.waive(first, at(first, 2, "fake.test-key"), "test key");
  assert.equal(entry.anchor, undefined);
  assert.equal(entry.occurrences, 2);

  // Same count: the guard holds and the waiver applies.
  const same = await p.run();
  assert.equal(at(same, 2, "fake.test-key").waived, true);
  assert.equal(at(same, 1, "fake.test-key").waived, false);

  // One more key in the file: the count changed, the waiver is stale and nothing is waived.
  write(p.ws, { "src/keys.js": 'const a = "sk_test_AAA";\nconst b = "sk_test_BBB";\nconst c = "sk_test_CCC";\n' });
  const more = await p.run();
  assert.ok(more.findings.every((f) => f.waived === false), JSON.stringify(more.findings));
  assert.equal(more.waivers.count, 0);
  assert.deepEqual(more.waivers.stale.map((e) => [e.rule, e.path, e.cause]), [["fake.test-key", "src/keys.js", "count-changed"]]);
});

function cliProject() {
  const project = tmp("v2-77-project-");
  const home = tmp("v2-77-cli-home-");
  const engine = tmp("v2-77-engine-");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(
    runtime,
    `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(path.join(engine, "calls.jsonl"))};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))};\nrequire(${JSON.stringify(FAKE)});\n`,
  );
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", NO_COLOR: "1" };
  delete env.JGATES_PYTHON;
  const cli = (args, locale = "en") => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env: { ...env, JGATES_LOCALE: locale }, input: "", timeout: 240_000 });
  write(project, { "src/app.py": "def add(a, b):\n    return a + b\n", "data/customers.csv": `name,cpf\nAna,${CPF}\n` });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  const init = cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  return { project, cli };
}

test("V2-77: an unreadable .jgates/waivers.json is reported in the result and in the run output in both languages, and the findings stay active", () => {
  const p = cliProject();
  write(p.project, { ".jgates/waivers.json": '{ "waivers": [ { "rule": "pii.cpf", "reason": "broken' });
  spawnSync("git", ["add", "-A"], { cwd: p.project });
  const args = ["run", "--cwd", p.project, "--no-interactive", "--only", "tool:builtin-pii"];

  const json = p.cli([...args, "--json"]);
  let doc;
  try {
    doc = JSON.parse(json.stdout);
  } catch {
    assert.fail(`no JSON from the run: ${json.stdout}\n${json.stderr}`);
  }
  assert.equal(doc.waivers.problem.file, ".jgates/waivers.json");
  assert.ok(doc.waivers.problem.message.length > 0);
  assert.equal(doc.waivers.count, 0);
  const cpf = doc.findings.filter((f) => f.ruleId === "pii.cpf");
  assert.equal(cpf.length, 1, JSON.stringify(doc.findings));
  assert.equal(cpf[0].waived, false, "the findings stay active");
  assert.equal(cpf[0].anchor, undefined, "personal data is never anchored on its line");

  const en = p.cli(args, "en");
  assert.match(en.stdout, /Warning: the waiver file \.jgates\/waivers\.json could not be read/, en.stdout + en.stderr);
  assert.match(en.stdout, /its findings stay active/);
  const pt = p.cli(args, "pt-BR");
  assert.match(pt.stdout, /Aviso: o arquivo de dispensas \.jgates\/waivers\.json não pôde ser lido/, pt.stdout + pt.stderr);
  assert.match(pt.stdout, /os achados continuam ativos/);
});
