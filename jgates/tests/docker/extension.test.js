import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { docker, dockerAvailable } from "./dev-docker.mjs";

// The extension image with the real engine (npm run test:docker; never part of npm test): a fixture project registers a
// small pip tool (bandit, with its SARIF extra) with `jgates tools add-custom`, builds its own image on top of the local
// development image jgates-tools:dev with `jgates tools build-extension`, and runs the tool through `jgates tools test`. The
// tool runs in a step container of the extension image (not of the tools image) and its SARIF report becomes a located
// finding. Changing the Dockerfile makes the tool refuse to run until the image is rebuilt. Everything this suite creates in
// the engine carries the JGates labels and its workspace id; the cleanup selects by them only (the extension image is
// removed by its workspace label, never by name).

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

function cleanup() {
  for (const ws of workspaces) {
    const filters = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${ws}`];
    for (const id of docker(["ps", "-aq", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["rm", "-f", id]);
    for (const name of docker(["volume", "ls", "-q", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["volume", "rm", "-f", name]);
    for (const id of docker(["image", "ls", "-q", "--no-trunc", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["image", "rm", "-f", id]);
  }
}

before(() => {
  assert.ok(dockerAvailable(), "Docker is required for npm run test:docker (the daemon did not answer)");
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is missing; build it with npm --prefix jgates run image:build`);
});

after(() => {
  try {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } finally {
    cleanup();
  }
});

test("a pip tool installed in the project's own image runs through `jgates tools test`, in the extension image, with a located finding; a Dockerfile change needs a rebuild", () => {
  const project = tmp("jgates-extension-project-");
  const home = tmp("jgates-extension-home-");
  const env = { ...process.env, JGATES_HOME: home, JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  delete env.JGATES_IMAGE_JSON;
  const cli = (args, timeout = 1_500_000) => spawnSync(process.execPath, [MAIN, ...args, "--cwd", project], { cwd: project, encoding: "utf8", env, input: "", timeout });
  fs.writeFileSync(path.join(project, "app.py"), "def run(cmd):\n    return 1\n\n\ndef risky(text):\n    return eval(text)\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  assert.equal(cli(["init", "--profile", "minimal", "--no-interactive", "--json"]).status, 0);
  spawnSync("git", ["add", "-A"], { cwd: project });
  const ws = workspaceId(project);
  workspaces.add(ws);

  const added = cli([
    "tools", "add-custom", "bandit",
    "--install", "pip:bandit[sarif]==1.8.6",
    "--command", "bandit",
    "--arg=-r", "--arg", ".",
    "--arg=-f", "--arg", "sarif",
    "--arg=-o", "--arg", "{output}/bandit.sarif",
    "--report", "sarif:bandit.sarif",
    "--capability", "sast",
    "--json",
  ]);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  assert.match(fs.readFileSync(path.join(project, ".jgates", "image", "Dockerfile"), "utf8"), /uv tool install --force --no-cache 'bandit\[sarif\]==1\.8\.6'/);

  // The first `tools test` builds the image (the plan said EXTENSION_OUTDATED) and runs the tool in it.
  const tested = cli(["tools", "test", "bandit", "--json"]);
  const doc = JSON.parse(tested.stdout || "{}");
  const buildLog = fs.existsSync(path.join(home, "workspaces", ws, "logs", "extension-build.log")) ? fs.readFileSync(path.join(home, "workspaces", ws, "logs", "extension-build.log"), "utf8").slice(-3000) : "(no build log)";
  assert.equal(doc.state, "findings", `${tested.stdout.slice(0, 2500)}\n${tested.stderr.slice(0, 1500)}\n${buildLog}`);
  assert.equal(tested.status, 0);
  assert.equal(doc.build.built, true);
  assert.ok(doc.findingCount >= 1);
  const finding = doc.sample.find((f) => f.path === "app.py" && f.rule === "B307");
  assert.ok(finding, JSON.stringify(doc.sample));
  assert.equal(finding.line, 6, "located at the eval call");

  // The image is labelled and is the one the step container ran on.
  const labelled = docker(["image", "ls", "--no-trunc", "--format", "{{.Repository}}:{{.Tag}} {{.ID}}", "--filter", "label=org.jgates.managed=true", "--filter", "label=org.jgates.kind=extension-image", "--filter", `label=org.jgates.workspace=${ws}`]).out.trim().split("\n").filter(Boolean);
  assert.equal(labelled.length, 1, labelled.join("\n"));
  const [tag, id] = labelled[0].split(" ");
  assert.equal(tag, doc.build.tag);
  const runPlan = JSON.parse(fs.readFileSync(path.join(doc.runDir, "plan.json"), "utf8"));
  assert.ok(runPlan.inputs.container.extensionImages.some((i) => i.name === tag && i.digest === id), "the plan pinned the image by its id");
  const stderrLogs = fs.readdirSync(path.join(doc.runDir, "logs")).filter((n) => n.endsWith(".stderr.log")).map((n) => fs.readFileSync(path.join(doc.runDir, "logs", n), "utf8")).join("\n");
  assert.ok(stderrLogs.includes(id), "the step container ran on the extension image");
  assert.ok(stderrLogs.includes("--network none"), "and without a network");
  assert.equal(docker(["ps", "-aq", "--filter", `label=org.jgates.workspace=${ws}`]).out.trim(), "", "no container is left");

  // A second test reuses the image: nothing is built.
  const again = JSON.parse(cli(["tools", "test", "bandit", "--json"]).stdout);
  assert.equal(again.state, "findings");
  assert.equal(again.build, null, "an image that is current is not rebuilt");

  // A change of the Dockerfile: the plan refuses to run the tool until the image is rebuilt.
  fs.appendFileSync(path.join(project, ".jgates", "image", "Dockerfile"), "LABEL org.example.note=changed\n");
  const refused = JSON.parse(cli(["tools", "test", "bandit", "--no-build", "--json"]).stdout);
  assert.equal(refused.state, "blocked");
  assert.ok(refused.blockers.some((b) => b.code === "EXTENSION_OUTDATED" && b.action.command === "jgates tools build-extension"), JSON.stringify(refused.blockers));
  const rebuilt = JSON.parse(cli(["tools", "build-extension", "--yes", "--json"]).stdout);
  assert.equal(rebuilt.built, true);
  assert.notEqual(rebuilt.tag, tag);
  assert.deepEqual(rebuilt.removed, [tag]);
});
