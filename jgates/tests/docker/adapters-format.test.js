import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { docker, dockerAvailable } from "./dev-docker.mjs";

// Format-check adapter with the real engine (npm run test:docker; never part of npm test): ruff format, prettier,
// gofmt, cargo fmt and dotnet format run through `jgates run` in step containers of the local development image
// jgates-tools:dev. Each stack has an unformatted fixture (the files the formatter would change are blocking findings)
// and a formatted twin (it passes). Nothing runs as a host process: every step is a `docker run` of the image, and the
// project folder is byte for byte the same afterwards. The image is selected with JGATES_TOOLS_IMAGE; the host-side
// probes read the package's mirror of the image's image.json, so there is no stand-in for any tool on the host.

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const dist = path.join(packageRoot, "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FORMAT_FIXTURES = path.join(packageRoot, "tests", "fixtures", "format-check");
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

/**
 * A project in its own folder (files written, git initialized, JGates initialized), with the tools.yml of the case when
 * given (otherwise the instances `jgates init` derives from the evidence). Returns its CLI.
 */
function makeProject({ files = {}, copy = null, tools = null, extraEnv = {} }) {
  const project = tmp("jgates-adapters-format-project-");
  const home = tmp("jgates-adapters-format-home-");
  if (copy) fs.cpSync(copy, project, { recursive: true });
  const write = (entries) => {
    for (const [name, content] of entries) {
      fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
      fs.writeFileSync(path.join(project, name), content);
    }
  };
  // `jgates init` refuses a project that already has a .jgates folder: those files come after it.
  write(Object.entries(files).filter(([name]) => !name.startsWith(".jgates/")));
  const env = { ...process.env, JGATES_HOME: home, JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", ...extraEnv };
  delete env.JGATES_IMAGE_JSON;
  const cli = (args, timeout = 900_000) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  const init = cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  write(Object.entries(files).filter(([name]) => name.startsWith(".jgates/")));
  if (tools !== null) fs.writeFileSync(path.join(project, ".jgates", "tools.yml"), tools);
  spawnSync("git", ["add", "-A"], { cwd: project });
  const ws = workspaceId(project);
  workspaces.add(ws);
  return {
    project,
    home,
    ws,
    cli,
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

/**
 * The bad project fails its check (a finding of the tool, or a failed decision) and the clean one passes, both through
 * the real engine and both leaving the project folder untouched.
 */
function scenario(name, { bad, clean, tool, rule, badStage = "completed", blocking = true, check = () => {} }) {
  test(name, () => {
    for (const kind of ["bad", "clean"]) {
      const p = makeProject(kind === "bad" ? bad : clean);
      const before = treeHash(p.project);
      const { doc } = p.run(tool);
      assert.equal(treeHash(p.project), before, `${kind}: the project folder is identical after the run`);
      assert.deepEqual(doc.workspaceChanges?.added ?? [], [], `${kind}: nothing was added to the project`);
      assertRanInContainers(doc, p.ws);
      const stage = doc.stages.find((s) => s.id.startsWith(`${tool}#`));
      assert.ok(stage, `${kind}: the stage of ${tool} exists: ${summary(doc)}`);
      if (kind === "bad") {
        const mine = found(doc, rule.tool ?? tool);
        assert.equal(stage.state, badStage, `bad: ${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
        assert.ok(mine.length > 0, `bad: the tool reported findings: ${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
        if (rule.id) assert.ok(mine.some((f) => (rule.id instanceof RegExp ? rule.id.test(f.ruleId) : f.ruleId === rule.id)), `bad: rule ${rule.id} among ${JSON.stringify(mine.map((f) => f.ruleId))}`);
        if (rule.path) assert.ok(mine.some((f) => f.location?.path === rule.path), `bad: a finding at ${rule.path}: ${JSON.stringify(mine.map((f) => f.location))}`);
        if (blocking) assert.notEqual(doc.decision, "passed", `bad: the run must not pass: ${summary(doc)}`);
        check(doc, p, "bad");
      } else {
        assert.equal(stage.state, "completed", `clean: ${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
        assert.equal(found(doc, rule.tool ?? tool).length, 0, `clean: no finding: ${summary(doc)}`);
        assert.equal(doc.decision, "passed", `clean: ${summary(doc)}\n${logsOf(doc).slice(-2500)}`);
        check(doc, p, "clean");
      }
    }
  });
}

const toolsYml = (id, adapter, capabilities, extra = "") => `schemaVersion: 1\ntools:\n  ${id}:\n    adapter: ${adapter}\n    capabilities: [${capabilities}]\n${extra}`;

const formatTools = (id, formatter) => toolsYml(id, "format-check", "format-check", `    formatter: ${formatter}\n`);

scenario("format-check python: ruff format --check flags the unformatted module and the formatted twin passes", {
  tool: "ruff-format",
  rule: { tool: "ruff", id: "format-check.unformatted", path: "app.py" },
  bad: { copy: path.join(FORMAT_FIXTURES, "python", "bad"), tools: formatTools("ruff-format", "ruff") },
  clean: { copy: path.join(FORMAT_FIXTURES, "python", "clean"), tools: formatTools("ruff-format", "ruff") },
});

scenario("format-check typescript: prettier --check flags the unformatted module and the formatted twin passes", {
  tool: "prettier",
  rule: { tool: "prettier", id: "format-check.unformatted", path: "src/index.ts" },
  bad: { copy: path.join(FORMAT_FIXTURES, "typescript", "bad"), tools: formatTools("prettier", "prettier") },
  clean: { copy: path.join(FORMAT_FIXTURES, "typescript", "clean"), tools: formatTools("prettier", "prettier") },
});

scenario("format-check go: gofmt -l flags the unformatted file and the formatted twin passes", {
  tool: "gofmt",
  rule: { tool: "gofmt", id: "format-check.unformatted", path: "main.go" },
  bad: { copy: path.join(FORMAT_FIXTURES, "go", "bad"), tools: formatTools("gofmt", "gofmt") },
  clean: { copy: path.join(FORMAT_FIXTURES, "go", "clean"), tools: formatTools("gofmt", "gofmt") },
});

scenario("format-check rust: cargo fmt --check flags the unformatted crate and the formatted twin passes", {
  tool: "cargo-fmt",
  rule: { tool: "rustfmt", id: "format-check.unformatted", path: "src/main.rs" },
  bad: { copy: path.join(FORMAT_FIXTURES, "rust", "bad"), tools: formatTools("cargo-fmt", "rustfmt") },
  clean: { copy: path.join(FORMAT_FIXTURES, "rust", "clean"), tools: formatTools("cargo-fmt", "rustfmt") },
});

scenario("format-check csharp: dotnet format whitespace flags the unformatted file and the formatted twin passes", {
  tool: "dotnet-format",
  rule: { tool: "dotnet-format", id: "format-check.unformatted", path: "Program.cs" },
  bad: { copy: path.join(FORMAT_FIXTURES, "csharp", "bad"), tools: formatTools("dotnet-format", "dotnet") },
  clean: { copy: path.join(FORMAT_FIXTURES, "csharp", "clean"), tools: formatTools("dotnet-format", "dotnet") },
});