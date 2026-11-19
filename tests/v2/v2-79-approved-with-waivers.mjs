import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-79 (fake engine): a run that passes with waivers says "approved with N waivers", and `--no-waivers` accepts none
// (PLAN-waivers.md section 4). The decision stays `passed` and the exit codes keep their meaning; the wording and the
// `waivers` block of the result are what change.
//
// The CLI scenarios run `jgates run` against the fake engine with the built-in personal-data check (the fake engine
// "detects" a formatted CPF), as V2-77 does. The decision scenarios run the core run service with a fake scanner step, so
// a check in error, four findings under one waiver, the both-gates approval and the stored results can be built exactly.

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

// ---------------------------------------------------------------------------------------------------- the CLI

function cliProject(waivers) {
  const project = tmp("v2-79-project-");
  const home = tmp("v2-79-home-");
  const engine = tmp("v2-79-engine-");
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
  if (waivers) write(project, { ".jgates/waivers.json": `${JSON.stringify({ waivers }, null, 2)}\n` });
  spawnSync("git", ["add", "-A"], { cwd: project });
  const args = ["run", "--cwd", project, "--no-interactive", "--only", "tool:builtin-pii"];
  const json = (extra = []) => {
    const r = cli([...args, ...extra, "--json"]);
    try {
      return { status: r.status, doc: JSON.parse(r.stdout) };
    } catch {
      assert.fail(`no JSON from the run: ${r.stdout}\n${r.stderr}`);
    }
  };
  return { project, cli, args, json };
}

const CPF_WAIVER = { rule: "pii.cpf", path: "data/*", reason: "legacy sample data", expires: "2999-12-31" };

test("V2-79: a run that passes with one waiver exits 0 and says approved with 1 waiver, with the list, in both languages", () => {
  const p = cliProject([CPF_WAIVER]);
  const { status, doc } = p.json();
  assert.equal(status, 0, JSON.stringify(doc.findings));
  assert.equal(doc.decision, "passed");
  assert.equal(doc.exitCode, 0);
  assert.equal(doc.waivers.count, 1);
  assert.equal(doc.waivers.findings, 1);
  assert.deepEqual(
    doc.waivers.applied.map((e) => [e.source, e.rule, e.path, e.line, e.reason, e.expires, e.findings]),
    [["project", "pii.cpf", "data/customers.csv", 2, "legacy sample data", "2999-12-31", 1]],
  );
  assert.deepEqual(doc.waivers.refused, []);
  assert.equal(doc.findings.find((f) => f.ruleId === "pii.cpf").waived, true);

  const en = p.cli(p.args, "en");
  assert.equal(en.status, 0, en.stdout + en.stderr);
  assert.match(en.stdout, /approved with 1 waiver(?!s)/);
  assert.doesNotMatch(en.stdout, /Decision: passed \(approved\)/, "never a plain approval");
  assert.match(en.stdout, /pii\.cpf\s+data\/customers\.csv:2\s+"legacy sample data"\s+until 2999-12-31/, en.stdout);
  assert.ok(!en.stdout.includes(CPF), "the value is never shown");
  const pt = p.cli(p.args, "pt-BR");
  assert.equal(pt.status, 0, pt.stdout + pt.stderr);
  assert.match(pt.stdout, /aprovado com 1 dispensa(?!s)/);
  assert.match(pt.stdout, /pii\.cpf\s+data\/customers\.csv:2\s+"legacy sample data"\s+até 2999-12-31/, pt.stdout);
});

test("V2-79: the same project with --no-waivers fails with exit 1, waives nothing, lists the waiver under waivers.refused and says so", () => {
  const p = cliProject([CPF_WAIVER]);
  const { status, doc } = p.json(["--no-waivers"]);
  assert.equal(status, 1, JSON.stringify(doc.waivers));
  assert.equal(doc.decision, "failed");
  assert.equal(doc.exitCode, 1);
  assert.equal(doc.waivers.count, 0);
  assert.equal(doc.waivers.findings, 0);
  assert.deepEqual(doc.waivers.applied, []);
  assert.deepEqual(
    doc.waivers.refused.map((e) => [e.source, e.rule, e.path, e.reason, e.findings]),
    [["project", "pii.cpf", "data/customers.csv", "legacy sample data", 1]],
  );
  const cpf = doc.findings.find((f) => f.ruleId === "pii.cpf");
  assert.equal(cpf.waived, false);
  assert.equal(cpf.blocking, true);
  assert.equal(doc.provenance.waivers.count, 0, "no waiver was in force");

  const en = p.cli([...p.args, "--no-waivers"], "en");
  assert.equal(en.status, 1, en.stdout + en.stderr);
  assert.match(en.stdout, /Waivers not accepted \(--no-waivers\): 1 waiver would have applied/);
  assert.doesNotMatch(en.stdout, /approved with/);
  const short = cpf.fingerprint.replace(/^jgf1:/, "").slice(0, 12);
  assert.ok(en.stdout.includes(short), `the short fingerprint ${short} is in the text:\n${en.stdout}`);
  const pt = p.cli([...p.args, "--no-waivers"], "pt-BR");
  assert.match(pt.stdout, /Dispensas não aceitas \(--no-waivers\): 1 dispensa teria valido/);
});

test("V2-79: a run with no waiver says a plain approval and waivers.count 0; --no-waivers and --waiver together is a usage error", () => {
  // Without the personal data nothing blocks: the pass is a plain approval.
  const p = cliProject();
  fs.rmSync(path.join(p.project, "data"), { recursive: true, force: true });
  spawnSync("git", ["add", "-A"], { cwd: p.project });
  const ok = p.cli(p.args, "en");
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Decision: passed \(/);
  assert.doesNotMatch(ok.stdout, /approved with \d+ waiver/);
  assert.doesNotMatch(ok.stdout, /Waivers applied/);
  const okJson = p.json();
  assert.equal(okJson.doc.waivers.count, 0);
  assert.deepEqual(okJson.doc.waivers.applied, []);

  // --no-waivers together with --waiver is refused before anything runs.
  const both = p.cli([...p.args, "--no-waivers", "--waiver", "rule=pii.cpf;reason=ad hoc", "--json"], "en");
  assert.equal(both.status, 3, both.stdout + both.stderr);
  assert.match(both.stdout + both.stderr, /NO_WAIVERS_WITH_WAIVER/);
});

test("V2-79: jgates ci refuses --no-waivers like its other refused options", () => {
  const p = cliProject([CPF_WAIVER]);
  const r = p.cli(["ci", "--cwd", p.project, "--no-waivers", "--json"], "en");
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /CI_OPTION_REFUSED/);
});

test("V2-79: jgates report --format text of a stored run says approved with waivers and shows the short fingerprints", () => {
  const p = cliProject([CPF_WAIVER]);
  const { doc } = p.json();
  const text = p.cli(["report", doc.runId, "--cwd", p.project, "--format", "text"], "en");
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.match(text.stdout, /approved with 1 waiver(?!s)/);
  assert.match(text.stdout, /pii\.cpf\s+data\/customers\.csv:2/);
  const refused = p.json(["--no-waivers"]).doc;
  const failed = p.cli(["report", refused.runId, "--cwd", p.project, "--format", "text"], "en");
  const short = refused.findings.find((f) => f.ruleId === "pii.cpf").fingerprint.replace(/^jgf1:/, "").slice(0, 12);
  assert.ok(failed.stdout.includes(short), failed.stdout);
  assert.match(failed.stdout, /Waivers not accepted \(--no-waivers\): 1 waiver would have applied/);
});

// ------------------------------------------------------------------------------------------ the core decisions

/** The fake scanner: one blocking finding per line that calls risky(...) in src/. */
function scan(dir) {
  const findings = [];
  const src = path.join(dir, "src");
  if (!fs.existsSync(src)) return findings;
  for (const name of fs.readdirSync(src).sort()) {
    fs.readFileSync(path.join(src, name), "utf8")
      .split("\n")
      .forEach((text, index) => {
        if (/\brisky\(/.test(text)) {
          findings.push({ stageId: "fake-scan", tool: "fake-scan", ruleId: "fake.risky-call", category: "lint", message: "a risky call", severity: "high", normalizedSeverity: "high", blocking: true, blockingReason: "blocking-category", waived: false, location: { path: `src/${name}`, line: index + 1 } });
        }
      });
  }
  return findings;
}

async function scenario(files, { waivers, state = "completed" } = {}) {
  const { executeRun } = await load("core", "run", "index.js");
  const ws = tmp("v2-79-ws-");
  const home = tmp("v2-79-core-home-");
  write(ws, files);
  if (waivers) write(ws, { ".jgates/waivers.json": `${JSON.stringify({ waivers }, null, 2)}\n` });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: ws }).status, 0);
  const run = (extra = {}) =>
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
          stages: [{ id: "fake-scan", kind: "step", adapter: "fake-scan", state, blockingViolations: findings.length }],
          requirements: [{ id: "fake-scan", required: true }],
          disabled: [],
          findings,
          logs: [],
          outputs: [],
        };
      },
      ...extra,
    });
  return { ws, home, run };
}

const RULE_WAIVER = { rule: "fake.risky-call", path: "src/*", reason: "reviewed by the team", expires: "2999-12-31" };

test("V2-79: one waiver covering four findings reads approved with 1 waiver (4 findings)", async () => {
  const results = await load("core", "results", "index.js");
  const { translator } = await load("i18n", "index.js");
  const s = await scenario({ "src/app.js": "risky(1);\nrisky(2);\nrisky(3);\nrisky(4);\n" }, { waivers: [RULE_WAIVER] });
  const result = await s.run();
  assert.equal(result.decision, "passed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.waivers.count, 1);
  assert.equal(result.waivers.findings, 4);
  assert.equal(result.waivers.applied[0].findings, 4);
  assert.deepEqual(results.approvalWording(result), { kind: "with-waivers", waivers: 1, findings: 4 });
  // The workspace has no commit, so the summary may go on with the note about local changes after a ";".
  assert.match(results.resultSummary(result, translator("run", "en")), /^approved with 1 waiver \(4 findings\)(;|$)/);
  assert.match(results.resultSummary(result, translator("run", "pt-BR")), /^aprovado com 1 dispensa \(4 achados\)(;|$)/);
});

test("V2-79: a check in error, timeout or blocked stays so with and without waivers, and the decision is the same", async () => {
  for (const state of ["error", "timeout", "blocked"]) {
    const files = { "src/app.js": "risky(1);\n" };
    const withWaivers = await (await scenario(files, { waivers: [RULE_WAIVER], state })).run();
    const without = await (await scenario(files, { state })).run();
    const refused = await (await scenario(files, { waivers: [RULE_WAIVER], state })).run({ noWaivers: true });
    for (const r of [withWaivers, without, refused]) {
      assert.equal(r.stages[0].state, state, `${state}: the state of the check is never changed`);
      assert.notEqual(r.decision, "passed", `${state}: a waiver never makes a failed check pass`);
    }
    assert.equal(withWaivers.decision, without.decision, state);
    assert.equal(withWaivers.exitCode, without.exitCode, state);
    assert.equal(refused.decision, without.decision, state);
    assert.equal(refused.exitCode, without.exitCode, state);
    const wording = (await load("core", "results", "index.js")).approvalWording(withWaivers);
    assert.equal(wording.kind, "plain", "a run that did not pass is never an approval with waivers");
  }
});

test("V2-79: a stored result without the waivers block that passed with waived findings reads as approved with waivers", async () => {
  const results = await load("core", "results", "index.js");
  const { translator } = await load("i18n", "index.js");
  const waived = (line, id) => ({ ruleId: "old.rule", location: { path: "a.js", line }, waived: true, waiverId: id, waiverReason: "old reason", normalizedSeverity: "high", blocking: false });
  const stored = { decision: "passed", findings: [waived(1, "old.rule@a.js"), waived(2, "old.rule@a.js"), waived(3, "other")] };
  assert.deepEqual(results.approvalWording(stored), { kind: "with-waivers", waivers: 2, findings: 3 });
  assert.equal(results.approvalWording({ ...stored, decision: "failed" }).kind, "plain");
  assert.equal(results.approvalWording({ decision: "passed", findings: [] }).kind, "plain");
  const lines = results.waiverLines({ ...stored, runId: "r" }, {}, translator("run", "en"));
  assert.ok(lines.some((l) => /old\.rule\s+a\.js:1\s+"old reason"/.test(l)), lines.join("\n"));
});

test("V2-79: with both gates a Quality approval with waivers lets the Semantic run follow and the sequence says the wording; with --no-waivers the failed Quality run does not advance", async () => {
  const seq = await load("core", "sequence", "index.js");
  const { computeSourceIdentity } = await load("core", "gates", "index.js");
  // The sequence message follows the process language: pin it, whatever the machine's language is.
  (await load("i18n", "index.js")).setLocale("en");
  const files = { "src/app.js": "risky(1);\nrisky(2);\n" };
  const s = await scenario(files, { waivers: [RULE_WAIVER] });
  const assess = (result) => {
    const evidence = seq.readQualityEvidence(s.home, result.workspace.id, result.runId);
    return seq.assessQualityPrerequisite({ quality: evidence, current: computeSourceIdentity(s.ws), policy: "declared-scope", semanticScope: null });
  };
  const waived = await s.run();
  const advanced = assess(waived);
  assert.equal(advanced.approved, true, JSON.stringify(advanced.reasons));
  assert.equal(advanced.status, "advance");
  assert.match(advanced.message, /approved with 1 waiver \(2 findings\)/);
  assert.match(advanced.message, /Semantic may start/);

  const refused = await s.run({ noWaivers: true });
  assert.equal(refused.decision, "failed");
  const stopped = assess(refused);
  assert.equal(stopped.approved, false);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.code, "QUALITY_FAILED");
});

test("V2-79: the agent context of a run that passed with waivers says approved with N waivers, names the dismissed findings and forbids creating waivers", async () => {
  const { buildAgentContext } = await load("core", "agent-context", "index.js");
  const { setLocale } = await load("i18n", "index.js");
  const s = await scenario({ "src/app.js": "risky(1);\nrisky(2);\n" }, { waivers: [RULE_WAIVER] });
  const result = await s.run();
  setLocale("en");
  const text = buildAgentContext(result).text;
  assert.match(text, /approved with 1 waiver \(2 findings\)/);
  assert.match(text, /fake\.risky-call at src\/app\.js:1: waived, reason "reviewed by the team", until 2999-12-31/);
  assert.match(text, /fake\.risky-call at src\/app\.js:2: waived/);
  assert.match(text, /must not create, edit or remove waivers/);
  const plain = buildAgentContext(await (await scenario({ "src/app.js": "ok();\n" })).run()).text;
  assert.doesNotMatch(plain, /approved with/);
  assert.doesNotMatch(plain, /Findings dismissed by waivers/);
});
