import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// A run that ends with a tool missing (container-first, ADR-0004): the tool comes from the JGates tools image, so the
// run never offers to install it on the host. On a terminal it lists what is missing with the image as the way to get
// it and asks nothing to install; with --json, --ci or without a terminal it asks nothing, the exit code is the same as
// before and the message points to `jgates doctor`. JGates runs in in-image mode here with an image.json that lacks
// Ruff (tests/setup/image-json.mjs); nothing touches the network.

process.env.JGATES_LOCALE = "en";
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const install = await import(pathToFileURL(path.join(dist, "core", "install", "index.js")).href);
const runModule = await import(pathToFileURL(path.join(dist, "cli", "commands", "run.js")).href);
const { imageJsonWithout } = await import(pathToFileURL(path.join(here, "setup", "image-json.mjs")).href);

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function project() {
  const dir = tmp("jgates-rio-ws-");
  const home = path.join(tmp("jgates-rio-home-"), "data");
  const bin = tmp("jgates-rio-bin-");
  fs.mkdirSync(path.join(dir, "demo"));
  fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(dir, "demo", "mod.py"), "import os\n");
  const env = { ...process.env, JGATES_HOME: home, PATH: bin, JGATES_LOCALE: "en", JGATES_IMAGE_JSON: imageJsonWithout("ruff") };
  for (const name of ["JGATES_PYTHON", "JGATES_RUFF", "JGATES_SEMGREP", "PIP_INDEX_URL"]) delete env[name];
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input: "", timeout: 120_000 });
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
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  ruff:\n    adapter: ruff\n    config: pyproject.toml\n");
  return { dir, home, bin, env, cli, cleanup: () => [dir, path.dirname(home), bin].forEach((d) => fs.rmSync(d, { recursive: true, force: true })) };
}

/** Runs the command in this process with a simulated terminal and a recording executor. */
async function interactiveRun(p, answers) {
  const input = new PassThrough();
  const output = new PassThrough();
  let asked = "";
  output.on("data", (c) => (asked += c.toString()));
  input.end(answers);
  const terminal = install.lineTerminal(input, output, true);
  const calls = [];
  runModule.installHooks.terminal = terminal;
  runModule.installHooks.env = p.env;
  runModule.installHooks.executor = {
    run(argv) {
      calls.push(argv);
      return { status: 0 };
    },
    async prepare() {},
  };
  const saved = { ...process.env };
  Object.assign(process.env, p.env);
  let out = "";
  let err = "";
  const ctx = {
    args: [],
    options: { cwd: p.dir, only: "tool:ruff" },
    lists: { only: ["tool:ruff"] },
    json: false,
    version: "0.0.0-test",
    commands: [],
    t: (k) => k,
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
  };
  try {
    const code = await runModule.command.run(ctx);
    return { code, out, err, asked, calls };
  } finally {
    terminal.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    delete runModule.installHooks.terminal;
    delete runModule.installHooks.env;
    delete runModule.installHooks.executor;
  }
}

test("a run blocked by a tool the tools image lacks lists it with the image's cause and asks nothing to install", async () => {
  const p = project();
  try {
    const r = await interactiveRun(p, "y\ny\n");
    assert.doesNotMatch(r.asked, /Install the essential items now/);
    assert.doesNotMatch(r.asked, /Run again now/);
    assert.equal(r.calls.length, 0, "nothing ran through the executor: " + JSON.stringify(r.calls));
    assert.equal(r.out.match(/Decision: /g).length, 1, "the run happened once:\n" + r.out);
    assert.equal(r.code, 2);
  } finally {
    p.cleanup();
  }
});

test("with --json, --ci and without a terminal nothing is asked, the exit code is the one of today and the message cites jgates doctor; the stage names the image", () => {
  const p = project();
  try {
    for (const extra of [["--json"], ["--ci", "--json"], ["--no-interactive"], []]) {
      const r = p.cli(["run", "--cwd", p.dir, "--only", "tool:ruff", ...extra]);
      assert.equal(r.code, 2, extra.join(" ") + "\n" + r.out + r.err);
      assert.doesNotMatch(r.out + r.err, /\[y\/N\]/);
      assert.match(r.err, /jgates doctor/, extra.join(" "));
      assert.doesNotMatch(r.err, /doctor --fix|pip install/, extra.join(" "));
      assert.equal(fs.existsSync(path.join(p.home, "tools", "python")), false, "nothing was installed");
    }
    const json = p.cli(["run", "--cwd", p.dir, "--only", "tool:ruff", "--json"]);
    const stage = json.doc.stages.find((s) => s.id === "ruff#lint");
    assert.equal(stage.state, "blocked");
    assert.match(stage.reason, /jgates setup/);
  } finally {
    p.cleanup();
  }
});
