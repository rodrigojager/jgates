import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// `jgates clean`, `jgates uninstall` and the storage accounting against the fake engine (tests/docker/fake-docker.cjs, which
// records every call and keeps its objects in FAKE_DOCKER_STATE/objects.json). The objects are seeded there: JGates images
// (a pinned one, one of another version, an extension image of a workspace whose folder is gone, one a container was made
// from), an unlabelled legacy sidecar and another unlabelled image, shared volumes, volumes of three workspaces, a running
// run and a stopped container, two networks. The real-engine case is V2-50 (tests/v2-docker/v2-50-uninstall.mjs).

const here = path.dirname(fileURLToPath(import.meta.url));
delete process.env.JGATES_IMAGE_JSON;
const packageRoot = path.resolve(here, "..");
const MAIN = path.join(packageRoot, "dist", "cli", "main.js");
const FAKE = path.join(here, "docker", "fake-docker.cjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(packageRoot, "..", "package.json"), "utf8")).version;
const load = (...parts) => import(pathToFileURL(path.join(packageRoot, "dist", ...parts)).href);

const WS_LIVE = "ws_" + "1".repeat(16);
const WS_ORPHAN = "ws_" + "2".repeat(16);
const WS_RUN = "ws_" + "3".repeat(16);
const sha = (c) => "sha256:" + c.repeat(64);
const managed = (kind, extra = {}) => ({ "org.jgates.managed": "true", "org.jgates.kind": kind, "org.jgates.version": VERSION, ...extra });

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function seed() {
  return {
    images: [
      // The image this CLI pins; its version label differs (an outdated image), so a plain clean would take it if it were free.
      { id: sha("a"), name: "jgates-tools", tag: "dev", labels: managed("step", { "org.jgates.version": "0.0.0-pinned" }), sizeBytes: 800e6, sharedBytes: 700e6, built: true },
      { id: sha("b"), name: "jgates-tools", tag: "0.0.1", labels: managed("step", { "org.jgates.version": "0.0.1" }), sizeBytes: 800e6, sharedBytes: 700e6, built: true },
      { id: sha("c"), name: `jgates-ext-${WS_ORPHAN}`, tag: "k1", labels: managed("extension-image", { "org.jgates.workspace": WS_ORPHAN }), sizeBytes: 850e6, sharedBytes: 700e6, built: true },
      { id: sha("d"), name: `jgates-ext-${WS_LIVE}`, tag: "k2", labels: managed("extension-image", { "org.jgates.workspace": WS_LIVE }), sizeBytes: 850e6, sharedBytes: 700e6, built: true },
      { id: sha("e"), name: "jgates-tools", tag: "0.0.2", labels: managed("step", { "org.jgates.version": "0.0.2" }), sizeBytes: 800e6, sharedBytes: 700e6, built: true },
      { id: sha("f"), name: "jgates/quality-sidecar", tag: "latest", labels: {}, sizeBytes: 500e6, built: true },
      { id: sha("9"), name: "someone/else", tag: "1", labels: {}, sizeBytes: 100e6, built: true },
    ],
    containers: [
      { id: "c1", name: "jgates-run_1-lint", state: "running", labels: managed("step", { "org.jgates.workspace": WS_RUN, "org.jgates.run": "run_1" }) },
      { id: "c2", name: "jgates-run_0-lint", state: "exited", labels: managed("step", { "org.jgates.workspace": WS_LIVE, "org.jgates.run": "run_0" }) },
      { id: "c3", name: "jgates-made-from-old", state: "exited", image: sha("e"), labels: managed("helper") },
    ],
    networks: [
      { id: "n1", name: `jgates-${WS_RUN}-run_1_default`, labels: managed("services", { "org.jgates.workspace": WS_RUN, "org.jgates.run": "run_1" }) },
      { id: "n2", name: `jgates-${WS_LIVE}-run_0_default`, labels: managed("services", { "org.jgates.workspace": WS_LIVE, "org.jgates.run": "run_0" }) },
    ],
    volumes: [
      { name: "jgates-cache", labels: managed("deps"), sizeBytes: 300e6 },
      { name: "jgates-data", labels: managed("data"), sizeBytes: 2000e6 },
      { name: "jgates-toolchains", labels: managed("toolchain"), sizeBytes: 1000e6 },
      { name: `jgates-${WS_ORPHAN}-src`, labels: managed("sync", { "org.jgates.workspace": WS_ORPHAN }), sizeBytes: 40e6 },
      { name: `jgates-${WS_ORPHAN}-deps-py-abc`, labels: managed("deps", { "org.jgates.workspace": WS_ORPHAN }), sizeBytes: 100e6 },
      { name: `jgates-${WS_LIVE}-src`, labels: managed("sync", { "org.jgates.workspace": WS_LIVE }), sizeBytes: 20e6 },
      { name: `jgates-${WS_RUN}-src`, labels: managed("sync", { "org.jgates.workspace": WS_RUN }), sizeBytes: 10e6 },
    ],
  };
}

/** A fake engine with the seeded objects, an isolated JGates home with a workspace registry, and a project folder. */
function machine({ objects = seed(), running = true, locale = "en" } = {}) {
  const dir = tmp("jgates-clean-");
  const state = path.join(dir, "state");
  fs.mkdirSync(state);
  const objectsFile = path.join(state, "objects.json");
  const content = running ? objects : { ...objects, containers: objects.containers.filter((c) => c.state !== "running"), networks: objects.networks.filter((n) => n.labels["org.jgates.run"] !== "run_1") };
  fs.writeFileSync(objectsFile, JSON.stringify(content));
  const calls = path.join(dir, "calls.jsonl");
  const runtime = path.join(dir, "docker.cjs");
  fs.writeFileSync(runtime, [`process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};`, `process.env.FAKE_DOCKER_STATE = ${JSON.stringify(state)};`, `require(${JSON.stringify(FAKE)});`].join("\n") + "\n");

  const home = path.join(dir, "home");
  const project = path.join(dir, "project");
  fs.mkdirSync(path.join(home, "workspaces"), { recursive: true });
  fs.mkdirSync(path.join(project, ".jgates"), { recursive: true });
  fs.mkdirSync(path.join(project, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(project, "jgates.yml"), "schemaVersion: 1\n");
  fs.writeFileSync(path.join(project, ".jgates", "tools.yml"), "schemaVersion: 1\ntools: {}\n");
  fs.writeFileSync(path.join(project, ".git", "hooks", "pre-commit"), "#!/bin/sh\n# jgates-hook: pre-commit\nexit 0\n");
  fs.writeFileSync(path.join(project, "app.py"), "x = 1\n");
  const gone = path.join(dir, "deleted-project");
  fs.writeFileSync(
    path.join(home, "workspaces.json"),
    JSON.stringify({
      schemaVersion: 1,
      workspaces: [
        { id: WS_LIVE, path: project, name: "project", lastAccess: new Date().toISOString() },
        { id: WS_ORPHAN, path: gone, name: "deleted", lastAccess: new Date().toISOString() },
        { id: WS_RUN, path: path.join(dir, "deleted-too"), name: "deleted-too", lastAccess: new Date().toISOString() },
      ],
    }),
  );
  fs.mkdirSync(path.join(home, "tools", "python"), { recursive: true });
  fs.writeFileSync(path.join(home, "tools", "python", "old.txt"), "x".repeat(4096));
  const keys = path.join(dir, "keys");
  fs.mkdirSync(keys);
  fs.writeFileSync(path.join(keys, "secrets.json"), "{}");

  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_TOOLS_IMAGE: "jgates-tools:dev", SEMANTIC_GATE_HOME: keys, JGATES_NO_CACHE: "1", JGATES_LOCALE: locale, NO_COLOR: "1" };
  delete env.JGATES_IMAGE_JSON;
  const read = () => JSON.parse(fs.readFileSync(objectsFile, "utf8"));
  const dockerCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout: 120_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, doc };
  };
  return { dir, home, project, keys, env, runtime, state, read, dockerCalls, cli, write: (o) => fs.writeFileSync(objectsFile, JSON.stringify(o)) };
}

const removals = (calls) => calls.filter((c) => ["rm", "kill", "stop", "prune"].some((v) => c.includes(v)));
const by = (doc, name) => doc.items.find((i) => i.name === name);
const names = (objs) => ({ images: objs.images.map((i) => `${i.name}:${i.tag}`), containers: objs.containers.map((c) => c.name), networks: objs.networks.map((n) => n.name), volumes: objs.volumes.map((v) => v.name) });

function treeHash(dir) {
  const hash = crypto.createHash("sha256");
  const walk = (d, rel) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        hash.update(`d:${next}\0`);
        walk(full, next);
      } else hash.update(`f:${next}:${fs.lstatSync(full).size}:${fs.lstatSync(full).mtimeMs}\0`).update(fs.readFileSync(full));
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

test("clean --dry-run --json lists the removable objects with sizes and removes nothing", () => {
  const m = machine();
  const before = fs.readFileSync(path.join(m.state, "objects.json"), "utf8");
  const r = m.cli(["clean", "--dry-run", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.doc.mode, "dry-run");
  assert.equal(r.doc.engine.state, "ready");
  const remove = r.doc.items.filter((i) => i.action === "remove").map((i) => `${i.resource}:${i.name}`).sort();
  assert.deepEqual(remove, [
    `container:jgates-made-from-old`,
    `container:jgates-run_0-lint`,
    `folder:${path.join(m.home, "tools", "python")}`,
    `image:jgates-ext-${WS_ORPHAN}:k1`,
    `image:jgates-tools:0.0.1`,
    `network:jgates-${WS_LIVE}-run_0_default`,
    `volume:jgates-${WS_ORPHAN}-deps-py-abc`,
    `volume:jgates-${WS_ORPHAN}-src`,
  ]);
  // Sizes are there; shared layers are counted once (two images of 800 and 850 MB sharing a 700 MB base: 250 MB of their own + 700 MB).
  assert.equal(by(r.doc, `jgates-${WS_ORPHAN}-src`).sizeBytes, 40e6);
  assert.equal(by(r.doc, "jgates-tools:0.0.1").sizeBytes, 800e6);
  assert.equal(by(r.doc, "jgates-tools:0.0.1").uniqueBytes, 100e6);
  assert.deepEqual({ unique: r.doc.totals.images.uniqueBytes, shared: r.doc.totals.images.sharedBytes, total: r.doc.totals.images.totalBytes, sum: r.doc.totals.images.sumBytes }, { unique: 250e6, shared: 700e6, total: 950e6, sum: 1650e6 });
  assert.equal(r.doc.totals.removeBytes, 950e6 + 40e6 + 100e6 + 4096);
  // Not selected by a plain clean: the shared volumes, the volumes of a workspace that still exists, its extension image, the unlabelled images.
  const listed = r.doc.items.map((i) => i.name);
  for (const kept of ["jgates-data", "jgates-cache", "jgates-toolchains", `jgates-${WS_LIVE}-src`, `jgates-ext-${WS_LIVE}:k2`, "someone/else:1"]) assert.ok(!listed.includes(kept), `${kept} is not listed`);
  assert.deepEqual(r.doc.unmanaged.map((u) => u.name), ["jgates/quality-sidecar:latest"]);
  // Nothing was removed: the objects are byte-identical, and no engine call removes, kills, stops or prunes.
  assert.equal(fs.readFileSync(path.join(m.state, "objects.json"), "utf8"), before);
  assert.deepEqual(removals(m.dockerCalls()), []);
  assert.ok(fs.existsSync(path.join(m.home, "tools", "python", "old.txt")));
});

test("objects in use are skipped as 'em uso': the running run, its network and volume, the pinned image, an image a container was made from", () => {
  const m = machine({ locale: "pt-BR" });
  const r = m.cli(["clean", "--dry-run", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const skipped = Object.fromEntries(r.doc.items.filter((i) => i.action === "skip").map((i) => [i.name, i]));
  assert.deepEqual(Object.keys(skipped).sort(), ["jgates-run_1-lint", "jgates-tools:0.0.2", "jgates-tools:dev", `jgates-${WS_RUN}-run_1_default`, `jgates-${WS_RUN}-src`].sort());
  for (const item of Object.values(skipped)) {
    assert.equal(item.reason, "in-use");
    assert.equal(item.label, "em uso");
  }
  assert.equal(skipped["jgates-run_1-lint"].inUse.code, "RUNNING_RUN");
  assert.equal(skipped["jgates-run_1-lint"].inUse.detail, "run_1");
  assert.equal(skipped[`jgates-${WS_RUN}-src`].inUse.code, "RUNNING_RUN");
  assert.equal(skipped[`jgates-${WS_RUN}-run_1_default`].inUse.code, "RUNNING_RUN");
  assert.equal(skipped["jgates-tools:dev"].inUse.code, "PINNED_IMAGE");
  assert.equal(skipped["jgates-tools:0.0.2"].inUse.code, "USED_BY_CONTAINER");
  assert.deepEqual(removals(m.dockerCalls()), []);
  // The text says it in Portuguese.
  const text = m.cli(["clean", "--dry-run"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /em uso\s+contêiner\s+jgates-run_1-lint/);
  assert.match(text.stdout, /em uso\s+imagem\s+jgates-tools:dev/);
  assert.match(text.stdout, /\d+ objetos estão em uso e foram ignorados\./);
});

test("without --yes and without a terminal clean stays a dry run; --dry-run with --yes is a usage error", () => {
  const m = machine();
  const before = fs.readFileSync(path.join(m.state, "objects.json"), "utf8");
  const r = m.cli(["clean", "--json"]);
  assert.equal(r.status, 0);
  assert.equal(r.doc.mode, "dry-run");
  assert.equal(r.doc.explicitDryRun, false);
  assert.equal(fs.readFileSync(path.join(m.state, "objects.json"), "utf8"), before);
  const both = m.cli(["clean", "--dry-run", "--yes", "--json"]);
  assert.equal(both.status, 3);
  assert.equal(both.doc.code, "DRY_RUN_WITH_YES");
  const bad = m.cli(["clean", "--workspace", "nope", "--json"]);
  assert.equal(bad.status, 3);
  assert.equal(bad.doc.code, "BAD_WORKSPACE");
  assert.deepEqual(removals(m.dockerCalls()), []);
});

test("clean --yes removes only what is free and labelled, line by line, and never the in-use or unlabelled objects", () => {
  const m = machine();
  const seeded = seed();
  const r = m.cli(["clean", "--yes", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.doc.mode, "applied");
  assert.equal(r.doc.applied.failed, 0);
  assert.equal(r.doc.applied.removed, 8);
  const left = names(m.read());
  assert.deepEqual(left.containers.sort(), ["jgates-run_1-lint"]);
  assert.deepEqual(left.networks, [`jgates-${WS_RUN}-run_1_default`]);
  assert.deepEqual(left.volumes.sort(), ["jgates-cache", "jgates-data", "jgates-toolchains", `jgates-${WS_LIVE}-src`, `jgates-${WS_RUN}-src`].sort());
  assert.deepEqual(left.images.sort(), ["jgates-tools:dev", "jgates-tools:0.0.2", `jgates-ext-${WS_LIVE}:k2`, "jgates/quality-sidecar:latest", "someone/else:1"].sort());
  assert.ok(!fs.existsSync(path.join(m.home, "tools", "python")), "the old tools folder is gone");
  // Every removal call names an object that carried the JGates label in the seed; no prune and no force on images.
  const labelled = new Set(["c1", "c2", "c3", "n1", "n2", ...seeded.images.filter((i) => i.labels["org.jgates.managed"]).map((i) => i.id), ...seeded.volumes.map((v) => v.name)]);
  const calls = removals(m.dockerCalls());
  assert.equal(calls.length, 7, "one removal call per engine object");
  for (const call of calls) {
    assert.ok(!call.includes("prune"), call.join(" "));
    const ids = call.filter((a) => !a.startsWith("-") && !["container", "volume", "image", "network", "rm"].includes(a));
    assert.ok(ids.length > 0 && ids.every((id) => labelled.has(id)), `unlabelled target in ${call.join(" ")}`);
  }
  // The freed space counts the layers only the removed images held: the shared base stays because the pinned image still uses it.
  assert.equal(r.doc.applied.freedBytes, 250e6 + 40e6 + 100e6 + 4096);
});

test("scopes pick only what they name: --caches takes the cache volume, --data and --toolchains the others, --images every free image", () => {
  const m = machine({ running: false });
  const caches = m.cli(["clean", "--caches", "--dry-run", "--json"]);
  assert.deepEqual(caches.doc.items.map((i) => i.name), ["jgates-cache"]);
  const data = m.cli(["clean", "--data", "--toolchains", "--dry-run", "--json"]);
  assert.deepEqual(data.doc.items.map((i) => i.name).sort(), ["jgates-data", "jgates-toolchains"]);
  const images = m.cli(["clean", "--images", "--dry-run", "--json"]);
  const free = images.doc.items.filter((i) => i.action === "remove").map((i) => i.name).sort();
  assert.deepEqual(free, ["jgates-tools:0.0.1", `jgates-ext-${WS_LIVE}:k2`, `jgates-ext-${WS_ORPHAN}:k1`].sort());
  assert.deepEqual(images.doc.items.filter((i) => i.action === "skip").map((i) => `${i.name}=${i.inUse.code}`).sort(), ["jgates-tools:0.0.2=USED_BY_CONTAINER", "jgates-tools:dev=PINNED_IMAGE"]);
  const workspace = m.cli(["clean", "--workspace", WS_LIVE, "--dry-run", "--json"]);
  assert.deepEqual(workspace.doc.items.map((i) => i.name).sort(), [`jgates-${WS_LIVE}-src`, `jgates-ext-${WS_LIVE}:k2`, `jgates-${WS_LIVE}-run_0_default`, "jgates-run_0-lint"].sort());
  const orphans = m.cli(["clean", "--orphans", "--dry-run", "--json"]);
  assert.deepEqual(orphans.doc.items.map((i) => i.name).sort(), [`jgates-${WS_ORPHAN}-src`, `jgates-${WS_ORPHAN}-deps-py-abc`, `jgates-${WS_RUN}-src`, `jgates-ext-${WS_ORPHAN}:k1`].sort());
  // A shared volume is applied for real, alone.
  const apply = m.cli(["clean", "--caches", "--yes", "--json"]);
  assert.equal(apply.status, 0, apply.stdout);
  assert.ok(!names(m.read()).volumes.includes("jgates-cache"));
  assert.ok(names(m.read()).volumes.includes("jgates-data"));
});

test("the unlabelled legacy sidecar is listed apart and removed only with --legacy-sidecar", () => {
  const m = machine({ running: false });
  const plain = m.cli(["clean", "--yes", "--json"]);
  assert.equal(plain.status, 0, plain.stdout);
  assert.ok(names(m.read()).images.includes("jgates/quality-sidecar:latest"));
  assert.deepEqual(plain.doc.unmanaged.map((u) => u.name), ["jgates/quality-sidecar:latest"]);
  const asked = m.cli(["clean", "--legacy-sidecar", "--yes", "--json"]);
  assert.equal(asked.status, 0, asked.stdout);
  assert.deepEqual(asked.doc.applied.legacySidecar.map((l) => [l.name, l.removed]), [["jgates/quality-sidecar:latest", true]]);
  const images = names(m.read()).images;
  assert.ok(!images.includes("jgates/quality-sidecar:latest"));
  assert.ok(images.includes("someone/else:1"), "another unlabelled image is never touched");
});

test("uninstall lists everything, including the project files it never touches, and removes nothing without --yes", () => {
  const m = machine();
  const projectBefore = treeHash(m.project);
  const before = fs.readFileSync(path.join(m.state, "objects.json"), "utf8");
  const r = m.cli(["uninstall", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.doc.mode, "dry-run");
  const listed = r.doc.items.map((i) => i.name);
  for (const name of ["jgates-data", "jgates-cache", "jgates-toolchains", "jgates-tools:dev", `jgates-ext-${WS_LIVE}:k2`, "jgates-run_0-lint"]) assert.ok(listed.includes(name), `${name} is listed`);
  assert.ok(!listed.includes("someone/else:1") && !listed.includes("jgates/quality-sidecar:latest"));
  assert.equal(r.doc.home.path, m.home);
  assert.equal(r.doc.home.removable, true);
  assert.equal(r.doc.home.removed, false);
  assert.deepEqual(r.doc.projectFiles.map((p) => [p.path, p.files.map((f) => f.kind).sort()]), [[m.project, ["config", "folder", "hook"]]]);
  const hook = r.doc.projectFiles[0].files.find((f) => f.kind === "hook");
  assert.match(hook.removeCommand, /^jgates hooks uninstall pre-commit --cwd /);
  assert.equal(r.doc.keyStore.exists, true);
  assert.equal(typeof r.doc.cli.command === "string" || typeof r.doc.cli.folder === "string", true);
  assert.equal(fs.readFileSync(path.join(m.state, "objects.json"), "utf8"), before);
  assert.deepEqual(removals(m.dockerCalls()), []);
  assert.equal(treeHash(m.project), projectBefore);
  assert.ok(fs.existsSync(m.home));
});

test("uninstall --yes removes every labelled object, the data folder and the old tools folder, keeps the key store, the unlabelled images and the projects", () => {
  const m = machine({ running: false });
  const projectBefore = treeHash(m.project);
  const r = m.cli(["uninstall", "--yes", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.doc.mode, "applied");
  assert.equal(r.doc.applied.failed, 0);
  assert.equal(r.doc.applied.incomplete, false);
  const objects = m.read();
  const withManaged = [...objects.images, ...objects.containers, ...objects.networks, ...objects.volumes].filter((o) => o.labels?.["org.jgates.managed"] === "true");
  assert.deepEqual(withManaged.map((o) => o.name), [], "zero objects with org.jgates.managed=true remain");
  assert.deepEqual(names(objects).images.sort(), ["jgates/quality-sidecar:latest", "someone/else:1"], "the unlabelled images are intact");
  assert.ok(!fs.existsSync(m.home), "the data folder is gone");
  assert.ok(fs.existsSync(path.join(m.keys, "secrets.json")), "the key store needs its own confirmation");
  assert.equal(r.doc.keyStore.removed, false);
  assert.equal(treeHash(m.project), projectBefore, "the project files are listed but unchanged");
  assert.deepEqual(removals(m.dockerCalls()).filter((c) => c.includes("prune")), []);
  // The key store goes only with the flag.
  const m2 = machine({ running: false });
  const withKeys = m2.cli(["uninstall", "--yes", "--include-key-store", "--json"]);
  assert.equal(withKeys.status, 0, withKeys.stdout + withKeys.stderr);
  assert.equal(withKeys.doc.keyStore.removed, true);
  assert.ok(!fs.existsSync(path.join(m2.keys, "secrets.json")));
});

test("uninstall skips what is in use as 'em uso' and keeps the data folder so it can run again", () => {
  const m = machine({ locale: "pt-BR" });
  const r = m.cli(["uninstall", "--yes", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.doc.applied.incomplete, true);
  assert.ok(fs.existsSync(m.home), "the data folder stays while something is in use");
  const left = names(m.read());
  assert.deepEqual(left.containers, ["jgates-run_1-lint"]);
  assert.ok(left.volumes.includes("jgates-data"), "shared volumes stay while a JGates container runs");
  assert.ok(r.doc.items.filter((i) => i.action === "skip").every((i) => i.label === "em uso"));
  // The run ended: the second uninstall finishes the job.
  const objects = m.read();
  m.write({ ...objects, containers: objects.containers.filter((c) => c.state !== "running") });
  const again = m.cli(["uninstall", "--yes", "--json"]);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(again.doc.applied.incomplete, false);
  assert.deepEqual(names(m.read()).volumes, []);
  assert.ok(!fs.existsSync(m.home));
});

test("uninstall refuses to remove a data folder that holds a project, and one that is not a JGates folder", async () => {
  const { checkHome } = await load("core", "cleanup", "index.js");
  const m = machine();
  assert.equal(checkHome(m.home).code, "OK");
  const stranger = tmp("jgates-not-home-");
  fs.writeFileSync(path.join(stranger, "precious.txt"), "mine");
  assert.equal(checkHome(stranger).code, "NOT_A_JGATES_FOLDER");
  assert.equal(checkHome(os.homedir()).code === "OK", false);
  assert.equal(checkHome(path.parse(os.tmpdir()).root).code, "TOO_BROAD");
  // A project inside the data folder.
  const inner = path.join(m.home, "inner-project");
  fs.mkdirSync(inner);
  const registry = JSON.parse(fs.readFileSync(path.join(m.home, "workspaces.json"), "utf8"));
  registry.workspaces.push({ id: "ws_" + "4".repeat(16), path: inner, name: "inner", lastAccess: new Date().toISOString() });
  fs.writeFileSync(path.join(m.home, "workspaces.json"), JSON.stringify(registry));
  assert.equal(checkHome(m.home).code, "HOLDS_A_PROJECT");
  assert.ok(fs.existsSync(path.join(stranger, "precious.txt")));
});

test("the storage report sizes tools by version, data, toolchains, caches, extensions and each workspace, with shared layers counted once", async () => {
  const m = machine();
  const { storageReport, engineContextFor } = await load("core", "cleanup", "index.js");
  const env = m.env;
  const report = await storageReport(env, engineContextFor(env));
  assert.equal(report.engine.state, "ready");
  assert.deepEqual(report.tools.map((t) => [t.version, t.bytes]), [["0.0.0-pinned", 800e6], ["0.0.1", 800e6], ["0.0.2", 800e6]]);
  assert.deepEqual(report.data.volumes.map((v) => [v.name, v.sizeBytes]), [["jgates-data", 2000e6]]);
  assert.deepEqual(report.toolchains.volumes.map((v) => v.sizeBytes), [1000e6]);
  assert.deepEqual(report.caches.volumes.map((v) => v.sizeBytes), [300e6]);
  assert.equal(report.extensions.images.length, 2);
  assert.equal(report.extensions.bytes, 300e6);
  const ws = Object.fromEntries(report.workspaces.map((w) => [w.workspace, w.bytes]));
  assert.deepEqual(ws, { [WS_ORPHAN]: 140e6, [WS_LIVE]: 20e6, [WS_RUN]: 10e6 });
  // Five images of 800-850 MB share a 700 MB base: the unique parts add up, the base counts once.
  assert.equal(report.images.sumBytes, 800e6 * 3 + 850e6 * 2);
  assert.equal(report.images.uniqueBytes, 100e6 * 3 + 150e6 * 2);
  assert.equal(report.images.sharedBytes, 700e6);
  assert.equal(report.images.totalBytes, 600e6 + 700e6);
  assert.equal(report.volumesBytes, 300e6 + 2000e6 + 1000e6 + 40e6 + 100e6 + 20e6 + 10e6);
  assert.equal(report.totalBytes, report.images.totalBytes + report.volumesBytes);
});

test("GET /api/storage carries the engine categories next to the workspaces and the retention", async () => {
  const m = machine();
  const { routes } = await load("server", "routes", "storage.js");
  const route = routes.find((r) => r.method === "GET" && r.path === "/api/storage");
  const saved = { ...process.env };
  Object.assign(process.env, { JGATES_CONTAINER_RUNTIME: m.runtime, JGATES_TOOLS_IMAGE: "jgates-tools:dev" });
  try {
    const server = { home: m.home, workspace: { id: WS_LIVE }, version: VERSION, projectDir: m.project, log: () => undefined };
    const { json } = await route.handler({ server });
    assert.equal(json.status, "OK");
    assert.equal(json.categories.engine.state, "ready");
    assert.deepEqual(json.categories.tools.map((t) => t.version), ["0.0.0-pinned", "0.0.1", "0.0.2"]);
    assert.equal(json.categories.totalBytes, 600e6 + 700e6 + 3470e6);
    const live = json.workspaces.find((w) => w.id === WS_LIVE);
    assert.equal(live.engine.bytes, 20e6);
    assert.ok(json.retention && json.workspaces.length === 3);
  } finally {
    for (const key of ["JGATES_CONTAINER_RUNTIME", "JGATES_TOOLS_IMAGE"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("with no engine the storage report is empty and clean still offers the data folder items", async () => {
  const m = machine();
  const env = { ...m.env, JGATES_CONTAINER_RUNTIME: path.join(m.dir, "no-such-engine") };
  const r = spawnSync(process.execPath, [MAIN, "clean", "--dry-run", "--json"], { cwd: m.project, encoding: "utf8", env, input: "" });
  const doc = JSON.parse(r.stdout);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(doc.engine.state, "unavailable");
  assert.deepEqual(doc.items.map((i) => i.resource), ["folder"]);
  const { storageReport, engineContextFor } = await load("core", "cleanup", "index.js");
  const report = await storageReport(env, engineContextFor(env));
  assert.equal(report.engine.state, "unavailable");
  assert.equal(report.totalBytes, 0);
});
