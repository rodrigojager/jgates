import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// `jgates doctor` and the prerequisites, container-first (ADR-0004): the host needs Node, Git and a container engine;
// every tool comes from the JGates tools image. What the doctor offers to prepare is the engine's install or start, the
// tools image's download and an instance's data (Semgrep rules) - never a tool installed on the host, never host
// Python. The engine is the fake one (tests/docker/fake-docker.cjs); nothing reaches the network.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FAKE = path.join(here, "docker", "fake-docker.cjs");
const install = await import(pathToFileURL(path.join(dist, "core", "install", "index.js")).href);
const prerequisites = await import(pathToFileURL(path.join(dist, "core", "prerequisites", "index.js")).href);
const { imageJsonWithout } = await import(pathToFileURL(path.join(here, "setup", "image-json.mjs")).href);
const VERSION = JSON.parse(fs.readFileSync(path.resolve(here, "..", "..", "package.json"), "utf8")).version;

const IN_IMAGE_JSON = process.env.JGATES_IMAGE_JSON;
const ALLOWED_RECIPES = ["docker-install", "docker-start", "image-pull", "prepare"];
const ALLOWED_PREREQUISITES = ["docker-install", "docker-start", "image-pull", "git-trust", "data-prepare", "manual"];
const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/** A Python project with a Ruff instance, run by the fake engine with the settings given (container mode by default). */
function project({ fake = {}, env: extra = {} } = {}) {
  const dir = tmp("jgates-di-ws-");
  const home = tmp("jgates-di-home-");
  const bin = tmp("jgates-di-bin-");
  const wrapper = path.join(bin, "docker.cjs");
  fs.writeFileSync(wrapper, `Object.assign(process.env, ${JSON.stringify({ FAKE_DOCKER_STATE: bin, FAKE_DOCKER_LOG: path.join(bin, "calls.jsonl"), ...fake })});\nrequire(${JSON.stringify(FAKE)});\n`);
  fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(dir, "mod.py"), "import os\n");
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: wrapper, JGATES_IMAGE_JSON: "", JGATES_LOCALE: "en", NO_COLOR: "1", ...extra };
  for (const name of ["JGATES_PYTHON", "JGATES_RUFF", "JGATES_TOOLS_IMAGE"]) if (!(name in extra)) delete env[name];
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
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  ruff:\n    adapter: ruff\n    capabilities: [lint]\n");
  return { dir, env, cli, doctor: () => cli(["doctor", "--cwd", dir, "--json"]) };
}

/** Every recipe and prerequisite of a doctor report: none installs a tool on the host. */
function assertNoHostInstall(report) {
  assert.ok(!report.runtimes.some((r) => r.id === "python"), "the host needs no Python");
  for (const x of [...report.runtimes, ...report.tools]) {
    if (x.recipe) assert.ok(ALLOWED_RECIPES.includes(x.recipe.kind), `${x.id ?? x.instance}: ${x.recipe.kind}`);
    if (x.recipe) assert.ok(!x.recipe.commands.some((c) => /pip install|npm install|go install|cargo install/.test(c)), JSON.stringify(x.recipe));
  }
  for (const tool of report.tools) if (tool.recipe) assert.equal(tool.recipe.kind, "prepare", `${tool.instance}: only data is prepared per instance`);
}

test("doctor --json with the engine stopped: the runtimes are Node, Git, Docker and the tools image; Docker is essential with its start recipe, and nothing installs a tool", () => {
  const p = project({ fake: { FAKE_DOCKER_DAEMON: "stopped" } });
  const r = p.doctor();
  assert.equal(r.code, 0, r.out + r.err);
  const ids = r.doc.runtimes.map((x) => x.id);
  assert.deepEqual(ids, ["node", "git", "docker", "image"]);
  const docker = r.doc.runtimes.find((x) => x.id === "docker");
  assert.equal(docker.state, "absent");
  assert.equal(docker.stopped, true);
  assert.equal(docker.reasonCode, "ENGINE_STOPPED");
  assert.equal(docker.classification, "essential");
  assert.equal(docker.recipe.kind, "docker-start");
  assert.equal(r.doc.runtimes.find((x) => x.id === "image").state, "not_checked");
  assert.equal(r.doc.environmentReady, false);
  assert.ok(r.doc.install.essential.includes("runtime:docker"));
  assertNoHostInstall(r.doc);
});

test("doctor --json with the tools image absent: the image is essential, with IMAGE_MISSING and the engine's pull as its recipe", () => {
  const p = project({ fake: { FAKE_DOCKER_LABELS: "none" }, env: { JGATES_TOOLS_IMAGE: "registry.example/jgates-tools:9" } });
  const r = p.doctor();
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.doc.runtimes.find((x) => x.id === "docker").state, "ready");
  const image = r.doc.runtimes.find((x) => x.id === "image");
  assert.equal(image.state, "absent");
  assert.equal(image.reasonCode, "IMAGE_MISSING");
  assert.equal(image.fix, "jgates setup");
  assert.equal(image.recipe.kind, "image-pull");
  assert.equal(image.recipe.available, true);
  assert.deepEqual(image.recipe.network.hosts, ["registry.example"]);
  assert.deepEqual(r.doc.install.essential, ["runtime:image"]);
  assertNoHostInstall(r.doc);
  const report = prerequisites.listPrerequisites(p.dir, { env: p.env });
  assert.deepEqual(report.items.map((i) => [i.id, i.kind, i.action]), [["image", "image-pull", "run"]]);
});

test("an image of another JGates version is incompatible, and the pin of an unpublished release is shown, never pulled", () => {
  const p = project({ fake: { FAKE_DOCKER_LABELS: JSON.stringify({ "org.jgates.version": "0.0.1" }) } });
  const r = p.doctor();
  const image = r.doc.runtimes.find((x) => x.id === "image");
  assert.equal(image.state, "incompatible");
  assert.equal(image.reasonCode, "IMAGE_VERSION_MISMATCH");
  assert.equal(image.recipe.kind, "image-pull");
  // Until publication the pin file holds a local image (jgates-tools:dev): nothing to pull from a registry.
  assert.equal(image.recipe.available, false);
  assert.match(image.recipe.reason, /not published/);
  const item = prerequisites.listPrerequisites(p.dir, { env: p.env }).items.find((i) => i.id === "image");
  assert.equal(item.action, null);
});

test("a ready engine and image of this version: the environment is ready and the tools are what image.json records", () => {
  const p = project({ fake: { FAKE_DOCKER_LABELS: JSON.stringify({ "org.jgates.version": VERSION }) } });
  const r = p.doctor();
  assert.equal(r.doc.runtimes.find((x) => x.id === "image").state, "ready");
  const ruff = r.doc.tools.find((x) => x.instance === "ruff");
  assert.equal(ruff.state, "ready");
  assert.equal(ruff.executable, "ruff");
  assert.equal(ruff.version, JSON.parse(fs.readFileSync(path.resolve(here, "..", "release", "image-tools.json"), "utf8")).tools.ruff);
  assert.equal(ruff.runner, "container");
  assert.equal(r.doc.environmentReady, true, JSON.stringify(r.doc.install));
});

test("inside the tools image a tool its image.json lacks is missing with the image as fix and no recipe; the prerequisites list only a manual item for it", () => {
  const p = project({ env: { JGATES_IMAGE_JSON: imageJsonWithout("ruff") } });
  const r = p.doctor();
  assert.equal(r.code, 0, r.out + r.err);
  const docker = r.doc.runtimes.find((x) => x.id === "docker");
  assert.equal(docker.state, "not_checked");
  assert.equal(docker.classification, "unused");
  assert.equal(r.doc.runtimes.find((x) => x.id === "image").state, "ready");
  const ruff = r.doc.tools.find((x) => x.instance === "ruff");
  assert.equal(ruff.state, "absent");
  assert.equal(ruff.missing, true);
  assert.equal(ruff.recipe, null);
  assert.equal(ruff.fix, "jgates setup");
  assert.match(ruff.message, /not in the JGates tools image/);
  assertNoHostInstall(r.doc);
  const report = prerequisites.listPrerequisites(p.dir, { env: p.env });
  for (const i of report.items) assert.ok(ALLOWED_PREREQUISITES.includes(i.kind), i.kind);
  assert.deepEqual(report.items.map((i) => [i.id, i.kind]), [["manual:tool:ruff", "manual"]]);
});

/** A simulated terminal: the answers are written up front, the questions captured. */
function terminal(answers) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.end(answers);
  return install.lineTerminal(input, output, true);
}

test("--fix --yes pulls the tools image through the engine and never runs a system command (Docker) without its own yes", async () => {
  const pulled = [];
  const ran = [];
  const executor = { run: (argv) => (ran.push(argv), { status: 0 }), prepare: async () => {}, pull: async (reference) => (pulled.push(reference), { status: 0 }) };
  const missingImage = project({ fake: { FAKE_DOCKER_LABELS: "none" }, env: { JGATES_TOOLS_IMAGE: "registry.example/jgates-tools:9" } });
  const assessment = install.assessEnvironment(missingImage.dir, { env: missingImage.env });
  const term = terminal("");
  const session = await install.offerInstall(assessment, { fix: true, yes: true, includeOptional: false, terminal: term, out: () => {}, env: missingImage.env, executor });
  term.close();
  assert.deepEqual(pulled, ["registry.example/jgates-tools:9"]);
  assert.deepEqual(session.outcomes.map((o) => [o.kind, o.status]), [["image-pull", "installed"]]);

  const stopped = project({ fake: { FAKE_DOCKER_DAEMON: "stopped" } });
  const second = install.assessEnvironment(stopped.dir, { env: stopped.env });
  const noTerm = await install.offerInstall(second, { fix: true, yes: true, includeOptional: false, terminal: install.NO_TERMINAL, out: () => {}, env: stopped.env, executor });
  assert.deepEqual(noTerm.outcomes.map((o) => [o.kind, o.status]), [["docker-start", "skipped"]]);
  assert.deepEqual(ran, [], "a system command needs its own yes on a terminal");
});
