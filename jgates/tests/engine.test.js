import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The engine module against the fake runtime (jgates/tests/docker/fake-docker.cjs), which records every call: the
// recorded docker arguments of every operation, the JGates labels on what is created, the label filter on every list,
// remove, kill and prune, detection, and a pull with progress that survives a dropped connection. The real engine is
// exercised by tests/docker (npm run test:docker).

const here = path.dirname(fileURLToPath(import.meta.url));
const engine = await import(pathToFileURL(path.resolve(here, "..", "dist", "core", "engine", "index.js")).href);
const FAKE = path.join(here, "docker", "fake-docker.cjs");
fs.chmodSync(FAKE, 0o755);

const FAKE_ENV = Object.keys(process.env).filter((k) => k.startsWith("FAKE_DOCKER_"));
const VERSION = "0.0.0-test";
const IMAGE = "jgates-tools:dev";

function sandbox(extraEnv = {}, runtime = FAKE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-engine-"));
  const log = path.join(dir, "calls.jsonl");
  const parentEnv = { ...process.env, FAKE_DOCKER_LOG: log, FAKE_DOCKER_STATE: dir, ...extraEnv };
  const envAllowlist = [...engine.ENGINE_CLIENT_ENV, "PATH", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", ...Object.keys(parentEnv).filter((k) => k.startsWith("FAKE_DOCKER_")), ...FAKE_ENV];
  const context = { runtime, runnerOptions: { parentEnv, envAllowlist } };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const objects = () => JSON.parse(fs.readFileSync(path.join(dir, "objects.json"), "utf8"));
  const seed = (value) => fs.writeFileSync(path.join(dir, "objects.json"), JSON.stringify(value));
  return { dir, context, calls, objects, seed, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const labelFlags = (call) => call.flatMap((a, i) => (a === "--label" ? [call[i + 1]] : []));
const filterFlags = (call) => call.flatMap((a, i) => (a === "--filter" ? [call[i + 1]] : []));
const MANAGED = "label=org.jgates.managed=true";
const helperLabels = engine.engineLabels({ kind: "helper", version: VERSION, workspace: "ws_0123456789abcdef", run: "run-1" });

test("every list, remove, kill and prune call carries the managed label filter", async () => {
  const s = sandbox();
  try {
    const unlabelled = { id: "c-foreign", name: "other-app", state: "running", labels: {} };
    const mine = { id: "c-mine", name: "jgates-run-1-ruff", state: "running", labels: engine.engineLabels({ kind: "step", version: VERSION, workspace: "ws_0123456789abcdef", run: "run-1" }) };
    const otherRun = { id: "c-other-run", name: "jgates-run-2-ruff", state: "running", labels: engine.engineLabels({ kind: "step", version: VERSION, run: "run-2" }) };
    s.seed({ containers: [unlabelled, mine, otherRun], volumes: [{ name: "foreign-vol", labels: {} }, { name: "jgates-cache", labels: engine.engineLabels({ kind: "data", version: VERSION }) }], networks: [], images: [] });

    const listed = await engine.listManaged("container", {}, s.context);
    assert.deepEqual(listed.map((o) => o.id).sort(), ["c-mine", "c-other-run"]);
    assert.equal((await engine.listManaged("volume", {}, s.context)).length, 1);

    const killed = await engine.killRun("run-1", s.context);
    assert.deepEqual(killed.map((o) => o.id), ["c-mine"]);
    await engine.removeManaged("volume", { kind: "data" }, s.context);
    await engine.pruneManaged(["container", "volume", "network", "image"], {}, s.context);

    const calls = s.calls();
    assert.ok(calls.length > 5);
    for (const call of calls) {
      if (/\b(ls|prune)\b/.test(call.join(" ")) || call[0] === "kill") {
        // `kill` and `rm` receive ids selected by a filtered list; list and prune carry the filter themselves.
        if (call[0] === "kill") continue;
        assert.ok(filterFlags(call).includes(MANAGED), `missing managed filter: ${call.join(" ")}`);
      }
    }
    const killList = calls.find((c) => c[0] === "container" && c[1] === "ls" && filterFlags(c).includes("label=org.jgates.run=run-1"));
    assert.ok(killList && filterFlags(killList).includes(MANAGED));
    assert.deepEqual(calls.find((c) => c[0] === "kill"), ["kill", "c-mine"]);
    assert.ok(calls.some((c) => c[0] === "volume" && c[1] === "rm" && c.includes("jgates-cache")));
    // Never anything outside the labels: the foreign container and volume are still there, the labelled ones are gone.
    const after = s.objects();
    assert.deepEqual(after.containers.map((c) => c.id), ["c-foreign"]);
    assert.deepEqual(after.volumes.map((v) => v.name), ["foreign-vol"]);
  } finally {
    s.cleanup();
  }
});

test("a scope narrows the filters by kind, workspace and run", () => {
  const args = engine.managedFilterArgs({ kind: "deps", workspace: "ws_aaaaaaaaaaaaaaaa", run: "r1", extraLabels: { "org.jgates.dev": "true" } });
  assert.deepEqual(args.filter((a) => a !== "--filter").sort(), [MANAGED, "label=org.jgates.kind=deps", "label=org.jgates.workspace=ws_aaaaaaaaaaaaaaaa", "label=org.jgates.run=r1", "label=org.jgates.dev=true"].sort());
});

test("volumes are created with JGates labels and initialized by a root helper; an existing volume is left alone", async () => {
  const s = sandbox();
  try {
    const labels = engine.engineLabels({ kind: "deps", version: VERSION, workspace: "ws_0123456789abcdef" });
    const name = engine.dependencyVolumeName("ws_0123456789abcdef", "api");
    assert.equal(name, "jgates-ws_0123456789abcdef-deps-api");
    assert.equal(await engine.ensureVolume(name, { labels, image: IMAGE, helperLabels }, s.context), true);
    assert.equal(await engine.ensureVolume(name, { labels, image: IMAGE, helperLabels }, s.context), false);

    const calls = s.calls();
    const create = calls.find((c) => c[0] === "volume" && c[1] === "create");
    assert.ok(create.includes(name));
    for (const [k, v] of Object.entries(labels)) assert.ok(labelFlags(create).includes(`${k}=${v}`), `volume label ${k}`);
    const helpers = calls.filter((c) => c[0] === "run");
    assert.equal(helpers.length, 1, "one helper for the creation, none for the existing volume");
    const helper = helpers[0];
    assert.ok(helper.join(" ").includes("--user 0:0") && helper.join(" ").includes("--cap-add CHOWN") && helper.join(" ").includes("--cap-drop ALL"));
    assert.ok(labelFlags(helper).includes("org.jgates.managed=true") && labelFlags(helper).includes("org.jgates.kind=helper"));
    assert.deepEqual(helper.slice(-3), ["chown", "10001:10001", "/volume"]);
  } finally {
    s.cleanup();
  }
});

test("run: the step contract and labels in the recorded arguments", async () => {
  const s = sandbox({ FAKE_DOCKER_STDOUT: "hello" });
  try {
    const labels = engine.engineLabels({ kind: "step", version: VERSION, workspace: "ws_0123456789abcdef", run: "run-1" });
    const result = await engine.runInEngine({ image: IMAGE, command: ["ruff", "check"], labels, name: "jgates-run-1-ruff", mounts: [{ type: "volume", source: "jgates-ws_0123456789abcdef-src", target: "/workspace", readonly: true }] }, s.context);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "hello");
    const call = s.calls().find((c) => c[0] === "run");
    const joined = call.join(" ");
    for (const flag of ["--rm", "--init", "--pull never", "--read-only", "--network none", "--cap-drop ALL", "--security-opt no-new-privileges", "--user 10001:10001", "--name jgates-run-1-ruff"]) assert.ok(joined.includes(flag), flag);
    assert.ok(call.some((a) => a.startsWith("/tmp:rw,noexec")) || joined.includes("--tmpfs /tmp:rw,noexec"));
    for (const [k, v] of Object.entries(labels)) assert.ok(labelFlags(call).includes(`${k}=${v}`));
    await assert.rejects(engine.runInEngine({ image: IMAGE, command: ["x"], labels: { "org.jgates.managed": "true" } }, s.context), /JGates labels/);
  } finally {
    s.cleanup();
  }
});

test("detection: no CLI is ENGINE_NOT_INSTALLED, a CLI without a daemon is ENGINE_STOPPED", async () => {
  const missing = sandbox({}, path.join(os.tmpdir(), "no-such-docker-binary"));
  const stopped = sandbox({ FAKE_DOCKER_DAEMON: "stopped" });
  const ready = sandbox({ FAKE_DOCKER_MEMORY_MB: "8192", FAKE_DOCKER_CPUS: "6" });
  try {
    const a = await engine.detectEngine({}, missing.context);
    assert.equal(a.code, "ENGINE_NOT_INSTALLED");
    assert.equal(a.facts.installed, false);
    const b = await engine.detectEngine({}, stopped.context);
    assert.equal(b.code, "ENGINE_STOPPED");
    assert.equal(b.facts.installed, true);
    assert.match(b.details, /Cannot connect/);
    const c = await engine.detectEngine({ requiredDiskMb: 0 }, ready.context);
    assert.equal(c.code, null);
    assert.equal(c.facts.running, true);
    assert.equal(c.facts.cpus, 6);
    assert.equal(c.facts.memoryMb, 8192);
    assert.equal(c.facts.arch, "x86_64");
    assert.equal(c.facts.serverVersion, "27.0.1-fake");
  } finally {
    missing.cleanup();
    stopped.cleanup();
    ready.cleanup();
  }
});

test("detection: low memory, low disk and an unsupported platform come from the engine's own figures", async () => {
  const lowMem = sandbox({ FAKE_DOCKER_MEMORY_MB: "2048" });
  const lowDisk = sandbox({ FAKE_DOCKER_DISK_FREE_MB: "3000" });
  const enoughDisk = sandbox({ FAKE_DOCKER_DISK_FREE_MB: "9000" });
  const windows = sandbox({ FAKE_DOCKER_OS: "windows" });
  const arm = sandbox({ FAKE_DOCKER_ARCH: "aarch64" });
  try {
    const mem = await engine.detectEngine({ requiredDiskMb: 0 }, lowMem.context);
    assert.equal(mem.code, "ENGINE_LOW_MEMORY");
    assert.equal(mem.facts.memoryMb, 2048);
    const disk = await engine.detectEngine({ requiredDiskMb: 5120, image: IMAGE, helperLabels }, lowDisk.context);
    assert.equal(disk.code, "DISK_LOW");
    assert.equal(disk.facts.diskFreeMb, 3000);
    assert.equal(disk.facts.diskSource, "engine");
    const dfCall = lowDisk.calls().find((c) => c[0] === "run");
    assert.ok(dfCall.includes("--network") && dfCall.includes("none") && dfCall.slice(-3).join(" ") === "df -Pk /");
    assert.equal((await engine.detectEngine({ requiredDiskMb: 5120, image: IMAGE, helperLabels }, enoughDisk.context)).code, null);
    assert.equal((await engine.detectEngine({}, windows.context)).code, "UNSUPPORTED_PLATFORM");
    assert.equal((await engine.detectEngine({}, arm.context)).code, "UNSUPPORTED_PLATFORM");
  } finally {
    for (const s of [lowMem, lowDisk, enoughDisk, windows, arm]) s.cleanup();
  }
});

test("pull: progress is aggregated in bytes, non-decreasing, with a total", async () => {
  const s = sandbox();
  try {
    const events = [];
    const result = await engine.pullImage("registry.example/jgates/tools:1.0", { onProgress: (e) => events.push(e) }, s.context);
    assert.equal(result.attempts, 1);
    assert.equal(result.total, 220000000);
    assert.equal(events[0].phase, "resolving");
    assert.equal(events.at(-1).phase, "done");
    assert.equal(events.at(-1).downloaded, 220000000);
    assert.ok(events.every((e) => e.total === 220000000));
    for (let i = 1; i < events.length; i++) assert.ok(events[i].downloaded >= events[i - 1].downloaded, "downloaded never decreases");
    assert.ok(events.some((e) => e.downloaded > 0 && e.downloaded < e.total), "intermediate progress");
    assert.deepEqual(
      s.calls().map((c) => c.slice(0, 2).join(" ")),
      ["manifest inspect", "pull registry.example/jgates/tools:1.0"],
    );
  } finally {
    s.cleanup();
  }
});

test("pull: a dropped connection mid-pull is retried, resumes the completed layers and finishes", async () => {
  const s = sandbox({ FAKE_DOCKER_PULL_DROPS: "2", FAKE_DOCKER_PULL_DROP_AFTER: "1" });
  try {
    const events = [];
    const result = await engine.pullImage("registry.example/jgates/tools:1.0", { onProgress: (e) => events.push(e), retryDelayMs: 1 }, s.context);
    assert.equal(result.attempts, 3);
    assert.equal(events.filter((e) => e.phase === "retrying").length, 2);
    assert.deepEqual(events.filter((e) => e.phase === "retrying").map((e) => e.attempt), [2, 3]);
    assert.equal(events.at(-1).phase, "done");
    for (let i = 1; i < events.length; i++) assert.ok(events[i].downloaded >= events[i - 1].downloaded, "downloaded never decreases across the drop");
    const dropped = events.find((e) => e.phase === "retrying");
    assert.ok(dropped.downloaded > 0, "the layers completed before the drop are kept");
    assert.equal(s.calls().filter((c) => c[0] === "pull").length, 3);
  } finally {
    s.cleanup();
  }
});

test("pull: every attempt dropped fails with IMAGE_PULL_FAILED and the engine's text in the details", async () => {
  const s = sandbox({ FAKE_DOCKER_PULL_DROPS: "9", FAKE_DOCKER_PULL_DROP_AFTER: "0", FAKE_DOCKER_MANIFEST: "none" });
  try {
    await assert.rejects(
      engine.pullImage("registry.example/jgates/tools:1.0", { attempts: 2, retryDelayMs: 1, expectedBytes: 5000 }, s.context),
      (error) => error.message === "IMAGE_PULL_FAILED" && /unexpected EOF/.test(error.details),
    );
    assert.equal(s.calls().filter((c) => c[0] === "pull").length, 2);
  } finally {
    s.cleanup();
  }
});

test("compose: labels reach every service through the override file, down is scoped to the project", async () => {
  const s = sandbox();
  try {
    const labels = engine.engineLabels({ kind: "services", version: VERSION, workspace: "ws_0123456789abcdef", run: "run-1" });
    const file = path.join(s.dir, "compose.yml");
    fs.writeFileSync(file, "services:\n  db:\n    image: postgres:16\n  api:\n    image: app\n");
    const up = await engine.composeUp({ project: "jgates-ws_0123456789abcdef-services", files: [file], services: ["db", "api"], labels, overrideDir: path.join(s.dir, "run") }, s.context);
    const override = fs.readFileSync(up.overrideFile, "utf8");
    for (const service of ["db", "api"]) assert.match(override, new RegExp(`  ${service}:\\n    labels:`));
    assert.match(override, /"org\.jgates\.managed": "true"/);
    assert.match(override, /"org\.jgates\.run": "run-1"/);
    const upCall = s.calls().find((c) => c[0] === "compose" && c.includes("up"));
    assert.deepEqual(upCall.slice(0, 3), ["compose", "--project-name", "jgates-ws_0123456789abcdef-services"]);
    assert.ok(upCall.includes("--wait") && upCall.join(" ").includes("--pull never"));
    assert.deepEqual(upCall.filter((_, i) => upCall[i - 1] === "-f"), [file, up.overrideFile]);
    await engine.composeDown({ project: "jgates-ws_0123456789abcdef-services", files: [file], labels }, s.context);
    const down = s.calls().find((c) => c[0] === "compose" && c.includes("down"));
    assert.ok(down.includes("--project-name") && down.includes("--remove-orphans") && down.includes("--volumes"));
    await assert.rejects(engine.composeUp({ project: "x", files: [file], services: ["db"], labels: { a: "b" }, overrideDir: s.dir }, s.context), /JGates labels/);
    await assert.rejects(engine.composeUp({ project: "Bad Name", files: [file], services: ["db"], labels, overrideDir: s.dir }, s.context), /invalid compose project/);
  } finally {
    s.cleanup();
  }
});

test("sizes: the managed volumes and images are counted, foreign ones are not", async () => {
  const s = sandbox();
  try {
    const labels = engine.engineLabels({ kind: "deps", version: VERSION, workspace: "ws_0123456789abcdef" });
    s.seed({
      containers: [],
      networks: [],
      volumes: [
        { name: "jgates-ws_0123456789abcdef-deps-api", labels, sizeBytes: 500_000_000 },
        { name: "foreign", labels: {}, sizeBytes: 9_000_000_000 },
      ],
      images: [
        { id: "sha256:aa", name: "jgates-tools", labels: engine.engineLabels({ kind: "toolchain", version: VERSION }), sizeBytes: 6_500_000_000 },
        { id: "sha256:bb", name: "postgres", labels: {}, sizeBytes: 400_000_000 },
      ],
    });
    const usage = await engine.managedUsage({}, s.context);
    assert.deepEqual(usage.volumes.map((v) => v.name), ["jgates-ws_0123456789abcdef-deps-api"]);
    assert.deepEqual(usage.images.map((i) => i.id), ["sha256:aa"]);
    assert.ok(Math.abs(usage.totalBytes - 7_000_000_000) < 50_000_000);
    assert.equal(engine.parseEngineSize("1.5GB"), 1_500_000_000);
    assert.equal(engine.parseEngineSize("230kB"), 230_000);
    assert.equal(engine.parseEngineSize("garbage"), 0);
    for (const call of s.calls().filter((c) => c[1] === "ls")) assert.ok(filterFlags(call).includes(MANAGED));
  } finally {
    s.cleanup();
  }
});

test("a stopped engine makes engine commands report an EngineError, never a silent success", async () => {
  const s = sandbox({ FAKE_DOCKER_DAEMON: "stopped" });
  try {
    await assert.rejects(engine.listManaged("container", {}, s.context), (error) => error.name === "EngineError" && /Cannot connect/.test(error.details));
  } finally {
    s.cleanup();
  }
});
