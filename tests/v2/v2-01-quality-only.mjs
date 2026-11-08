import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// V2-01: Quality only. A project with a semantic provider configured runs `jgates run` (no --semantic): exactly one
// run, a Quality one, and the provider is never invoked. The provider is a fake command that counts its calls.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const PYTHON = path.join(root, ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
const require = createRequire(import.meta.url);
const { createPiiFixture, removePiiFixture } = require(path.join(root, "tests", "fixtures", "jgates", "pii-fixture.js"));

test("V2-01: Quality-only run with a semantic provider configured makes one run and zero provider calls", () => {
  const fixture = createPiiFixture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "v2-01-home-"));
  const aux = fs.mkdtempSync(path.join(os.tmpdir(), "v2-01-aux-"));
  const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON, NO_COLOR: "1" };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input: "", timeout: 120_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  try {
    const calls = path.join(aux, "calls.log");
    const script = path.join(aux, "fake-provider.mjs");
    fs.writeFileSync(
      script,
      [
        `import fs from "node:fs";`,
        `for await (const c of process.stdin) {}`,
        `fs.appendFileSync(${JSON.stringify(calls)}, "CALL\\n");`,
        `process.stdout.write(JSON.stringify({ status: "APPROVED", score: 100, findings: [] }));`,
      ].join("\n"),
    );
    const init = cli("init", "--cwd", fixture.dir, "--profile", "minimal", "--no-interactive", "--json");
    assert.equal(init.code, 0, init.out + init.err);
    const configFile = path.join(fixture.dir, "jgates.yml");
    const block = ["extensions:", "  semantic-gate:", "    provider: command", `    command: ${JSON.stringify(process.execPath)}`, `    commandArgs: [${JSON.stringify(script)}]`, "    model: fake-model", ""].join("\n");
    fs.writeFileSync(configFile, `${fs.readFileSync(configFile, "utf8").replace(/\n*$/, "\n")}${block}`);
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: fixture.dir }).status, 0);

    // The semantic provider is ready: a Semantic run could start, but this is a Quality-only run.
    const plan = cli("semantic", "plan", "--cwd", fixture.dir, "--json");
    assert.equal(plan.doc.plan.ready, true, plan.out + plan.err);

    const r = cli("run", "--cwd", fixture.dir, "--no-interactive", "--json", "--only", "tool:builtin-pii");
    assert.ok(r.doc && typeof r.doc.runId === "string", r.out + r.err);
    assert.match(r.doc.runId, /^run_/);
    assert.notEqual(r.doc.gate, "semantic");
    assert.equal(r.doc.semantic, undefined, "no semantic block without --semantic");
    assert.equal(r.doc.semanticRun, undefined);
    assert.equal(fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0, 0, "the provider was never invoked");

    // Exactly one run: one Quality run in its history and no Semantic run at all.
    const history = cli("history", "--cwd", fixture.dir, "--json");
    assert.deepEqual(history.doc.runs.map((x) => x.runId), [r.doc.runId]);
    const semantic = cli("semantic", "history", "--cwd", fixture.dir, "--json");
    assert.equal(semantic.code, 0, semantic.out + semantic.err);
    assert.deepEqual(semantic.doc.runs, []);
    assert.equal(fs.existsSync(path.join(home, "workspaces", r.doc.workspace.id, "semantic-runs")), false);
  } finally {
    removePiiFixture(fixture.dir);
    for (const d of [home, aux]) fs.rmSync(d, { recursive: true, force: true });
  }
});
