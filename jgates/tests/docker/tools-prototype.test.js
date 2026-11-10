import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { docker, dockerAvailable } from "./dev-docker.mjs";

// S0 prototype with the real engine (npm run test:docker; never part of npm test): the project is synchronized into a
// labelled source volume, its Python dependencies are installed with uv into a dependency volume (the only container
// with network), and ruff and pytest run from the jgates-tools:dev image in `--network none` containers that write
// into a run folder. The project folder is only read: its tree hash is the same before and after.
// The project is JGATES_S0_PROJECT when set (the copy of the user's test project used to measure slice S0), otherwise
// a small Python project written by the test. With JGATES_S0_MEASURE_FILE the timings are also written there as JSON.

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const dist = path.join(packageRoot, "dist");
const engine = await import(pathToFileURL(path.join(dist, "core", "engine", "index.js")).href);
const sync = await import(pathToFileURL(path.join(dist, "core", "sync", "index.js")).href);
const deps = await import(pathToFileURL(path.join(dist, "core", "deps", "index.js")).href);
const { workspaceId } = await import(pathToFileURL(path.join(dist, "core", "ids", "index.js")).href);

const IMAGE = engine.DEV_TOOLS_IMAGE;
const VERSION = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
// Everything this test creates carries these labels; the cleanup selects by them only.
const TEST_LABELS = { "org.jgates.dev": "true", "org.jgates.test": "tools-prototype" };
const FILTERS = Object.entries(TEST_LABELS).flatMap(([k, v]) => ["--filter", `label=${k}=${v}`]);

let tmp = "";
let projectDir = "";
let ws = "";
let cacheVolume = "";
let imageId = "";
let manifest = null;

const treeHash = (root) => {
  const h = crypto.createHash("sha256");
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        h.update(`dir:${path.relative(root, p)}\0`);
        walk(p);
      } else h.update(`file:${path.relative(root, p)}\0`).update(fs.readFileSync(p));
    }
  };
  walk(root);
  return h.digest("hex");
};

function writeFixture(dir) {
  const files = {
    "requirements.txt": "iniconfig==2.3.1\n",
    "requirements-dev.txt": "-r requirements.txt\npytest==9.2.0\n",
    "pyproject.toml": '[tool.ruff]\nline-length = 88\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\npythonpath = ["."]\n',
    "app/__init__.py": "",
    "app/core.py": "import os\n\n\ndef double(value):\n    return value * 2\n",
    "tests/test_core.py": "import iniconfig\n\nfrom app.core import double\n\n\ndef test_double():\n    assert double(2) == 4\n\n\ndef test_dependency_is_installed():\n    assert iniconfig.IniConfig\n",
    // Host environments and caches that must never reach the source volume.
    ".venv/pyvenv.cfg": "home = C:\\Python\n",
    "node_modules/left-pad/index.js": "module.exports = 1;\n",
    "app/__pycache__/core.cpython-313.pyc": "not bytecode",
  };
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

function cleanup() {
  for (const id of docker(["ps", "-aq", ...FILTERS]).out.split(/\s+/).filter(Boolean)) docker(["rm", "-f", id]);
  for (const name of docker(["volume", "ls", "-q", ...FILTERS]).out.split(/\s+/).filter(Boolean)) docker(["volume", "rm", "-f", name]);
}

before(async () => {
  assert.ok(dockerAvailable(), "Docker is required for npm run test:docker (the daemon did not answer)");
  cleanup();
  if (docker(["image", "inspect", IMAGE]).code !== 0) {
    const built = spawnSync(process.execPath, [path.join(packageRoot, "scripts", "image-build.mjs")], { stdio: "inherit" });
    assert.equal(built.status, 0, "npm --prefix jgates run image:build failed");
  }
  const facts = await engine.inspectImage(IMAGE);
  assert.ok(facts, `${IMAGE} is missing after the build`);
  assert.equal(facts.labels["org.jgates.dev"], "true");
  assert.equal(facts.labels["jproject.project"], "jgates");
  imageId = facts.id;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-s0-"));
  if (process.env.JGATES_S0_PROJECT) {
    projectDir = path.resolve(process.env.JGATES_S0_PROJECT);
    assert.ok(fs.statSync(projectDir).isDirectory(), `JGATES_S0_PROJECT is not a folder: ${projectDir}`);
  } else {
    projectDir = path.join(tmp, "project");
    writeFixture(projectDir);
  }
  ws = workspaceId(projectDir);
  cacheVolume = `jgates-${ws}-cache-s0`;
});

after(() => {
  try {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  } finally {
    cleanup();
  }
});

const labels = (kind, run) => engine.engineLabels({ kind, version: VERSION, workspace: ws, ...(run ? { run } : {}), extra: TEST_LABELS });

/** Median wall time of `count` runs of `fn`. */
async function median(count, fn) {
  const times = [];
  for (let i = 0; i < count; i++) {
    const started = Date.now();
    await fn();
    times.push(Date.now() - started);
  }
  return times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
}

/** One step container: the source volume at /workspace, the dependency volume at /workspace/.venv, the run folder at /output. */
function runStep(run, runDir, step, command, env = {}) {
  return engine.runInEngine({
    image: imageId,
    name: `jgates-${run}-${step}`.slice(0, 120),
    command,
    labels: labels("step", run),
    network: "none",
    mounts: [
      { type: "volume", source: engine.sourceVolumeName(ws), target: "/workspace" },
      { type: "volume", source: engine.dependencyVolumeName(ws, "root"), target: deps.PYTHON_VENV_TARGET },
      { type: "bind", source: runDir, target: "/output" },
    ],
    workdir: "/workspace",
    env,
    timeoutMs: 600_000,
  });
}

function volumeListing(command) {
  const r = docker(["run", "--rm", "--pull", "never", "--network", "none", "--label", "org.jgates.dev=true", "--label", "org.jgates.test=tools-prototype", "--mount", `type=volume,src=${engine.sourceVolumeName(ws)},dst=/workspace,readonly`, imageId, "sh", "-c", command]);
  assert.equal(r.code, 0, r.err);
  return r.out;
}

test("S0: sync, uv dependencies, ruff and pytest in --network none containers leave the project untouched", async (t) => {
  const measures = { project: projectDir, imageId };
  const hashBefore = treeHash(projectDir);
  manifest = await engine.readImageManifest(imageId, labels("helper"));
  for (const tool of ["ruff", "pytest", "uv"]) assert.match(manifest.tools[tool] ?? "", /^\d+\.\d+/, `image.json lists ${tool}`);

  // Per-container overhead: a container that only runs `true`, under the same contract as a step.
  measures.containerOverheadMs = await median(5, async () => {
    const r = await engine.runInEngine({ image: imageId, command: ["true"], labels: labels("helper"), timeoutMs: 60_000 });
    assert.equal(r.exitCode, 0, r.stderr);
  });

  const cold = await sync.syncProject({ projectDir, workspace: ws, image: imageId, version: VERSION, extraLabels: TEST_LABELS });
  assert.equal(cold.createdVolume, true);
  assert.ok(cold.totalFiles > 0 && cold.changedFiles === cold.totalFiles, `cold sync copies every file: ${JSON.stringify({ total: cold.totalFiles, changed: cold.changedFiles })}`);
  assert.ok(cold.container.args.includes(`type=bind,src=${path.resolve(projectDir)},dst=/host,readonly`), "the project is mounted read-only");
  const warm = await sync.syncProject({ projectDir, workspace: ws, image: imageId, version: VERSION, extraLabels: TEST_LABELS });
  assert.equal(warm.createdVolume, false);
  assert.equal(warm.changedFiles, 0, "a second sync with no change copies nothing");
  assert.equal(warm.totalFiles, cold.totalFiles);
  measures.sync = { files: cold.totalFiles, coldMs: cold.durationMs, warmMs: warm.durationMs };
  const listing = volumeListing("find /workspace \\( -name node_modules -o -name __pycache__ -o -name pyvenv.cfg -o -path /workspace/.git \\) -print -prune");
  assert.doesNotMatch(listing, /node_modules|__pycache__|pyvenv\.cfg/, "host environments and caches are never copied");
  if (fs.existsSync(path.join(projectDir, ".git"))) assert.match(listing, /\/workspace\/\.git/, ".git is copied");
  // A Windows bind mount shows every file as executable; the copy must not (tools would report it).
  assert.equal(volumeListing("find /workspace -path /workspace/.git -prune -o -type f -perm /111 -print").trim(), "", "no synchronized file is executable");

  const requirementFiles = fs.existsSync(path.join(projectDir, "requirements-dev.txt")) ? ["requirements-dev.txt"] : ["requirements.txt"];
  const depsInput = { componentDir: projectDir, requirementFiles, workspace: ws, component: "root", image: imageId, imageId, pythonVersion: manifest.runtimes.python, version: VERSION, cacheVolume, extraLabels: TEST_LABELS };
  const depsCold = await deps.preparePythonDependencies(depsInput);
  assert.equal(depsCold.status, "installed", depsCold.container.stderr);
  assert.ok(depsCold.container.args.includes("bridge"), "the deps container is the one with network");
  const depsWarm = await deps.preparePythonDependencies(depsInput);
  assert.equal(depsWarm.status, "reused", "the same key reuses the installed dependencies");
  // A new dependency volume with the shared uv cache already filled (a reinstall after a key change).
  docker(["volume", "rm", "-f", depsCold.volume]);
  const depsCached = await deps.preparePythonDependencies(depsInput);
  assert.equal(depsCached.status, "installed");
  measures.dependencies = { coldMs: depsCold.durationMs, warmMs: depsWarm.durationMs, reinstallWithCacheMs: depsCached.durationMs };

  const run = `run_s0_${Date.now()}`;
  const runDir = path.join(tmp, "runs", run);
  fs.mkdirSync(runDir, { recursive: true });
  const ruffStarted = Date.now();
  const ruff = await runStep(run, runDir, "ruff", ["ruff", "check", "--no-cache", "--output-format", "json", "--output-file", "/output/ruff.json", "."]);
  measures.ruffMs = Date.now() - ruffStarted;
  assert.ok(ruff.exitCode === 0 || ruff.exitCode === 1, `ruff exit ${ruff.exitCode}: ${ruff.stderr}`);
  assert.ok(ruff.args.includes("--network") && ruff.args[ruff.args.indexOf("--network") + 1] === "none");
  assert.ok(ruff.args.includes("--pull") && ruff.args[ruff.args.indexOf("--pull") + 1] === "never");
  const findings = JSON.parse(fs.readFileSync(path.join(runDir, "ruff.json"), "utf8"));
  assert.ok(Array.isArray(findings), "ruff wrote its JSON report into the run folder");
  measures.ruffFindings = findings.map((f) => f.code).sort();
  assert.ok(!measures.ruffFindings.includes("EXE002"), "no executable-bit finding from the synchronized copy");

  const pytestStarted = Date.now();
  const pytest = await runStep(run, runDir, "pytest", [`${deps.PYTHON_VENV_TARGET}/bin/python`, "-m", "pytest", "-p", "no:cacheprovider", "--junitxml=/output/pytest.xml"], { COVERAGE_FILE: "/output/.coverage" });
  measures.pytestMs = Date.now() - pytestStarted;
  assert.ok(pytest.exitCode === 0 || pytest.exitCode === 1, `pytest exit ${pytest.exitCode}: ${pytest.stdout.slice(-2000)} ${pytest.stderr}`);
  const junit = fs.readFileSync(path.join(runDir, "pytest.xml"), "utf8");
  const tests = Number(/<testsuite[^>]* tests="(\d+)"/.exec(junit)?.[1] ?? "0");
  assert.ok(tests > 0, "pytest ran the project's tests with its installed dependencies");
  measures.pytest = { exitCode: pytest.exitCode, tests, failures: Number(/<testsuite[^>]* failures="(\d+)"/.exec(junit)?.[1] ?? "0"), errors: Number(/<testsuite[^>]* errors="(\d+)"/.exec(junit)?.[1] ?? "0") };

  measures.totalWarmRunMs = warm.durationMs + depsWarm.durationMs + measures.ruffMs + measures.pytestMs;
  assert.equal(treeHash(projectDir), hashBefore, "the project folder is identical after the run");

  t.diagnostic(`S0 ${JSON.stringify(measures)}`);
  if (process.env.JGATES_S0_MEASURE_FILE) fs.writeFileSync(process.env.JGATES_S0_MEASURE_FILE, `${JSON.stringify(measures, null, 2)}\n`);
});
