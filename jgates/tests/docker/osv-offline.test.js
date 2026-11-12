import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { docker, dockerAvailable } from "./dev-docker.mjs";

// OSV-Scanner offline with the real engine (npm run test:docker): the scanner runs with `--network none` and the jgates-data
// volume, so it must not resolve transitive dependencies online. A requirements.txt without vulnerable packages ends the
// stage completed with no finding (it used to end in error, exit 127, lookup of api.deps.dev), and PyYAML==5.3.1 still
// reports PYSEC-2021-142. Needs the volume filled by `jgates tools update-data`.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(path.resolve(here, "..", ".."), "dist");
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
const baseEnv = { ...process.env, JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
delete baseEnv.JGATES_IMAGE_JSON;

before(() => {
  assert.ok(dockerAvailable(), "Docker is required for npm run test:docker (the daemon did not answer)");
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is missing; build it with npm --prefix jgates run image:build`);
  assert.equal(docker(["volume", "inspect", "jgates-data"]).code, 0, "the jgates-data volume is missing; run jgates tools update-data");
});

after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  for (const ws of workspaces) {
    const filters = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${ws}`];
    for (const id of docker(["ps", "-aq", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["rm", "-f", id]);
    for (const name of docker(["volume", "ls", "-q", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["volume", "rm", "-f", name]);
  }
});

function scan(requirements) {
  const project = tmp("jgates-osv-offline-project-");
  const home = tmp("jgates-osv-offline-home-");
  fs.writeFileSync(path.join(project, "requirements.txt"), requirements);
  const cli = (args) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env: { ...baseEnv, JGATES_HOME: home }, input: "", timeout: 1_800_000 });
  const git = (...args) => assert.equal(spawnSync("git", ["-c", "user.name=jgates-test", "-c", "user.email=test@example.invalid", ...args], { cwd: project }).status, 0);
  git("init", "-q");
  const init = cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  fs.writeFileSync(path.join(project, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  osv-scanner:\n    adapter: osv-scanner\n    capabilities: [dependencies]\n");
  git("add", "-A");
  workspaces.add(workspaceId(project));
  const r = cli(["run", "--cwd", project, "--no-interactive", "--json", "--only", "tool:osv-scanner"]);
  let doc = null;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    doc = null;
  }
  assert.ok(doc?.stages, `no result document\n${r.stdout.slice(0, 2000)}\n${r.stderr.slice(0, 2000)}`);
  const stage = doc.stages.find((s) => s.id.startsWith("osv-scanner#"));
  assert.ok(stage, JSON.stringify(doc.stages));
  return { doc, stage };
}

test("OSV-Scanner offline: a requirements.txt without vulnerable packages completes with no finding", () => {
  const { doc, stage } = scan("six==1.16.0\n");
  assert.equal(stage.state, "completed", JSON.stringify(stage));
  assert.deepEqual(doc.findings.filter((f) => f.tool === "osv-scanner" || f.origin === "osv-scanner"), []);
});

test("OSV-Scanner offline: PyYAML==5.3.1 still reports PYSEC-2021-142", () => {
  const { doc, stage } = scan("PyYAML==5.3.1\n");
  assert.equal(stage.state, "completed", JSON.stringify(stage));
  const ids = JSON.stringify(doc.findings);
  assert.ok(ids.includes("PYSEC-2021-142"), ids.slice(0, 2000));
});
