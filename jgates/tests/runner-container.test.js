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

// ---- The step launcher (container-first): the same adapter command, in a container or natively in the image ----

const STEP_ENV = [...FAKE_ENV, "FAKE_DOCKER_LABELS", "FAKE_DOCKER_IMAGE_ID"];

/** A run's launcher on the fake engine; `inspect` false: the engine has no tools image. */
function launcherSandbox({ inspect = true, imageJson = null } = {}) {
  const s = sandbox(inspect ? { FAKE_DOCKER_LABELS: JSON.stringify({ "org.jgates.version": "1.2.3" }) } : { FAKE_DOCKER_LABELS: "none" });
  const runDir = path.join(s.dir, "run");
  fs.mkdirSync(runDir);
  const env = { ...s.options.parentEnv, JGATES_TOOLS_IMAGE: "jgates-tools:dev", ...(imageJson ? { JGATES_IMAGE_JSON: imageJson } : { JGATES_IMAGE_JSON: path.join(s.dir, "absent-image.json") }) };
  const engine = { runtime: FAKE, runnerOptions: { parentEnv: env, envAllowlist: [...runner.DEFAULT_ENV_ALLOWLIST, ...STEP_ENV] } };
  const launcher = runner.createStepLauncher({ env, workspaceId: "ws_0123456789abcdef", runId: "run-1", runDir, projectDir: s.workspace, version: "1.2.3", engine });
  return { ...s, runDir, env, launcher };
}

const inStep = (launcher, launch, fn) => runner.runInScope({ stepId: "tool-a", ...(launcher ? { launcher } : {}), ...(launch ? { launch } : {}) }, fn);
const stepRuns = (s) => s.calls().filter((c) => c[0] === "run");
const flag = (c, name) => c[c.indexOf(name) + 1];

test("a step process becomes one docker run with the contract, the default resources and no network", async () => {
  const s = launcherSandbox();
  try {
    assert.ok(s.launcher, "a launcher outside the image");
    const result = await inStep(s.launcher, { network: "none" }, () =>
      runner.runSpec({ executable: "mytool", args: ["--out", path.join(s.runDir, "out.json"), path.join(s.workspace, "src", "a.py")], cwd: path.join(s.workspace, "src"), env: { TOOL_HOME: path.join(s.runDir, "home") } }, s.options),
    );
    assert.equal(result.exitCode, 0);
    const [call] = stepRuns(s);
    assert.ok(call, "one docker run");
    assert.equal(stepRuns(s).length, 1);
    assert.equal(flag(call, "--pull"), "never");
    assert.equal(flag(call, "--name"), "jgates-run-1-tool-a");
    for (const f of ["--rm", "--init", "--read-only"]) assert.ok(call.includes(f), f);
    assert.equal(flag(call, "--network"), "none");
    assert.equal(flag(call, "--memory"), "4096m", "default memory");
    assert.equal(flag(call, "--cpus"), "2", "default cpus");
    assert.equal(flag(call, "--cap-drop"), "ALL");
    assert.equal(flag(call, "--security-opt"), "no-new-privileges");
    assert.equal(flag(call, "--workdir"), "/workspace/src");
    assert.ok(call.includes("org.jgates.kind=step") && call.includes("org.jgates.run=run-1") && call.includes("org.jgates.workspace=ws_0123456789abcdef"));
    const mounts = call.filter((a, i) => call[i - 1] === "--mount");
    assert.ok(mounts.includes("type=volume,src=jgates-ws_0123456789abcdef-src,dst=/workspace"));
    assert.ok(mounts.includes(`type=bind,src=${s.runDir},dst=/output`));
    assert.ok(!mounts.some((m) => m.includes(s.workspace)), "the project is never mounted");
    const image = call.indexOf("mytool");
    assert.deepEqual(call.slice(image), ["mytool", "--out", "/output/out.json", "/workspace/src/a.py"]);
    assert.ok(call.includes("TOOL_HOME=/output/home"), "host paths in the environment are mapped too");
  } finally {
    s.cleanup();
  }
});

test("the manifest resources and the plan network reach the docker run; a network step gets a bridge", async () => {
  const s = launcherSandbox();
  try {
    await inStep(s.launcher, { network: "bridge", resources: { memoryMb: 1536, cpus: 1, tmpfsMb: 128 } }, () => runner.runSpec({ executable: "mytool", args: [], cwd: s.workspace }, s.options));
    const [call] = stepRuns(s);
    assert.equal(flag(call, "--network"), "bridge");
    assert.equal(flag(call, "--memory"), "1536m");
    assert.equal(flag(call, "--cpus"), "1");
    assert.match(flag(call, "--tmpfs"), /size=128m$/);
  } finally {
    s.cleanup();
  }
});

test("without the tools image in the engine a native launch is refused with HOST_EXECUTION_REFUSED and nothing runs on the host", async () => {
  const s = launcherSandbox({ inspect: false });
  const marker = path.join(s.dir, "host-ran.txt");
  try {
    const result = await inStep(s.launcher, { network: "none" }, () =>
      runner.runSpec({ executable: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], cwd: s.workspace }, s.options),
    );
    assert.equal(result.spawnError?.code, "HOST_EXECUTION_REFUSED");
    assert.equal(result.exitCode, null);
    assert.equal(fs.existsSync(marker), false, "the command did not run on the host");
    assert.equal(stepRuns(s).length, 0);
    assert.throws(() => runner.assertNativeAllowed(s.env, "mytool"), (e) => e.code === "HOST_EXECUTION_REFUSED");
    assert.equal(runner.stepMode(s.env), "container");
  } finally {
    s.cleanup();
  }
});

test("with /etc/jgates/image.json present (path override) the same step runs natively in the image", async () => {
  const dir = tmp("jgates-image-json-");
  const imageJson = path.join(dir, "image.json");
  fs.writeFileSync(imageJson, JSON.stringify({ jgatesVersion: "1.2.3", imageVersion: "1", tools: { ruff: "0.6.0" } }));
  const s = launcherSandbox({ imageJson });
  const marker = path.join(s.dir, "native-ran.txt");
  try {
    assert.equal(runner.stepMode(s.env), "in-image");
    assert.equal(runner.readImageJson(s.env).tools.ruff, "0.6.0");
    assert.equal(s.launcher, null, "no launcher: the command runs natively");
    assert.doesNotThrow(() => runner.assertNativeAllowed(s.env, "mytool"));
    const result = await inStep(null, null, () =>
      runner.runSpec({ executable: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], cwd: s.workspace }, s.options),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(fs.readFileSync(marker, "utf8"), "x");
    assert.equal(stepRuns(s).length, 0, "no container was started");
  } finally {
    s.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("host paths map to container paths without touching other text", () => {
  const pairs = [
    { host: "/home/me/proj", target: "/workspace" },
    { host: "/data/runs/r1", target: "/output" },
  ];
  assert.equal(runner.mapHostPaths("/home/me/proj/src/a.py", pairs), "/workspace/src/a.py");
  assert.equal(runner.mapHostPaths("--out=/data/runs/r1/o.json", pairs), "--out=/output/o.json");
  assert.equal(runner.mapHostPaths("/home/me/project2/x", pairs), "/home/me/project2/x", "a longer name that starts with the prefix is not the workspace");
  assert.equal(runner.mapHostPaths("/home/me/proj", pairs), "/workspace");
  assert.equal(runner.mapHostPaths("plain text", pairs), "plain text");
});

test("the adapter manifest schema validates `resources` (memoryMb, cpus, tmpfsMb)", async () => {
  const { validateManifest } = await import(pathToFileURL(path.resolve(here, "..", "dist", "core", "catalog", "index.js")).href);
  const { builtinManifests, manifestResources } = await import(pathToFileURL(path.resolve(here, "..", "dist", "adapters", "manifests.js")).href);
  const base = structuredClone(builtinManifests().find((m) => m.id === "generic-command"));
  delete base.resources;
  assert.equal(validateManifest(base).ok, true, JSON.stringify(validateManifest(base)));
  assert.equal(validateManifest({ ...base, resources: { memoryMb: 2048, cpus: 1.5, tmpfsMb: 512 } }).ok, true);
  assert.equal(validateManifest({ ...base, resources: { memoryMb: 8 } }).ok, false, "memory below the floor");
  assert.equal(validateManifest({ ...base, resources: { cpus: 0 } }).ok, false, "zero cpus");
  assert.equal(validateManifest({ ...base, resources: { gpus: 1 } }).ok, false, "unknown resource");
  assert.equal(manifestResources("generic-command"), undefined, "no resources in the manifest: the 4096 MB / 2 CPUs defaults apply");
});
