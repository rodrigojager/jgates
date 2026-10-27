import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LABEL, TOOL_LABEL, buildImage, builderCacheEmpty, docker, cleanupWork, dockerAvailable, labeledContainers, labeledImages } from "./dev-docker.mjs";

// Smoke with the real Docker (npm run test:docker; never part of npm test): Ruff runs in a container built by the
// jgates-dev builder, with the configuration file chosen in tools.yml, and changing that file changes the finding of
// the next run (the same check as the local runner, in a container); `runner: container` in tools.yml takes a plan and a run of the CLI to the
// same image. Afterwards only the last image stays: no container, volume or build cache.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "..", "dist");
const runner = await import(pathToFileURL(path.join(dist, "core", "runner", "index.js")).href);
const { chooseRuffConfig } = await import(pathToFileURL(path.join(dist, "adapters", "ruff", "config.js")).href);

const TAG = "jgates-dev/ruff:0.17.2";
// Everything this smoke creates carries the tool label too: the cleanup leaves the images of other smokes alone.
const TOOL = "ruff";
const SMOKE_LABELS = { "org.jgates.dev": "true", "org.jgates.tool": TOOL };
const MODULE = "import os\n\n\ndef f():\n    if True: return 1\n";
let imageId = "";
let dir = "";

const treeHash = (root) => {
  const h = crypto.createHash("sha256");
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(path.relative(root, p) + "\0").update(fs.readFileSync(p));
    }
  };
  walk(root);
  return h.digest("hex");
};

before(() => {
  assert.ok(dockerAvailable(), "Docker is required for npm run test:docker (the daemon did not answer)");
  cleanupWork({ tool: TOOL });
  imageId = buildImage({ context: path.resolve(here, "..", "..", "docker", "ruff"), tag: TAG });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-docker-smoke-"));
});

after(() => {
  try {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    // Runs on failure too: leaves the last image only.
    cleanupWork({ keep: imageId || null, tool: TOOL });
  }
});

async function ruffInContainer(workspace) {
  const choice = chooseRuffConfig(workspace, "ruff", ".");
  assert.equal(choice.source, "binding", "the configuration comes from tools.yml");
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-docker-out-"));
  try {
    const result = await runner.runContainer(
      {
        image: imageId,
        command: ["check", "--config", runner.toContainerPath(choice.file), "--no-fix", "--output-format", "json", "--cache-dir", "/output/ruff", "."],
        workspace,
        outputDir,
        labels: SMOKE_LABELS,
        timeoutMs: 120_000,
        limits: { memoryMb: 512, cpus: 1, pids: 128 },
      },
      {},
    );
    assert.equal(result.spawnError, null);
    assert.ok(result.exitCode === 0 || result.exitCode === 1, `ruff exit ${result.exitCode}: ${result.stderr}`);
    assert.equal(result.container.network, "none");
    assert.ok(fs.existsSync(path.join(outputDir, "ruff")), "the tool wrote in the separate output folder");
    return { choice, codes: JSON.parse(result.stdout).map((f) => f.code).sort() };
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

test("Ruff in the container reads the file chosen in tools.yml, and changing that file changes the next finding", async () => {
  fs.mkdirSync(path.join(dir, ".jgates"));
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  ruff:\n    adapter: ruff\n    config: lint.toml\n");
  fs.writeFileSync(path.join(dir, "mod.py"), MODULE);
  fs.writeFileSync(path.join(dir, "lint.toml"), '[lint]\nselect = ["F"]\n');
  const before = treeHash(dir);

  const first = await ruffInContainer(dir);
  assert.equal(first.choice.file, "lint.toml");
  assert.deepEqual(first.codes, ["F401"]);

  fs.writeFileSync(path.join(dir, "lint.toml"), '[lint]\nselect = ["E701"]\n');
  const second = await ruffInContainer(dir);
  assert.deepEqual(second.codes, ["E701"], "the next run follows the edited file");
  assert.notEqual(second.choice.sha256, first.choice.sha256);

  // The workspace is mounted read-only: the runs left it as the test wrote it (the edits above are the test's own).
  assert.notEqual(before, treeHash(dir));
  fs.writeFileSync(path.join(dir, "lint.toml"), '[lint]\nselect = ["F"]\n');
  assert.equal(before, treeHash(dir), "nothing but the test's own edit changed in the workspace");
});

test("the container cannot write in the workspace nor reach the network", () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-docker-out-"));
  try {
    // The arguments are the runner's own; only the entrypoint is swapped to probe the sandbox from inside.
    const probe = (code) => {
      const { args } = runner.buildContainerArgs({ image: imageId, command: ["-c", code], workspace: dir, outputDir, labels: SMOKE_LABELS });
      args.splice(args.indexOf(imageId), 0, "--entrypoint", "python");
      return docker(args);
    };
    const write = probe("open('/workspace/intruder.txt', 'w').write('x')");
    assert.notEqual(write.code, 0, "writing in the workspace must fail");
    assert.ok(!fs.existsSync(path.join(dir, "intruder.txt")));
    const net = probe("import socket; socket.create_connection(('1.1.1.1', 53), 3)");
    assert.notEqual(net.code, 0, "the network is off");
    const out = probe("open('/output/ok.txt', 'w').write('x')");
    assert.equal(out.code, 0, out.err);
    assert.ok(fs.existsSync(path.join(outputDir, "ok.txt")), "the output folder is writable");
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("runner: container in tools.yml: the plan picks the container runner and the run executes Ruff in the image", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-docker-plan-ws-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-docker-plan-home-"));
  // The image is pinned in .jgates/lock.json by `tools prepare` (no JGATES_*_IMAGE).
  const env = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1" };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [path.join(dist, "cli", "main.js"), ...args], { encoding: "utf8", env, timeout: 300_000 });
    try {
      return { code: r.status, doc: JSON.parse(r.stdout), raw: r.stdout + r.stderr };
    } catch {
      return { code: r.status, doc: null, raw: r.stdout + r.stderr };
    }
  };
  try {
    fs.writeFileSync(path.join(ws, "mod.py"), MODULE);
    fs.writeFileSync(path.join(ws, "lint.toml"), '[lint]\nselect = ["F"]\n');
    assert.equal(cli("init", "--cwd", ws, "--profile", "minimal", "--no-interactive", "--json").code, 0);
    fs.writeFileSync(path.join(ws, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  ruff:\n    adapter: ruff\n    capabilities: [lint]\n    runner: container\n    config: lint.toml\n");
    const prepared = cli("tools", "prepare", "--cwd", ws, "--instance", "ruff", "--image", imageId, "--no-interactive", "--json");
    assert.equal(prepared.code, 0, prepared.raw);
    assert.equal(prepared.doc.result.image.pinned, imageId);
    const before = treeHash(ws);

    const planned = cli("plan", "--cwd", ws, "--only", "tool:ruff", "--json");
    assert.equal(planned.code, 0, planned.raw);
    const item = planned.doc.plan.groups.willRun.find((i) => i.id === "ruff#lint");
    assert.equal(item.runtime.name, "container");
    assert.equal(item.availability.status, "available", item.availability.reason);
    assert.equal(item.command.container.image, imageId);
    assert.equal(item.versions.toolVersion, "0.17.2", "the version comes from the image label");

    const ran = cli("run", "--cwd", ws, "--only", "tool:ruff", "--no-interactive", "--json");
    assert.ok(ran.doc, ran.raw);
    const stage = ran.doc.stages.find((s) => s.id === "ruff#lint");
    assert.equal(stage.state, "completed", JSON.stringify(stage));
    assert.deepEqual(ran.doc.findings.filter((f) => f.tool === "ruff").map((f) => [f.ruleId, f.location.path]), [["F401", "mod.py"]]);
    assert.ok(fs.existsSync(path.join(ran.doc.runDir, "cache", "ruff", "CACHEDIR.TAG")), "Ruff wrote its cache in the run folder through /output");
    assert.deepEqual([ran.doc.workspaceChanges.added, ran.doc.workspaceChanges.modified, ran.doc.workspaceChanges.removed], [[], [], []]);
    assert.equal(treeHash(ws), before, "the workspace is as the test left it");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the work leaves one labeled image, no container and an empty builder cache", () => {
  cleanupWork({ keep: imageId, tool: TOOL });
  assert.equal(labeledImages(TOOL).length, 1, `images with ${LABEL} and ${TOOL_LABEL}=${TOOL}: ${labeledImages(TOOL).join(", ")}`);
  assert.deepEqual(labeledContainers(TOOL), []);
  assert.ok(builderCacheEmpty(), "the jgates-dev build cache is empty");
});
