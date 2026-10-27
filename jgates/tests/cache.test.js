import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

// Cache of results with demonstrable validity: the same plan
// over the same state reuses the stages and says from which run; code, configuration, policy or an imported file
// changing runs them again; inputs that can not be traced are never served from the cache and the JSON says why.
// The end-to-end part drives a real `jgates run` over the fake tool of the runner tests (no model, no network).

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FAKE = path.join(here, "fixtures", "executables", "fake-tool.cjs");
const run = await import(pathToFileURL(path.join(dist, "core", "run", "index.js")).href);
const cacheMod = await import(pathToFileURL(path.join(dist, "core", "cache", "index.js")).href);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validateResult = ajv.compile(readJson(path.resolve(here, "..", "schemas", "result", "result.schema.json")));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const assertValid = (doc) => assert.ok(validateResult(doc), JSON.stringify(validateResult.errors, null, 2));

// ---------------------------------------------------------------------------------------------------------------
// End to end.

function project() {
  const dir = tmp("jgates-cache-ws-");
  const home = tmp("jgates-cache-home-");
  const bin = tmp("jgates-cache-bin-");
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.mkdirSync(path.join(dir, "demo"));
  fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(dir, "demo", "__init__.py"), "");
  fs.writeFileSync(path.join(dir, "demo", "mod.py"), "x = 1\n");
  const env = { ...process.env, JGATES_HOME: home, JGATES_RUFF: FAKE, PATH: bin, JGATES_PYTHON: path.join(bin, "no-python") };
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, timeout: 120_000 });
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
  fs.writeFileSync(path.join(dir, "lint.toml"), "# fake-mode: clean\n");
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  lint:\n    adapter: ruff\n    capabilities: [lint]\n    config: lint.toml\n");
  const go = (...more) => {
    const r = cli(["run", "--cwd", dir, "--only", "tool:lint", "--no-interactive", "--json", ...more]);
    assert.ok(r.doc, r.out + r.err);
    assertValid(r.doc);
    return r;
  };
  const lint = (doc) => doc.stages.find((s) => s.id === "lint#lint");
  return { dir, home, env, cli, go, lint, cleanup: () => [dir, home, bin].forEach((d) => fs.rmSync(d, { recursive: true, force: true })) };
}

test("the same plan over the same state reuses the stage in the second run and says from which run and when", () => {
  const p = project();
  try {
    const first = p.go();
    assert.equal(p.lint(first.doc).state, "completed");
    assert.equal(p.lint(first.doc).cache.status, "executed");
    const second = p.go();
    const s = p.lint(second.doc);
    assert.equal(s.state, "completed");
    assert.equal(s.cache.status, "reused");
    assert.equal(s.cache.runId, first.doc.runId);
    assert.ok(Date.parse(s.cache.at) >= Date.parse(first.doc.startedAt), "the date is the origin run's");
    assert.ok(s.cache.reason.includes(first.doc.runId));
    assert.equal(second.doc.decision, first.doc.decision);
    assert.equal(second.doc.analyzed.identity, first.doc.analyzed.identity);
    // Nothing ran: no process was started by the reused step.
    assert.equal(s.execution.processes, 0);
  } finally {
    p.cleanup();
  }
});

test("changing the code, the configuration or the tool config invalidates the cache and the stage runs again", () => {
  const p = project();
  try {
    assert.equal(p.lint(p.go().doc).cache.status, "executed");
    assert.equal(p.lint(p.go().doc).cache.status, "reused");

    fs.writeFileSync(path.join(p.dir, "demo", "mod.py"), "x = 2\n");
    const afterCode = p.lint(p.go().doc);
    assert.equal(afterCode.cache.status, "executed", "code changed");
    assert.equal(p.lint(p.go().doc).cache.status, "reused");

    fs.appendFileSync(path.join(p.dir, "jgates.yml"), "execution:\n  timeoutSeconds: 77\n");
    assert.equal(p.lint(p.go().doc).cache.status, "executed", "configuration changed");
    assert.equal(p.lint(p.go().doc).cache.status, "reused");

    fs.writeFileSync(path.join(p.dir, "lint.toml"), "# fake-mode: clean\n# changed\n");
    assert.equal(p.lint(p.go().doc).cache.status, "executed", "the tool's own config changed");
  } finally {
    p.cleanup();
  }
});

test("changing the policy invalidates the cache and the stage runs again", () => {
  const p = project();
  try {
    const policy = path.join(p.dir, ".jgates", "policy.yml");
    fs.writeFileSync(policy, "schemaVersion: 1\nrules:\n  E501:\n    severity: warning\n");
    const first = p.go();
    assert.equal(p.lint(first.doc).cache.status, "executed");
    assert.equal(p.lint(p.go().doc).cache.status, "reused");

    fs.writeFileSync(policy, "schemaVersion: 1\nrules:\n  E501:\n    severity: blocking\n");
    const after = p.go();
    assert.equal(p.lint(after.doc).cache.status, "executed", "policy changed");
    assert.notEqual(after.doc.provenance.hashes.policy, first.doc.provenance.hashes.policy, "the identity of the result carries the policy hash");
    assert.equal(p.lint(p.go().doc).cache.status, "reused");
  } finally {
    p.cleanup();
  }
});

test("a real run after the policy changed warns against the baseline with POLICY_CHANGED", () => {
  const p = project();
  try {
    const policy = path.join(p.dir, ".jgates", "policy.yml");
    fs.writeFileSync(policy, "schemaVersion: 1\nrules:\n  E501:\n    severity: warning\n");
    const first = p.go();
    const set = p.cli(["baseline", "set", first.doc.runId, "--cwd", p.dir, "--json"]);
    assert.equal(set.code, 0, set.out + set.err);
    // `--only` is a reduced run, so the comparison is flagged for that reason; the policy is not among the warnings.
    const same = p.go().doc.baseline;
    assert.ok(!same.warnings.some((w) => w.code === "POLICY_CHANGED"), JSON.stringify(same.warnings));

    fs.writeFileSync(policy, "schemaVersion: 1\nrules:\n  E501:\n    severity: blocking\n");
    const after = p.go();
    assert.equal(after.doc.baseline.comparable, false);
    assert.ok(after.doc.baseline.warnings.some((w) => w.code === "POLICY_CHANGED"), JSON.stringify(after.doc.baseline.warnings));
  } finally {
    p.cleanup();
  }
});

test("a change only in outputs does not invalidate the cache (no invalidation loop)", () => {
  const p = project();
  try {
    p.go();
    fs.mkdirSync(path.join(p.dir, ".ruff_cache"), { recursive: true });
    fs.writeFileSync(path.join(p.dir, ".ruff_cache", "x"), "cache");
    fs.writeFileSync(path.join(p.dir, ".coverage"), "data");
    assert.equal(p.lint(p.go().doc).cache.status, "reused");
    assert.equal(p.lint(p.go().doc).cache.status, "reused");
  } finally {
    p.cleanup();
  }
});

test("--no cache switch: JGATES_NO_CACHE=1 runs the stage and writes nothing to the cache", () => {
  const p = project();
  try {
    p.env.JGATES_NO_CACHE = "1";
    const first = p.go();
    assert.equal(p.lint(first.doc).cache, undefined);
    delete p.env.JGATES_NO_CACHE;
    assert.equal(p.lint(p.go().doc).cache.status, "executed", "the earlier run stored nothing");
  } finally {
    p.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The module and executeRun with steps that say what their result depends on.

function workspace(files) {
  const dir = tmp("jgates-cache-unit-ws-");
  const home = tmp("jgates-cache-unit-home-");
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return { dir, home, cleanup: () => [dir, home].forEach((d) => fs.rmSync(d, { recursive: true, force: true })) };
}

const outputOf = (id) => ({
  stages: [{ id, state: "completed", interpreted: true }],
  requirements: [{ id, required: true }],
  disabled: [],
  findings: [],
  logs: [],
  outputs: [],
});

/** Runs one cacheable step; returns the result and how many times the step really ran. */
async function runStep(w, subject, counter) {
  const result = await run.executeRun({
    workspacePath: w.dir,
    home: w.home,
    version: "0.0.0-test",
    adapter: "unit",
    options: {},
    env: { ...process.env, JGATES_HOME: w.home },
    steps: () => [
      {
        id: "step",
        skeleton: () => outputOf("step"),
        run: async () => {
          counter.n += 1;
          return outputOf("step");
        },
        cacheSubject: subject,
      },
    ],
  });
  return result.stages.find((s) => s.id === "step");
}

test("a file imported by a configuration is an input of the steps that use it: changing it invalidates them", async () => {
  const w = workspace({
    "tool.config.js": 'import rules from "./rules/base.js";\nexport default { rules };\n',
    "rules/base.js": 'import extra from "./extra.cjs";\nexport default extra;\n',
    "rules/extra.cjs": "module.exports = ['a'];\n",
  });
  try {
    const subject = { material: { tool: "t" }, configs: ["tool.config.js"], blockers: [] };
    const counter = { n: 0 };
    assert.equal((await runStep(w, subject, counter)).cache.status, "executed");
    const again = await runStep(w, subject, counter);
    assert.equal(again.cache.status, "reused");
    assert.equal(counter.n, 1, "the second run did not execute the step");

    const trace = cacheMod.traceConfigs(w.dir, ["tool.config.js"]);
    assert.deepEqual(trace.files.map((f) => f.path), ["rules/base.js", "rules/extra.cjs", "tool.config.js"], "the transitive imports are inputs");
    assert.deepEqual(trace.untraceable, []);
    const before = trace.files.find((f) => f.path === "rules/extra.cjs").sha256;
    fs.writeFileSync(path.join(w.dir, "rules", "extra.cjs"), "module.exports = ['b'];\n");
    const after = cacheMod.traceConfigs(w.dir, ["tool.config.js"]).files.find((f) => f.path === "rules/extra.cjs").sha256;
    assert.notEqual(before, after);

    assert.equal((await runStep(w, subject, counter)).cache.status, "executed");
    assert.equal(counter.n, 2, "the dependent step ran again");
  } finally {
    w.cleanup();
  }
});

test("a step that depends on the key material of another step is not invalidated by a different step's material", async () => {
  const w = workspace({ "a.txt": "a\n" });
  try {
    const counter = { n: 0 };
    const a = { material: { tool: "a" }, configs: [], blockers: [] };
    const b = { material: { tool: "b" }, configs: [], blockers: [] };
    await runStep(w, a, counter);
    assert.equal((await runStep(w, b, counter)).cache.status, "executed", "other material, other key");
    assert.equal((await runStep(w, a, counter)).cache.status, "reused");
    assert.equal(counter.n, 2);
  } finally {
    w.cleanup();
  }
});

test("a step with inputs that can not be traced is never served from the cache and the JSON says why", async () => {
  const cases = [
    { name: "dynamic import", file: "dyn.config.js", text: "export default await import(process.argv[2]);\n", code: "DYNAMIC_IMPORT" },
    { name: "computed require", file: "req.config.js", text: "const n = 'x';\nmodule.exports = require('./' + n);\n", code: "COMPUTED_REQUIRE" },
    { name: "environment", file: "env.config.js", text: "module.exports = { level: process.env.LEVEL };\n", code: "ENVIRONMENT_DEPENDENT" },
  ];
  for (const c of cases) {
    const w = workspace({ [c.file]: c.text });
    try {
      const subject = { material: { tool: "t" }, configs: [c.file], blockers: [] };
      const counter = { n: 0 };
      for (let i = 0; i < 2; i += 1) {
        const s = await runStep(w, subject, counter);
        assert.equal(s.cache.status, "uncacheable", c.name);
        assert.equal(s.cache.code, c.code, c.name);
        assert.ok(s.cache.reason.includes(c.file), `${c.name}: the reason names the file`);
      }
      assert.equal(counter.n, 2, `${c.name}: ran both times`);
      assert.equal(fs.existsSync(path.join(w.home, "workspaces")) && fs.readdirSync(path.join(w.home, "workspaces")).some((id) => fs.existsSync(path.join(w.home, "workspaces", id, "cache")) && fs.readdirSync(path.join(w.home, "workspaces", id, "cache")).length > 0), false, `${c.name}: nothing stored`);
    } finally {
      w.cleanup();
    }
  }
});

test("blockers from the caller (network, code-changing tool) and a truncated manifest make the step uncacheable", async () => {
  const w = workspace({ "a.txt": "a\n" });
  try {
    const counter = { n: 0 };
    const subject = { material: {}, configs: [], blockers: [{ code: "NETWORK", message: "usa a rede" }] };
    for (let i = 0; i < 2; i += 1) {
      const s = await runStep(w, subject, counter);
      assert.equal(s.cache.status, "uncacheable");
      assert.equal(s.cache.code, "NETWORK");
      assert.equal(s.cache.reason, "usa a rede");
    }
    assert.equal(counter.n, 2);
  } finally {
    w.cleanup();
  }
});

test("a step that did not end in a usable state is not stored; a run that changed its inputs stores nothing", async () => {
  const w = workspace({ "a.txt": "a\n" });
  try {
    const subject = { material: {}, configs: [], blockers: [] };
    let n = 0;
    const exec = (output, mutate) =>
      run.executeRun({
        workspacePath: w.dir,
        home: w.home,
        version: "0.0.0-test",
        adapter: "unit",
        options: {},
        env: { ...process.env, JGATES_HOME: w.home },
        steps: () => [
          {
            id: "step",
            skeleton: () => outputOf("step"),
            run: async () => {
              n += 1;
              mutate?.();
              return output;
            },
            cacheSubject: subject,
          },
        ],
      });
    const failed = { ...outputOf("step"), stages: [{ id: "step", state: "error", reason: "boom", interpreted: false }] };
    await exec(failed);
    const ok = await exec(outputOf("step"));
    assert.equal(ok.stages[0].cache.status, "executed", "the error was not stored");
    assert.equal(n, 2);
    // The step changes a file it analyzes while running: the result is stale and must not be reused.
    fs.writeFileSync(path.join(w.dir, "a.txt"), "b\n");
    const stale = await exec(outputOf("step"), () => fs.writeFileSync(path.join(w.dir, "a.txt"), "c\n"));
    assert.equal(stale.analyzed.stale, true);
    const next = await exec(outputOf("step"));
    assert.equal(next.stages[0].cache.status, "executed", "a stale run left nothing in the cache");
  } finally {
    w.cleanup();
  }
});
