import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-97 (fake engine): findings that do not block. A recorded Semgrep output holds one blocking and one informational
// finding of pack rules. The run fails for the blocking one alone; with only the informational one it is approved and
// says "and 1 informational" ("e 1 informativo"); the report lists them apart in both languages; `jgates waivers add`
// refuses the informational one; the baseline comparison counts them apart; each finding carries the requirement ids of
// its rule (as the pack index states them); the SARIF output marks the informational one with the level `note`.
//
// The runs go through the core run service with a step that normalizes the recorded output the way the Semgrep adapter
// does (the same function, with the bundled pack's rules); no engine is started.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = path.join(root, "jgates", "dist");
const MAIN = path.join(DIST, "cli", "main.js");
const FIXTURES = path.join(root, "tests", "v2", "fixtures", "informational");
const load = (...parts) => import(pathToFileURL(path.join(DIST, ...parts)).href);

const BLOCKING_RULE = "jgates.python.weak-hash";
const INFORMATIONAL_RULE = "jgates.python.weak-cipher";

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function project() {
  const { executeRun } = await load("core", "run", "index.js");
  const semgrep = await load("adapters", "semgrep", "index.js");
  const index = semgrep.packRuleIndex(semgrep.bundledPackRulesDir("jgates"));
  const ruleOf = (id) => {
    const rule = index.rules.find((r) => r.id === id);
    assert.ok(rule && rule.asvsRequirements.length > 0, `the pack rule ${id} exists and states its requirements`);
    return rule;
  };
  const packRules = new Map(index.rules.filter((r) => r.signal === null).map((r) => [r.id, r.asvsRequirements]));
  const ws = tmp("v2-97-ws-");
  const home = tmp("v2-97-home-");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "app.py"), "import hashlib\n\nhashlib.md5(b'x')\n\n\n\n\nAES.new(key, AES.MODE_ECB)\n");
  const env = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1" };
  const run = (recorded) =>
    executeRun({
      workspacePath: ws,
      home,
      version: "test",
      adapter: "semgrep",
      options: {},
      env,
      selection: { scope: "workspace" },
      execute: async (context) => {
        const text = fs.readFileSync(path.join(FIXTURES, recorded), "utf8");
        const parsed = semgrep.parseSemgrepOutput(text, { stageId: "semgrep", version: "1.182.1", workspace: context.workspacePath, cwd: context.workspacePath, packRules });
        assert.equal(parsed.ok, true, parsed.problem);
        return {
          stages: [{ id: "semgrep", kind: "step", adapter: "semgrep", state: "completed", blockingViolations: parsed.findings.filter((f) => f.blocking).length, findings: parsed.findings.length }],
          requirements: [{ id: "semgrep", required: true }],
          disabled: [],
          findings: parsed.findings,
          logs: [],
          outputs: [],
        };
      },
    });
  const cli = (locale, ...args) => spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: { ...env, JGATES_LOCALE: locale }, timeout: 120_000 });
  return { ws, run, cli, ruleOf };
}

test("V2-97: the run fails for the blocking finding alone and each finding carries its requirement ids", async () => {
  const p = await project();
  const result = await p.run("blocking-and-informational.json");
  assert.equal(result.decision, "failed");
  assert.equal(result.blockingViolations, 1, "only the blocking finding counts");
  const byRule = (id) => result.findings.find((f) => f.ruleId.endsWith(id));
  assert.equal(byRule(BLOCKING_RULE).blocking, true);
  assert.equal(byRule(INFORMATIONAL_RULE).blocking, false);
  assert.equal(byRule(INFORMATIONAL_RULE).informational, true);
  assert.deepEqual(byRule(BLOCKING_RULE).asvsRequirements, p.ruleOf(BLOCKING_RULE).asvsRequirements);
  assert.deepEqual(byRule(INFORMATIONAL_RULE).asvsRequirements, p.ruleOf(INFORMATIONAL_RULE).asvsRequirements);
});

test("V2-97: a run with only the informational finding is approved and says 'and 1 informational'", async () => {
  const p = await project();
  const result = await p.run("informational-only.json");
  assert.equal(result.decision, "passed");
  assert.equal(result.blockingViolations, 0);
  const en = p.cli("en", "report", result.runId, "--cwd", p.ws, "--format", "text");
  assert.equal(en.status, 0, en.stderr);
  assert.match(en.stdout, /approved and 1 informational/);
  const pt = p.cli("pt-BR", "report", result.runId, "--cwd", p.ws, "--format", "text");
  assert.equal(pt.status, 0, pt.stderr);
  assert.match(pt.stdout, /aprovado e 1 informativo/);
});

test("V2-97: the report lists the informational finding after the blocking one under its own heading, with 'ASVS <id>'", async () => {
  const p = await project();
  const result = await p.run("blocking-and-informational.json");
  const blockingIds = result.findings.find((f) => f.blocking).asvsRequirements;
  const informationalIds = result.findings.find((f) => f.informational).asvsRequirements;
  for (const [locale, summary, heading] of [
    ["en", "failed: 1 blocking violation and 1 informational", "Informational findings"],
    ["pt-BR", "reprovado: 1 violação bloqueante e 1 informativo", "Achados informativos"],
  ]) {
    const out = p.cli(locale, "report", result.runId, "--cwd", p.ws, "--format", "text");
    assert.equal(out.status, 0, out.stderr);
    const lines = out.stdout.split("\n");
    assert.ok(out.stdout.includes(summary), out.stdout);
    const blockAt = lines.findIndex((l) => l.includes(BLOCKING_RULE));
    const headingAt = lines.findIndex((l) => l.startsWith(heading));
    const infoAt = lines.findIndex((l) => l.includes(INFORMATIONAL_RULE));
    assert.ok(blockAt >= 0 && headingAt > blockAt && infoAt > headingAt, `blocking, heading, informational: ${out.stdout}`);
    assert.ok(lines[blockAt].includes(`ASVS ${blockingIds.join(", ")}`));
    assert.ok(lines[infoAt].includes(`ASVS ${informationalIds.join(", ")}`));
    assert.doesNotMatch(out.stdout, /compliant|conformant|certified|conforme|certificado/i, "the label never says a requirement is met");
  }
});

test("V2-97: the SARIF output marks the informational finding as a note and keeps the level of the blocking one", async () => {
  const p = await project();
  const result = await p.run("blocking-and-informational.json");
  const out = p.cli("en", "report", result.runId, "--cwd", p.ws, "--format", "sarif");
  assert.equal(out.status, 0, out.stderr);
  const levels = Object.fromEntries(JSON.parse(out.stdout).runs[0].results.map((r) => [r.ruleId.split("/").pop().split(".").slice(-3).join("."), r.level]));
  assert.equal(levels[BLOCKING_RULE], "error");
  assert.equal(levels[INFORMATIONAL_RULE], "note");
});

test("V2-97: `jgates waivers add` refuses the informational finding with a reason, in both languages, and writes nothing", async () => {
  const p = await project();
  const result = await p.run("blocking-and-informational.json");
  const fingerprint = result.findings.find((f) => f.informational).fingerprint.replace(/^jgf1:/, "").slice(0, 12);
  const args = ["waivers", "add", "--finding", fingerprint, "--run", result.runId, "--until", "2099-01-01", "--reason", "accepted by the team", "--yes", "--cwd", p.ws];
  const en = p.cli("en", ...args);
  assert.notEqual(en.status, 0);
  assert.match(en.stderr + en.stdout, /informational/);
  assert.match(en.stderr + en.stdout, /cannot be waived|nothing to waive/);
  const pt = p.cli("pt-BR", ...args);
  assert.notEqual(pt.status, 0);
  assert.match(pt.stderr + pt.stdout, /informativo/);
  assert.equal(fs.existsSync(path.join(p.ws, ".jgates", "waivers.json")), false, "nothing was written");
  // The blocking finding is still waivable.
  const blocking = result.findings.find((f) => f.blocking).fingerprint.replace(/^jgf1:/, "").slice(0, 12);
  const ok = p.cli("en", "waivers", "add", "--finding", blocking, "--run", result.runId, "--until", "2099-01-01", "--reason", "accepted by the team", "--yes", "--cwd", p.ws);
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
});

test("V2-97: the baseline comparison counts informational findings apart from blocking ones", async () => {
  const p = await project();
  const first = await p.run("blocking-and-informational.json");
  const set = p.cli("en", "baseline", "set", first.runId, "--cwd", p.ws, "--json");
  assert.equal(set.status, 0, set.stderr + set.stdout);
  const second = await p.run("informational-only.json");
  assert.equal(second.baseline.runId, first.runId);
  assert.deepEqual([second.baseline.new, second.baseline.kept], [0, 0], "no blocking finding is left: the blocking one is resolved");
  assert.deepEqual([second.baseline.newInformational, second.baseline.keptInformational, second.baseline.resolvedInformational], [0, 1, 0]);
  const out = p.cli("en", "baseline", "compare", second.runId, "--cwd", p.ws, "--json");
  assert.equal(out.status, 0, out.stderr);
  const doc = JSON.parse(out.stdout);
  assert.equal(doc.comparison.keptInformational, 1);
  assert.equal(doc.comparison.resolved.length, 1);
});
