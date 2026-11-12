import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-63 (fake engine, in-image steps): mutation testing is not applicable when the project's own tests fail.
//   - with a failing baseline test run the mutation stage is `not_applicable` (never `error`), its text is the one of a
//     catalogued reason code (MUTATION_TESTS_FAILING: pt-BR and en text, and an action), the run is not an error run;
//   - with passing tests the stage runs as before (a measured score);
//   - the engines' own baseline failures (mutmut "stopping after 1 failures ... failed to collect stats", Stryker's
//     failed initial test run) are recognised, and an unrelated engine error is not taken for one;
//   - `jgates help` and `jgates run --help` no longer mention the bridge, in both languages.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "jgates", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FIXTURE = path.join(root, "jgates", "tests", "fixtures", "mutation", "js");
const mutation = await import(pathToFileURL(path.join(dist, "adapters", "mutation", "index.js")).href);
const reasons = await import(pathToFileURL(path.join(dist, "core", "reasons", "index.js")).href);

const made = [];
const tmp = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

// A stand-in for StrykerJS: it runs the project's tests first, like the real engine does, and either stops with the
// message of a failed initial test run or writes a report in which every mutant is killed.
const FAKE_STRYKER = `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--version")) { console.log("9.0.0"); process.exit(0); }
const tests = fs.readdirSync("test").filter((f) => f.endsWith(".test.js")).map((f) => path.join("test", f));
const r = spawnSync(process.execPath, ["--test", ...tests], { encoding: "utf8" });
if (r.status !== 0) {
  console.error("ERROR Stryker: there were failed tests in the initial test run.");
  process.exit(1);
}
const mutant = (id) => ({ id: String(id), mutatorName: "EqualityOperator", replacement: "a > b", status: "Killed", location: { start: { line: id, column: 1 }, end: { line: id, column: 4 } } });
fs.mkdirSync(path.join("reports", "mutation"), { recursive: true });
fs.writeFileSync(path.join("reports", "mutation", "mutation.json"), JSON.stringify({ schemaVersion: "1.0", files: { "src/age.js": { language: "javascript", mutants: [mutant(1), mutant(2), mutant(3)] } } }));
`;

function runIn({ red, locale }) {
  const dir = tmp("v2-63-project-");
  const home = tmp("v2-63-home-");
  const tools = tmp("v2-63-tools-");
  fs.cpSync(FIXTURE, dir, { recursive: true });
  if (red) fs.writeFileSync(path.join(dir, "test", "age.test.js"), `"use strict";\nconst test = require("node:test");\ntest("red on purpose", () => { throw new Error("broken"); });\n`);
  const stryker = path.join(tools, "stryker.cjs");
  fs.writeFileSync(stryker, FAKE_STRYKER);
  const env = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1", JGATES_LOCALE: locale, NO_COLOR: "1", JGATES_STRYKER: stryker };
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { cwd: dir, encoding: "utf8", env, input: "", timeout: 240_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  const init = cli(["init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  mutation:\n    adapter: mutation\n    engine: stryker\n    capabilities: [mutation]\n");
  return cli(["run", "--cwd", dir, "--only", "tool:mutation", "--no-interactive", "--json"]);
}

const stageOf = (doc) => doc.stages.find((s) => s.id === "mutation#mutation");
const metricOf = (doc) => (doc.metrics ?? []).find((m) => m.id === "mutation.score");

test("V2-63: the reason code is catalogued with pt-BR and en text and an action", () => {
  assert.equal(reasons.isReasonCode("MUTATION_TESTS_FAILING"), true);
  const en = reasons.resolveReason("MUTATION_TESTS_FAILING", {}, "en");
  const pt = reasons.resolveReason("MUTATION_TESTS_FAILING", {}, "pt-BR");
  assert.match(en.message, /own tests fail/);
  assert.match(pt.message, /testes do próprio projeto falham/);
  assert.notEqual(en.action.label, "");
  assert.notEqual(pt.action.label, "");
  assert.notEqual(en.action.label, pt.action.label);
});

test("V2-63: the engines' baseline failures are recognised and other errors are not", () => {
  const mutmutRed = "Running stats\n...stopping after 1 failures\nfailed to collect stats. runner returned 1\n";
  assert.equal(mutation.baselineTestsFailed("mutmut", mutmutRed), true);
  assert.equal(mutation.baselineTestsFailed("mutmut", "Traceback: ModuleNotFoundError: No module named 'x'"), false);
  assert.equal(mutation.baselineTestsFailed("stryker", "there were failed tests in the initial test run."), true);
  assert.equal(mutation.baselineTestsFailed("stryker", "Error: cannot find config"), false);
  assert.equal(mutation.baselineTestsFailed("stryker-net", "Initial test run failed"), true);
  assert.equal(mutation.baselineTestsFailed("stryker-net", "unrelated failure"), false);
});

for (const locale of ["en", "pt-BR"]) {
  test(`V2-63: failing tests make the mutation stage not applicable, not an error (${locale})`, () => {
    const ran = runIn({ red: true, locale });
    assert.ok(ran.doc, ran.out + ran.err);
    const stage = stageOf(ran.doc);
    assert.equal(stage.state, "not_applicable");
    const expected = reasons.resolveReason("MUTATION_TESTS_FAILING", {}, locale);
    assert.ok(stage.reason.startsWith(expected.message), stage.reason);
    assert.ok(stage.reason.includes(expected.action.label), stage.reason);
    assert.equal(metricOf(ran.doc).measured, false);
    assert.ok(!ran.doc.stages.some((s) => s.state === "error"), "no stage of the run is an error");
    assert.notEqual(ran.doc.decision, "error");
  });
}

test("V2-63: with passing tests the mutation stage runs as before", () => {
  const ran = runIn({ red: false, locale: "en" });
  assert.ok(ran.doc, ran.out + ran.err);
  assert.equal(stageOf(ran.doc).state, "completed");
  assert.notEqual(metricOf(ran.doc).measured, false);
  assert.equal(metricOf(ran.doc).value, 100);
});

for (const locale of ["en", "pt-BR"]) {
  test(`V2-63: help and run --help do not mention the bridge (${locale})`, () => {
    const env = { ...process.env, JGATES_LOCALE: locale, NO_COLOR: "1" };
    for (const args of [["help"], ["run", "--help"]]) {
      const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input: "", timeout: 60_000 });
      const text = r.stdout + r.stderr;
      assert.match(text, /\brun\b/);
      assert.doesNotMatch(text, /pela ponte|through the bridge|\bponte\b|\bbridge\b/i, `${args.join(" ")} (${locale})`);
    }
  });
}
