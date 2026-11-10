import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { docker, dockerAvailable } from "./dev-docker.mjs";

// Runtime smoke with the real engine (npm run test:docker; never part of npm test): `jgates run` on a small Python
// project with the local development image jgates-tools:dev. The ruff and pytest steps run in `--network none`
// containers of that image against the synchronized source volume, their logs start with the in-container command and
// the full `docker run` line, a real ruff finding comes back as a failure, cancelling a run kills only the containers
// of that run, and the project folder is byte for byte the same afterwards.
//
// The two steps are `generic-command` tool instances (`ruff`, `pytest`) because the Ruff and pytest adapters still probe
// the host for their tools until the probes read /etc/jgates/image.json (T12). The host only needs a file with the
// tool's name for the plan to call it available: the stand-ins in a temporary PATH folder are never executed, the
// containers run the image's own ruff and pytest. The tools-image gate is switched on by JGATES_TOOLS_IMAGE.

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const dist = path.join(packageRoot, "dist");
const MAIN = path.join(dist, "cli", "main.js");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const engine = await load("core", "engine", "index.js");
const { workspaceId } = await load("core", "ids", "index.js");
const IMAGE = engine.DEV_TOOLS_IMAGE;

const made = [];
const workspaces = new Set();
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};

/** Everything this smoke created in the engine carries its workspace id (and the JGates labels); the cleanup selects by them only. */
function cleanup() {
  for (const ws of workspaces) {
    const filters = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${ws}`];
    for (const id of docker(["ps", "-aq", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["rm", "-f", id]);
    for (const name of docker(["volume", "ls", "-q", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["volume", "rm", "-f", name]);
  }
}

before(() => {
  assert.ok(dockerAvailable(), "Docker is required for npm run test:docker (the daemon did not answer)");
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is missing; build it with npm --prefix jgates run image:build`);
});

after(() => {
  try {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    cleanup();
  }
});

function treeHash(root) {
  const h = crypto.createHash("sha256");
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      const next = rel ? `${rel}/${e.name}` : e.name;
      const stat = fs.lstatSync(p);
      if (e.isDirectory()) {
        h.update(`d:${next}\0`);
        walk(p, next);
      } else h.update(`f:${next}:${stat.size}:${stat.mtimeMs}\0`).update(fs.readFileSync(p));
    }
  };
  walk(root, "");
  return h.digest("hex");
}

const FIXTURE = {
  "pyproject.toml": '[tool.ruff]\nline-length = 88\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\npythonpath = ["."]\n',
  "app/__init__.py": "",
  "app/core.py": "def double(value):\n    return value * 2\n",
  "tests/test_core.py": "from app.core import double\n\n\ndef test_double():\n    with open('coverage.xml', 'w') as report:\n        report.write('<coverage/>')\n    assert double(2) == 4\n",
};

function template(tool, command, args, executesProjectCode) {
  return [
    "schemaVersion: 1",
    `id: ${tool}`,
    "extends: [builtin:base]",
    "config:",
    "  tools:",
    `    ${tool}:`,
    "      adapter: generic-command",
    "      enabled: true",
    "      capabilities: [lint]",
    `      command: ${command}`,
    `      args: ${JSON.stringify(args)}`,
    "      config:",
    `        effects: { readsCode: true, writesOutputs: false, mayChangeCode: false, executesProjectCode: ${executesProjectCode}, usesNetwork: false }`,
    "        evidence: { kind: exit-code }",
    "",
  ].join("\n");
}

const TOOLS = {
  "ruff-check": ["ruff", ["check", "--no-cache", "."], false],
  "pytest-run": ["pytest", ["-p", "no:cacheprovider", "-q"], true],
  "hang-wait": ["sleep", ["300"], false],
};

/** A project in its own folder, with the JGates configuration and the tool instances; returns its CLI. */
function makeProject(files, tools) {
  const project = tmp("jgates-smoke-project-");
  const home = tmp("jgates-smoke-home-");
  const stubs = tmp("jgates-smoke-stubs-");
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
    fs.writeFileSync(path.join(project, name), content);
  }
  // Presence markers for the host-side probe (never executed): the tools live in the image.
  for (const tool of tools) {
    const [command] = TOOLS[tool];
    fs.writeFileSync(path.join(stubs, command), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    fs.writeFileSync(path.join(stubs, `${command}.cmd`), "@exit /b 99\r\n");
  }
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const env = { ...process.env, [pathKey]: `${stubs}${path.delimiter}${process.env[pathKey] ?? ""}`, JGATES_HOME: home, JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  const cli = (args) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout: 600_000 });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  assert.equal(cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]).status, 0);
  fs.mkdirSync(path.join(project, ".jgates", "templates"), { recursive: true });
  for (const tool of tools) {
    const [command, args, runs] = TOOLS[tool];
    fs.writeFileSync(path.join(project, ".jgates", "templates", `${tool}.yml`), template(tool, command, args, runs));
  }
  fs.appendFileSync(path.join(project, "jgates.yml"), tools.map((t) => `  - id: ${t}\n    source: .jgates/templates/${t}.yml\n    activation: always\n`).join(""));
  spawnSync("git", ["add", "-A"], { cwd: project });
  const ws = workspaceId(project);
  workspaces.add(ws);
  const only = tools.flatMap((t) => ["--only", `tool:${t}`]);
  return { project, home, env, ws, cli, run: (...more) => cli(["run", "--cwd", project, "--no-interactive", "--json", ...only, ...more]) };
}

const stageOf = (doc, tool) => doc.stages.find((s) => s.execution?.step === tool);

test("ruff and pytest run in containers of jgates-tools:dev on the Python fixture and the project is untouched", () => {
  const p = makeProject(FIXTURE, ["ruff-check", "pytest-run"]);
  const before = treeHash(p.project);
  const run = p.run();
  const doc = JSON.parse(run.stdout);
  assert.ok(doc.stages, run.stdout.slice(0, 3000) + run.stderr.slice(0, 2000));
  for (const tool of ["ruff-check", "pytest-run"]) {
    const stage = stageOf(doc, tool);
    assert.ok(stage, `${tool} ran: ${JSON.stringify(doc.stages.map((s) => [s.id, s.state, s.reason]))}`);
    assert.equal(stage.state, "completed", `${tool}: ${stage.reason}`);
    assert.equal(stage.execution.exitCode, 0, fs.readFileSync(path.join(doc.runDir, "logs", `${tool}.stdout.log`), "utf8"));
  }
  assert.equal(doc.decision, "passed", JSON.stringify(doc.stages.map((s) => [s.id, s.state, s.reason])));
  assert.equal(treeHash(p.project), before, "the project folder is identical after the run");
  assert.deepEqual(doc.workspaceChanges?.added ?? [], []);
  assert.ok(!fs.existsSync(path.join(p.project, "coverage.xml")), "the file the test wrote is not in the project");

  // The steps were containers of the development image, with the contract.
  const events = fs.readFileSync(path.join(doc.runDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const synced = events.find((e) => e.type === "phase-finished" && e.data.phase === "sync");
  assert.equal(synced?.data.status, "succeeded", JSON.stringify(synced));
  const volume = synced.data.details.volume;
  const image = docker(["image", "inspect", "--format", "{{.Id}}", IMAGE]).out.trim();
  for (const tool of ["ruff-check", "pytest-run"]) {
    const header = fs.readFileSync(path.join(doc.runDir, "logs", `${tool}.stderr.log`), "utf8").split("\n---\n")[0];
    assert.match(header, new RegExp(`^executable: ${TOOLS[tool][0]}$`, "m"), "the in-container command");
    assert.match(header, /^cwd: \/workspace$/m);
    const line = /^Comando executado: (.*)$/m.exec(header)?.[1] ?? "";
    for (const part of ["run --rm --init --pull never --name", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges", "--network none", `src=${volume},dst=/workspace`, "dst=/output", image]) {
      assert.ok(line.includes(part), `${tool}: the docker run line holds ${part}: ${line}`);
    }
  }
  // pytest really ran the project's test (it wrote coverage.xml in the source volume, never in the project).
  const listing = docker(["run", "--rm", "--pull", "never", "--network", "none", "--label", "org.jgates.managed=true", "--label", `org.jgates.workspace=${p.ws}`, "--mount", `type=volume,src=${volume},dst=/workspace,readonly`, IMAGE, "sh", "-c", "ls /workspace /workspace/app"]);
  assert.equal(listing.code, 0, listing.err);
  assert.match(listing.out, /coverage\.xml/, "the test wrote its file in the source volume");
  assert.match(listing.out, /core\.py/);
  assert.doesNotMatch(listing.out, /__pycache__/);
  // Nothing of the run is left running: every step container was removed (--rm).
  assert.equal(docker(["ps", "-aq", "--filter", `label=org.jgates.workspace=${p.ws}`]).out.trim(), "");
});

test("a real ruff finding in the container makes the run fail, and the project stays untouched", () => {
  const p = makeProject({ ...FIXTURE, "app/core.py": "import os\n\n\ndef double(value):\n    return value * 2\n" }, ["ruff-check"]);
  const before = treeHash(p.project);
  const ranRuff = p.run();
  const doc = JSON.parse(ranRuff.stdout);
  assert.ok(doc.stages, ranRuff.stdout.slice(0, 3000) + ranRuff.stderr.slice(0, 2000));
  const stage = stageOf(doc, "ruff-check");
  assert.ok(stage, JSON.stringify(doc.stages.map((s) => [s.id, s.state, s.reason])));
  assert.equal(stage.execution.exitCode, 1, "ruff exits 1 when it finds something");
  assert.notEqual(doc.decision, "passed");
  const out = fs.readFileSync(path.join(doc.runDir, "logs", "ruff-check.stdout.log"), "utf8");
  assert.match(out, /F401/, "the output is ruff's own: unused import");
  assert.equal(treeHash(p.project), before);
});

test("cancelling a run kills the containers of that run only", async () => {
  const { executeRun } = await load("core", "run", "index.js");
  const { planSteps, planDisabled } = await load("core", "run", "plan-run.js");
  const { buildPlan } = await load("core", "plan", "index.js");
  const { readVersion } = await load("cli", "version.js");
  const p = makeProject(FIXTURE, ["hang-wait"]);
  // A container of another run of JGates, which the cancellation must leave alone.
  const other = docker(["run", "-d", "--rm", "--pull", "never", "--network", "none", "--label", "org.jgates.managed=true", "--label", "org.jgates.run=run_not_mine", "--label", `org.jgates.workspace=${p.ws}`, IMAGE, "sleep", "120"]);
  assert.equal(other.code, 0, other.err);
  const otherId = other.out.trim();
  try {
    const version = readVersion();
    const built = buildPlan(p.project, { only: ["tool:hang-wait"], env: p.env, home: p.home, compare: false, version });
    assert.equal(built.ok, true, JSON.stringify(built.errors ?? built.error));
    const plan = built.plan;
    const controller = new AbortController();
    let runId = null;
    const pending = executeRun({
      workspacePath: p.project,
      home: p.home,
      version,
      adapter: "quality-bridge",
      options: { planHash: plan.planHash, planSource: "built", profile: "minimal", scope: "full" },
      plan,
      steps: (context) => planSteps(context, plan),
      disabled: planDisabled(plan),
      env: p.env,
      cache: false,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "run-started") runId = event.runId;
      },
    });
    const deadline = Date.now() + 120_000;
    let mine = "";
    while (Date.now() < deadline) {
      if (runId) mine = docker(["ps", "-q", "--filter", `label=org.jgates.run=${runId}`, "--filter", "label=org.jgates.kind=step"]).out.trim();
      if (mine) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(mine, "the step container of the run is running");
    controller.abort("user cancelled");
    const result = await pending;
    assert.equal(result.decision, "cancelled");
    assert.equal(result.exitCode, 130);
    assert.equal(docker(["ps", "-aq", "--filter", `label=org.jgates.run=${result.runId}`]).out.trim(), "", "no container of the run is left");
    assert.equal(docker(["ps", "-q", "--filter", `id=${otherId}`]).out.trim().length > 0, true, "the container of another run is still running");
  } finally {
    docker(["rm", "-f", otherId]);
  }
});
