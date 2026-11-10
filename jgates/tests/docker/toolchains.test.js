import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { docker, dockerAvailable } from "./dev-docker.mjs";

// The toolchain volume with the real engine (npm run test:docker; never part of npm test):
//   - a project with `.python-version` 3.11 gets Python 3.11 from uv into the toolchain volume, its virtual environment is
//     created on it, and pytest (installed from requirements.txt) runs under Python 3.11 in a step-like container; a second
//     workspace pinning 3.11 finds it in the volume and fetches nothing;
//   - a project with @playwright/test gets Playwright's matching chromium in the toolchain volume, a step-like container
//     finds it (and launches it), and a second workspace with the same Playwright version downloads nothing;
//   - an unknown version (2.5) is not ready without starting a container, and a version uv cannot find (3.99) is not ready
//     after a real failed fetch; both offer 'Usar a versão padrão' and 'Corrigir .python-version'.
// Everything created carries org.jgates.test=toolchains (and the JGates labels); the cleanup selects by it only, and the
// toolchain and cache volumes have test names (the machine's jgates-toolchains is never touched).

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "..", "dist");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const engine = await load("core", "engine", "index.js");
const deps = await load("core", "deps", "index.js");
const sync = await load("core", "sync", "index.js");
const discovery = await load("core", "discovery", "index.js");
const i18n = await load("i18n", "index.js");
const { workspaceId } = await load("core", "ids", "index.js");
i18n.setLocale("pt-BR");

const IMAGE = engine.DEV_TOOLS_IMAGE;
const TEST = "toolchains";
const TEST_LABELS = { "org.jgates.test": TEST };
const CACHE = "jgates-test-toolchains-cache";
const TOOLCHAINS = "jgates-test-toolchains-volume";
const VERSION = "0.0.0-test";
const context = { runtime: "docker", runnerOptions: { parentEnv: process.env } };

const PYTHON_PROJECT = {
  ".python-version": "3.11\n",
  "requirements.txt": "pytest==8.3.4\n",
  "test_version.py": "import sys\n\n\ndef test_python_version():\n    assert sys.version_info[:2] == (3, 11), sys.version\n",
};
const PLAYWRIGHT_PROJECT = {
  "package.json": JSON.stringify({ name: "fx-pw", version: "1.0.0", private: true, devDependencies: { "@playwright/test": "1.65.0" } }, null, 2) + "\n",
  "index.js": "console.log('hello');\n",
};

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const write = (root, files) => {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
};

function cleanup() {
  const filters = ["--filter", `label=org.jgates.test=${TEST}`, "--filter", "label=org.jgates.managed=true"];
  for (const id of docker(["ps", "-aq", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["rm", "-f", id]);
  for (const name of docker(["volume", "ls", "-q", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["volume", "rm", "-f", name]);
}

before(() => {
  assert.ok(dockerAvailable(), "Docker is required for npm run test:docker (the daemon did not answer)");
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is missing; build it with npm --prefix jgates run image:build`);
  cleanup();
});

after(() => {
  try {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    cleanup();
  }
});

/** One JGates home for every workspace of the test, like the machine's. */
const home = tmp("jgates-toolchains-home-");

/** A synchronized project; `home` is shared by every workspace of the test, like the machine's JGates home. */
async function prepared(files, extra = {}) {
  const project = tmp("jgates-toolchains-project-");
  write(project, files);
  const ws = workspaceId(project);
  const image = engine.inspectImageSync(IMAGE, context);
  assert.ok(image, IMAGE);
  await sync.syncProject({ projectDir: project, workspace: ws, image: image.id, version: VERSION, home, extraLabels: TEST_LABELS, context });
  const { inventory } = discovery.discoverWorkspace(project);
  const { units } = deps.installUnits(inventory.classifications.filter((c) => c.approvable));
  assert.equal(units.length, 1, JSON.stringify(units.map((u) => u.id)));
  const input = {
    projectDir: project,
    workspace: ws,
    home,
    version: VERSION,
    imageId: image.id,
    governed: false,
    settings: deps.loadDependencySettings(project),
    env: {},
    vault: false,
    engine: context,
    cacheVolume: CACHE,
    toolchainsVolume: TOOLCHAINS,
    extraLabels: TEST_LABELS,
    logs: { dir: path.join(home, "logs", ws), root: home },
    timeoutMs: 900_000,
    ...extra,
  };
  return { project, ws, image: image.id, unit: units[0], input };
}

/** A container like a step: no network, the source, the unit's volume, the cache and the toolchains (read-only). */
function stepLike(w, outcome, command) {
  const recipe = outcome.recipe;
  return engine.runInEngine(
    {
      image: w.image,
      command: ["sh", "-c", command],
      labels: engine.engineLabels({ kind: "step", version: VERSION, workspace: w.ws, extra: TEST_LABELS }),
      mounts: [
        { type: "volume", source: engine.sourceVolumeName(w.ws), target: "/workspace" },
        { type: "volume", source: outcome.volume, target: recipe.target },
        { type: "volume", source: CACHE, target: "/cache" },
        { type: "volume", source: outcome.toolchainsVolume, target: "/toolchains", readonly: true },
      ],
      network: "none",
      workdir: w.unit.installRoot === "." ? "/workspace" : `/workspace/${w.unit.installRoot}`,
      env: { ...recipe.stepEnv, PATH: [...recipe.pathPrefix, deps.DEFAULT_IMAGE_PATH].join(":") },
      resources: { memoryMb: 2048, cpus: 2, pids: 1024, tmpfsMb: 512 },
      timeoutMs: 600_000,
    },
    context,
  );
}

const logOf = (outcome) => (outcome.log ? fs.readFileSync(path.join(home, outcome.log), "utf8") : "(no log)");
const recorded = (id) => deps.readToolchainState(home).entries[id];

test("a project pinning Python 3.11 runs pytest under 3.11; a second workspace pinning it fetches nothing", async () => {
  const w = await prepared(PYTHON_PROJECT);
  assert.equal(w.unit.info.language.version, "3.11");
  assert.equal(w.unit.info.manager, "pip");
  const first = await deps.prepareUnit(w.unit, w.input);
  assert.equal(first.status, "installed", `${first.message}\n${first.details}\n${logOf(first)}`);
  assert.deepEqual(first.toolchains.map((t) => [t.id, t.status]), [["python-3.11", "fetched"]], first.toolchains.map((t) => t.output).join("\n"));
  assert.equal(first.toolchainsVolume, TOOLCHAINS);
  const volumes = docker(["volume", "ls", "--filter", `label=org.jgates.test=${TEST}`, "--filter", "label=org.jgates.kind=toolchain", "--format", "{{.Name}}"]).out.split(/\s+/).filter(Boolean);
  assert.deepEqual(volumes, [TOOLCHAINS]);

  // pytest, installed into the unit's virtual environment, runs under Python 3.11 with no network.
  const check = await stepLike(w, first, "python --version && python -m pytest -q -p no:cacheprovider test_version.py");
  assert.equal(check.exitCode, 0, `pytest under 3.11 failed\n${check.stdout}\n${check.stderr}`);
  assert.match(check.stdout, /Python 3\.11\./);
  assert.match(check.stdout, /1 passed/);
  // The interpreter is the one of the toolchain volume, not the image's.
  const where = await stepLike(w, first, "python -c 'import sys; print(sys.executable, sys.base_prefix)'");
  assert.match(where.stdout, /\/toolchains\/uv-python\//, where.stdout + where.stderr);

  // A second workspace (another folder, the same home and toolchain volume) finds Python 3.11 and downloads nothing.
  const fetchedAt = recorded("python-3.11")?.fetchedAt;
  assert.ok(fetchedAt, "the host record of the fetch");
  const other = await prepared({ ...PYTHON_PROJECT, "extra.txt": "second workspace\n" });
  assert.notEqual(other.ws, w.ws);
  const second = await deps.prepareUnit(other.unit, other.input);
  assert.equal(second.status, "installed", `${second.message}\n${second.details}\n${logOf(second)}`);
  assert.deepEqual(second.toolchains.map((t) => [t.id, t.status]), [["python-3.11", "reused"]]);
  assert.equal(recorded("python-3.11").fetchedAt, fetchedAt, "nothing was fetched again");
  const again = await stepLike(other, second, "python -m pytest -q -p no:cacheprovider test_version.py");
  assert.equal(again.exitCode, 0, `${again.stdout}\n${again.stderr}`);
});

test("an unknown Python version is not ready; one uv cannot find is not ready after a failed fetch; both offer the two actions", async () => {
  const unknown = await prepared({ ...PYTHON_PROJECT, ".python-version": "2.5\n" });
  const containersBefore = docker(["ps", "-aq", "--filter", `label=org.jgates.test=${TEST}`]).out.split(/\s+/).filter(Boolean).length;
  const notReady = await deps.prepareUnit(unknown.unit, unknown.input);
  assert.equal(notReady.status, "not-ready");
  assert.equal(notReady.code, "DEPENDENCIES_NOT_READY");
  assert.match(notReady.message, /Python 2\.5/);
  assert.deepEqual(notReady.actions.map((a) => a.label), ["Usar a versão padrão 3.15.2 desta vez", "Corrigir .python-version"]);
  assert.equal(docker(["ps", "-aq", "--filter", `label=org.jgates.test=${TEST}`]).out.split(/\s+/).filter(Boolean).length, containersBefore);

  const missing = await prepared({ ...PYTHON_PROJECT, ".python-version": "3.99\n" });
  const failed = await deps.prepareUnit(missing.unit, missing.input);
  assert.equal(failed.status, "not-ready", `${failed.message}\n${failed.details}`);
  assert.equal(failed.code, "DEPENDENCIES_NOT_READY");
  assert.match(failed.message, /3\.99/);
  assert.match(failed.details, /3\.99|No download found|no interpreter/i);
  assert.deepEqual(failed.actions.map((a) => a.id), ["use-default-version", "fix-version-file"]);
  assert.equal(failed.volume === null ? null : docker(["volume", "ls", "-q", "--filter", `name=^${failed.volume}$`]).out.trim(), "", "no dependency volume was created");

  // Choosing the default version for this run installs with the image's Python.
  const chosen = await prepared({ ...PYTHON_PROJECT, ".python-version": "2.5\n", "test_version.py": "def test_ok():\n    pass\n" }, { env: { JGATES_TOOLCHAIN_DEFAULT: "python" } });
  const outcome = await deps.prepareUnit(chosen.unit, chosen.input);
  assert.equal(outcome.status, "installed", `${outcome.message}\n${outcome.details}\n${logOf(outcome)}`);
  assert.deepEqual(outcome.toolchains, []);
  const check = await stepLike(chosen, { ...outcome, toolchainsVolume: TOOLCHAINS }, "python --version && python -m pytest -q -p no:cacheprovider test_version.py");
  assert.equal(check.exitCode, 0, `${check.stdout}\n${check.stderr}`);
  assert.match(check.stdout, /Python 3\.15\./);
});

test("Playwright's matching chromium lands in the toolchain volume, a step finds and launches it, and a second workspace downloads nothing", async () => {
  const w = await prepared(PLAYWRIGHT_PROJECT);
  assert.equal(w.unit.info.ecosystem, "node");
  const first = await deps.prepareUnit(w.unit, w.input);
  assert.equal(first.status, "installed", `${first.message}\n${first.details}\n${logOf(first)}`);
  const browsers = first.toolchains.find((t) => t.id === "playwright");
  assert.ok(browsers, JSON.stringify(first.toolchains));
  assert.equal(browsers.status, "fetched", browsers.output);
  assert.match(browsers.output, /fetched playwright 1.65.0/);

  const listing = await stepLike(w, first, 'ls "$PLAYWRIGHT_BROWSERS_PATH"');
  assert.equal(listing.exitCode, 0, listing.stdout + listing.stderr);
  assert.match(listing.stdout, /chromium-\d+/, "the chromium build is in the volume");
  // The browser is the one Playwright 1.65.0 asks for: its executable exists under the shared path and starts.
  const launch = await stepLike(
    w,
    first,
    [
      "node -e \"const { chromium } = require('@playwright/test');",
      "const fs = require('fs');",
      "const exe = chromium.executablePath();",
      "if (!exe.startsWith('/toolchains/playwright/') || !fs.existsSync(exe)) { console.log('MISSING ' + exe); process.exit(2); }",
      "(async () => { const b = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }); console.log('launched ' + b.version()); await b.close(); })().catch((e) => { console.log('LAUNCH FAILED ' + e.message); process.exit(3); });\"",
    ].join(" "),
  );
  assert.equal(launch.exitCode, 0, `${launch.stdout}\n${launch.stderr}`);
  assert.match(launch.stdout, /launched \d+\./);

  // A second workspace with the same Playwright version: the marker in the volume says the browsers are there.
  const other = await prepared(PLAYWRIGHT_PROJECT);
  assert.notEqual(other.ws, w.ws);
  const recordedBefore = JSON.stringify(deps.readToolchainState(home));
  const second = await deps.prepareUnit(other.unit, other.input);
  assert.ok(["installed", "reused"].includes(second.status), `${second.message}\n${second.details}`);
  const again = second.toolchains.find((t) => t.id === "playwright");
  assert.equal(again.status, "reused", again.output);
  assert.equal(JSON.stringify(deps.readToolchainState(home)), recordedBefore, "no new fetch was recorded");
});
