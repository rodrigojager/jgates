import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-44: the CLI and the tools image come from different releases. With the fake engine reporting an image built for
// another JGates version, `jgates plan --json` and `jgates run --json` report the blocker IMAGE_VERSION_MISMATCH with
// its text and its action in the chosen language, and the run never starts (nothing is executed, so it never ends
// `passed`). The fake engine records every call: the image is inspected, no container is ever run.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const IMAGE_VERSION = "0.0.1";

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};

test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = tmp("v2-44-ws-");
  const home = tmp("v2-44-home-");
  const bin = tmp("v2-44-bin-");
  const log = path.join(bin, "calls.jsonl");
  const runtime = path.join(bin, "docker.cjs");
  // The engine client gets a minimal environment, so the fake's settings are baked into the wrapper.
  const labels = JSON.stringify({ "org.jgates.version": IMAGE_VERSION });
  fs.writeFileSync(runtime, `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(log)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(bin)};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(labels)};\nrequire(${JSON.stringify(FAKE)});\n`);
  fs.writeFileSync(path.join(dir, "mod.py"), "import os\n");
  const env = {
    ...process.env,
    JGATES_HOME: home,
    JGATES_CONTAINER_RUNTIME: runtime,
    JGATES_TOOLS_IMAGE: "jgates-tools:dev",
    JGATES_NO_CACHE: "1",
    NO_COLOR: "1",
  };
  const cli = (args, locale) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { cwd: dir, encoding: "utf8", env: { ...env, JGATES_LOCALE: locale }, timeout: 120_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, doc };
  };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, cli, calls };
}

test("V2-44: an image of another JGates version blocks the plan and the run with IMAGE_VERSION_MISMATCH and its action", () => {
  const w = setup();
  const init = w.cli(["init", "--cwd", w.dir, "--profile", "minimal", "--no-interactive", "--json"], "en");
  assert.equal(init.status, 0, init.stderr || init.stdout);

  // The plan, in English: one mismatch blocker with the versions, the action and no raw engine text as the message.
  const plan = w.cli(["plan", "--cwd", w.dir, "--json"], "en");
  assert.ok(plan.doc, plan.stdout + plan.stderr);
  const planDoc = plan.doc.plan ?? plan.doc;
  const mismatches = planDoc.blockers.filter((b) => b.code === "IMAGE_VERSION_MISMATCH");
  assert.equal(mismatches.length, 1, JSON.stringify(planDoc.blockers));
  const [blocker] = mismatches;
  assert.equal(planDoc.approvable, false);
  assert.match(blocker.message, new RegExp(`version ${IMAGE_VERSION.replace(/\./g, "\\.")}`));
  assert.ok(blocker.message.includes(CLI_VERSION), blocker.message);
  assert.equal(blocker.action.label, "Download the tools of this version");
  assert.equal(blocker.action.kind, "command");
  assert.equal(blocker.action.command, "jgates setup");

  // The same blocker in Portuguese carries the pt-BR text and action.
  const ptPlan = w.cli(["plan", "--cwd", w.dir, "--json"], "pt-BR");
  const ptDoc = ptPlan.doc.plan ?? ptPlan.doc;
  const ptBlocker = ptDoc.blockers.find((b) => b.code === "IMAGE_VERSION_MISMATCH");
  assert.ok(ptBlocker, JSON.stringify(ptDoc.blockers));
  assert.match(ptBlocker.message, /Estas ferramentas são da versão 0\.0\.1/);
  assert.equal(ptBlocker.action.label, "Baixar as ferramentas desta versão");

  // The run is refused with the same blocker and never ends `passed`; no container is started.
  const run = w.cli(["run", "--cwd", w.dir, "--json"], "en");
  assert.notEqual(run.status, 0, run.stdout);
  assert.ok(run.doc, run.stdout + run.stderr);
  assert.notEqual(run.doc.status, "passed");
  assert.equal(run.doc.executed, false);
  assert.ok(run.doc.blockers.some((b) => b.code === "IMAGE_VERSION_MISMATCH" && b.action?.label === "Download the tools of this version"), JSON.stringify(run.doc.blockers));
  const engineCalls = w.calls();
  assert.ok(engineCalls.some((c) => c[0] === "image" && c[1] === "inspect"), "the image was inspected");
  assert.ok(!engineCalls.some((c) => c[0] === "run"), "no container was started");
});
