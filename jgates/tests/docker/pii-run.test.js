import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { docker, dockerAvailable } from "./dev-docker.mjs";

// The personal-data check in a normal run with the real engine (npm run test:docker). The sample project is cloned (never
// used in place) from JGATES_E2E_PROJECT, by default D:/projeto-teste-jgates. On `master` the built-in PII stage of
// `jgates run` reports the CPFs of tests/fixtures/customers.csv (file and line, never the value); on `correcoes` the
// stage completes with no PII finding. Before the fix the detector received the host path and refused the run.

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(here, "..", "..", "dist", "cli", "main.js");
const SAMPLE = process.env.JGATES_E2E_PROJECT || "D:/projeto-teste-jgates";
const FIXTURE = "tests/fixtures/customers.csv";

const dirs = [];
const workspaces = new Set();
const tmp = (prefix) => {
  const base = process.env.JGATES_E2E_TMP ? path.resolve(process.env.JGATES_E2E_TMP) : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, prefix));
  dirs.push(dir);
  return dir;
};
const env = { ...process.env, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_LOCALE: "en", NO_COLOR: "1" };
delete env.JGATES_PYTHON;
delete env.JGATES_CONTAINER_RUNTIME;

before(() => {
  assert.ok(dockerAvailable(), "Docker is required for npm run test:docker (the daemon did not answer)");
  assert.ok(fs.existsSync(path.join(SAMPLE, ".git")), `the sample project is not at ${SAMPLE} (set JGATES_E2E_PROJECT)`);
});

after(() => {
  // Only what this test created for its workspaces, selected by the JGates label.
  for (const id of workspaces) {
    const filter = `label=org.jgates.workspace=${id}`;
    const containers = docker(["ps", "-aq", "--filter", filter]).out.split(/\s+/).filter(Boolean);
    if (containers.length > 0) docker(["rm", "-f", ...containers]);
    const volumes = docker(["volume", "ls", "-q", "--filter", filter]).out.split(/\s+/).filter(Boolean);
    if (volumes.length > 0) docker(["volume", "rm", "-f", ...volumes]);
  }
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function cloneAt(branch) {
  const dir = path.join(tmp("pii-run-"), "project");
  const clone = spawnSync("git", ["clone", "-q", "--branch", branch, SAMPLE, dir], { encoding: "utf8" });
  assert.equal(clone.status, 0, clone.stderr);
  // The JGates configuration of the sample is not committed: the clone gets a copy of it.
  fs.copyFileSync(path.join(SAMPLE, "jgates.yml"), path.join(dir, "jgates.yml"));
  fs.cpSync(path.join(SAMPLE, ".jgates"), path.join(dir, ".jgates"), { recursive: true });
  return dir;
}

function piiRun(project) {
  const home = tmp("pii-run-home-");
  const r = spawnSync(process.execPath, [MAIN, "run", "--cwd", project, "--no-interactive", "--json", "--only", "tool:builtin-pii"], {
    encoding: "utf8",
    env: { ...env, JGATES_HOME: home },
    input: "",
    timeout: 540_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  let doc;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    assert.fail(`no JSON from the run (exit ${r.status}): ${r.stdout.slice(0, 500)}\n${r.stderr.slice(0, 500)}`);
  }
  if (doc.workspace?.id) workspaces.add(doc.workspace.id);
  return { doc, stdout: r.stdout };
}

test("master: jgates run reports the CPFs of customers.csv with file and line, in a completed stage", () => {
  const { doc, stdout } = piiRun(cloneAt("master"));
  const stages = doc.stages.filter((s) => s.adapter === "builtin-pii");
  assert.ok(stages.length > 0, JSON.stringify(doc.stages.map((s) => [s.id, s.adapter, s.state, s.reason])));
  for (const stage of stages) assert.equal(stage.state, "completed", `${stage.id}: ${stage.state} ${stage.reason ?? ""}`);
  const findings = doc.findings.filter((f) => f.ruleId === "pii.cpf");
  assert.ok(findings.length > 0, "at least one pii.cpf finding");
  for (const f of findings) {
    assert.equal(f.location.path, FIXTURE);
    assert.ok(f.location.line >= 1, "the finding carries a line");
  }
  assert.ok(!/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/.test(stdout), "no CPF value in the output");
});

test("correcoes: the PII stage completes with no PII finding", () => {
  const { doc } = piiRun(cloneAt("correcoes"));
  const stages = doc.stages.filter((s) => s.adapter === "builtin-pii");
  assert.ok(stages.length > 0, JSON.stringify(doc.stages.map((s) => [s.id, s.adapter, s.state, s.reason])));
  for (const stage of stages) assert.equal(stage.state, "completed", `${stage.id}: ${stage.state} ${stage.reason ?? ""}`);
  assert.deepEqual(doc.findings.filter((f) => f.category === "pii"), []);
});
