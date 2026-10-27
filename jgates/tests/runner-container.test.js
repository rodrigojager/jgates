import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The container runner against a fake runtime that records its arguments: the
// command has the image by digest, a read-only workspace, no network, the limits, and never --privileged or the Docker
// socket; cancelling asks for the container to be removed and the step ends cancelled. The real Docker is exercised
// by tests/docker (npm run test:docker), not here.

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = await import(pathToFileURL(path.resolve(here, "..", "dist", "core", "runner", "index.js")).href);
const FAKE = path.join(here, "docker", "fake-docker.cjs");
fs.chmodSync(FAKE, 0o755);

const DIGEST = "sha256:" + "ab".repeat(32);
const IMAGE = `registry.example/jgates/ruff@${DIGEST}`;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAKE_ENV = ["FAKE_DOCKER_LOG", "FAKE_DOCKER_STATE", "FAKE_DOCKER_MODE", "FAKE_DOCKER_STDOUT", "FAKE_DOCKER_EXIT"];

function sandbox(extraEnv = {}) {
  const dir = tmp("jgates-container-");
  const workspace = path.join(dir, "ws");
  const output = path.join(dir, "out");
  fs.mkdirSync(workspace);
  fs.mkdirSync(output);
  const log = path.join(dir, "calls.jsonl");
  const parentEnv = { ...process.env, FAKE_DOCKER_LOG: log, FAKE_DOCKER_STATE: dir, ...extraEnv };
  const options = { parentEnv, envAllowlist: [...runner.DEFAULT_ENV_ALLOWLIST, ...FAKE_ENV] };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, workspace, output, options, calls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const baseSpec = (s, over = {}) => ({ runtime: FAKE, image: IMAGE, command: ["check", "--no-fix", "."], workspace: s.workspace, outputDir: s.output, ...over });

test("the recorded command pins the image, mounts the workspace read-only, turns the network off and sets the limits", async () => {
  const s = sandbox({ FAKE_DOCKER_STDOUT: "[]" });
  try {
    const result = await runner.runContainer(baseSpec(s, { cwd: "api", limits: { memoryMb: 512, cpus: 1.5, pids: 64 }, env: { RUFF_CACHE_DIR: "/output/cache" }, labels: { "org.jgates.dev": "true" } }), s.options);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "[]");
    const [call] = s.calls();
    assert.equal(call[0], "run");
    const joined = call.join(" ");
    assert.ok(call.includes(IMAGE), "image by digest");
    assert.ok(call.includes("--read-only"), "read-only root filesystem");
    assert.ok(call.includes(`type=bind,src=${s.workspace},dst=/workspace,readonly`), "workspace mounted read-only");
    assert.ok(call.includes(`type=bind,src=${s.output},dst=/output`), "separate writable output folder");
    assert.deepEqual(call.slice(call.indexOf("--network"), call.indexOf("--network") + 2), ["--network", "none"]);
    assert.equal(call[call.indexOf("--memory") + 1], "512m");
    assert.equal(call[call.indexOf("--memory-swap") + 1], "512m", "no swap beyond the memory limit");
    assert.equal(call[call.indexOf("--cpus") + 1], "1.5");
    assert.equal(call[call.indexOf("--pids-limit") + 1], "64");
    assert.equal(call[call.indexOf("--workdir") + 1], "/workspace/api");
    assert.deepEqual(call.slice(call.indexOf("--cap-drop"), call.indexOf("--cap-drop") + 2), ["--cap-drop", "ALL"]);
    assert.ok(call.includes("no-new-privileges"));
    assert.ok(call.includes("RUFF_CACHE_DIR=/output/cache"));
    assert.ok(call.includes("org.jgates.dev=true"));
    assert.deepEqual(call.slice(call.indexOf(IMAGE)), [IMAGE, "check", "--no-fix", "."], "the tool command follows the image");
    assert.doesNotMatch(joined, /--privileged/);
    assert.doesNotMatch(joined, /docker\.sock/);
    assert.doesNotMatch(joined, /--network (host|bridge)/);
    assert.equal(call[call.indexOf("--user") + 1], runner.defaultContainerUser());
    assert.notEqual(call[call.indexOf("--user") + 1].split(":")[0], "0", "not root by default");
    assert.deepEqual(result.container.args, call.slice(0), "the facts carry the exact arguments");
    assert.equal(result.container.rootException, false);
    assert.equal(result.container.removalRequested, false);
    // Nothing of the parent environment reaches the container except what the spec gives.
    assert.ok(!call.some((a) => /FAKE_DOCKER|HOME=|PATH=/.test(a)));
  } finally {
    s.cleanup();
  }
});

test("a tag, a socket mount, a bad limit and a path out of the workspace are refused before anything runs", async () => {
  const s = sandbox();
  try {
    const refused = async (over, code) => {
      await assert.rejects(runner.runContainer(baseSpec(s, over), s.options), (e) => e instanceof runner.ContainerSpecError && e.code === code, code);
    };
    await refused({ image: "ghcr.io/astral-sh/ruff:latest" }, "IMAGE_NOT_PINNED");
    await refused({ image: "ruff:0.17.2" }, "IMAGE_NOT_PINNED");
    await refused({ workspace: "/var/run/docker.sock" }, "BAD_MOUNT");
    await refused({ outputDir: "relative/out" }, "BAD_MOUNT");
    await refused({ workspace: "/tmp/a,dst=/etc" }, "BAD_MOUNT");
    await refused({ limits: { memoryMb: 0 } }, "BAD_LIMIT");
    await refused({ limits: { pids: 1.5 } }, "BAD_LIMIT");
    await refused({ cwd: "../etc" }, "BAD_CWD");
    await refused({ env: { "A=B": "x" } }, "BAD_ENV");
    assert.deepEqual(s.calls(), [], "the runtime was never called");
    assert.equal(runner.toContainerPath("a/b"), "/workspace/a/b");
    assert.equal(runner.toContainerPath("."), "/workspace");
  } finally {
    s.cleanup();
  }
});

test("network and root are declared exceptions, reported in the facts", async () => {
  const s = sandbox();
  try {
    const result = await runner.runContainer(baseSpec(s, { network: "bridge", user: "root" }), s.options);
    const [call] = s.calls();
    assert.equal(call[call.indexOf("--network") + 1], "bridge");
    assert.equal(call[call.indexOf("--user") + 1], "root");
    assert.equal(result.container.network, "bridge");
    assert.equal(result.container.rootException, true);
    assert.doesNotMatch(call.join(" "), /--privileged/);
  } finally {
    s.cleanup();
  }
});

test("the exit code of the tool comes through and a runtime failure (125) is told apart", async () => {
  const s = sandbox({ FAKE_DOCKER_EXIT: "1" });
  const f = sandbox({ FAKE_DOCKER_EXIT: "125" });
  try {
    const tool = await runner.runContainer(baseSpec(s), s.options);
    assert.equal(tool.exitCode, 1);
    assert.equal(tool.container.runtimeFailure, false);
    const runtime = await runner.runContainer(baseSpec(f), f.options);
    assert.equal(runtime.exitCode, 125);
    assert.equal(runtime.container.runtimeFailure, true);
  } finally {
    s.cleanup();
    f.cleanup();
  }
});

test("a missing runtime is a spawn error, not a result", async () => {
  const s = sandbox();
  try {
    const result = await runner.runContainer(baseSpec(s, { runtime: path.join(s.dir, "no-such-docker") }), s.options);
    assert.equal(result.exitCode, null);
    assert.ok(result.spawnError);
  } finally {
    s.cleanup();
  }
});

test("cancelling a container step asks the runtime to remove the container and the stage ends cancelled", async () => {
  const s = sandbox({ FAKE_DOCKER_MODE: "hang" });
  try {
    const controller = new AbortController();
    let containerName = null;
    const step = {
      id: "ruff-container",
      skeleton: () => ({ stages: [{ id: "ruff-container#lint", state: "pending" }], requirements: [{ id: "ruff-container#lint", required: true }], disabled: [], findings: [], logs: [], outputs: [] }),
      run: async () => {
        const result = await runner.runContainer(baseSpec(s), s.options);
        containerName = result.container.name;
        return {
          stages: [{ id: "ruff-container#lint", state: "completed", interpreted: true }],
          requirements: [{ id: "ruff-container#lint", required: true }],
          disabled: [],
          findings: [],
          logs: [],
          outputs: [],
        };
      },
    };
    const running = runner.executeSteps([step], { signal: controller.signal, killGraceMs: 200 });
    const until = Date.now() + 5000;
    while (!fs.readdirSync(s.dir).some((f) => f.endsWith(".container"))) {
      assert.ok(Date.now() < until, "the fake container started");
      await sleep(25);
    }
    controller.abort();
    const done = await running;
    assert.equal(done.cancelled, true);
    assert.equal(done.reports[0].output.stages[0].state, "cancelled");
    const calls = s.calls();
    const rm = calls.find((c) => c[0] === "rm");
    assert.ok(rm, "the runtime was asked to remove the container");
    assert.deepEqual(rm.slice(0, 2), ["rm", "--force"]);
    const name = calls[0][calls[0].indexOf("--name") + 1];
    assert.equal(rm[rm.length - 1], name, "by the name the run gave it");
    assert.deepEqual(fs.readdirSync(s.dir).filter((f) => f.endsWith(".container")), [], "no container is left");
    assert.ok(containerName === null || containerName === name);
  } finally {
    s.cleanup();
  }
});

test("a timeout also removes the container", async () => {
  const s = sandbox({ FAKE_DOCKER_MODE: "hang" });
  try {
    const result = await runner.runContainer(baseSpec(s, { timeoutMs: 400 }), { ...s.options, killGraceMs: 200 });
    assert.equal(result.timedOut, true);
    assert.equal(result.container.removalRequested, true);
    assert.ok(s.calls().some((c) => c[0] === "rm" && c.includes(result.container.name)));
    assert.deepEqual(fs.readdirSync(s.dir).filter((f) => f.endsWith(".container")), []);
  } finally {
    s.cleanup();
  }
});
