import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { docker, dockerAvailable } from "./dev-docker.mjs";

// Stack lint adapters with the real engine (npm run test:docker; never part of npm test): golangci-lint (Go), clippy
// (Rust), the .NET analyzers (C#), ShellCheck (shell scripts) and Hadolint (Dockerfiles) run through `jgates run` in step
// containers of the local development image jgates-tools:dev. Each stack has a fixture with a known defect (the issue is
// a located, blocking finding of the tool) and a clean twin (it passes). Nothing runs as a host process: every step is a
// `docker run` of the image, and the project folder is byte for byte the same afterwards (the only writes of the .NET
// build, bin/ and obj/, happen in the synced copy inside the engine, never in the project). The image is selected with
// JGATES_TOOLS_IMAGE; the host-side probes read the package's mirror of the image's image.json.

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const dist = path.join(packageRoot, "dist");
const MAIN = path.join(dist, "cli", "main.js");
const LINT_FIXTURES = path.join(packageRoot, "tests", "fixtures", "lint-stacks");
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

/** Everything this suite created in the engine carries its workspace id (and the JGates labels); the cleanup selects by them only. */
function cleanup() {
  for (const ws of workspaces) {
    const filters = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${ws}`];
    for (const id of docker(["ps", "-aq", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["rm", "-f", id]);
    for (const name of docker(["volume", "ls", "-q", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["volume", "rm", "-f", name]);
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

function treeHash(root) {
  const h = crypto.createHash("sha256");
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === ".git") continue;
      if (e.isDirectory()) {
        h.update(`d:${next}\0`);
        walk(p, next);
      } else h.update(`f:${next}\0`).update(fs.readFileSync(p));
    }
  };
  walk(root, "");
  return h.digest("hex");
}

/** A project in its own folder (the fixture copied, git initialized, JGates initialized: the lint template comes in by the evidence). Returns its CLI. */
function makeProject(copy) {
  const project = tmp("jgates-adapters-lint-project-");
  const home = tmp("jgates-adapters-lint-home-");
  fs.cpSync(copy, project, { recursive: true });
  const env = { ...process.env, JGATES_HOME: home, JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  delete env.JGATES_IMAGE_JSON;
  const cli = (args, timeout = 900_000) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  const init = cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  spawnSync("git", ["add", "-A"], { cwd: project });
  const ws = workspaceId(project);
  workspaces.add(ws);
  return {
    project,
    ws,
    run: (tool) => {
      const ran = cli(["run", "--cwd", project, "--no-interactive", "--json", "--only", `tool:${tool}`]);
      let doc = null;
      try {
        doc = JSON.parse(ran.stdout);
      } catch {
        doc = null;
      }
      assert.ok(doc?.stages, `${tool}: no result document\n${ran.stdout.slice(0, 3000)}\n${ran.stderr.slice(0, 3000)}`);
      return { code: ran.status, doc };
    },
  };
}

const found = (doc, tool) => doc.findings.filter((f) => f.tool === tool || f.origin === tool);
const summary = (doc) => JSON.stringify({ decision: doc.decision, stages: doc.stages.map((s) => [s.id, s.state, s.reason]), findings: doc.findings.map((f) => [f.tool, f.ruleId, f.location?.path]) }).slice(0, 4000);

/** All the step logs of a run (stdout and stderr) as one text. */
function logsOf(doc) {
  const dir = path.join(doc.runDir, "logs");
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), "utf8")).join("\n=====\n") : "";
}

/** The run really went through the engine: a step container of the image, with the contract's flags, and nothing else. */
function assertRanInContainers(doc, ws) {
  const logs = logsOf(doc);
  for (const part of ["run --rm --init --pull never --name", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges"]) {
    assert.ok(logs.includes(part), `a step log holds the docker run flag ${part}`);
  }
  assert.ok(!/HOST_EXECUTION_REFUSED/.test(JSON.stringify(doc.stages)), "no step was refused");
  assert.equal(docker(["ps", "-aq", "--filter", `label=org.jgates.workspace=${ws}`]).out.trim(), "", "no container of the run is left");
}

/** The fixture with the defect fails its lint with a located finding of the tool; its clean twin passes; the project folder stays untouched. */
function scenario(name, { stack, tool, rule }) {
  test(name, () => {
    for (const kind of ["bad", "clean"]) {
      const p = makeProject(path.join(LINT_FIXTURES, stack, kind));
      const before = treeHash(p.project);
      const { doc } = p.run(tool);
      assert.equal(treeHash(p.project), before, `${kind}: the project folder is identical after the run`);
      assert.deepEqual(doc.workspaceChanges?.added ?? [], [], `${kind}: nothing was added to the project`);
      assertRanInContainers(doc, p.ws);
      const stage = doc.stages.find((s) => s.id === `${tool}#lint`);
      assert.ok(stage, `${kind}: the lint stage of ${tool} exists: ${summary(doc)}`);
      const mine = found(doc, rule.tool);
      if (kind === "bad") {
        assert.equal(stage.state, "completed", `bad: ${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
        assert.ok(mine.length > 0, `bad: the tool reported findings: ${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
        const hit = mine.find((f) => f.ruleId === rule.id && f.location?.path === rule.path);
        assert.ok(hit, `bad: rule ${rule.id} at ${rule.path} among ${JSON.stringify(mine.map((f) => [f.ruleId, f.location]))}`);
        assert.equal(hit.category, "lint");
        assert.equal(hit.blocking, true);
        assert.ok(hit.location.line >= 1, "the finding is located");
        assert.notEqual(doc.decision, "passed", `bad: the run must not pass: ${summary(doc)}`);
      } else {
        assert.equal(stage.state, "completed", `clean: ${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
        assert.equal(mine.length, 0, `clean: no finding: ${summary(doc)}`);
        assert.equal(doc.decision, "passed", `clean: ${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
      }
    }
  });
}

scenario("lint go: golangci-lint flags the unchecked error and the clean twin passes", {
  stack: "go",
  tool: "golangci-lint",
  rule: { tool: "golangci-lint", id: "errcheck", path: "main.go" },
});

scenario("lint rust: clippy flags the length comparison and the clean twin passes", {
  stack: "rust",
  tool: "clippy",
  rule: { tool: "clippy", id: "clippy::len_zero", path: "src/main.rs" },
});

scenario("lint csharp: the .NET analyzers flag the ignored result and the clean twin passes", {
  stack: "csharp",
  tool: "dotnet-analyzers",
  rule: { tool: "dotnet-analyzers", id: "CA1806", path: "Program.cs" },
});

scenario("lint shell: shellcheck flags the unquoted variable and the clean twin passes", {
  stack: "shell",
  tool: "shellcheck",
  rule: { tool: "shellcheck", id: "SC2086", path: "deploy.sh" },
});

scenario("lint docker: hadolint flags the latest tag and the clean twin passes", {
  stack: "docker",
  tool: "hadolint",
  rule: { tool: "hadolint", id: "DL3007", path: "Dockerfile" },
});
