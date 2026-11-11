import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-48 (fake engine): the extension image and the own tools that run on it. A project registers two own tools with
// `jgates tools add-custom` (a SARIF tool and a JUnit tool, both installed in the project's own image), builds the image
// with `jgates tools build-extension`, and runs them: the SARIF tool gives a finding with file and line, the JUnit tool a
// failing test with file and line, and both steps run on the extension image (not on the tools image). A change of the
// Dockerfile makes the next plan and run refuse with EXTENSION_OUTDATED and its action (the build command) before any
// step container starts; a new tools image does the same with another cause; `--dry-run` prints the files' diff and writes
// nothing; and an own tool never counts as a validated capability in the support matrix.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const TOOLS_ID = `sha256:${"a".repeat(64)}`;
const NEW_TOOLS_ID = `sha256:${"b".repeat(64)}`;

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const SARIF = JSON.stringify({
  version: "2.1.0",
  runs: [
    {
      tool: { driver: { name: "acme-lint", version: "1.0", rules: [{ id: "AC001" }] } },
      results: [{ ruleId: "AC001", level: "error", message: { text: "Do not use eval" }, locations: [{ physicalLocation: { artifactLocation: { uri: "/workspace/app.py" }, region: { startLine: 7, startColumn: 3 } } }] }],
    },
  ],
});
const JUNIT = [
  '<?xml version="1.0"?>',
  '<testsuites><testsuite name="acme" tests="2" failures="1">',
  '<testcase classname="tests.test_app" name="test_ok" file="tests/test_app.py" line="3"/>',
  '<testcase classname="tests.test_app" name="test_add" file="tests/test_app.py" line="9"><failure message="assert 1 == 2">trace</failure></testcase>',
  "</testsuite></testsuites>",
].join("\n");

function setup() {
  const project = tmp("v2-48-project-");
  const home = tmp("v2-48-home-");
  const engine = tmp("v2-48-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(
    runtime,
    `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))};\nprocess.env.FAKE_DOCKER_IMAGE_ID = ${JSON.stringify(TOOLS_ID)};\ntry { Object.assign(process.env, JSON.parse(require("node:fs").readFileSync(${JSON.stringify(path.join(engine, "env.json"))}, "utf8"))); } catch {}\nrequire(${JSON.stringify(FAKE)});\n`,
  );
  const base = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  const cli = (args, engineEnv = {}) => {
    fs.writeFileSync(path.join(engine, "env.json"), JSON.stringify(engineEnv));
    return spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env: base, input: "", timeout: 240_000 });
  };
  const dockerCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const stepRuns = () => dockerCalls().filter((c) => c[0] === "run" && c.includes("org.jgates.kind=step"));
  const images = () => JSON.parse(fs.readFileSync(path.join(engine, "objects.json"), "utf8")).images;

  fs.writeFileSync(path.join(project, "app.py"), "def add(a, b):\n    return a + b\n\n\nresult = eval('1')\n");
  fs.mkdirSync(path.join(project, "tests"));
  fs.writeFileSync(path.join(project, "tests", "test_app.py"), "def test_add():\n    assert 1 + 1 == 2\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  assert.equal(cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]).status, 0);
  spawnSync("git", ["add", "-A"], { cwd: project });
  return { project, cli, dockerCalls, stepRuns, images, engine };
}

const ADD_SARIF = ["tools", "add-custom", "sarif-tool", "--install", "pip:acme-lint==1.0", "--command", "acme-lint", "--arg=--out={output}/lint.sarif", "--arg", "{workspace}", "--report", "sarif:lint.sarif", "--capability", "sast"];
const ADD_JUNIT = ["tools", "add-custom", "junit-tool", "--install", "pip:acme-tests==2.0", "--command", "acme-tests", "--arg=--junit={output}/tests.xml", "--report", "junit:tests.xml", "--capability", "tests"];

test("V2-48: own tools from an extension image give findings with file and line, and a Dockerfile change is EXTENSION_OUTDATED with the action", () => {
  const { project, cli, dockerCalls, stepRuns, images } = setup();
  const toolsFile = path.join(project, ".jgates", "tools.yml");
  const dockerfile = path.join(project, ".jgates", "image", "Dockerfile");

  // 1. --dry-run prints the diff of tools.yml and of the Dockerfile and writes nothing.
  const toolsBefore = fs.existsSync(toolsFile) ? fs.readFileSync(toolsFile, "utf8") : null;
  const dry = cli([...ADD_SARIF, "--cwd", project, "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr + dry.stdout);
  assert.match(dry.stdout, /\+\+\+ b\/\.jgates\/tools\.yml/);
  assert.match(dry.stdout, /\+\s+sarif-tool:/);
  assert.match(dry.stdout, /\+\+\+ b\/\.jgates\/image\/Dockerfile/);
  assert.match(dry.stdout, /\+RUN .*uv tool install .*acme-lint==1\.0/);
  assert.equal(fs.existsSync(toolsFile) ? fs.readFileSync(toolsFile, "utf8") : null, toolsBefore, "tools.yml untouched by --dry-run");
  assert.equal(fs.existsSync(dockerfile), false, "no Dockerfile written by --dry-run");
  const dryJson = JSON.parse(cli([...ADD_SARIF, "--cwd", project, "--dry-run", "--json"]).stdout);
  assert.equal(dryJson.dryRun, true);
  assert.deepEqual(dryJson.changes.map((c) => c.file).sort(), [".jgates/image/Dockerfile", ".jgates/tools.yml"]);
  assert.deepEqual(dryJson.written, []);
  assert.equal(fs.existsSync(dockerfile), false);

  // A value that would put shell text in the Dockerfile is refused.
  const hostile = cli([...ADD_SARIF.slice(0, 5), "pip:x; rm -rf /", ...ADD_SARIF.slice(6), "--cwd", project]);
  assert.notEqual(hostile.status, 0);
  assert.equal(fs.existsSync(dockerfile), false);

  // 2. The two own tools are registered for real.
  for (const add of [ADD_SARIF, ADD_JUNIT]) {
    const added = cli([...add, "--cwd", project, "--json"]);
    assert.equal(added.status, 0, added.stderr + added.stdout);
  }
  const docker = fs.readFileSync(dockerfile, "utf8");
  assert.match(docker, /^ARG JGATES_TOOLS\nFROM \$\{JGATES_TOOLS\}\n/);
  assert.match(docker, /acme-lint==1\.0/);
  assert.match(docker, /acme-tests==2\.0/);
  const tools = fs.readFileSync(toolsFile, "utf8");
  assert.match(tools, /image: extension/);
  assert.match(tools, /kind: sarif/);
  const again = cli([...ADD_SARIF, "--cwd", project, "--json"]);
  assert.notEqual(again.status, 0, "an existing id is refused");

  // 3. Before the image is built, the plan blocks the steps that use it with EXTENSION_OUTDATED and the build command.
  const plan0 = JSON.parse(cli(["plan", "--cwd", project, "--only", "tool:sarif-tool", "--only", "tool:junit-tool", "--json"]).stdout);
  const outdated0 = (plan0.plan ?? plan0).blockers.find((b) => b.code === "EXTENSION_OUTDATED");
  assert.ok(outdated0, JSON.stringify((plan0.plan ?? plan0).blockers));
  assert.equal(outdated0.action.kind, "command");
  assert.equal(outdated0.action.command, "jgates tools build-extension");
  assert.deepEqual([...outdated0.items].sort(), ["junit-tool", "sarif-tool"]);
  const refused = cli(["run", "--cwd", project, "--no-interactive", "--json", "--only", "tool:sarif-tool"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /EXTENSION_OUTDATED/);
  assert.equal(stepRuns().length, 0, "no step container started");

  // 4. The build needs a yes, then it is one `docker build` on the tools image with the JGates labels.
  const noYes = cli(["tools", "build-extension", "--cwd", project, "--no-interactive"]);
  assert.notEqual(noYes.status, 0);
  assert.equal(dockerCalls().filter((c) => c[0] === "build").length, 0);
  const built = cli(["tools", "build-extension", "--cwd", project, "--yes", "--json"]);
  assert.equal(built.status, 0, built.stderr + built.stdout);
  const builtDoc = JSON.parse(built.stdout);
  assert.equal(builtDoc.built, true);
  assert.match(builtDoc.tag, /^jgates-ext-ws_[0-9a-f]{16}:[0-9a-f]{16}$/);
  const buildCalls = dockerCalls().filter((c) => c[0] === "build");
  assert.equal(buildCalls.length, 1);
  const build = buildCalls[0];
  assert.ok(build.includes("JGATES_TOOLS=jgates-tools:dev"), build.join(" "));
  assert.ok(build.includes("--pull=false"));
  assert.ok(build.includes("org.jgates.managed=true"));
  assert.ok(build.includes("org.jgates.kind=extension-image"));
  assert.equal(build[build.indexOf("--tag") + 1], builtDoc.tag);
  assert.equal(path.resolve(build[build.length - 1]), path.join(project, ".jgates", "image"));
  assert.ok(dockerCalls().some((c) => c[0] === "image" && c[1] === "prune" && c.includes("label=org.jgates.managed=true")), "dangling images pruned by label only");
  const extImage = images().find((i) => `${i.name}:${i.tag}` === builtDoc.tag);
  assert.ok(extImage, "the fake engine holds the built image");
  // A second build with nothing changed builds nothing.
  assert.equal(JSON.parse(cli(["tools", "build-extension", "--cwd", project, "--yes", "--json"]).stdout).built, false);
  assert.equal(dockerCalls().filter((c) => c[0] === "build").length, 1);

  // 5. The run: both steps run on the extension image, and their reports become findings with file and line.
  const outputs = JSON.stringify({
    "sarif-tool": { "outputs/generic-command/sarif-tool/lint.sarif": SARIF },
    "junit-tool": { "outputs/generic-command/junit-tool/tests.xml": JUNIT },
  });
  const run = cli(["run", "--cwd", project, "--no-interactive", "--json", "--only", "tool:sarif-tool", "--only", "tool:junit-tool"], { FAKE_DOCKER_OUTPUT_FILES: outputs });
  const doc = JSON.parse(run.stdout);
  const steps = stepRuns();
  assert.equal(steps.length, 2, JSON.stringify(steps.map((c) => c[c.indexOf("--name") + 1])));
  for (const call of steps) {
    assert.ok(call.includes(extImage.id), `the step runs on the extension image: ${call.join(" ")}`);
    assert.ok(!call.includes(TOOLS_ID), "not on the tools image");
    assert.equal(call[call.indexOf("--network") + 1], "none");
  }
  const sarif = doc.findings.find((f) => f.tool === "sarif-tool");
  assert.ok(sarif, JSON.stringify(doc.stages.map((s) => [s.id, s.state, s.reason])));
  assert.equal(sarif.ruleId, "AC001");
  assert.equal(sarif.location.path, "app.py");
  assert.equal(sarif.location.line, 7);
  assert.equal(sarif.origin, "own-tool");
  assert.equal(sarif.blocking, true);
  const junit = doc.findings.find((f) => f.tool === "junit-tool");
  assert.ok(junit, JSON.stringify(doc.findings));
  assert.equal(junit.location.path, "tests/test_app.py");
  assert.equal(junit.location.line, 9);
  assert.equal(junit.origin, "own-tool");
  assert.equal(doc.decision, "failed");

  // 6. A change of the Dockerfile: the plan and the run refuse before any step container starts, with the action.
  fs.appendFileSync(dockerfile, "RUN echo changed\n");
  const before = stepRuns().length;
  const plan1 = JSON.parse(cli(["plan", "--cwd", project, "--only", "tool:sarif-tool", "--json"]).stdout);
  const outdated1 = (plan1.plan ?? plan1).blockers.find((b) => b.code === "EXTENSION_OUTDATED");
  assert.ok(outdated1, "a changed Dockerfile is outdated");
  assert.equal(outdated1.action.command, "jgates tools build-extension");
  assert.match(outdated1.message, /Dockerfile or a file next to it changed/);
  const refused1 = cli(["run", "--cwd", project, "--no-interactive", "--json", "--only", "tool:sarif-tool"], { FAKE_DOCKER_OUTPUT_FILES: outputs });
  assert.notEqual(refused1.status, 0);
  assert.match(refused1.stdout + refused1.stderr, /EXTENSION_OUTDATED/);
  assert.equal(stepRuns().length, before, "no step container started for the outdated image");

  // 7. The rebuild replaces the old tag; then a new tools image (a JGates update) makes it outdated again, for that reason.
  const rebuilt = JSON.parse(cli(["tools", "build-extension", "--cwd", project, "--yes", "--json"]).stdout);
  assert.equal(rebuilt.built, true);
  assert.notEqual(rebuilt.tag, builtDoc.tag);
  assert.deepEqual(rebuilt.removed, [builtDoc.tag]);
  assert.equal(images().filter((i) => i.name === extImage.name).length, 1, "one extension image per workspace");
  const plan2 = JSON.parse(cli(["plan", "--cwd", project, "--only", "tool:sarif-tool", "--json"], { FAKE_DOCKER_IMAGE_ID: NEW_TOOLS_ID }).stdout);
  const outdated2 = (plan2.plan ?? plan2).blockers.find((b) => b.code === "EXTENSION_OUTDATED");
  assert.ok(outdated2, "a new tools image makes the extension outdated");
  assert.match(outdated2.message, /tools image changed/);
  const planOk = JSON.parse(cli(["plan", "--cwd", project, "--only", "tool:sarif-tool", "--json"]).stdout);
  assert.equal((planOk.plan ?? planOk).blockers.some((b) => b.code === "EXTENSION_OUTDATED"), false, "the rebuilt image is current");
  assert.ok(((planOk.plan ?? planOk).inputs.container.extensionImages ?? []).some((i) => i.name === rebuilt.tag && i.digest === rebuilt.digest), "the plan pins the extension image by its id");

  // 8. An own tool is never counted as a validated capability in the support matrix.
  const matrix = JSON.parse(cli(["tools", "matrix", "--cwd", project, "--json"]).stdout);
  assert.equal(matrix.matrix.rows.filter((r) => r.adapter === "generic-command" && r.state === "validated").length, 0);
});
