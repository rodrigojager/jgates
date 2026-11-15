import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-95 (fake engine): the baseline comparison matches findings by the anchor (PLAN-small-items.md section 2). A file with
// three findings of one rule is the baseline; the next run fixes the first and introduces one below: one new (the
// introduced one, marked new), one resolved (the fixed one, with its line) and two kept. The same pair of runs with a
// baseline stored without anchors gives the numbers of the fingerprint v1 and says matchedBy "fingerprint". The SARIF of
// the run carries only partialFingerprints["jgates/v1"] and no anchor, and the stored baseline file is never rewritten.
//
// Like V2-77, the runs go through the core run service with a fake scanner step that reads the analyzed folder, so the
// anchors are computed from the real files of the run; the baseline is marked and the SARIF written by the CLI.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = path.join(root, "jgates", "dist");
const MAIN = path.join(DIST, "cli", "main.js");
const load = (...parts) => import(pathToFileURL(path.join(DIST, ...parts)).href);

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** The fake scanner: one finding per line of src/app.js that calls risky(...). */
function scan(dir) {
  const file = path.join(dir, "src", "app.js");
  if (!fs.existsSync(file)) return [];
  const findings = [];
  fs.readFileSync(file, "utf8")
    .split("\n")
    .forEach((text, index) => {
      if (/\brisky\(/.test(text)) {
        findings.push({ stageId: "fake-scan", tool: "fake-scan", ruleId: "fake.risky-call", category: "lint", severity: "high", normalizedSeverity: "high", blocking: true, blockingReason: "blocking-category", waived: false, message: "a risky call", location: { path: "src/app.js", line: index + 1 } });
      }
    });
  return findings;
}

async function project() {
  const { executeRun } = await load("core", "run", "index.js");
  const ws = tmp("v2-95-ws-");
  const home = tmp("v2-95-home-");
  const env = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1" };
  const write = (text) => {
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src", "app.js"), text);
  };
  const run = () =>
    executeRun({
      workspacePath: ws,
      home,
      version: "test",
      adapter: "fake-scan",
      options: {},
      env,
      selection: { scope: "workspace" },
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
  const cli = (...args) => spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, timeout: 120_000 });
  const setBaseline = (result) => {
    const set = cli("baseline", "set", result.runId, "--cwd", ws, "--json");
    assert.equal(set.status, 0, set.stderr + set.stdout);
  };
  return { ws, write, run, cli, setBaseline };
}

const lineOf = (result, line) => {
  const f = result.findings.find((x) => x.location.line === line);
  assert.ok(f, `no finding at line ${line}: ${JSON.stringify(result.findings.map((x) => x.location.line))}`);
  return f;
};

// Baseline: risky(1) risky(2) risky(3). Next: the first is fixed and a new one is added below.
const BEFORE = "risky(1);\nrisky(2);\nrisky(3);\n";
const AFTER = "risky(2);\nrisky(3);\nrisky(4);\n";

test("V2-95: the fixed finding is resolved with its line, the introduced one is new and marked new, two are kept", async () => {
  const p = await project();
  p.write(BEFORE);
  const first = await p.run();
  assert.equal(first.findings.length, 3);
  assert.ok(first.findings.every((f) => /^jga1:[0-9a-f]{32}$/.test(f.anchor)));
  p.setBaseline(first);
  const stored = path.join(first.runDir, "result.json");
  const before = sha(stored);

  p.write(AFTER);
  const second = await p.run();
  assert.equal(second.baseline.runId, first.runId);
  assert.equal(second.baseline.matchedBy, "anchor");
  assert.equal(second.baseline.new, 1);
  assert.equal(second.baseline.kept, 2);
  assert.equal(second.baseline.resolved.length, 1);
  assert.equal(second.baseline.resolved[0].line, 1, "the fixed finding was at line 1 of the baseline");
  assert.equal(second.baseline.resolved[0].ruleId, "fake.risky-call");
  assert.equal(second.baseline.resolved[0].fingerprint, lineOf(first, 1).fingerprint);
  assert.deepEqual(second.findings.map((f) => [f.location.line, f.baselineState]), [[1, "unchanged"], [2, "unchanged"], [3, "new"]]);

  // The text of `jgates baseline compare` shows the same numbers.
  const cmp = p.cli("baseline", "compare", second.runId, "--cwd", p.ws, "--json");
  assert.equal(cmp.status, 0, cmp.stderr);
  const doc = JSON.parse(cmp.stdout);
  assert.deepEqual([doc.comparison.new, doc.comparison.kept, doc.comparison.resolved.length, doc.comparison.matchedBy], [1, 2, 1, "anchor"]);

  // The SARIF has the fingerprint v1 only: no anchor anywhere.
  const sarifRun = p.cli("report", second.runId, "--cwd", p.ws, "--format", "sarif");
  assert.equal(sarifRun.status, 0, sarifRun.stderr);
  assert.ok(!sarifRun.stdout.includes("jga1"), "the anchor is never exported");
  const sarif = JSON.parse(sarifRun.stdout);
  const sarifResults = sarif.runs[0].results;
  assert.equal(sarifResults.length, 3);
  for (const r of sarifResults) {
    assert.deepEqual(Object.keys(r.partialFingerprints), ["jgates/v1"]);
    assert.match(r.partialFingerprints["jgates/v1"], /^jgf1:/);
  }
  assert.deepEqual(sarifResults.map((r) => r.properties.baselineState), ["unchanged", "unchanged", "new"]);

  assert.equal(sha(stored), before, "the stored baseline is byte-identical");
});

test("V2-95: a baseline stored without anchors gives the fingerprint numbers", async () => {
  const p = await project();
  p.write(BEFORE);
  const first = await p.run();
  // Store it the way a run made before the anchor existed did: no anchor on any finding.
  const stored = path.join(first.runDir, "result.json");
  const doc = JSON.parse(fs.readFileSync(stored, "utf8"));
  for (const f of doc.findings) delete f.anchor;
  fs.writeFileSync(stored, `${JSON.stringify(doc, null, 2)}\n`);
  p.setBaseline(first);
  const before = sha(stored);

  p.write(AFTER);
  const second = await p.run();
  // By the fingerprint v1 the positions are the same as before: nothing new and nothing resolved, as today.
  assert.equal(second.baseline.matchedBy, "fingerprint");
  assert.equal(second.baseline.new, 0);
  assert.equal(second.baseline.kept, 3);
  assert.deepEqual(second.baseline.resolved, []);
  assert.deepEqual(second.findings.map((f) => f.baselineState), ["unchanged", "unchanged", "unchanged"]);
  assert.equal(sha(stored), before, "the stored baseline is byte-identical");
});
