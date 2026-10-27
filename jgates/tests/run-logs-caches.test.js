import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Logs, runners, caches and workspace state of the Ruff and Semgrep adapters and of the run: the logs go from the runner straight to disk with its size limit, Ruff runs on the container runner
// the plan picks (`runner: container`, against the fake runtime here; npm run test:docker does it with Docker), the
// caches go to the run folder as each manifest declares (outputPaths, env), and the workspace state keeps the Git
// status before and after the run.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FAKE_DOCKER = path.join(here, "docker", "fake-docker.cjs");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const exe = (name) => path.join(VENV_BIN, process.platform === "win32" ? `${name}.exe` : name);
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const mainFixture = require(path.join(repo, "tests", "fixtures", "jgates", "main-fixture.js"));
const runApi = await import(pathToFileURL(path.join(dist, "core", "run", "index.js")).href);
const runner = await import(pathToFileURL(path.join(dist, "core", "runner", "index.js")).href);
const catalog = await import(pathToFileURL(path.join(dist, "core", "catalog", "index.js")).href);
const { ruffManifest } = await import(pathToFileURL(path.join(dist, "adapters", "ruff", "index.js")).href);
const { semgrepManifest } = await import(pathToFileURL(path.join(dist, "adapters", "semgrep", "index.js")).href);

const validateResult = new Ajv2020({ strict: true, allErrors: true }).compile(JSON.parse(fs.readFileSync(path.join(here, "..", "schemas", "result", "result.schema.json"), "utf8")));
const validatePlan = new Ajv2020({ strict: false, allErrors: true }).compile(JSON.parse(fs.readFileSync(path.join(here, "..", "schemas", "plan", "plan.schema.json"), "utf8")));

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const rm = (...dirs) => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
const POSIX = process.platform !== "win32";
const NO_POSIX = "the fake executables are scripts with a #! line (POSIX only)";

const RULE = "rules:\n  - id: no-eval\n    message: Do not call eval\n    severity: ERROR\n    languages: [python]\n    pattern: eval(...)\n";
const SEMGREP_TOOL = "  semgrep:\n    adapter: semgrep\n    capabilities: [sast]\n    config:\n      path: .jgates/rules\n      kind: directory\n      role: rules\n";
const DIGEST = "sha256:" + "ab".repeat(32);
const IMAGE = `registry.example/jgates/ruff@${DIGEST}`;

/** An executable Node script (#! with the absolute node path), so it runs without PATH and without a shell. */
function script(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function cliIn(env) {
  return (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, timeout: 600_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
}

/** Every path under dir (forward slashes), .git included only when asked. */
function tree(dir, { withGit = false } = {}) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git" && !withGit) continue;
      const p = path.join(d, e.name);
      out.push(path.relative(dir, p).split(path.sep).join("/") + (e.isDirectory() ? "/" : ""));
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

const stageOf = (result, id) => result.stages.find((s) => s.id === id);

test("Ruff and Semgrep write their logs through the runner: output past JGATES_MAX_LOG_BYTES leaves a cut log with the marker", { skip: POSIX ? false : NO_POSIX }, () => {
  const dir = tmp("jgates-p5f-logs-ws-");
  const home = tmp("jgates-p5f-logs-home-");
  const bin = tmp("jgates-p5f-logs-bin-");
  try {
    // Each fake answers --version and then writes 5000 bytes to stdout and to stderr; the log limit is 1000 bytes.
    const ruff = script(bin, "ruff", `const a = process.argv.slice(2);
if (a.includes("--version")) { console.log("ruff 0.17.2"); process.exit(0); }
process.stderr.write("r".repeat(5000));
process.stdout.write("[" + " ".repeat(4998) + "]");`);
    const semgrep = script(bin, "semgrep", `const fs = require("node:fs");
const a = process.argv.slice(2);
if (a.includes("--version")) { console.log("1.150.0"); process.exit(0); }
fs.writeFileSync(a[a.indexOf("--output") + 1], JSON.stringify({ results: [], errors: [], paths: { scanned: [] } }));
process.stderr.write("s".repeat(5000));
process.stdout.write("x".repeat(5000));`);
    fs.writeFileSync(path.join(dir, "mod.py"), "value = 1\n");
    const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON, JGATES_RUFF: ruff, JGATES_SEMGREP: semgrep, JGATES_MAX_LOG_BYTES: "1000", JGATES_NO_CACHE: "1", PATH: bin };
    const cli = cliIn(env);
    assert.equal(cli(["init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"]).code, 0);
    fs.mkdirSync(path.join(dir, ".jgates", "rules"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".jgates", "rules", "no-eval.yml"), RULE);
    fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), `schemaVersion: 1\ntools:\n  ruff:\n    adapter: ruff\n    capabilities: [lint]\n${SEMGREP_TOOL}`);

    const ran = cli(["run", "--cwd", dir, "--only", "tool:ruff,tool:semgrep", "--no-interactive", "--json"]);
    assert.ok(ran.doc, ran.out + ran.err);
    const result = ran.doc;
    assert.ok(validateResult(result), JSON.stringify(validateResult.errors));
    // The in-memory capture (what the adapter parses) is not the log: both stages read their whole output.
    assert.equal(stageOf(result, "ruff#lint")?.state, "completed", JSON.stringify(result.stages));
    assert.equal(stageOf(result, "ruff#lint")?.interpreted, undefined);
    assert.equal(stageOf(result, "semgrep#sast")?.state, "completed", JSON.stringify(result.stages));
    assert.equal(stageOf(result, "semgrep#sast")?.interpreted, undefined);

    for (const tool of ["ruff", "semgrep"]) {
      assert.ok(result.artifacts.logs.includes(`logs/${tool}.stdout.log`), JSON.stringify(result.artifacts.logs));
      const out = fs.readFileSync(path.join(result.runDir, "logs", `${tool}.stdout.log`), "utf8");
      const err = fs.readFileSync(path.join(result.runDir, "logs", `${tool}.stderr.log`), "utf8");
      assert.ok(out.includes(runner.TRUNCATION_MARKER), `${tool} stdout log has the marker`);
      assert.match(out, /kept 1000 of 5000 bytes \(limit 1000 bytes\)/);
      assert.ok(Buffer.byteLength(out) < 1200, `${tool} stdout log is cut at the limit (${Buffer.byteLength(out)} bytes)`);
      // The stderr log keeps the process facts around the cut output: the runner's header and footer.
      assert.ok(err.includes(runner.TRUNCATION_MARKER), `${tool} stderr log has the marker`);
      assert.match(err, /^executable: /);
      assert.match(err, /exit code: 0/);
      assert.ok(Buffer.byteLength(err) < 2000, `${tool} stderr log is cut at the limit (${Buffer.byteLength(err)} bytes)`);
    }
  } finally {
    rm(dir, home, bin);
  }
});

/** A runtime that behaves as the fake Docker of tests/docker and records every call (the run passes it no FAKE_* variable). */
function fakeRuntime(dir, { stdout = "[]", exit = 0, labels } = {}) {
  const log = path.join(dir, "docker-calls.jsonl");
  const vars = { FAKE_DOCKER_LOG: log, FAKE_DOCKER_STATE: dir, FAKE_DOCKER_STDOUT: stdout, FAKE_DOCKER_EXIT: String(exit), ...(labels ? { FAKE_DOCKER_LABELS: labels } : {}) };
  const file = script(dir, "docker", `Object.assign(process.env, ${JSON.stringify(vars)});\nrequire(${JSON.stringify(FAKE_DOCKER)});`);
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { file, calls };
}

function containerProject(runtimeOptions, { prepare = true } = {}) {
  const dir = tmp("jgates-p5f-ctr-ws-");
  const home = tmp("jgates-p5f-ctr-home-");
  const bin = tmp("jgates-p5f-ctr-bin-");
  const runtime = fakeRuntime(bin, runtimeOptions);
  fs.writeFileSync(path.join(dir, "mod.py"), "import os\n");
  fs.writeFileSync(path.join(dir, "lint.toml"), '[lint]\nselect = ["F"]\n');
  // No JGATES_*_IMAGE: the image comes only from .jgates/lock.json, pinned by `tools prepare`.
  const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON, JGATES_CONTAINER_RUNTIME: runtime.file, JGATES_NO_CACHE: "1", PATH: bin };
  for (const name of Object.keys(env)) if (/^JGATES_.*_IMAGE$/.test(name)) delete env[name];
  const cli = cliIn(env);
  assert.equal(cli(["init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"]).code, 0);
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  ruff:\n    adapter: ruff\n    capabilities: [lint]\n    runner: container\n    config: lint.toml\n");
  if (prepare) {
    const prepared = cli(["tools", "prepare", "--cwd", dir, "--instance", "ruff", "--image", IMAGE, "--no-interactive", "--json"]);
    assert.equal(prepared.code, 0, prepared.out + prepared.err);
  }
  return { dir, home, bin, env, cli, runtime, cleanup: () => rm(dir, home, bin) };
}

test("with runner: container the plan shows the container runner for Ruff and the run goes through runContainer (fake runtime)", { skip: POSIX ? false : NO_POSIX }, () => {
  const finding = [{ code: "F401", message: "`os` imported but unused", filename: "/workspace/mod.py", location: { row: 1, column: 8 } }];
  const p = containerProject({ stdout: JSON.stringify(finding), exit: 1 });
  try {
    const planned = p.cli(["plan", "--cwd", p.dir, "--only", "tool:ruff", "--json"]);
    assert.equal(planned.code, 0, planned.out + planned.err);
    const plan = planned.doc.plan;
    assert.ok(validatePlan(plan), JSON.stringify(validatePlan.errors));
    const item = plan.groups.willRun.find((i) => i.id === "ruff#lint");
    assert.ok(item, JSON.stringify(plan.groups.willRun.map((i) => i.id)));
    assert.deepEqual(item.runtime, { name: "container", interpreter: p.runtime.file, available: true });
    assert.equal(item.availability.status, "available", item.availability.reason);
    assert.equal(item.versions.toolVersion, "0.17.2", "the version comes from the image label, pinned in the lock");
    assert.equal(item.command.container.image, IMAGE);
    const locked = JSON.parse(fs.readFileSync(path.join(p.dir, ".jgates", "lock.json"), "utf8")).tools.ruff;
    assert.deepEqual({ pinned: locked.image.pinned, version: locked.toolVersion }, { pinned: IMAGE, version: "0.17.2" });
    assert.equal(item.command.container.runtime, p.runtime.file);
    assert.equal(item.command.container.network, "none");
    assert.deepEqual(item.command.container.mounts, [
      { source: "{workspace}", target: "/workspace", readOnly: true },
      { source: "{runDir}/cache/ruff", target: "/output", readOnly: false },
    ]);
    assert.deepEqual(item.command.args, ["check", "--config", "/workspace/lint.toml", "--no-fix", "--output-format", "json", "--cache-dir", "/output", "."]);
    assert.deepEqual(item.command.env, { RUFF_CACHE_DIR: "/output" });
    assert.ok(item.conditions.some((c) => c.includes(IMAGE)), JSON.stringify(item.conditions));
    const inspect = p.runtime.calls().find((c) => c[0] === "image" && c[1] === "inspect");
    assert.ok(inspect && inspect.includes(IMAGE), "planning only inspects the image");
    assert.equal(p.runtime.calls().filter((c) => c[0] === "run").length, 0, "planning starts no container");

    const treeBefore = tree(p.dir);
    const ran = p.cli(["run", "--cwd", p.dir, "--only", "tool:ruff", "--no-interactive", "--json"]);
    const result = ran.doc;
    assert.ok(result, ran.out + ran.err);
    assert.ok(validateResult(result), JSON.stringify(validateResult.errors));
    const stage = stageOf(result, "ruff#lint");
    assert.equal(stage.state, "completed", JSON.stringify(stage));
    assert.equal(stage.nativeStatus, "exit 1");
    const findings = result.findings.filter((f) => f.tool === "ruff");
    assert.deepEqual(findings.map((f) => [f.ruleId, f.location.path, f.location.line]), [["F401", "mod.py", 1]], "the container path /workspace/mod.py maps back to the workspace file");
    assert.equal(result.decision, "failed", "a blocking finding fails the run");

    const call = p.runtime.calls().find((c) => c[0] === "run");
    assert.ok(call, "the run started the container through the runtime");
    const at = call.indexOf(IMAGE);
    assert.ok(at > 0, "image by digest");
    assert.deepEqual(call.slice(at + 1), item.command.args, "the plan's command runs in the image");
    assert.ok(call.includes("--read-only"));
    assert.deepEqual(call.slice(call.indexOf("--network"), call.indexOf("--network") + 2), ["--network", "none"]);
    const workspaceReal = fs.realpathSync(p.dir);
    assert.ok(call.includes(`type=bind,src=${p.dir},dst=/workspace,readonly`) || call.includes(`type=bind,src=${workspaceReal},dst=/workspace,readonly`), call.join(" "));
    const outputMount = call.find((a) => a.endsWith(",dst=/output"));
    assert.equal(outputMount, `type=bind,src=${path.join(result.runDir, "cache", "ruff")},dst=/output`, "the only writable mount is the cache folder of the run");
    assert.ok(call.includes("RUFF_CACHE_DIR=/output"));
    assert.equal(call[call.indexOf("--workdir") + 1], "/workspace");
    assert.ok(!call.includes("--privileged"));
    // The log is the docker client's, streamed by the runner.
    const err = fs.readFileSync(path.join(result.runDir, "logs", "ruff.stderr.log"), "utf8");
    assert.ok(err.startsWith(`executable: ${p.runtime.file}\n`), err.slice(0, 200));
    assert.deepEqual(tree(p.dir), treeBefore, "nothing new in the workspace");
    assert.deepEqual(result.workspaceChanges.added, []);
  } finally {
    p.cleanup();
  }
});

test("runner: container without a usable image is blocked with the reason (not prepared, missing, lock edited, no runtime), never passed", { skip: POSIX ? false : NO_POSIX }, () => {
  const p = containerProject({ labels: "none" }, { prepare: false });
  try {
    const item = (env = {}) => {
      const planned = cliIn({ ...p.env, ...env })(["plan", "--cwd", p.dir, "--only", "tool:ruff", "--json"]);
      assert.ok(planned.doc, planned.out + planned.err);
      return planned.doc.plan.groups.willRun.find((i) => i.id === "ruff#lint");
    };
    // Nothing prepared: the instruction is the prepare command (no variable chooses an image).
    const unprepared = item();
    assert.equal(unprepared.runtime.name, "container");
    assert.equal(unprepared.availability.status, "unavailable");
    assert.match(unprepared.availability.reason, /jgates tools prepare --instance ruff/);
    assert.doesNotMatch(unprepared.availability.reason, /JGATES_RUFF_IMAGE/);
    // An image the runtime does not have is not pinned: prepare refuses and writes nothing.
    const refused = p.cli(["tools", "prepare", "--cwd", p.dir, "--instance", "ruff", "--image", IMAGE, "--no-interactive", "--json"]);
    assert.equal(refused.code, 3, refused.out);
    assert.equal(refused.doc.error.code, "IMAGE_NOT_FOUND");
    assert.ok(!fs.existsSync(path.join(p.dir, ".jgates", "lock.json")));
    // Pinned, but gone from the runtime: unavailable, with the command that prepares it again.
    const lock = (image) => fs.writeFileSync(path.join(p.dir, ".jgates", "lock.json"), JSON.stringify({ schemaVersion: 1, tools: { ruff: { adapter: "ruff", adapterVersion: "0.1.0", toolVersion: "0.17.2", preparedAt: "2026-10-26T00:00:00Z", image: { reference: image, id: DIGEST, pinned: image, versionLabel: "org.jgates.tool.version" } } } }));
    lock(IMAGE);
    const missing = item();
    assert.equal(missing.availability.status, "unavailable");
    assert.match(missing.availability.reason, /não está no runtime/);
    assert.match(missing.availability.reason, /jgates tools prepare --instance ruff/);
    // A tag written in the lock by hand never runs: the lock schema refuses it.
    lock("jgates-dev/ruff:0.17.2");
    assert.match(item().availability.reason, /lock\.json não é válido/);
    lock(IMAGE);
    const noRuntime = item({ JGATES_CONTAINER_RUNTIME: path.join(p.bin, "nao-existe") });
    assert.match(noRuntime.availability.reason, /Docker/);

    const ran = p.cli(["run", "--cwd", p.dir, "--only", "tool:ruff", "--no-interactive", "--json"]);
    assert.ok(ran.doc, ran.out + ran.err);
    assert.equal(stageOf(ran.doc, "ruff#lint").state, "blocked");
    assert.notEqual(ran.doc.decision, "passed");
    assert.equal(p.runtime.calls().filter((c) => c[0] === "run").length, 0, "no container was started");
  } finally {
    p.cleanup();
  }
});

test("the manifests declare where the caches go (outputPaths, env), and the plan points the tools there", () => {
  for (const manifest of [ruffManifest, semgrepManifest]) assert.deepEqual(catalog.validateManifest(manifest).errors, []);
  assert.deepEqual(ruffManifest.redirection.outputPaths, [{ path: "cache/ruff", purpose: "cache", env: ["RUFF_CACHE_DIR"] }]);
  assert.deepEqual(semgrepManifest.redirection.outputPaths, [{ path: "cache/semgrep/home", purpose: "home", env: ["HOME", "USERPROFILE"] }]);
  assert.ok(ruffManifest.runtimes.includes("container"));
  const broken = { ...ruffManifest, redirection: { ...ruffManifest.redirection, outputPaths: [{ path: "../escape", purpose: "cache" }] } };
  assert.equal(catalog.validateManifest(broken).ok, false, "an output path never leaves the run folder");
});

test("a full run on the main fixture leaves no Ruff or Semgrep cache in the project; both caches are in the run folder", { skip: fs.existsSync(exe("ruff")) && fs.existsSync(exe("semgrep")) ? false : "ruff and semgrep are not installed in the repository .venv (npm --prefix jgates run setup:dev-tools)" }, () => {
  const { dir } = mainFixture.createMainFixture();
  const home = tmp("jgates-p5f-main-home-");
  try {
    const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON, JGATES_NO_CACHE: "1", DOCKER_HOST: "tcp://127.0.0.1:1", PATH: [VENV_BIN, "/usr/bin", "/bin"].join(path.delimiter) };
    const cli = cliIn(env);
    assert.equal(cli(["init", "--cwd", dir, "--profile", "strict", "--no-interactive", "--json"]).code, 0);
    fs.mkdirSync(path.join(dir, ".jgates", "rules"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".jgates", "rules", "no-eval.yml"), RULE);
    fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), `schemaVersion: 1\ntools:\n${SEMGREP_TOOL}`);
    const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
    git("add", "-A");
    assert.equal(git("commit", "-qm", "jgates configuration").status, 0);
    const before = tree(dir);

    const planned = cli(["plan", "--cwd", dir, "--json"]);
    assert.equal(planned.code, 0, planned.out + planned.err);
    const items = planned.doc.plan.groups.willRun;
    const ruffItem = items.find((i) => i.adapter === "ruff");
    const semgrepItem = items.find((i) => i.adapter === "semgrep");
    assert.ok(ruffItem && semgrepItem, JSON.stringify(items.map((i) => i.id)));
    assert.equal(ruffItem.command.env.RUFF_CACHE_DIR, "{runDir}/cache/ruff");
    assert.equal(ruffItem.command.args[ruffItem.command.args.indexOf("--cache-dir") + 1], "{runDir}/cache/ruff");
    assert.equal(semgrepItem.command.env.HOME, "{runDir}/cache/semgrep/home");

    const ran = cli(["run", "--cwd", dir, "--no-interactive", "--json"]);
    const result = ran.doc;
    assert.ok(result, ran.out + ran.err);
    assert.ok(validateResult(result), JSON.stringify(validateResult.errors));
    for (const item of [ruffItem, semgrepItem]) {
      const stage = stageOf(result, item.id);
      assert.equal(stage?.state, "completed", JSON.stringify(stage));
      assert.notEqual(stage.interpreted, false, JSON.stringify(stage));
    }
    // Nothing in the project: no .ruff_cache, no .semgrep, no other file (ignored files included).
    assert.deepEqual(tree(dir), before);
    assert.ok(!tree(dir).some((f) => /(^|\/)(\.ruff_cache|\.semgrep|\.semgrep_logs)\//.test(f)));
    assert.deepEqual([result.workspaceChanges.added, result.workspaceChanges.modified, result.workspaceChanges.removed], [[], [], []]);
    assert.equal(result.workspaceGit.repository, true);
    assert.equal(result.workspaceGit.changed, false);
    assert.deepEqual(result.workspaceGit.before, { tracked: [], untracked: [], truncated: false });
    // The caches are in the run folder, where the manifests said.
    assert.ok(fs.existsSync(path.join(result.runDir, "cache", "ruff", "CACHEDIR.TAG")), "Ruff's cache is in the run folder");
    assert.ok(fs.existsSync(path.join(result.runDir, "cache", "semgrep", "home", ".semgrep")), "Semgrep's home is in the run folder");
  } finally {
    mainFixture.removeFixture(dir);
    rm(home);
  }
});

test("the workspace state keeps the Git status before and after the run, and the result shows it", async () => {
  const ws = tmp("jgates-p5f-git-ws-");
  const plain = tmp("jgates-p5f-git-plain-");
  const home = tmp("jgates-p5f-git-home-");
  const git = (...args) => spawnSync("git", args, { cwd: ws, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
  const step = (root, write) => ({
    id: "messy",
    skeleton: () => ({ stages: [{ id: "messy#check", kind: "step", adapter: "fake", state: "pending" }], requirements: [{ id: "messy#check", required: true }], disabled: [], findings: [], logs: [], outputs: [] }),
    run: async () => {
      if (write) {
        fs.writeFileSync(path.join(root, "left-behind.txt"), "x");
        fs.appendFileSync(path.join(root, "tracked.txt"), "changed\n");
      }
      return { stages: [{ id: "messy#check", kind: "step", adapter: "fake", state: "completed", reason: "ok" }], requirements: [{ id: "messy#check", required: true }], disabled: [], findings: [], logs: [], outputs: [] };
    },
  });
  const execute = (root, write) => runApi.executeRun({ workspacePath: root, home, version: "0.0.0-test", adapter: "fake", options: {}, env: { ...process.env, JGATES_NO_CACHE: "1" }, steps: () => [step(root, write)] });
  try {
    assert.equal(git("init", "-q").status, 0);
    fs.writeFileSync(path.join(ws, "tracked.txt"), "one\n");
    fs.writeFileSync(path.join(ws, "draft.txt"), "untracked before the run\n");
    git("add", "tracked.txt");
    assert.equal(git("commit", "-qm", "one").status, 0);

    const result = await execute(ws, true);
    assert.ok(validateResult(result), JSON.stringify(validateResult.errors));
    assert.deepEqual(result.workspaceGit, {
      repository: true,
      before: { tracked: [], untracked: ["draft.txt"], truncated: false },
      after: { tracked: [{ path: "tracked.txt", status: " M" }], untracked: ["draft.txt", "left-behind.txt"], truncated: false },
      changed: true,
    });
    const saved = JSON.parse(fs.readFileSync(path.join(result.runDir, "result.json"), "utf8"));
    assert.deepEqual(saved.workspaceGit, result.workspaceGit, "result.json keeps it too");
    assert.deepEqual(result.workspaceChanges.added, ["left-behind.txt"]);

    const clean = await execute(ws, false);
    assert.equal(clean.workspaceGit.changed, false);
    assert.deepEqual(clean.workspaceGit.before, clean.workspaceGit.after);

    // A folder outside Git: the manifest still runs, the Git records are null.
    const outside = await execute(plain, true);
    assert.ok(validateResult(outside), JSON.stringify(validateResult.errors));
    assert.deepEqual(outside.workspaceGit, { repository: false, before: null, after: null, changed: false });
    assert.ok(outside.workspaceChanges.added.includes("left-behind.txt"));
  } finally {
    rm(ws, plain, home);
  }
});

test("run-plan.test.js removes every jgates-rp-* folder it creates", () => {
  const source = fs.readFileSync(path.join(here, "run-plan.test.js"), "utf8");
  const created = [...source.matchAll(/tmp\("(jgates-rp-[a-z0-9-]+)"\)/g)].map((m) => m[1]);
  assert.ok(created.includes("jgates-rp-plan-"), "the plan files have their own folder");
  // Every temporary folder the file creates is bound to a name that a cleanup removes.
  for (const match of source.matchAll(/const (\w+) = tmp\("jgates-rp-[a-z0-9-]+"\);/g)) {
    const name = match[1];
    assert.match(source, new RegExp(`fs\\.rmSync\\(${name},|\\[[^\\]]*\\b${name}\\b[^\\]]*\\]\\) fs\\.rmSync`), `${name} is removed`);
  }
  assert.doesNotMatch(source, /path\.join\(tmp\(/, "no anonymous temporary folder");
});
