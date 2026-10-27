import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// `jgates doctor` classifies what is missing (essential, optional with its alternative, unused) from the project's
// tools.yml and offers the recipes that install it: Python packages into <JGATES_HOME>/tools/python, images and rules
// through `tools prepare`, Docker through the system's command after a confirmation. Every tool here is a fake (a
// Node script with a #! line): no network, no real pip, no real Docker, and nothing runs sudo.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const install = await import(pathToFileURL(path.join(dist, "core", "install", "index.js")).href);
const ruffProbe = await import(pathToFileURL(path.join(dist, "adapters", "ruff", "probe.js")).href);
const bridge = await import(pathToFileURL(path.join(dist, "core", "bridge", "index.js")).href);

const POSIX = process.platform !== "win32";
const NO_POSIX = "the fake tools are scripts with a #! line (POSIX only)";
const UBUNTU = { platform: "linux", osRelease: 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n' };
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const QUESTION = /\[[sy]\/N\]/;

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function script(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/**
 * A fake Python: as the system one it answers --version, creates a "virtual environment" (-m venv) holding a copy
 * of itself and lacks the sidecar's packages; inside that environment, `-m pip install` writes a fake ruff and a
 * fake semgrep for the requirements it gets and records the call in FAKE_PIP_LOG.
 */
const FAKE_PYTHON = String.raw`
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
const self = fs.realpathSync(__filename);
const inEnv = fs.existsSync(path.join(path.dirname(self), "..", "pyvenv.cfg"));
const log = (entry) => { if (process.env.FAKE_PIP_LOG) fs.appendFileSync(process.env.FAKE_PIP_LOG, JSON.stringify(entry) + "\n"); };
if (args[0] === "--version") { console.log("Python 3.12.1"); process.exit(0); }
if (args[0] === "-c") process.exit(inEnv && fs.existsSync(path.join(path.dirname(self), ".deps")) ? 0 : 1);
if (args[0] === "-m" && args[1] === "venv") {
  const dir = args[2];
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "pyvenv.cfg"), "home = fake\n");
  fs.copyFileSync(self, path.join(dir, "bin", "python"));
  fs.chmodSync(path.join(dir, "bin", "python"), 0o755);
  log({ step: "venv", dir, by: self });
  process.exit(0);
}
if (args[0] === "-m" && args[1] === "pip" && inEnv) {
  const bin = path.dirname(self);
  const reqs = args.slice(3).filter((a) => !a.startsWith("-"));
  const versions = { ruff: "0.6.9", semgrep: "1.120.0" };
  for (const req of reqs) {
    const name = req.split(/[<>=!~,]/)[0];
    if (versions[name]) {
      fs.writeFileSync(path.join(bin, name), "#!/bin/sh\necho \"" + name + " " + versions[name] + "\"\n");
      fs.chmodSync(path.join(bin, name), 0o755);
    }
    if (name === "defusedxml") fs.writeFileSync(path.join(bin, ".deps"), "");
  }
  log({ step: "pip", python: self, reqs, network: Boolean(process.env.FAKE_NETWORK) });
  process.exit(0);
}
process.exit(2);
`;

/** A fake docker: `info` answers a server version (or fails when the file "stopped" is next to it); images carry the ruff version label. */
const FAKE_DOCKER = String.raw`
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
if (args[0] === "info") { if (fs.existsSync(path.join(__dirname, "stopped"))) { console.error("Cannot connect to the Docker daemon"); process.exit(1); } console.log("27.1.0"); process.exit(0); }
if (args[0] === "image" && args[1] === "inspect" && args[2] === "--format") { console.log(JSON.stringify({ "org.jgates.tool.version": "0.17.2" })); process.exit(0); }
if (args[0] === "image" && args[1] === "inspect") { console.log(JSON.stringify([{ Id: "${IMAGE_ID}", RepoDigests: [], Config: { Labels: { "org.jgates.tool.version": "0.17.2" } } }])); process.exit(0); }
process.exit(1);
`;

const TOOLS = {
  ruffLocal: "  ruff:\n    adapter: ruff\n    capabilities: [lint]\n",
  ruffContainer: "  ruff:\n    adapter: ruff\n    capabilities: [lint]\n    runner: container\n",
  semgrep: "  semgrep:\n    adapter: semgrep\n    capabilities: [sast]\n",
  semgrepOff: "  semgrep:\n    adapter: semgrep\n    capabilities: [sast]\n    enabled: false\n",
  trivy: "  trivy:\n    adapter: trivy\n    capabilities: [sca]\n",
};

/** The ruff image pinned in .jgates/lock.json, as `tools prepare` writes it. */
const RUFF_LOCK = {
  schemaVersion: 1,
  tools: {
    ruff: { adapter: "ruff", adapterVersion: "0.1.0", toolVersion: "0.17.2", preparedAt: "2026-10-25T00:00:00Z", image: { reference: "jgates-dev/ruff:0.17.2", id: IMAGE_ID, pinned: IMAGE_ID, versionLabel: "org.jgates.tool.version" } },
  },
};

/** A project with its tools.yml, a data folder that does not exist yet and a bin folder with the fakes asked for. */
function project({ tools, python = true, docker = null, lock = null, extraEnv = {} }) {
  const dir = tmp("jgates-di-ws-");
  const homeParent = tmp("jgates-di-home-");
  const home = path.join(homeParent, "data");
  const bin = tmp("jgates-di-bin-");
  const pipLog = path.join(bin, "pip.jsonl");
  fs.mkdirSync(path.join(dir, ".jgates"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), `schemaVersion: 1\ntools:\n${tools.join("")}`);
  if (lock) fs.writeFileSync(path.join(dir, ".jgates", "lock.json"), JSON.stringify(lock, null, 2));
  if (python) script(bin, "python3", FAKE_PYTHON);
  if (docker) {
    script(bin, "docker", FAKE_DOCKER);
    if (docker === "stopped") fs.writeFileSync(path.join(bin, "stopped"), "");
  }
  const env = { ...process.env, JGATES_HOME: home, PATH: bin, FAKE_PIP_LOG: pipLog, JGATES_LOCALE: "en", ...extraEnv };
  for (const name of ["JGATES_PYTHON", "JGATES_RUFF", "JGATES_SEMGREP", "JGATES_CONTAINER_RUNTIME", "PIP_INDEX_URL", "JGATES_SIDECAR_DIR"]) if (!(name in extraEnv)) delete env[name];
  const cli = (args, input = "") => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input, timeout: 120_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  const pipCalls = () => (fs.existsSync(pipLog) ? fs.readFileSync(pipLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    dir,
    home,
    bin,
    env,
    cli,
    pipCalls,
    assess: () => install.assessEnvironment(dir, { env, system: UBUNTU }),
    cleanup: () => [dir, homeParent, bin].forEach((d) => fs.rmSync(d, { recursive: true, force: true })),
  };
}

const item = (assessment, key) => assessment.items.find((i) => i.key === key);

/** An executor that records what it was asked to run and never runs anything. */
function fakeExecutor(output) {
  const calls = [];
  return {
    calls,
    run(argv, options) {
      calls.push({ argv, interactive: options.interactive, outputBefore: output ? output.text() : "" });
      return { status: 0 };
    },
    async prepare(projectDir, instance) {
      calls.push({ prepare: instance });
    },
  };
}

/** A simulated terminal: the answers are written to its stdin up front, the questions are captured. */
function terminal(answers, interactive = true) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => (text += chunk.toString()));
  input.end(answers);
  const term = install.lineTerminal(input, output, interactive);
  return { term, text: () => text };
}

function offer(p, assessment, options, answers = "") {
  const t = terminal(answers, options.interactive ?? true);
  let printed = "";
  const capture = { text: () => printed + t.text() };
  const executor = fakeExecutor(capture);
  const run = install.offerInstall(assessment, {
    fix: options.fix ?? false,
    yes: options.yes ?? false,
    includeOptional: options.includeOptional ?? false,
    terminal: options.noTerminal ? install.NO_TERMINAL : t.term,
    out: (s) => (printed += s),
    env: p.env,
    executor,
  });
  return run.then((session) => {
    t.term.close();
    const questions = (t.text().match(new RegExp(QUESTION.source, "g")) ?? []).length;
    return { session, executor, printed: () => printed, questions };
  });
}

const pipRequirements = (calls) => calls.filter((c) => c.argv?.includes("pip")).flatMap((c) => c.argv.slice(c.argv.indexOf("install") + 1).filter((a) => !a.startsWith("-")));

// ---------------------------------------------------------------------------------------------------------------
// Classification.

test("classification: an enabled check with no other runner is essential; a check switched off is unused", { skip: POSIX ? false : NO_POSIX }, () => {
  const p = project({ tools: [TOOLS.ruffLocal, TOOLS.semgrepOff] });
  try {
    const a = p.assess();
    const ruff = item(a, "tool:ruff");
    assert.equal(ruff.classification, "essential");
    assert.equal(ruff.missing, true);
    assert.equal(ruff.alternative, null);
    assert.equal(ruff.disable.command, "jgates run --skip tool:ruff");
    assert.equal(ruff.recipe.kind, "python-packages");
    const semgrep = item(a, "tool:semgrep");
    assert.equal(semgrep.classification, "unused");
    assert.equal(semgrep.missing, false, "a check switched off never asks for its tool");
    assert.equal(semgrep.recipe, null);
    assert.equal(item(a, "runtime:docker").classification, "unused", "no instance runs in a container");
    assert.deepEqual(a.report.install.optional, []);
    assert.ok(a.report.install.essential.includes("tool:ruff"));
    assert.ok(!a.report.install.essential.includes("tool:semgrep"));
  } finally {
    p.cleanup();
  }
});

test("classification: a missing local tool whose pinned image is in Docker is optional and names the container as alternative", { skip: POSIX ? false : NO_POSIX }, () => {
  const p = project({ tools: [TOOLS.ruffLocal, TOOLS.semgrep], docker: "running", lock: RUFF_LOCK });
  try {
    const a = p.assess();
    const ruff = item(a, "tool:ruff");
    assert.equal(ruff.classification, "optional");
    assert.equal(ruff.alternative.kind, "container");
    assert.match(ruff.alternative.command, /runner: container/);
    assert.ok(ruff.recipe, "the optional item still carries its recipe");
    assert.equal(item(a, "tool:semgrep").classification, "essential");
    assert.deepEqual(a.report.install.optional, ["tool:ruff"]);
    assert.equal(a.report.runtimes.find((r) => r.id === "docker").state, "ready");
  } finally {
    p.cleanup();
  }
});

test("classification: an instance in a container without Docker is optional when the local tool answers; Docker is optional too", { skip: POSIX ? false : NO_POSIX }, () => {
  const p = project({ tools: [TOOLS.ruffContainer], extraEnv: {} });
  const fakeBin = tmp("jgates-di-ruff-");
  try {
    const localRuff = path.join(fakeBin, "ruff");
    fs.writeFileSync(localRuff, '#!/bin/sh\necho "ruff 0.6.9"\n', { mode: 0o755 });
    const env = { ...p.env, JGATES_RUFF: localRuff };
    const a = install.assessEnvironment(p.dir, { env, system: UBUNTU });
    const ruff = item(a, "tool:ruff");
    assert.equal(ruff.missing, true);
    assert.equal(ruff.classification, "optional");
    assert.equal(ruff.alternative.kind, "local");
    assert.match(ruff.alternative.message, new RegExp(localRuff.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(ruff.alternative.command, /runner: local/);
    const docker = item(a, "runtime:docker");
    assert.equal(docker.classification, "optional");
    assert.equal(docker.alternative.kind, "local");
    assert.equal(docker.recipe.kind, "docker-install");
    assert.equal(ruff.recipe.kind, "prepare");
    assert.equal(ruff.recipe.available, false, "the image cannot be prepared without Docker");

    // Without the local tool there is no other runner: the instance and Docker are essential.
    const b = p.assess();
    assert.equal(item(b, "tool:ruff").classification, "essential");
    assert.equal(item(b, "runtime:docker").classification, "essential");
    assert.doesNotMatch(b.report.runtimes.find((r) => r.id === "docker").message, /optional/i, "the text does not call an essential Docker optional");
  } finally {
    p.cleanup();
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The conversation, with a simulated stdin and a fake executor.

test("interaction: essential and optional items are asked in separate questions, and each answer installs only its group", { skip: POSIX ? false : NO_POSIX }, async () => {
  const p = project({ tools: [TOOLS.ruffLocal, TOOLS.semgrep], docker: "running", lock: RUFF_LOCK });
  try {
    const r = await offer(p, p.assess(), {}, "y\nn\n");
    assert.deepEqual(r.session.asked, ["essential", "optional"]);
    assert.deepEqual(r.session.accepted, ["essential"]);
    assert.equal(r.questions, 2, "two questions: the essential items, then the optional ones");
    const reqs = pipRequirements(r.executor.calls);
    assert.ok(reqs.some((x) => x.startsWith("semgrep")), "the essential semgrep is installed");
    assert.ok(!reqs.some((x) => x.startsWith("ruff")), "the optional ruff is not, after a no");
    assert.ok(reqs.some((x) => x.startsWith("defusedxml")), "the sidecar's packages go into the environment");
    assert.match(r.printed(), /alternative|alternativa/i, "the optional question says the alternative");
  } finally {
    p.cleanup();
  }
});

test("interaction: an answer other than yes cancels without installing anything", { skip: POSIX ? false : NO_POSIX }, async () => {
  const p = project({ tools: [TOOLS.ruffLocal, TOOLS.semgrep], docker: "running", lock: RUFF_LOCK });
  try {
    for (const answers of ["n\nn\n", "\n", "maybe\nwhatever\n", ""]) {
      const r = await offer(p, p.assess(), {}, answers);
      assert.equal(r.executor.calls.length, 0, `nothing runs after ${JSON.stringify(answers)}`);
      assert.deepEqual(r.session.accepted, []);
      assert.equal(r.session.ran, false);
      assert.match(r.printed(), /nothing was installed|nada foi instalado/i);
    }
  } finally {
    p.cleanup();
  }
});

test("interaction: without --fix the doctor asks only when something essential is missing; --fix asks for the optional ones too", { skip: POSIX ? false : NO_POSIX }, async () => {
  const p = project({ tools: [TOOLS.ruffLocal], docker: "running", lock: RUFF_LOCK });
  try {
    const plain = await offer(p, p.assess(), {}, "y\n");
    assert.deepEqual(plain.session.asked, [], "only an optional item missing: no question");
    assert.equal(plain.executor.calls.length, 0);
    const fix = await offer(p, p.assess(), { fix: true }, "y\n");
    assert.deepEqual(fix.session.asked, ["optional"]);
    assert.ok(pipRequirements(fix.executor.calls).some((x) => x.startsWith("ruff")));
  } finally {
    p.cleanup();
  }
});

test("interaction: --fix --yes installs the essential items without asking; --include-optional joins the optional ones", { skip: POSIX ? false : NO_POSIX }, async () => {
  const p = project({ tools: [TOOLS.ruffLocal, TOOLS.semgrep], docker: "running", lock: RUFF_LOCK });
  try {
    for (const noTerminal of [false, true]) {
      const r = await offer(p, p.assess(), { fix: true, yes: true, noTerminal });
      assert.equal(r.questions, 0, "no question with --yes");
      assert.deepEqual(r.session.asked, []);
      const reqs = pipRequirements(r.executor.calls);
      assert.ok(reqs.some((x) => x.startsWith("semgrep")));
      assert.ok(!reqs.some((x) => x.startsWith("ruff")), "the optional ones wait for --include-optional");
    }
    const all = await offer(p, p.assess(), { fix: true, yes: true, includeOptional: true, noTerminal: true });
    const reqs = pipRequirements(all.executor.calls);
    assert.ok(reqs.some((x) => x.startsWith("semgrep")) && reqs.some((x) => x.startsWith("ruff")));
    assert.equal(all.executor.calls.filter((c) => c.argv?.includes("pip")).length, 1, "one environment, one pip call");
  } finally {
    p.cleanup();
  }
});

test("interaction: without a terminal (or with --json) nothing is asked and, without --yes, nothing is installed", { skip: POSIX ? false : NO_POSIX }, async () => {
  const p = project({ tools: [TOOLS.ruffLocal, TOOLS.semgrep] });
  try {
    const r = await offer(p, p.assess(), { fix: true, noTerminal: true }, "y\n");
    assert.deepEqual(r.session.asked, []);
    assert.equal(r.executor.calls.length, 0);

    // The real command: stdin is a pipe with a "yes" in it, never a terminal.
    for (const args of [["doctor", "--fix"], ["doctor", "--fix", "--json"], ["doctor"], ["doctor", "--json"], ["doctor", "--fix", "--ci"]]) {
      const out = p.cli([...args, "--cwd", p.dir], "y\ny\n");
      assert.equal(out.code, 0, out.out + out.err);
      assert.doesNotMatch(out.out + out.err, QUESTION, `${args.join(" ")} never asks`);
      assert.equal(fs.existsSync(p.home), false, `${args.join(" ")} installs nothing and creates no data folder`);
      assert.deepEqual(p.pipCalls(), []);
      if (args.includes("--json")) assert.equal(out.doc?.session?.asked?.length ?? 0, 0);
    }
    assert.match(p.cli(["doctor", "--fix", "--cwd", p.dir]).out, /--fix --yes/, "without a terminal --fix points to --fix --yes");
  } finally {
    p.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The Python recipe, for real (fake python and pip, no network).

test("the Python recipe creates the environment under JGATES_HOME with the fake pip, and the adapter and the bridge find the tools there", { skip: POSIX ? false : NO_POSIX }, () => {
  const p = project({ tools: [TOOLS.ruffLocal, TOOLS.semgrepOff] });
  try {
    const before = p.cli(["doctor", "--cwd", p.dir, "--json"]);
    const recipe = before.doc.tools.find((x) => x.instance === "ruff").recipe;
    const envDir = path.join(p.home, "tools", "python");
    assert.deepEqual(recipe.writes, [envDir], "the preview says where it writes");
    assert.deepEqual(recipe.network.hosts, ["pypi.org", "files.pythonhosted.org"], "and which hosts pip reaches");
    assert.match(recipe.commands[0], / -m venv /);
    assert.match(recipe.commands[1], / -m pip install .*ruff>=0\.5\.0/);
    assert.equal(fs.existsSync(p.home), false, "the preview installs nothing");

    const r = p.cli(["doctor", "--cwd", p.dir, "--fix", "--yes", "--json"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.deepEqual(r.doc.session.outcomes.map((o) => [o.kind, o.status]), [["python-packages", "installed"]]);
    const calls = p.pipCalls();
    assert.deepEqual(calls.map((c) => c.step), ["venv", "pip"]);
    assert.equal(calls[0].dir, envDir, "the environment is created under JGATES_HOME, never in the system Python");
    assert.equal(calls[1].python, path.join(envDir, "bin", "python"), "pip is the environment's own");
    assert.ok(calls[1].reqs.includes("ruff>=0.5.0"));
    assert.ok(calls[1].reqs.some((x) => x.startsWith("defusedxml")) && calls[1].reqs.some((x) => x.startsWith("tomlkit")));
    if (process.platform !== "win32") assert.equal(fs.statSync(p.home).mode & 0o777, 0o700, "the data folder is private");

    // The doctor run after the installation, the Ruff adapter's finder and the bridge's Python all point there.
    const ruff = r.doc.tools.find((x) => x.instance === "ruff");
    assert.equal(ruff.state, "ready");
    assert.equal(ruff.executable, path.join(envDir, "bin", "ruff"));
    assert.equal(ruffProbe.findRuff(p.env).executable, path.join(envDir, "bin", "ruff"));
    assert.equal(bridge.resolvePython(p.env).interpreter, path.join(envDir, "bin", "python"));
    assert.equal(bridge.resolveProjectPython(p.env).interpreter, path.join(p.bin, "python3"), "the project's Python (pytest) is not the JGates environment");
    assert.equal(p.cli(["doctor", "--cwd", p.dir, "--json"]).doc.tools.find((x) => x.instance === "ruff").state, "ready");
  } finally {
    p.cleanup();
  }
});

test("the Python recipe says what is missing when there is no Python to create the environment", { skip: POSIX ? false : NO_POSIX }, () => {
  const p = project({ tools: [TOOLS.ruffLocal], python: false });
  try {
    const recipe = item(p.assess(), "tool:ruff").recipe;
    assert.equal(recipe.available, false);
    assert.match(recipe.reason, /Python 3\.11/);
  } finally {
    p.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Docker: the system's command, only after a confirmation; nothing else runs sudo.

test("the Docker recipe is the system's command and runs only after a yes on the terminal", { skip: POSIX ? false : NO_POSIX }, async () => {
  const p = project({ tools: [TOOLS.trivy] });
  try {
    const a = p.assess();
    const docker = item(a, "runtime:docker");
    assert.equal(docker.classification, "essential");
    assert.deepEqual(docker.recipe.commands, ["sudo apt-get update", "sudo apt-get install -y docker.io"]);
    assert.equal(docker.recipe.system, true);

    // --yes never covers a system command: without a terminal it is skipped, nothing runs.
    const unattended = await offer(p, a, { fix: true, yes: true, noTerminal: true });
    assert.equal(unattended.executor.calls.length, 0);
    assert.equal(unattended.session.outcomes.find((o) => o.id === "docker:install").status, "skipped");

    // On a terminal with --yes it asks for its own yes; a no runs nothing.
    const declined = await offer(p, a, { fix: true, yes: true }, "n\n");
    assert.equal(declined.questions, 1);
    assert.equal(declined.executor.calls.length, 0);

    // A yes to the group, after the preview showed the command, runs it as is (the command itself asks for sudo).
    const accepted = await offer(p, a, {}, "y\n");
    assert.deepEqual(accepted.executor.calls.map((c) => c.argv), [["sudo", "apt-get", "update"], ["sudo", "apt-get", "install", "-y", "docker.io"]]);
    assert.ok(accepted.executor.calls.every((c) => c.interactive), "the terminal reaches the command, for sudo's password");
    assert.match(accepted.executor.calls[0].outputBefore, /sudo apt-get install -y docker\.io/, "the command was shown before it ran");

    // The executor is never reached for an unconfirmed system recipe, whatever calls it.
    const recipe = a.recipes.get("runtime:docker");
    const ex = fakeExecutor();
    assert.equal((await install.executeRecipe(recipe, { executor: ex, env: p.env, confirmed: false, interactive: true })).status, "skipped");
    assert.equal(ex.calls.length, 0);
  } finally {
    p.cleanup();
  }
});

test("Docker installed but stopped: the recipe starts it", { skip: POSIX ? false : NO_POSIX }, () => {
  const p = project({ tools: [TOOLS.trivy], docker: "stopped" });
  try {
    const a = p.assess();
    const runtime = a.report.runtimes.find((r) => r.id === "docker");
    assert.equal(runtime.state, "absent");
    assert.equal(runtime.stopped, true);
    assert.deepEqual(item(a, "runtime:docker").recipe.commands, ["sudo systemctl start docker"]);
  } finally {
    p.cleanup();
  }
});

test("system commands by system, and no recipe runs sudo by itself", { skip: POSIX ? false : NO_POSIX }, async () => {
  const cmd = (system) => install.dockerInstallRecipe(system);
  assert.deepEqual(cmd({ platform: "linux", osRelease: "ID=debian\n" }).steps.at(-1), ["sudo", "apt-get", "install", "-y", "docker.io"]);
  assert.deepEqual(cmd({ platform: "linux", osRelease: "ID=fedora\n" }).steps[0], ["sudo", "dnf", "install", "-y", "moby-engine"]);
  assert.deepEqual(cmd({ platform: "darwin", osRelease: null }).steps, [["brew", "install", "--cask", "docker"]]);
  assert.deepEqual(cmd({ platform: "win32", osRelease: null }).steps, [["winget", "install", "--exact", "--id", "Docker.DockerDesktop"]]);
  const unknown = cmd({ platform: "linux", osRelease: "ID=arch\n" });
  assert.equal(unknown.available, false);
  assert.match(unknown.reason, /docs\.docker\.com/);
  for (const system of [UBUNTU, { platform: "darwin", osRelease: null }, { platform: "win32", osRelease: null }]) {
    assert.equal(install.dockerInstallRecipe(system).system, true);
    assert.equal(install.dockerStartRecipe(system).system, true);
  }

  // Every recipe that is not a system command: no sudo anywhere.
  const p = project({ tools: [TOOLS.ruffLocal, TOOLS.semgrep, TOOLS.trivy], docker: "running" });
  try {
    const a = p.assess();
    const nonSystem = [...a.recipes.values()].filter((r) => !r.system);
    assert.ok(nonSystem.some((r) => r.kind === "python-packages") && nonSystem.some((r) => r.kind === "prepare"));
    for (const r of nonSystem) {
      assert.ok(r.steps.every((s) => !s.includes("sudo")), `${r.id} has no sudo`);
      assert.ok(r.commands.every((c) => !/\bsudo\b/.test(c)), `${r.id} shows no sudo`);
    }
    // And a recipe that would need sudo without being a system command is refused before the executor.
    const ex = fakeExecutor();
    const forged = { ...nonSystem.find((r) => r.kind === "python-packages"), steps: [["sudo", "pip", "install", "ruff"]] };
    assert.equal((await install.executeRecipe(forged, { executor: ex, env: p.env, confirmed: true, interactive: true })).status, "skipped");
    assert.equal(ex.calls.length, 0);
  } finally {
    p.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The JSON of the doctor.

test("doctor --json: every runtime and tool carries its classification, alternative and recipe preview", { skip: POSIX ? false : NO_POSIX }, () => {
  const p = project({ tools: [TOOLS.ruffLocal, TOOLS.semgrep, TOOLS.semgrepOff.replace("semgrep:", "semgrep-off:"), TOOLS.trivy], docker: "running", lock: RUFF_LOCK });
  try {
    const r = p.cli(["doctor", "--cwd", p.dir, "--json"]);
    assert.equal(r.code, 0, r.out + r.err);
    const d = r.doc;
    assert.equal(d.status, "OK");
    for (const x of [...d.runtimes, ...d.tools]) {
      for (const key of ["classification", "missing", "alternative", "recipe"]) assert.ok(key in x, `${x.id ?? x.instance} has ${key}`);
      assert.ok(["essential", "optional", "unused"].includes(x.classification));
      if (x.recipe) {
        for (const key of ["id", "kind", "commands", "network", "writes", "system", "available", "reason"]) assert.ok(key in x.recipe, `${x.id ?? x.instance} recipe has ${key}`);
        assert.ok(!("steps" in x.recipe), "the JSON carries the preview, not the internals");
      }
    }
    const ruff = d.tools.find((x) => x.instance === "ruff");
    assert.deepEqual([ruff.classification, ruff.alternative.kind], ["optional", "container"]);
    assert.equal(d.tools.find((x) => x.instance === "semgrep-off").classification, "unused");
    const trivy = d.tools.find((x) => x.instance === "trivy");
    assert.equal(trivy.classification, "essential");
    assert.equal(trivy.recipe.kind, "prepare");
    assert.match(trivy.recipe.commands[0], /^jgates tools prepare --instance trivy/);
    assert.ok(Array.isArray(d.install.essential) && Array.isArray(d.install.optional));
    assert.ok(d.install.optional.includes("tool:ruff"));
    assert.ok(d.install.essential.includes("tool:semgrep") && d.install.essential.includes("tool:trivy"));
    assert.equal(d.session, null);

    const text = p.cli(["doctor", "--cwd", p.dir]);
    assert.equal(text.code, 0);
    assert.match(text.out, /essential:/);
    assert.match(text.out, /optional: there is an alternative/);
    assert.match(text.out, /alternative: .*runner: container/);
    assert.match(text.out, /jgates doctor --fix/);
  } finally {
    p.cleanup();
  }
});
