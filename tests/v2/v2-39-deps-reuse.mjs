import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-39 (fake engine): the project's dependencies are installed once and reused while their key holds. A Python
// project (pyproject.toml + uv.lock) with a check that runs project code is run four times through `jgates run`:
//   1. first run: the `deps` phase installs into a fresh volume jgates-<ws>-deps-root-<key12> (one deps container, with
//      network), the volume holds the key, and the step container gets the volume at /workspace/.venv with VIRTUAL_ENV;
//   2. second run: same key, "Dependências em dia (reaproveitadas)", no deps container is started;
//   3. uv.lock changes: a new key, a new volume, the install runs again and the old volume is removed;
//   4. uv.lock changes again and the install fails: the fresh volume is removed, the good one is kept, the check is
//      blocked with DEPENDENCIES_FAILED and the run is incomplete (exit 2); `jgates deps prepare` says the same.
// `jgates plan --json` records the same key in inputs.container.dependencyKeys.

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

test("V2-39: dependencies install once, are reused while the key holds, reinstall into a new volume on a lockfile change, and a failed install keeps the good volume", () => {
  const project = tmp("v2-39-project-");
  const home = tmp("v2-39-home-");
  const engine = tmp("v2-39-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  // The engine client gets only an allowlisted environment, so the fake's settings live in its launcher script.
  const engineScript = (depsExit) =>
    fs.writeFileSync(
      runtime,
      `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))};\nprocess.env.FAKE_DOCKER_DEPS_EXIT = ${JSON.stringify(String(depsExit))};\nrequire(${JSON.stringify(FAKE)});\n`,
    );
  engineScript(0);
  const baseEnv = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "pt-BR", NO_COLOR: "1" };
  const cli = (args, extra = {}) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env: { ...baseEnv, ...extra }, input: "", timeout: 240_000 });
  const dockerCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const objects = () => JSON.parse(fs.readFileSync(path.join(engine, "objects.json"), "utf8"));
  const depsVolumes = (ws) => objects().volumes.filter((v) => v.labels["org.jgates.kind"] === "deps" && v.labels["org.jgates.workspace"] === ws).map((v) => v.name).sort();

  fs.writeFileSync(path.join(project, "pyproject.toml"), '[project]\nname = "fx"\nversion = "0.1.0"\nrequires-python = ">=3.10"\ndependencies = []\n');
  fs.writeFileSync(path.join(project, "uv.lock"), UV_LOCK);
  fs.writeFileSync(path.join(project, "check.js"), "process.exit(0);\n");
  fs.mkdirSync(path.join(project, ".jgates", "templates"), { recursive: true });
  fs.writeFileSync(path.join(project, ".jgates", "templates", "py-check.yml"), TEMPLATE);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  assert.equal(cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]).status, 0);
  fs.appendFileSync(path.join(project, "jgates.yml"), "  - id: py-check\n    source: .jgates/templates/py-check.yml\n    activation: always\n");
  const only = ["--only", "tool:py-check"];

  /** One run: its result, the deps phase details and the docker calls it made. */
  const run = () => {
    fs.rmSync(calls, { force: true });
    const r = cli(["run", "--cwd", project, "--no-interactive", "--json", ...only]);
    const doc = JSON.parse(r.stdout);
    const events = fs.readFileSync(path.join(doc.runDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const phase = events.find((e) => e.type === "phase-finished" && e.data.phase === "deps");
    assert.ok(phase, `a deps phase: ${events.map((e) => `${e.type}:${e.data.phase ?? ""}`).join(", ")}`);
    const unit = phase.data.details.units.find((u) => u.unit === "root");
    assert.ok(unit, JSON.stringify(phase.data.details));
    const made = dockerCalls();
    const depsRuns = made.filter((c) => c[0] === "run" && c.includes("org.jgates.kind=deps"));
    const step = made.find((c) => c[0] === "run" && c.includes("org.jgates.kind=step") && c[c.indexOf("--name") + 1] === `jgates-${doc.runId}-py-check`);
    return { r, doc, unit, depsRuns, step };
  };
  const mountsOf = (call) => call.filter((a, i) => call[i - 1] === "--mount");
  const envOf = (call) => Object.fromEntries(call.filter((a, i) => call[i - 1] === "--env").map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
  const markerKey = (volume) => JSON.parse(fs.readFileSync(path.join(engine, "volumes", volume, ".jgates-deps.json"), "utf8")).key;

  // 1. First run: install into a fresh volume named after the key.
  const first = run();
  const ws = first.doc.workspace.id;
  assert.equal(first.r.status, 0, first.r.stdout + first.r.stderr);
  assert.equal(first.unit.status, "installed", JSON.stringify(first.unit));
  assert.match(first.unit.key, /^[0-9a-f]{64}$/);
  assert.equal(first.unit.volume, `jgates-${ws}-deps-root-${first.unit.key.slice(0, 12)}`);
  assert.equal(first.unit.manager, "uv");
  assert.equal(first.depsRuns.length, 1, "one deps container");
  const depsCall = first.depsRuns[0];
  assert.equal(depsCall[depsCall.indexOf("--network") + 1], "bridge", "the deps container is the one with network");
  assert.ok(mountsOf(depsCall).includes(`type=volume,src=${first.unit.volume},dst=/workspace/.venv`), mountsOf(depsCall).join(" | "));
  assert.ok(mountsOf(depsCall).includes("type=volume,src=jgates-cache,dst=/cache"), "the package cache is shared");
  assert.equal(markerKey(first.unit.volume), first.unit.key, "the key is stored in the volume");
  assert.deepEqual(depsVolumes(ws), [first.unit.volume]);
  const volumeLabels = objects().volumes.find((v) => v.name === first.unit.volume).labels;
  assert.equal(volumeLabels["org.jgates.deps.unit"], "root");
  assert.equal(volumeLabels["org.jgates.deps.key"], first.unit.key);
  // The step runs with the project's environment: the volume at /workspace/.venv, the cache, VIRTUAL_ENV and PATH.
  assert.ok(first.step, "the py-check step container");
  assert.equal(first.step[first.step.indexOf("--network") + 1], "none", "the check itself has no network");
  assert.ok(mountsOf(first.step).includes(`type=volume,src=${first.unit.volume},dst=/workspace/.venv`), mountsOf(first.step).join(" | "));
  assert.equal(envOf(first.step).VIRTUAL_ENV, "/workspace/.venv");
  assert.match(envOf(first.step).PATH, /^\/workspace\/\.venv\/bin:/);
  const stage = first.doc.stages.find((s) => s.id.startsWith("py-check"));
  assert.equal(stage.state, "completed", JSON.stringify(stage));

  // The plan records the same key.
  const planned = JSON.parse(cli(["plan", "--cwd", project, "--json", ...only]).stdout);
  assert.equal(planned.plan.inputs.container.dependencyKeys.root, first.unit.key);

  // 2. Second run: same key, reused, no deps container.
  const second = run();
  assert.equal(second.r.status, 0, second.r.stdout + second.r.stderr);
  assert.equal(second.unit.status, "reused");
  assert.equal(second.unit.key, first.unit.key);
  assert.equal(second.unit.volume, first.unit.volume);
  assert.match(second.unit.message, /Dependências em dia/);
  assert.equal(second.depsRuns.length, 0, "nothing is installed again");
  assert.ok(mountsOf(second.step).includes(`type=volume,src=${first.unit.volume},dst=/workspace/.venv`));
  const log = fs.readFileSync(path.join(second.doc.runDir, second.unit.log), "utf8");
  assert.match(log, /Dependências em dia \(reaproveitadas\)/);

  // 3. The lockfile changes: a new key, a fresh volume, swapped in; the old one is removed.
  fs.writeFileSync(path.join(project, "uv.lock"), UV_LOCK + "\n# changed\n");
  const third = run();
  assert.equal(third.r.status, 0, third.r.stdout + third.r.stderr);
  assert.equal(third.unit.status, "installed");
  assert.notEqual(third.unit.key, first.unit.key);
  assert.notEqual(third.unit.volume, first.unit.volume);
  assert.equal(third.depsRuns.length, 1);
  assert.deepEqual(third.unit.removedVolumes, [first.unit.volume]);
  assert.deepEqual(depsVolumes(ws), [third.unit.volume], "only the new volume is left");
  assert.equal(markerKey(third.unit.volume), third.unit.key);
  assert.ok(mountsOf(third.step).includes(`type=volume,src=${third.unit.volume},dst=/workspace/.venv`));

  // 4. Another change, and the install fails: the good volume stays, the check is blocked, the run is incomplete.
  fs.writeFileSync(path.join(project, "uv.lock"), UV_LOCK + "\n# changed again\n");
  engineScript(1);
  const fourth = run();
  assert.equal(fourth.r.status, 2, fourth.r.stdout + fourth.r.stderr);
  assert.equal(fourth.doc.decision, "incomplete");
  assert.equal(fourth.unit.status, "failed");
  assert.equal(fourth.unit.code, "DEPENDENCIES_FAILED");
  assert.equal(fourth.unit.keptVolume, third.unit.volume);
  assert.equal(fourth.depsRuns.length, 1, "the install was tried");
  assert.deepEqual(depsVolumes(ws), [third.unit.volume], "the fresh volume is gone, the good one is kept");
  assert.equal(fourth.step, undefined, "the check did not start");
  const blocked = fourth.doc.stages.find((s) => s.id.startsWith("py-check"));
  assert.equal(blocked.state, "blocked", JSON.stringify(blocked));
  assert.equal(blocked.execution.notRun.problems[0].code, "DEPENDENCIES_FAILED");
  assert.match(blocked.reason, /instalação das dependências do componente root falhou/);
  const failedLog = fs.readFileSync(path.join(fourth.doc.runDir, fourth.unit.log), "utf8");
  assert.match(failedLog, /fake install: the package index refused the request/);

  // `jgates deps prepare` reports the same failure; `deps status` shows it.
  const prepared = cli(["deps", "prepare", "--cwd", project, "--json"]);
  assert.equal(prepared.status, 1, prepared.stdout + prepared.stderr);
  const prepDoc = JSON.parse(prepared.stdout);
  assert.equal(prepDoc.code, "DEPENDENCIES_FAILED");
  assert.equal(prepDoc.units[0].keptVolume, third.unit.volume);
  const status = JSON.parse(cli(["deps", "status", "--cwd", project, "--json"]).stdout);
  assert.equal(status.units[0].state, "failed");
  assert.equal(status.units[0].volume, third.unit.volume);

  // With the install working again, `deps prepare` swaps in the new volume.
  engineScript(0);
  const fixed = cli(["deps", "prepare", "--cwd", project, "--json"]);
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
  const fixedUnit = JSON.parse(fixed.stdout).units[0];
  assert.equal(fixedUnit.status, "installed");
  assert.deepEqual(depsVolumes(ws), [fixedUnit.volume]);
  assert.equal(JSON.parse(cli(["deps", "status", "--cwd", project, "--json"]).stdout).units[0].state, "ready");
  // `deps clean` removes the workspace's dependency volumes (by label) and nothing else.
  const cleaned = JSON.parse(cli(["deps", "clean", "--cwd", project, "--json"]).stdout);
  assert.deepEqual(cleaned.removed, [fixedUnit.volume]);
  assert.deepEqual(depsVolumes(ws), []);
  assert.ok(objects().volumes.some((v) => v.name === `jgates-${ws}-src`), "the source volume is untouched");
  assert.ok(objects().volumes.some((v) => v.name === "jgates-cache"), "the shared cache is untouched");
});
