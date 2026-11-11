import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Mutation adapter: a suite that misses a boundary bug leaves surviving mutants and the strengthened suite kills them,
// with the score as a metric (numerator, denominator) and the survivors as located findings. StrykerJS runs for real
// when it can be found (JGATES_STRYKER, or the repository node_modules); otherwise the end-to-end test asserts that the
// stage is blocked with the install guidance, never a favorable result. mutmut does not run natively on Windows: there
// the stage is asserted to be blocked with that reason; on Linux/macOS with mutmut in JGATES_PYTHON it runs for real.
// The mutmut parser is also proven on output captured from a real mutmut 3.8.1 run (Linux container).

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FIXTURES = path.join(here, "fixtures", "mutation");
const mutation = await import(pathToFileURL(path.join(dist, "adapters", "mutation", "index.js")).href);
const { imageJsonWithout } = await import(pathToFileURL(path.join(here, "setup", "image-json.mjs")).href);

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function findStryker() {
  if (process.env.JGATES_STRYKER && fs.existsSync(process.env.JGATES_STRYKER)) return process.env.JGATES_STRYKER;
  const entry = path.join(repo, "node_modules", "@stryker-mutator", "core", "bin", "stryker.js");
  return fs.existsSync(entry) ? entry : null;
}

function findMutmutPython() {
  if (process.platform === "win32") return null;
  const python = process.env.JGATES_PYTHON;
  if (!python) return null;
  const r = spawnSync(python, ["-c", "import mutmut, pytest"], { encoding: "utf8" });
  return r.status === 0 ? python : null;
}

function listTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** A project from the fixture: the weak suite, or the strengthened one laid over it. */
function project({ stack, strong, minimum, env: extraEnv = {} }) {
  const dir = tmp("jgates-mut-");
  const home = tmp("jgates-mut-home-");
  const emptyBin = tmp("jgates-mut-bin-");
  const source = stack === "js" ? "js" : "py";
  fs.cpSync(path.join(FIXTURES, source), dir, { recursive: true });
  if (strong) fs.cpSync(path.join(FIXTURES, `${source}-strong`), dir, { recursive: true });
  // The command runner of Stryker needs Node and the system shell tools (cmd, taskkill) on the PATH; nothing else.
  const system = process.platform === "win32" ? [path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")] : ["/usr/bin", "/bin"];
  const env = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", PATH: [path.dirname(process.execPath), ...system, emptyBin].join(path.delimiter), DOCKER_HOST: "tcp://127.0.0.1:1", ...extraEnv };
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, timeout: 600_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  // The minimal profile: --only turns the mutation instance on, and no other requirement (unit, coverage) is left uncovered.
  const init = cli(["init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  const settings = `    capabilities: [mutation]\n${minimum !== undefined ? `    minimumScore: ${minimum}\n` : ""}`;
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), `schemaVersion: 1\ntools:\n  mutation:\n    adapter: mutation\n    engine: ${stack === "js" ? "stryker" : "mutmut"}\n${settings}`);
  const run = () => cli(["run", "--cwd", dir, "--only", "tool:mutation", "--no-interactive", "--json"]);
  const plan = () => cli(["plan", "--cwd", dir, "--only", "tool:mutation", "--json"]);
  const cleanup = () => {
    for (const d of [dir, home, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
  };
  return { dir, run, plan, cleanup };
}

const metric = (result, id) => (result.metrics ?? []).find((m) => m.id === id);
const stage = (result) => result.stages.find((s) => s.id === "mutation#mutation");
const found = (result, rule) => result.findings.filter((f) => f.tool === "mutation" && f.ruleId === rule);

test("mutation javascript: the weak suite leaves surviving mutants and the strengthened suite kills them [proves: mutation#mutation, mutation#mutation@javascript]", () => {
  const stryker = findStryker();
  if (!stryker) {
    // No Stryker on this machine to stand for the image's: with an image that lacks it, the stage is blocked with the
    // image's cause, never a pass.
    const p = project({ stack: "js", strong: false, minimum: 90, env: { JGATES_IMAGE_JSON: imageJsonWithout("stryker") } });
    try {
      const ran = p.run();
      assert.notEqual(ran.code, 0, "an engine that is not installed is never a favorable result");
      assert.equal(stage(ran.doc).state, "blocked");
      assert.match(stage(ran.doc).reason, /StrykerJS.*JGates tools image/i);
      assert.equal(metric(ran.doc, "mutation.score").measured, false);
    } finally {
      p.cleanup();
    }
    return;
  }
  const env = { JGATES_STRYKER: stryker };
  const weak = project({ stack: "js", strong: false, minimum: 90, env });
  const strong = project({ stack: "js", strong: true, minimum: 90, env });
  try {
    const before = listTree(weak.dir);
    const planned = weak.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = planned.doc.plan.groups.willRun.find((i) => i.id === "mutation#mutation");
    assert.ok(item, JSON.stringify(planned.doc.plan.groups.willRun.map((i) => i.id)));
    assert.equal(item.adapter, "mutation");
    assert.equal(item.effects.executesProjectCode, true, "mutation testing declares that it executes project code");
    assert.ok(item.conditions.some((c) => /copy of the component inside the run folder/.test(c)), "the engine runs in a copy inside the run folder");
    assert.ok(item.command.args.includes("json"), "the JSON report is the evidence");

    const ranWeak = weak.run();
    const w = ranWeak.doc;
    assert.equal(ranWeak.code, 1, ranWeak.out + ranWeak.err);
    assert.equal(w.decision, "failed");
    assert.equal(stage(w).state, "completed");
    const weakScore = metric(w, "mutation.score");
    assert.equal(weakScore.unit, "percent");
    assert.equal(weakScore.origin, "mutation");
    assert.ok(Number.isInteger(weakScore.numerator) && Number.isInteger(weakScore.denominator) && weakScore.denominator > 0, JSON.stringify(weakScore));
    assert.equal(weakScore.value, Math.round((weakScore.numerator / weakScore.denominator) * 10000) / 100);
    assert.ok(weakScore.value < 90, `${weakScore.value}% is under the minimum`);
    const survivors = found(w, "mutation.survived");
    assert.ok(survivors.length >= 2, "the two boundary mutants (>= 18 -> > 18, > 100 -> >= 100) survive");
    assert.ok(survivors.every((f) => f.location.path === "src/age.js" && Number.isInteger(f.location.line) && f.blocking === false));
    assert.ok(survivors.some((f) => f.location.line === 5), "the age boundary is located");
    assert.ok(survivors.some((f) => f.location.line === 10), "the price boundary is located");
    const below = found(w, "mutation.score-below-minimum");
    assert.equal(below.length, 1);
    assert.equal(below[0].blocking, true);
    assert.equal(metric(w, "mutation.survived").value, survivors.length);

    // Nothing of the engine is left in the workspace; the report lives in the run folder.
    assert.deepEqual(listTree(weak.dir).filter((f) => !f.startsWith(".jgates/")), before.filter((f) => !f.startsWith(".jgates/")));
    assert.deepEqual(w.workspaceChanges.added, []);
    assert.ok(fs.existsSync(path.join(w.runDir, "outputs", "mutation", "mutation", "mutation.json")));

    const ranStrong = strong.run();
    const s = ranStrong.doc;
    assert.equal(ranStrong.code, 0, ranStrong.out + ranStrong.err);
    assert.equal(s.decision, "passed");
    const strongScore = metric(s, "mutation.score");
    assert.equal(strongScore.value, 100);
    assert.equal(strongScore.numerator, strongScore.denominator);
    assert.equal(found(s, "mutation.survived").length, 0);
    assert.equal(metric(s, "mutation.survived").value, 0);
    assert.ok(strongScore.denominator >= weakScore.denominator - 0, "the same code is mutated");
  } finally {
    weak.cleanup();
    strong.cleanup();
  }
});

test("mutation javascript: a red baseline suite has no score and is an error, never a pass", () => {
  const stryker = findStryker();
  if (!stryker) {
    assert.equal(findStryker(), null, "without Stryker the blocked case above is the evidence");
    return;
  }
  const p = project({ stack: "js", strong: false, minimum: 90, env: { JGATES_STRYKER: stryker } });
  try {
    fs.writeFileSync(path.join(p.dir, "test", "age.test.js"), `const test = require("node:test");\ntest("red", () => { throw new Error("broken"); });\n`);
    const ran = p.run();
    assert.notEqual(ran.code, 0);
    assert.equal(stage(ran.doc).state, "error");
    assert.match(stage(ran.doc).reason, /fail before any mutation/i);
    assert.equal(metric(ran.doc, "mutation.score").measured, false);
    assert.equal(metric(ran.doc, "mutation.score").value, undefined);
  } finally {
    p.cleanup();
  }
});

test("mutation python: the mutmut results are read from real output and the engine is blocked where it cannot run [proves: mutation#mutation, mutation#mutation@python]", () => {
  // Output captured from a real mutmut 3.8.1 run (jgates/quality-sidecar container, Linux) over the fixtures py and py-strong.
  const cap = (name) => fs.readFileSync(path.join(FIXTURES, "mutmut-captured", name), "utf8");
  const weak = mutation.parseMutmutOutput(cap("weak.stats.json"), cap("weak.results.txt"));
  assert.equal(weak.ok, true);
  assert.equal(weak.engine, "mutmut");
  assert.equal(weak.killed, 3);
  assert.equal(weak.survived, 4);
  assert.equal(weak.valid, 7);
  assert.equal(weak.score, 42.86);
  assert.equal(weak.survivors.length, 4);
  assert.deepEqual([...new Set(weak.survivors.map((s) => s.file))], ["pkg/age"]);
  assert.deepEqual([...new Set(weak.survivors.map((s) => s.replacement))].sort(), ["is_adult", "price"]);
  const strong = mutation.parseMutmutOutput(cap("strong.stats.json"), cap("strong.results.txt"));
  assert.equal(strong.score, 100);
  assert.equal(strong.survivors.length, 0);

  const python = findMutmutPython();
  // Without a Python that runs mutmut here (Windows), an image that lacks mutmut stands for the case it cannot run.
  const env = python ? { JGATES_PYTHON: python } : { JGATES_IMAGE_JSON: imageJsonWithout("mutmut") };
  const p = project({ stack: "py", strong: false, minimum: 90, env });
  const q = project({ stack: "py", strong: true, minimum: 90, env });
  try {
    const ranWeak = p.run();
    if (!python) {
      // mutmut cannot run here (Windows, or no mutmut in JGATES_PYTHON): blocked with the reason, no score, never a pass.
      assert.notEqual(ranWeak.code, 0);
      assert.equal(stage(ranWeak.doc).state, "blocked");
      assert.match(stage(ranWeak.doc).reason, /does not run natively on Windows|mutmut is not installed|no Python to run mutmut|mutmut is not in the JGates tools image/i);
      assert.equal(metric(ranWeak.doc, "mutation.score").measured, false);
      return;
    }
    assert.equal(ranWeak.code, 1, ranWeak.out + ranWeak.err);
    assert.ok(metric(ranWeak.doc, "mutation.score").value < 90);
    const survivors = found(ranWeak.doc, "mutation.survived");
    assert.ok(survivors.length >= 2);
    assert.ok(survivors.every((f) => f.location.path === "pkg/age.py"));
    const ranStrong = q.run();
    assert.equal(ranStrong.code, 0, ranStrong.out + ranStrong.err);
    assert.equal(metric(ranStrong.doc, "mutation.score").value, 100);
  } finally {
    p.cleanup();
    q.cleanup();
  }
});

test("parseStrykerReport counts detected, survived and uncovered mutants, leaves invalid ones out of the score and refuses documents it cannot read", () => {
  const mutant = (status, line, extra = {}) => ({ id: String(line), mutatorName: "EqualityOperator", replacement: "a > b", status, location: { start: { line, column: 3 }, end: { line, column: 9 } }, ...extra });
  const report = JSON.stringify({
    schemaVersion: "1.0",
    files: {
      "src\\a.js": { language: "javascript", mutants: [mutant("Killed", 1), mutant("Timeout", 2), mutant("Survived", 3), mutant("NoCoverage", 4), mutant("CompileError", 5), mutant("Ignored", 6)] },
      "src/b.js": { mutants: [mutant("Killed", 7)] },
    },
  });
  const r = mutation.parseStrykerReport(report);
  assert.equal(r.ok, true);
  assert.equal(r.detected, 3, "killed and timeout");
  assert.equal(r.survived, 1);
  assert.equal(r.notCovered, 1);
  assert.equal(r.excluded, 2, "compile errors and ignored mutants are outside the score");
  assert.equal(r.valid, 5);
  assert.equal(r.score, 60);
  assert.deepEqual(r.survivors.map((s) => [s.file, s.line, s.kind]), [["src/a.js", 3, "survived"], ["src/a.js", 4, "not-covered"]]);
  assert.equal(mutation.parseStrykerReport(JSON.stringify({ files: {} })).score, null, "no mutant is no score, never 100");
  assert.equal(mutation.parseStrykerReport("<html></html>").ok, false);
  assert.equal(mutation.parseStrykerReport(JSON.stringify({ files: { "a.js": { mutants: [{ id: "1" }] } } })).ok, false);
  assert.equal(mutation.parseMutmutOutput("not json", "").ok, false);
  assert.equal(mutation.parseMutmutOutput(JSON.stringify({ killed: 1 }), "").ok, false);
});

test("a mutation instance with an invalid setting is refused, and mutate cannot leave the component", () => {
  const p = project({ stack: "js", strong: false, minimum: 150, env: { JGATES_STRYKER: findStryker() ?? "stryker-not-here" } });
  try {
    const ran = p.run();
    assert.notEqual(ran.code, 0, ran.out + ran.err);
    assert.match(ran.out + ran.err, /minimumScore|schema|0 to 100|between/i);
  } finally {
    p.cleanup();
  }
  const settings = mutation.mutationSettings({ tool: "m", config: { tools: { m: { mutate: ["../outside/**"] } } } });
  assert.equal(settings.problems.length, 1);
  assert.deepEqual(mutation.mutationSettings({ tool: "m", config: { tools: { m: { engine: "stryker", mutate: ["src/**/*.js"], minimumScore: 70 } } } }), { engine: "stryker", mutate: ["src/**/*.js"], minimumScore: 70, component: null, timeoutSeconds: null, problems: [] });
});
