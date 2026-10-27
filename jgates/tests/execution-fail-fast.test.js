import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// `execution.failFast` of jgates.yml (Configuração > Execução) is read by the run engine, so the screen's setting has
// an effect: with it, `jgates run` behaves as if --fail-fast had been passed; the flag still works without it.

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(here, "..", "dist", "cli", "main.js");
const FAKE = path.join(here, "fixtures", "executables", "fake-tool.cjs");
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function project(failFastLine) {
  const dir = tmp("jgates-ff-ws-");
  const home = tmp("jgates-ff-home-");
  const bin = tmp("jgates-ff-bin-");
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
  let tools = "schemaVersion: 1\ntools:\n";
  for (const [id, mode] of [["lint-a", "malformed"], ["lint-b", "clean"]]) {
    fs.writeFileSync(path.join(dir, `${id}.toml`), `# fake-mode: ${mode}\n`);
    tools += `  ${id}:\n    adapter: ruff\n    capabilities: [lint]\n    config: ${id}.toml\n`;
  }
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), tools);
  if (failFastLine) fs.appendFileSync(path.join(dir, "jgates.yml"), `execution:\n  ${failFastLine}\n`);
  const run = (...more) => cli(["run", "--cwd", dir, "--only", "tool:lint-a", "--only", "tool:lint-b", "--no-interactive", "--json", ...more]);
  return { run, cleanup: () => [dir, home, bin].forEach((d) => fs.rmSync(d, { recursive: true, force: true })) };
}

const stage = (doc, id) => doc.stages.find((s) => s.id === id);

test("execution.failFast: true in jgates.yml stops the run at the first failed stage, like --fail-fast", () => {
  const p = project("failFast: true");
  try {
    const result = p.run();
    assert.ok(result.doc, result.out + result.err);
    assert.equal(stage(result.doc, "lint-a#lint").state, "error");
    const b = stage(result.doc, "lint-b#lint");
    assert.equal(b.state, "blocked");
    assert.equal(b.execution.notRun.cause, "fail-fast");
    assert.equal(result.doc.stopped.cause, "fail-fast");
    assert.equal(result.doc.selection.options.failFast, true);
  } finally {
    p.cleanup();
  }
});

test("without execution.failFast the independent stage still runs, and failFast: false stays off", () => {
  for (const line of [null, "failFast: false"]) {
    const p = project(line);
    try {
      const result = p.run();
      assert.ok(result.doc, result.out + result.err);
      assert.equal(stage(result.doc, "lint-a#lint").state, "error");
      assert.equal(stage(result.doc, "lint-b#lint").state, "completed", String(line));
      assert.equal(result.doc.stopped, undefined);
    } finally {
      p.cleanup();
    }
  }
});

test("--fail-fast still works when jgates.yml does not ask for it", () => {
  const p = project(null);
  try {
    const result = p.run("--fail-fast");
    assert.equal(stage(result.doc, "lint-b#lint").execution.notRun.cause, "fail-fast");
  } finally {
    p.cleanup();
  }
});
