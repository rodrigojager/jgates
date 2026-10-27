import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Ruff adapter: the file chosen in the binding reaches the scanner, the findings are normalized,
// and a change made through `tools config write` changes the plan hash and the result.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const HAS_RUFF = fs.existsSync(path.join(VENV_BIN, process.platform === "win32" ? "ruff.exe" : "ruff"));
const runner = await import(pathToFileURL(path.join(dist, "core", "runner", "index.js")).href);
const ruffAdapter = await import(pathToFileURL(path.join(dist, "adapters", "ruff", "index.js")).href);
const catalog = await import(pathToFileURL(path.join(dist, "core", "catalog", "index.js")).href);

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const PYPROJECT = `[project]
name = "demo"
version = "0.1.0"

[tool.pytest.ini_options]
addopts = "-q"

[tool.ruff.lint]
select = ["E", "F"]
`;
// One violation per rule: F401 (unused import) and E711 (comparison to None).
const MODULE = "import os\n\n\ndef check(value):\n    return value == None\n";

function listTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

function project(extraEnv = {}) {
  assert.ok(HAS_RUFF, "ruff is not installed in the repository .venv: run `npm --prefix jgates run setup:dev-tools`");
  const dir = tmp("jgates-ruff-ws-");
  const home = tmp("jgates-ruff-home-");
  const emptyBin = tmp("jgates-ruff-bin-");
  fs.mkdirSync(path.join(dir, "demo"));
  fs.writeFileSync(path.join(dir, "pyproject.toml"), PYPROJECT);
  fs.writeFileSync(path.join(dir, "demo", "__init__.py"), "");
  fs.writeFileSync(path.join(dir, "demo", "mod.py"), MODULE);
  const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON, PATH: emptyBin, ...extraEnv };
  const cli = (args, input) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input: input ?? "", timeout: 120_000 });
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
  // The binding: the instance reads its configuration from the pyproject.toml the editor will write.
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  ruff:\n    adapter: ruff\n    config: pyproject.toml\n");
  const plan = (...more) => cli(["plan", "--cwd", dir, "--only", "tool:ruff", "--json", ...more]);
  const run = () => cli(["run", "--cwd", dir, "--only", "tool:ruff", "--no-interactive", "--json"]);
  const cleanup = () => {
    for (const d of [dir, home, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
  };
  return { dir, home, cli, plan, run, cleanup };
}

const ruffFindings = (result) => result.findings.filter((f) => f.tool === "ruff");

test("a known violation comes back as a finding with rule, file, line and the Ruff version; the plan shows the effective command [proves: ruff#lint]", () => {
  const p = project();
  try {
    const before = listTree(p.dir);
    const planned = p.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = planned.doc.plan.groups.willRun.find((i) => i.id === "ruff#lint");
    assert.ok(item, "ruff#lint will run");
    assert.equal(item.adapter, "ruff");
    assert.match(item.versions.toolVersion, /^\d+\.\d+\.\d+/);
    // Rendered command: executable + args, with the chosen configuration file.
    assert.ok(path.isAbsolute(item.command.executable));
    const at = item.command.args.indexOf("--config");
    assert.ok(at >= 0, JSON.stringify(item.command.args));
    assert.equal(item.command.args[at + 1], "{workspace}/pyproject.toml");
    assert.ok(item.command.args.includes("--no-fix"));
    assert.equal(item.command.args[item.command.args.indexOf("--output-format") + 1], "json");
    assert.equal(item.command.args[item.command.args.indexOf("--cache-dir") + 1], "{runDir}/cache/ruff");
    assert.ok(item.configFiles.some((f) => f.file === "pyproject.toml" && /^sha256:/.test(f.sha256)));
    assert.ok(planned.doc.plan.invocations.some((i) => i.adapter === "ruff" && i.command.executable === item.command.executable));

    const ran = p.run();
    assert.equal(ran.code, 1, ran.out + ran.err);
    const result = ran.doc;
    assert.equal(result.decision, "failed");
    const stage = result.stages.find((s) => s.id === "ruff#lint");
    assert.equal(stage.state, "completed");
    const found = ruffFindings(result);
    assert.deepEqual(found.map((f) => f.ruleId).sort(), ["E711", "F401"]);
    const f401 = found.find((f) => f.ruleId === "F401");
    assert.equal(f401.location.path, "demo/mod.py");
    assert.equal(f401.location.line, 1);
    assert.equal(f401.toolVersion, item.versions.toolVersion);
    assert.equal(f401.blocking, true);
    assert.equal(found.find((f) => f.ruleId === "E711").location.line, 5);

    // Nothing is left in the workspace: no .ruff_cache, no output file.
    assert.deepEqual(listTree(p.dir), before);
    assert.equal(fs.existsSync(path.join(p.dir, ".ruff_cache")), false);
    assert.deepEqual(result.workspaceChanges.added, []);
    assert.ok(fs.existsSync(path.join(result.runDir, "cache", "ruff")), "the cache lives in the run folder");
    assert.ok(fs.existsSync(path.join(result.runDir, "outputs", "ruff", "ruff", "ruff.json")));
  } finally {
    p.cleanup();
  }
});

test("ignoring a rule through tools config write changes the plan hash and the result, and leaves the other rule alone", () => {
  const p = project();
  try {
    const first = p.plan().doc.plan;
    const firstRun = p.run().doc;
    const e711Before = ruffFindings(firstRun).find((f) => f.ruleId === "E711");
    assert.ok(e711Before);

    const read = p.cli(["tools", "config", "read", "ruff", "--file", "config", "--cwd", p.dir, "--json"]);
    assert.equal(read.code, 0, read.out + read.err);
    const document = read.doc.document;
    const edited = document.text.replace('select = ["E", "F"]', 'select = ["E", "F"]\nignore = ["F401"]');
    assert.notEqual(edited, document.text);
    const write = p.cli(["tools", "config", "write", "ruff", "--file", "config", "--if-match", document.revision, "--no-interactive", "--cwd", p.dir, "--json"], edited);
    assert.equal(write.code, 0, write.out + write.err);

    const second = p.plan().doc.plan;
    assert.notEqual(second.planHash, first.planHash, "the configuration file is an input of the plan");
    const sha = (plan) => plan.groups.willRun.find((i) => i.id === "ruff#lint").configFiles.find((f) => f.file === "pyproject.toml").sha256;
    assert.notEqual(sha(second), sha(first));
    // The rest of the command is unchanged: only the content of the chosen file moved.
    assert.deepEqual(second.groups.willRun.find((i) => i.id === "ruff#lint").command.args, first.groups.willRun.find((i) => i.id === "ruff#lint").command.args);

    const secondRun = p.run().doc;
    const found = ruffFindings(secondRun);
    assert.deepEqual(found.map((f) => f.ruleId), ["E711"], "F401 is ignored, E711 still reported");
    assert.equal(found[0].fingerprint, e711Before.fingerprint, "the unrelated rule is reported exactly as before");
    assert.equal(found[0].location.line, e711Before.location.line);
    assert.equal(secondRun.decision, "failed");
  } finally {
    p.cleanup();
  }
});

test("without a binding Ruff's own resolution picks the configuration file; ruff.toml wins over pyproject.toml", () => {
  const p = project();
  try {
    fs.writeFileSync(path.join(p.dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools: {}\n");
    const native = p.plan().doc.plan.groups.willRun.find((i) => i.id === "ruff#lint");
    assert.equal(native.command.args[native.command.args.indexOf("--config") + 1], "{workspace}/pyproject.toml");
    fs.writeFileSync(path.join(p.dir, "ruff.toml"), '[lint]\nselect = ["E"]\n');
    const next = p.plan().doc.plan.groups.willRun.find((i) => i.id === "ruff#lint");
    assert.ok(next.configFiles.some((f) => f.file === "ruff.toml"));
    assert.equal(next.command.args[next.command.args.indexOf("--config") + 1], "{workspace}/ruff.toml");
    const found = ruffFindings(p.run().doc);
    assert.deepEqual(found.map((f) => f.ruleId), ["E711"], "ruff.toml selects only E");
  } finally {
    p.cleanup();
  }
});

test("without Ruff installed the stage is blocked and the decision is incomplete, never passed; the message says how to install", () => {
  const p = project({ JGATES_PYTHON: path.join(os.tmpdir(), "jgates-no-such-venv", "bin", "python") });
  try {
    const planned = p.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const item = planned.doc.plan.groups.willRun.find((i) => i.id === "ruff#lint");
    assert.equal(item.availability.status, "unavailable");
    assert.match(item.availability.reason, /jgates doctor --fix/);
    assert.ok(planned.doc.plan.warnings.some((w) => w.code === "TOOL_UNAVAILABLE"));

    const ran = p.run();
    assert.equal(ran.code, 2, ran.out + ran.err);
    assert.equal(ran.doc.decision, "incomplete");
    assert.notEqual(ran.doc.decision, "passed");
    const stage = ran.doc.stages.find((s) => s.id === "ruff#lint");
    assert.equal(stage.state, "blocked");
    assert.match(stage.reason, /jgates doctor --fix/);
    assert.deepEqual(ruffFindings(ran.doc), []);
  } finally {
    p.cleanup();
  }
});

test("the manifest is valid for the catalog", () => {
  const result = catalog.validateManifest(ruffAdapter.ruffManifest);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("the runner executes without a shell, with an allowlisted environment, and reports failures", async () => {
  const dir = tmp("jgates-runner-");
  try {
    const parentEnv = { PATH: process.env.PATH, SECRET_TOKEN: "do-not-leak", HOME: "/home/x" };
    const ok = await runner.runSpec(
      { executable: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify({a: process.argv[1], t: process.env.SECRET_TOKEN ?? null, x: process.env.EXTRA, home: process.env.HOME}))", "$(echo hi); echo no"], cwd: dir, env: { EXTRA: "1" }, stdin: null },
      { parentEnv },
    );
    assert.equal(ok.exitCode, 0);
    assert.deepEqual(JSON.parse(ok.stdout), { a: "$(echo hi); echo no", t: null, x: "1", home: "/home/x" });

    const stdin = await runner.runSpec({ executable: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"], cwd: dir, stdin: "from stdin" });
    assert.equal(stdin.stdout, "from stdin");

    const missing = await runner.runSpec({ executable: path.join(dir, "nope"), args: [], cwd: dir });
    assert.equal(missing.exitCode, null);
    assert.equal(missing.spawnError?.code, "ENOENT");

    const slow = await runner.runSpec({ executable: process.execPath, args: ["-e", "setTimeout(() => {}, 30000)"], cwd: dir, timeoutMs: 200 });
    assert.equal(slow.timedOut, true);

    assert.equal(runner.substituteTokens("{runDir}/a/{workspace}", { runDir: "/r", workspace: "/w" }), "/r/a//w");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
