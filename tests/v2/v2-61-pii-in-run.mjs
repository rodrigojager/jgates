import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-61 (fake engine): the personal-data check works in a normal validation. The built-in PII stage of a run is one step
// container; its request travels on standard input, so the target must be a folder of the container (/workspace), never the
// host path of the project. A fixture with a valid CPF gives a completed stage with a pii.cpf finding that carries file and
// line (and never the value); a clean fixture gives no finding and no error stage; no recorded engine call or request has a
// host path as the detector's target.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const CPF = "529.982.247-25";

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function run(files) {
  const project = tmp("v2-61-project-");
  const home = tmp("v2-61-home-");
  const engine = tmp("v2-61-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(
    runtime,
    `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))};\nrequire(${JSON.stringify(FAKE)});\n`,
  );
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  delete env.JGATES_PYTHON;
  const cli = (args) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout: 240_000 });
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
    fs.writeFileSync(path.join(project, name), text);
  }
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  assert.equal(cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]).status, 0);
  spawnSync("git", ["add", "-A"], { cwd: project });
  fs.rmSync(calls, { force: true });
  const result = cli(["run", "--cwd", project, "--no-interactive", "--json", "--only", "tool:builtin-pii"]);
  let doc;
  try {
    doc = JSON.parse(result.stdout);
  } catch {
    assert.fail(`no JSON from the run: ${result.stdout}\n${result.stderr}`);
  }
  const piiStages = doc.stages.filter((s) => s.adapter === "builtin-pii");
  const requests = fs.existsSync(path.join(engine, "pii-step.jsonl")) ? fs.readFileSync(path.join(engine, "pii-step.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const dockerCalls = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { doc, project, piiStages, requests, dockerCalls, stdout: result.stdout };
}

function assertTargetInContainer(r) {
  assert.ok(r.requests.length > 0, "the detector ran in a step container");
  for (const request of r.requests) assert.match(request.target, /^\/workspace(\/|$)/, `target seen by the detector: ${request.target}`);
  assert.ok(!r.dockerCalls.some((c) => c.some((a) => String(a).includes(r.project))), "no host project path reached the engine");
}

test("V2-61: a normal run finds the CPF with file and line, with the target inside the container", () => {
  const r = run({ "src/app.py": "def add(a, b):\n    return a + b\n", "data/customers.csv": `name,cpf\nAna,${CPF}\n` });
  assert.ok(r.piiStages.length > 0, `the PII stage is in the result: ${JSON.stringify(r.doc.stages.map((s) => [s.id, s.adapter, s.state]))}`);
  for (const stage of r.piiStages) assert.equal(stage.state, "completed", `${stage.id}: ${stage.state} ${stage.reason ?? ""}`);
  const findings = r.doc.findings.filter((f) => f.ruleId === "pii.cpf");
  assert.equal(findings.length, 1, JSON.stringify(r.doc.findings));
  assert.equal(findings[0].location.path, "data/customers.csv");
  assert.equal(findings[0].location.line, 2);
  assert.ok(!r.stdout.includes(CPF), "the value is never shown");
  assertTargetInContainer(r);
});

test("V2-61: a clean project has no PII finding and no error stage", () => {
  const r = run({ "src/app.py": "def add(a, b):\n    return a + b\n", "README.md": "nothing personal here\n" });
  assert.ok(r.piiStages.length > 0, "the PII stage is in the result");
  for (const stage of r.piiStages) assert.equal(stage.state, "completed", `${stage.id}: ${stage.state} ${stage.reason ?? ""}`);
  assert.deepEqual(r.doc.findings.filter((f) => f.ruleId.startsWith("pii.")), []);
  assert.ok(!r.doc.stages.some((s) => s.state === "error"), JSON.stringify(r.doc.stages.filter((s) => s.state === "error")));
  assertTargetInContainer(r);
});
