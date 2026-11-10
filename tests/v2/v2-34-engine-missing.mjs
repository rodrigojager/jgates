import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-34 (fake engine): no engine, or an engine that is stopped.
//   - `setup` exits 2 with ENGINE_NOT_INSTALLED / ENGINE_STOPPED, the reason's action (an official link, or the text of the
//     start action) and the recipe (the install or start command, shown and never run), in English and in Portuguese;
//   - nothing is pulled, no volume is created and no container is run;
//   - `status` says the same with exit 2;
//   - `jgates run` is blocked with the same code and is never `passed`.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function machine({ stopped }) {
  const project = tmp("v2-34-project-");
  const home = tmp("v2-34-home-");
  const engine = tmp("v2-34-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = stopped ? path.join(engine, "docker.cjs") : path.join(engine, "no-such-container-engine");
  if (stopped) fs.writeFileSync(runtime, `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nprocess.env.FAKE_DOCKER_DAEMON = "stopped";\nrequire(${JSON.stringify(FAKE)});\n`);
  fs.writeFileSync(path.join(project, "mod.py"), "import os\n");
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", NO_COLOR: "1" };
  const cli = (args, locale = "en") => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env: { ...env, JGATES_LOCALE: locale }, input: "", timeout: 120_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, doc };
  };
  const dockerCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { project, cli, dockerCalls, engine };
}

test("V2-34: with the engine missing or stopped, setup exits 2 with ENGINE_NOT_INSTALLED / ENGINE_STOPPED and its actions, status says so and run is blocked", () => {
  for (const scenario of [
    { name: "not installed", stopped: false, code: "ENGINE_NOT_INSTALLED", recipe: "docker:install", english: /Docker is not installed/, portuguese: /O Docker não está instalado/, actionKind: "link" },
    { name: "stopped", stopped: true, code: "ENGINE_STOPPED", recipe: "docker:start", english: /Docker is installed, but it is stopped/, portuguese: /O Docker está instalado, mas parado/, actionKind: "none" },
  ]) {
    const m = machine(scenario);
    assert.equal(m.cli(["init", "--cwd", m.project, "--profile", "minimal", "--no-interactive", "--json"]).status, 0);

    const setup = m.cli(["setup", "--json"]);
    assert.equal(setup.status, 2, setup.stdout + setup.stderr);
    assert.ok(setup.doc, setup.stdout);
    assert.equal(setup.doc.status, "NOT_READY");
    assert.equal(setup.doc.ready, false);
    assert.equal(setup.doc.reasons.length, 1, JSON.stringify(setup.doc.reasons));
    const [reason] = setup.doc.reasons;
    assert.equal(reason.code, scenario.code);
    assert.match(reason.message, scenario.english);
    assert.equal(reason.action.kind, scenario.actionKind);
    assert.ok(reason.action.label.length > 0, "the action has a label");
    if (scenario.actionKind === "link") assert.match(reason.action.url, /^https:\/\/.*docker\.com\//);
    assert.equal(reason.recipe.id, scenario.recipe, "the install or start recipe is part of the answer");
    assert.ok(reason.recipe.available ? reason.recipe.commands.length > 0 : reason.recipe.reason.length > 0, JSON.stringify(reason.recipe));
    assert.deepEqual(setup.doc.steps.map((s) => [s.id, s.state]), [["engine", "failed"]]);
    // Nothing was pulled, created or run, and nothing was installed or started by setup.
    const used = m.dockerCalls();
    assert.ok(!used.some((c) => ["pull", "run", "load"].includes(c[0]) || (c[0] === "volume" && c[1] === "create")), JSON.stringify(used));

    // The same in Portuguese.
    const pt = m.cli(["setup", "--json"], "pt-BR");
    assert.equal(pt.status, 2);
    assert.match(pt.doc.reasons[0].message, scenario.portuguese);
    // And as text, with the action.
    const text = m.cli(["setup"]);
    assert.equal(text.status, 2);
    assert.match(text.stdout, /This machine is not ready yet\./);
    assert.ok(text.stdout.includes(scenario.code) && text.stdout.includes("What to do:"), text.stdout);

    const status = m.cli(["status", "--json"]);
    assert.equal(status.status, 2, status.stdout);
    assert.equal(status.doc.ready, false);
    assert.equal(status.doc.reasons[0].code, scenario.code);

    // `run` is blocked: not executed, never passed, with the same code and action.
    const run = m.cli(["run", "--cwd", m.project, "--json"]);
    assert.notEqual(run.status, 0, run.stdout);
    assert.ok(run.doc, run.stdout + run.stderr);
    assert.notEqual(run.doc.status, "passed");
    assert.equal(run.doc.executed, false);
    const blocker = run.doc.blockers.find((b) => b.code === scenario.code);
    assert.ok(blocker, JSON.stringify(run.doc.blockers));
    assert.ok(blocker.action.label.length > 0);
    assert.ok(!m.dockerCalls().some((c) => c[0] === "run"), "no container was started");
  }
});
