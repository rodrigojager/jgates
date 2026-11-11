import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-50 (real engine): setup, a run and `jgates uninstall --yes` with an isolated JGATES_HOME.
//
// Scope, and why: the developer's machine shares the engine with other work. `jgates-tools:dev` (label org.jgates.dev, no
// org.jgates.managed) and the shared volumes `jgates-data`, `jgates-toolchains` and `jgates-cache` (org.jgates.managed=true,
// ~2 GB of advisory data reused by test:docker) must survive this test. So the uninstall runs with
// `--only-workspace <the test's own workspace id>`: the engine objects it may remove are the ones carrying
// org.jgates.managed=true AND org.jgates.workspace=<that id> (the id of a temporary project, so nothing else has it). The
// shared volumes and the dev image are never in its selection; the test asserts they are still there afterwards.
//
// What it checks, end to end with the real engine:
//   - `jgates setup --no-data --yes` is ready; a real `jgates run` creates the workspace's labelled source volume;
//   - objects made by the test (a dependencies volume, a stopped container, a run network and an extension image, all with the
//     JGates labels and the test workspace) and the objects of the run are all listed by `uninstall --dry-run`, which removes nothing;
//   - after `uninstall --yes`: zero objects with org.jgates.managed=true and the test workspace remain (containers, networks,
//     volumes, images), the unlabelled image the test made (its own unique tag, used by the managed container) is intact, the
//     data folder and the old tools folder are gone, the key store is kept, the shared volumes and jgates-tools:dev are still
//     there, and the project folder is listed (jgates.yml, .jgates, the hook with its removal command) but its tree hash is the same.
// Everything the test creates is removed by the test afterwards, selected by its own labels or exact names.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "jgates", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const IMAGE = "jgates-tools:dev";
const SHARED_VOLUMES = ["jgates-data", "jgates-toolchains", "jgates-cache"];

const docker = (args, input) => {
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, input });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};
const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
let workspace = "";
let unlabelled = "";
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  if (workspace) {
    const filters = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${workspace}`];
    for (const id of lines(docker(["ps", "-aq", ...filters]).out)) docker(["rm", "-f", id]);
    for (const id of lines(docker(["network", "ls", "-q", ...filters]).out)) docker(["network", "rm", id]);
    for (const name of lines(docker(["volume", "ls", "-q", ...filters]).out)) docker(["volume", "rm", "-f", name]);
    for (const id of lines(docker(["image", "ls", "-q", ...filters]).out)) docker(["image", "rm", id]);
  }
  // Last: the unlabelled image the test made (a container of the workspace may have used it).
  if (unlabelled) docker(["image", "rm", unlabelled]);
});

/** Hash of the whole tree: relative paths, kinds, sizes, mtimes and contents, in a stable order. */
function treeHash(dir) {
  const hash = crypto.createHash("sha256");
  const walk = (d, rel) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(full);
      if (entry.isDirectory()) {
        hash.update(`d:${next}\0`);
        walk(full, next);
      } else hash.update(`f:${next}:${stat.size}:${stat.mtimeMs}\0`).update(fs.readFileSync(full));
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

const probeTemplate = [
  "schemaVersion: 1",
  "id: probe",
  "extends: [builtin:base]",
  "config:",
  "  tools:",
  "    probe:",
  "      adapter: generic-command",
  "      enabled: true",
  "      capabilities: [lint]",
  "      command: python3",
  '      args: ["-c", "print(1)"]',
  "      config:",
  "        effects: { readsCode: true, writesOutputs: false, mayChangeCode: false, executesProjectCode: false, usesNetwork: false }",
  "        evidence: { kind: exit-code }",
  "",
].join("\n");

test("V2-50 (real engine): uninstall removes every labelled object of the test workspace and leaves the unlabelled image, the shared objects and the project untouched", { timeout: 900_000 }, async () => {
  assert.equal(docker(["version", "--format", "{{.Server.Version}}"]).code, 0, "Docker is required for the real-engine acceptance cases (the daemon did not answer)");
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is missing; build it with npm --prefix jgates run image:build`);
  const { workspaceId } = await import(pathToFileURL(path.join(dist, "core", "ids", "index.js")).href);

  const project = tmp("v2-50-project-");
  const home = tmp("v2-50-home-");
  const stubs = tmp("v2-50-stubs-");
  const keys = tmp("v2-50-keys-");
  workspace = workspaceId(project);
  fs.writeFileSync(path.join(keys, "secrets.json"), "{}");
  fs.writeFileSync(path.join(stubs, "python3"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  fs.writeFileSync(path.join(stubs, "python3.cmd"), "@exit /b 99\r\n");
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const env = {
    ...process.env,
    [pathKey]: `${stubs}${path.delimiter}${process.env[pathKey] ?? ""}`,
    JGATES_HOME: home,
    SEMANTIC_GATE_HOME: keys,
    JGATES_IMAGE_JSON: "",
    JGATES_TOOLS_IMAGE: IMAGE,
    JGATES_NO_CACHE: "1",
    JGATES_LOCALE: "en",
    NO_COLOR: "1",
  };
  if (env.JGATES_CONTAINER_RUNTIME === "jgates-test-no-engine") delete env.JGATES_CONTAINER_RUNTIME;
  const cli = (args) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  const json = (r) => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      return assert.fail(`no JSON (exit ${r.status}): ${r.stdout.slice(-1500)}\n${r.stderr.slice(-1500)}`);
    }
  };

  // The unlabelled image: made by the test with its own unique tag, no JGates label at all.
  unlabelled = `jgates-test-v250-unlabelled:${crypto.randomBytes(5).toString("hex")}`;
  const built = docker(["build", "--quiet", "--tag", unlabelled, "-"], "FROM scratch\nLABEL test.owner=v2-50\n");
  assert.equal(built.code, 0, built.err);
  const unlabelledId = docker(["image", "inspect", "--format", "{{.Id}}", unlabelled]).out.trim();
  assert.match(unlabelledId, /^sha256:/);
  assert.equal(docker(["image", "inspect", "--format", "{{json .Config.Labels}}", unlabelled]).out.trim().includes("org.jgates.managed"), false);

  // The shared objects that must survive (whatever exists now).
  const sharedBefore = SHARED_VOLUMES.filter((v) => docker(["volume", "inspect", v]).code === 0);
  const devLabels = docker(["image", "inspect", "--format", "{{json .Config.Labels}}", IMAGE]).out;
  assert.equal(devLabels.includes('"org.jgates.managed"'), false, "the development image is not labelled org.jgates.managed, so no label scope can take it");

  // The project: a small one with JGates files, a pre-commit hook of JGates and one tool.
  fs.writeFileSync(path.join(project, "app.py"), "x = 1\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  assert.equal(cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]).status, 0);
  fs.mkdirSync(path.join(project, ".jgates", "templates"), { recursive: true });
  fs.writeFileSync(path.join(project, ".jgates", "templates", "probe.yml"), probeTemplate);
  fs.appendFileSync(path.join(project, "jgates.yml"), "  - id: probe\n    source: .jgates/templates/probe.yml\n    activation: always\n");
  const hooked = cli(["hooks", "install", "pre-commit", "--cwd", project, "--json"]);
  assert.equal(hooked.status, 0, hooked.stdout + hooked.stderr);
  spawnSync("git", ["add", "-A"], { cwd: project });

  // 1. setup, then a real run (the sync helper and the step are real containers).
  const setup = cli(["setup", "--no-data", "--yes", "--json"]);
  assert.equal(json(setup).ready, true, setup.stdout + setup.stderr);
  const run = json(cli(["run", "--cwd", project, "--no-interactive", "--json", "--only", "tool:probe"]));
  assert.ok(run.runDir && fs.existsSync(run.runDir), JSON.stringify(run).slice(0, 800));
  const wsFilter = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${workspace}`];
  assert.deepEqual(lines(docker(["volume", "ls", "-q", ...wsFilter]).out), [`jgates-${workspace}-src`], "the run left the workspace's source volume");

  // 2. More JGates objects of the test workspace, made by the test with the JGates labels.
  const labels = ["--label", "org.jgates.managed=true", "--label", "org.jgates.version=0.0.0-test", "--label", `org.jgates.workspace=${workspace}`];
  assert.equal(docker(["volume", "create", ...labels, "--label", "org.jgates.kind=deps", `jgates-${workspace}-deps-v250-aaaaaaaaaaaa`]).code, 0);
  assert.equal(docker(["network", "create", ...labels, "--label", "org.jgates.kind=services", "--label", "org.jgates.run=run_v250", `jgates-${workspace}-run_v250_default`]).code, 0);
  assert.equal(docker(["create", "--name", `jgates-${workspace}-v250-stopped`, ...labels, "--label", "org.jgates.kind=step", unlabelled, "/nothing"]).code, 0);
  const extension = docker(["build", "--quiet", "--tag", `jgates-ext-${workspace}:v250`, "--label", "org.jgates.managed=true", "--label", "org.jgates.kind=extension-image", "--label", "org.jgates.version=0.0.0-test", "--label", `org.jgates.workspace=${workspace}`, "-"], "FROM scratch\n");
  assert.equal(extension.code, 0, extension.err);
  const count = () => ({
    containers: lines(docker(["ps", "-aq", ...wsFilter]).out).length,
    networks: lines(docker(["network", "ls", "-q", ...wsFilter]).out).length,
    volumes: lines(docker(["volume", "ls", "-q", ...wsFilter]).out).length,
    images: lines(docker(["image", "ls", "-q", ...wsFilter]).out).length,
  });
  const before = count();
  assert.ok(before.containers >= 1 && before.networks >= 1 && before.volumes >= 2 && before.images >= 1, JSON.stringify(before));

  const projectBefore = treeHash(project);

  // 3. The dry run lists everything and removes nothing.
  const dry = json(cli(["uninstall", "--dry-run", "--only-workspace", workspace, "--json"]));
  assert.equal(dry.mode, "dry-run");
  assert.equal(dry.engine.state, "ready");
  const listed = dry.items.map((i) => `${i.resource}:${i.name}`);
  for (const expected of [`volume:jgates-${workspace}-src`, `volume:jgates-${workspace}-deps-v250-aaaaaaaaaaaa`, `network:jgates-${workspace}-run_v250_default`, `container:jgates-${workspace}-v250-stopped`, `image:jgates-ext-${workspace}:v250`]) {
    assert.ok(listed.includes(expected), `${expected} is listed: ${listed.join(", ")}`);
  }
  assert.ok(!listed.some((n) => n.includes(unlabelled) || SHARED_VOLUMES.some((v) => n === `volume:${v}`) || n.includes(IMAGE)), "the unlabelled image, the shared volumes and the dev image are not in the selection");
  assert.deepEqual(count(), before, "a dry run removes nothing");
  assert.ok(fs.existsSync(home));
  assert.equal(dry.projectFiles.length, 1);
  // (The registry keeps the canonical spelling of the path, lowercase on Windows.)
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  assert.ok(same(dry.projectFiles[0].path, project), `${dry.projectFiles[0].path} is ${project}`);
  const kinds = dry.projectFiles[0].files.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ["config", "folder", "hook"]);
  assert.match(dry.projectFiles[0].files.find((f) => f.kind === "hook").removeCommand, /^jgates hooks uninstall pre-commit --cwd /);

  // The old tools folder an earlier release left in the data folder.
  fs.mkdirSync(path.join(home, "tools", "python"), { recursive: true });
  fs.writeFileSync(path.join(home, "tools", "python", "old.txt"), "old");

  // 4. The real uninstall.
  const done = cli(["uninstall", "--yes", "--only-workspace", workspace, "--json"]);
  const doc = json(done);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(doc.mode, "applied");
  assert.equal(doc.applied.failed, 0, JSON.stringify(doc.applied.lines.filter((l) => l.outcome !== "removed")));
  assert.equal(doc.applied.incomplete, false);

  assert.deepEqual(count(), { containers: 0, networks: 0, volumes: 0, images: 0 }, "zero objects with org.jgates.managed=true remain for the test workspace");
  assert.deepEqual(lines(docker(["ps", "-aq", "--filter", `label=org.jgates.run=${path.basename(run.runDir)}`]).out), [], "no container of the run");
  // The unlabelled image is intact.
  assert.equal(docker(["image", "inspect", "--format", "{{.Id}}", unlabelled]).out.trim(), unlabelledId, "the unlabelled image is intact");
  // The shared objects are still there.
  for (const volume of sharedBefore) assert.equal(docker(["volume", "inspect", volume]).code, 0, `${volume} is still there`);
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is still there`);
  // The data folder and the old tools folder are gone; the key store needs its own confirmation and is kept.
  assert.ok(!fs.existsSync(home), "the data folder is removed");
  assert.ok(fs.existsSync(path.join(keys, "secrets.json")), "the key store is kept");
  assert.equal(doc.keyStore.removed, false);
  // The project files were listed, never touched.
  assert.equal(treeHash(project), projectBefore, "the project tree is unchanged");
  assert.ok(fs.existsSync(path.join(project, ".git", "hooks", "pre-commit")));
});
