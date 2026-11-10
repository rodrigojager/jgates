import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-40 (fake engine): a pinned language version is fetched once into the toolchain volume and shared. Two workspaces
// (two project folders, one JGates home) pin Python 3.11 with `.python-version`:
//   1. the first run starts one `toolchain` container (with network) that runs `uv python install 3.11` into
//      jgates-toolchains, then the deps container creates the virtual environment on 3.11 with the toolchain volume
//      mounted, and the step container gets the same volume (read-only) with UV_PYTHON_INSTALL_DIR;
//   2. the second workspace issues no toolchain container at all (the recorded engine calls show none): it reuses the
//      version and only installs its own dependencies;
//   3. a project that pins an unknown version (2.5) is not ready: no toolchain or deps container starts, the check is
//      blocked with DEPENDENCIES_NOT_READY, the run is incomplete, and the unit offers "Usar a versão padrão" and
//      "Corrigir .python-version";
//   4. choosing the default version for one run (JGATES_TOOLCHAIN_DEFAULT=python) installs with the image's Python.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const TEMPLATE = [
  "schemaVersion: 1",
  "id: py-check",
  "extends: [builtin:base]",
  "config:",
  "  tools:",
  "    py-check:",
  "      adapter: generic-command",
  "      enabled: true",
  "      capabilities: [lint]",
  `      command: ${JSON.stringify(process.execPath)}`,
  '      args: ["{workspace}/check.js"]',
  "      config:",
  "        effects: { readsCode: true, writesOutputs: false, mayChangeCode: false, executesProjectCode: true, usesNetwork: false }",
  "        evidence: { kind: exit-code }",
  "",
].join("\n");

const UV_LOCK = 'version = 1\nrequires-python = ">=3.10"\n\n[[package]]\nname = "fx"\nversion = "0.1.0"\nsource = { virtual = "." }\n';

test("V2-40: a pinned Python is fetched once into the toolchain volume and the second workspace reuses it; an unknown version is not ready with two actions", () => {
  const home = tmp("v2-40-home-");
  const engine = tmp("v2-40-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(
    runtime,
    `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))};\nrequire(${JSON.stringify(FAKE)});\n`,
  );
  const baseEnv = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "pt-BR", NO_COLOR: "1" };
  delete baseEnv.JGATES_TOOLCHAIN_DEFAULT;
  const dockerCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const kindOf = (call, kind) => call[0] === "run" && call.includes(`org.jgates.kind=${kind}`);
  const mountsOf = (call) => call.filter((a, i) => call[i - 1] === "--mount");
  const envOf = (call) => Object.fromEntries(call.filter((a, i) => call[i - 1] === "--env").map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
  const commandOf = (call) => call.slice(call.indexOf("-c", call.indexOf("jgates-tools:dev") >= 0 ? call.indexOf("jgates-tools:dev") : 0) + 1).join(" ");

  /** A project with a Python check, pinned to `pin` (null: no pin). */
  const makeProject = (pin) => {
    const project = tmp("v2-40-project-");
    fs.writeFileSync(path.join(project, "pyproject.toml"), '[project]\nname = "fx"\nversion = "0.1.0"\nrequires-python = ">=3.10"\ndependencies = []\n');
    fs.writeFileSync(path.join(project, "uv.lock"), UV_LOCK);
    if (pin) fs.writeFileSync(path.join(project, ".python-version"), `${pin}\n`);
    fs.writeFileSync(path.join(project, "check.js"), "process.exit(0);\n");
    fs.mkdirSync(path.join(project, ".jgates", "templates"), { recursive: true });
    fs.writeFileSync(path.join(project, ".jgates", "templates", "py-check.yml"), TEMPLATE);
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
    const cli = (args, extra = {}) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env: { ...baseEnv, ...extra }, input: "", timeout: 240_000 });
    assert.equal(cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]).status, 0);
    fs.appendFileSync(path.join(project, "jgates.yml"), "  - id: py-check\n    source: .jgates/templates/py-check.yml\n    activation: always\n");
    return { project, cli };
  };
  /** One run of a project: its result, the deps phase unit and the docker calls it made. */
  const run = ({ project, cli }, extra = {}) => {
    fs.rmSync(calls, { force: true });
    const r = cli(["run", "--cwd", project, "--no-interactive", "--json", "--only", "tool:py-check"], extra);
    const doc = JSON.parse(r.stdout);
    const events = fs.readFileSync(path.join(doc.runDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const phase = events.find((e) => e.type === "phase-finished" && e.data.phase === "deps");
    assert.ok(phase, `a deps phase: ${events.map((e) => `${e.type}:${e.data.phase ?? ""}`).join(", ")}`);
    const unit = phase.data.details.units.find((u) => u.unit === "root");
    assert.ok(unit, JSON.stringify(phase.data.details));
    const made = dockerCalls();
    const step = made.find((c) => kindOf(c, "step") && c[c.indexOf("--name") + 1] === `jgates-${doc.runId}-py-check`);
    return { r, doc, unit, toolchain: made.filter((c) => kindOf(c, "toolchain")), deps: made.filter((c) => kindOf(c, "deps")), step };
  };

  // 1. The first workspace fetches Python 3.11 into the toolchain volume.
  const first = run(makeProject("3.11"));
  assert.equal(first.r.status, 0, first.r.stdout + first.r.stderr);
  assert.equal(first.unit.status, "installed", JSON.stringify(first.unit));
  assert.equal(first.toolchain.length, 1, "one toolchain container");
  const fetchCall = first.toolchain[0];
  assert.equal(fetchCall[fetchCall.indexOf("--network") + 1], "bridge", "the download has network");
  assert.ok(mountsOf(fetchCall).includes("type=volume,src=jgates-toolchains,dst=/toolchains"), mountsOf(fetchCall).join(" | "));
  assert.match(fetchCall.join(" "), /uv python install '3\.11'/);
  assert.equal(envOf(fetchCall).UV_PYTHON_INSTALL_DIR, "/toolchains/uv-python");
  assert.equal(first.deps.length, 1);
  const depsCall = first.deps[0];
  assert.ok(mountsOf(depsCall).includes("type=volume,src=jgates-toolchains,dst=/toolchains,readonly"), "the install sees the toolchains read-only");
  assert.match(depsCall.join(" "), /uv' 'venv' '--allow-existing' '--python' '3\.11'/, "the virtual environment is created on Python 3.11");
  assert.equal(envOf(depsCall).UV_PYTHON_DOWNLOADS, "never");
  assert.deepEqual(first.unit.toolchains.map((t) => [t.id, t.status]), [["python-3.11", "fetched"]]);
  assert.ok(first.step, "the step container");
  assert.ok(mountsOf(first.step).includes("type=volume,src=jgates-toolchains,dst=/toolchains,readonly"), mountsOf(first.step).join(" | "));
  assert.equal(envOf(first.step).UV_PYTHON_INSTALL_DIR, "/toolchains/uv-python");
  const volume = JSON.parse(fs.readFileSync(path.join(engine, "objects.json"), "utf8")).volumes.find((v) => v.name === "jgates-toolchains");
  assert.equal(volume.labels["org.jgates.kind"], "toolchain");
  assert.equal(volume.labels["org.jgates.managed"], "true");
  assert.equal(volume.labels["org.jgates.workspace"], undefined, "the toolchains belong to the machine, not to a workspace");

  // 2. A second workspace pinning the same version downloads nothing; it installs its own dependencies.
  const second = run(makeProject("3.11"));
  assert.notEqual(second.doc.workspace.id, first.doc.workspace.id, "another workspace");
  assert.equal(second.r.status, 0, second.r.stdout + second.r.stderr);
  assert.equal(second.unit.status, "installed");
  assert.equal(second.toolchain.length, 0, "no new toolchain download");
  assert.equal(second.deps.length, 1, "its own dependencies are installed");
  assert.deepEqual(second.unit.toolchains.map((t) => [t.id, t.status]), [["python-3.11", "reused"]]);
  assert.ok(mountsOf(second.step).includes("type=volume,src=jgates-toolchains,dst=/toolchains,readonly"));
  assert.notEqual(second.unit.volume, first.unit.volume);

  // 3. An unknown version is not ready: nothing starts, the actions are offered.
  const unknown = makeProject("2.5");
  const third = run(unknown);
  assert.equal(third.r.status, 2, third.r.stdout + third.r.stderr);
  assert.equal(third.doc.decision, "incomplete");
  assert.equal(third.unit.status, "not-ready");
  assert.equal(third.unit.code, "DEPENDENCIES_NOT_READY");
  assert.match(third.unit.message, /Python 2\.5/);
  assert.equal(third.toolchain.length, 0);
  assert.equal(third.deps.length, 0);
  assert.equal(third.step, undefined, "the check did not start");
  const labels = third.unit.actions.map((a) => a.label);
  assert.ok(labels.some((l) => l.startsWith("Usar a versão padrão")), labels.join(" | "));
  assert.ok(labels.includes("Corrigir .python-version"), labels.join(" | "));
  assert.deepEqual(third.unit.actions.map((a) => a.id), ["use-default-version", "fix-version-file"]);
  const blocked = third.doc.stages.find((s) => s.id.startsWith("py-check"));
  assert.equal(blocked.state, "blocked", JSON.stringify(blocked));
  assert.equal(blocked.execution.notRun.problems[0].code, "DEPENDENCIES_NOT_READY");

  // 4. The default version for this run: the image's Python installs, no toolchain involved.
  const fourth = run(unknown, { JGATES_TOOLCHAIN_DEFAULT: third.unit.actions[0].env.JGATES_TOOLCHAIN_DEFAULT });
  assert.equal(fourth.r.status, 0, fourth.r.stdout + fourth.r.stderr);
  assert.equal(fourth.unit.status, "installed");
  assert.equal(fourth.toolchain.length, 0);
  assert.equal(fourth.deps.length, 1);
  assert.match(fourth.deps[0].join(" "), /'--python' '\/usr\/local\/bin\/python3'/);
  assert.equal(mountsOf(fourth.deps[0]).some((m) => m.includes("/toolchains")), false);
  assert.equal(commandOf(fourth.deps[0]).includes("3.11"), false);
});
