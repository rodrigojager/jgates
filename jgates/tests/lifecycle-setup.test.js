import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// The lifecycle commands against the fake engine (jgates/tests/docker/fake-docker.cjs, which records every call): the disk
// check before a download, the export/import of the tools image with its digest check, the load of a tarball by setup, the
// start of a stopped engine, and the in-image no-op. The end-to-end cases are V2-33 and V2-34.

const here = path.dirname(fileURLToPath(import.meta.url));
// The default suite runs in the in-image mode (tests/setup/in-image.mjs); these tests build their own environments.
delete process.env.JGATES_IMAGE_JSON;
const packageRoot = path.resolve(here, "..");
const MAIN = path.join(packageRoot, "dist", "cli", "main.js");
const FAKE = path.join(here, "docker", "fake-docker.cjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(packageRoot, "..", "package.json"), "utf8")).version;
const load = (...parts) => import(pathToFileURL(path.join(packageRoot, "dist", ...parts)).href);
const LABELS = JSON.stringify({ "org.jgates.version": VERSION });

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake engine. `imageWhen`: "always" (the image is there), "loaded" (only after a `load`), "pulled" (only after a pull).
 * `idAfterLoad`: the image id the engine reports once a tarball was loaded (a tampered image).
 */
function machine({ imageWhen = "always", idAfterLoad = null, started = null, extra = {} } = {}) {
  const dir = tmp("jgates-lifecycle-");
  const calls = path.join(dir, "calls.jsonl");
  const runtime = path.join(dir, "docker.cjs");
  const lines = [
    `const fs = require("node:fs");`,
    `const path = require("node:path");`,
    `const state = ${JSON.stringify(dir)};`,
    `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};`,
    `process.env.FAKE_DOCKER_STATE = state;`,
    `const loaded = fs.existsSync(path.join(state, "loaded.jsonl"));`,
    `const pulled = fs.existsSync(path.join(state, "pull-attempts"));`,
    `const present = ${imageWhen === "always" ? "true" : imageWhen === "loaded" ? "loaded" : "pulled"};`,
    `process.env.FAKE_DOCKER_LABELS = present ? ${JSON.stringify(LABELS)} : "none";`,
    ...(idAfterLoad ? [`if (loaded) process.env.FAKE_DOCKER_IMAGE_ID = ${JSON.stringify(idAfterLoad)};`] : []),
    ...(started ? [`process.env.FAKE_DOCKER_DAEMON = fs.existsSync(${JSON.stringify(started)}) ? "running" : "stopped";`] : []),
    ...Object.entries(extra).map(([k, v]) => `process.env.${k} = ${JSON.stringify(String(v))};`),
    `require(${JSON.stringify(FAKE)});`,
  ];
  fs.writeFileSync(runtime, lines.join("\n") + "\n");
  const env = { ...process.env, JGATES_HOME: path.join(dir, "home"), JGATES_CONTAINER_RUNTIME: runtime, JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  delete env.JGATES_IMAGE_JSON;
  const dockerCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const cli = (args, input = "") => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { cwd: dir, encoding: "utf8", env: { ...env, JGATES_IMAGE_JSON: "" }, input, timeout: 120_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, doc };
  };
  return { dir, env, dockerCalls, cli };
}

const pin = (overrides = {}) => ({ schemaVersion: 1, name: "jgates-tools", reference: "jgates-tools:dev", digest: "sha256:" + "1".repeat(64), imageVersion: "0.0.0", jgatesVersion: VERSION, platform: "linux/amd64", sizeBytes: 1_930_000_000, published: false, ...overrides });

test("the disk the download needs is compressed + unpacked + 10 %", async () => {
  const { diskRequirement } = await load("core", "lifecycle", "index.js");
  const real = diskRequirement(pin({ compressedBytes: 1_930_000_000, uncompressedBytes: 5_580_000_000 }));
  assert.equal(real.totalBytes, Math.ceil((1_930_000_000 + 5_580_000_000) * 1.1));
  assert.equal(real.totalMb, Math.ceil(real.totalBytes / 1048576));
  // Without the unpacked size the ratio measured on the first complete image is used.
  const estimated = diskRequirement(pin());
  assert.equal(estimated.compressedBytes, 1_930_000_000);
  assert.ok(estimated.uncompressedBytes > 5_500_000_000 && estimated.uncompressedBytes < 5_700_000_000, String(estimated.uncompressedBytes));
});

test("not enough free disk is DISK_LOW before anything is downloaded", async () => {
  const { runSetup } = await load("core", "lifecycle", "index.js");
  const m = machine({ imageWhen: "pulled" });
  // A pin that needs more than any disk has.
  const result = await runSetup({ env: m.env, version: VERSION, pin: pin({ sizeBytes: 5e14 }), locale: "en" });
  assert.equal(result.ready, false);
  assert.equal(result.pulled, false);
  const low = result.reasons.find((r) => r.code === "DISK_LOW");
  assert.ok(low, JSON.stringify(result.reasons));
  assert.match(low.message, /more free space is needed/);
  assert.equal(low.action.route, "preferences/storage");
  assert.deepEqual(result.steps.map((s) => [s.id, s.state]), [["engine", "done"], ["disk", "failed"]]);
  const used = m.dockerCalls();
  assert.ok(!used.some((c) => c[0] === "pull" || c[0] === "manifest" || c[0] === "load"), "no download started: " + JSON.stringify(used));
  // The same pin with a small size passes the check and pulls.
  const fine = await runSetup({ env: m.env, version: VERSION, pin: pin({ sizeBytes: 1_000 }), withData: false, locale: "en" });
  assert.equal(fine.ready, true, JSON.stringify(fine.reasons));
  assert.ok(m.dockerCalls().some((c) => c[0] === "pull"));
});

test("a pull that fails is IMAGE_PULL_FAILED with the engine text only in details", async () => {
  const { runSetup } = await load("core", "lifecycle", "index.js");
  const m = machine({ imageWhen: "pulled", extra: { FAKE_DOCKER_PULL_DROPS: 5, FAKE_DOCKER_PULL_DROP_AFTER: 0 } });
  const result = await runSetup({ env: m.env, version: VERSION, pin: pin({ sizeBytes: 1_000 }), withData: false, locale: "en" });
  assert.equal(result.ready, false);
  const failed = result.reasons.find((r) => r.code === "IMAGE_PULL_FAILED");
  assert.ok(failed, JSON.stringify(result.reasons));
  assert.match(failed.details, /unexpected EOF/);
  assert.ok(!failed.message.includes("EOF") || failed.message.includes("The download of the tools stopped"));
  assert.equal(failed.action.command, "jgates setup");
});

test("export then import verifies the digest of the image; a changed tarball or image is refused", async () => {
  const { exportImage, importImage, TransferError, sha256OfFile } = await load("core", "lifecycle", "index.js");
  const a = machine({ imageWhen: "always" });
  const file = path.join(a.dir, "out", "tools.tar");
  const record = await exportImage({ env: a.env, version: VERSION, file });
  assert.ok(a.dockerCalls().some((c) => c[0] === "save" && c.includes(file) && c.at(-1) === "jgates-tools:dev"));
  assert.equal(record.sha256, (await sha256OfFile(file)).sha256);
  assert.match(record.imageId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.parse(fs.readFileSync(`${file}.json`, "utf8")).imageId, record.imageId);

  // Another machine (no image yet) imports it: loaded, verified.
  const b = machine({ imageWhen: "loaded" });
  const imported = await importImage({ env: b.env, version: VERSION, file });
  assert.equal(imported.loadedId, record.imageId);
  assert.ok(b.dockerCalls().some((c) => c[0] === "load" && c.includes(file)));

  // A tarball that is not the one exported: refused before the engine loads anything.
  const c = machine({ imageWhen: "loaded" });
  const tampered = path.join(c.dir, "tampered.tar");
  fs.copyFileSync(file, tampered);
  fs.copyFileSync(`${file}.json`, `${tampered}.json`);
  fs.appendFileSync(tampered, "tampered");
  await assert.rejects(importImage({ env: c.env, version: VERSION, file: tampered }), (e) => e instanceof TransferError && e.code === "IMPORT_TARBALL_MISMATCH");
  assert.ok(!c.dockerCalls().some((call) => call[0] === "load"), "nothing was loaded");

  // No record: refused (an image that cannot be verified is not loaded).
  const bare = path.join(c.dir, "bare.tar");
  fs.copyFileSync(file, bare);
  await assert.rejects(importImage({ env: c.env, version: VERSION, file: bare }), (e) => e.code === "IMPORT_NO_RECORD");
  await assert.rejects(importImage({ env: c.env, version: VERSION, file: path.join(c.dir, "missing.tar") }), (e) => e.code === "IMPORT_FILE_MISSING");

  // The engine ends up with another image than the one recorded: the digest check fails.
  const d = machine({ imageWhen: "loaded", idAfterLoad: "sha256:" + "9".repeat(64) });
  await assert.rejects(importImage({ env: d.env, version: VERSION, file }), (e) => e.code === "IMPORT_DIGEST_MISMATCH" && e.message.includes(record.imageId));

  // A published release also pins the digest: an image that is not that one is refused.
  const e = machine({ imageWhen: "loaded" });
  await assert.rejects(importImage({ env: { ...e.env, JGATES_TOOLS_IMAGE: "" }, version: VERSION, file, pin: pin({ published: true, reference: "jgates-tools:dev", digest: "sha256:" + "7".repeat(64) }) }), (err) => err.code === "IMPORT_PIN_MISMATCH");
  const ok = machine({ imageWhen: "loaded" });
  const pinned = await importImage({ env: { ...ok.env, JGATES_TOOLS_IMAGE: "" }, version: VERSION, file, pin: pin({ published: true, reference: "jgates-tools:dev", digest: record.imageId }) });
  assert.equal(pinned.loadedId, record.imageId);

  // Nothing to export without the image; an engine that cannot save leaves no file.
  const empty = machine({ imageWhen: "loaded" });
  await assert.rejects(exportImage({ env: empty.env, version: VERSION, file: path.join(empty.dir, "x.tar") }), (err) => err.code === "IMAGE_MISSING");
  const broken = machine({ imageWhen: "always", extra: { FAKE_DOCKER_SAVE_FAIL: 1 } });
  const brokenFile = path.join(broken.dir, "x.tar");
  await assert.rejects(exportImage({ env: broken.env, version: VERSION, file: brokenFile }), (err) => err.code === "EXPORT_FAILED");
  assert.ok(!fs.existsSync(brokenFile) && !fs.existsSync(`${brokenFile}.json`));
});

test("jgates tools export and import work from the command line, with JSON and exit codes", () => {
  const a = machine({ imageWhen: "always" });
  const file = path.join(a.dir, "tools.tar");
  const exported = a.cli(["tools", "export", file, "--json"]);
  assert.equal(exported.status, 0, exported.stdout + exported.stderr);
  assert.equal(exported.doc.status, "OK");
  assert.equal(exported.doc.record.sha256.length, 64);
  const b = machine({ imageWhen: "loaded" });
  const imported = b.cli(["tools", "import", file, "--json"]);
  assert.equal(imported.status, 0, imported.stdout + imported.stderr);
  assert.equal(imported.doc.verified, true);
  assert.equal(imported.doc.loadedId, exported.doc.record.imageId);
  fs.appendFileSync(file, "x");
  const c = machine({ imageWhen: "loaded" });
  const refused = c.cli(["tools", "import", file, "--json"]);
  assert.equal(refused.status, 2);
  assert.equal(refused.doc.code, "IMPORT_TARBALL_MISMATCH");
  assert.equal(c.cli(["tools", "import", "--json"]).status, 3, "the file is required");
  const text = c.cli(["tools", "import", file]);
  assert.equal(text.status, 2);
  assert.match(text.stderr, /IMPORT_TARBALL_MISMATCH/);
});

test("setup --from loads the exported image instead of pulling it, and the machine is ready", () => {
  const a = machine({ imageWhen: "always" });
  const file = path.join(a.dir, "tools.tar");
  assert.equal(a.cli(["tools", "export", file, "--json"]).status, 0);
  const b = machine({ imageWhen: "loaded" });
  const setup = b.cli(["setup", "--from", file, "--no-data", "--json"]);
  assert.equal(setup.status, 0, setup.stdout + setup.stderr);
  assert.equal(setup.doc.ready, true);
  assert.equal(setup.doc.pulled, true);
  const used = b.dockerCalls();
  assert.ok(used.some((c) => c[0] === "load"));
  assert.ok(!used.some((c) => c[0] === "pull"), "loaded, not pulled");
  // Without data the machine is ready and says what stays incomplete.
  assert.deepEqual(setup.doc.steps.find((s) => s.id === "data").state, "skipped");
  assert.ok(setup.doc.warnings.some((w) => w.code === "DATA_MISSING" && w.action.command === "jgates tools update-data"));
  // A tarball that fails its check leaves the machine not ready, with the image still missing.
  fs.appendFileSync(file, "x");
  const c = machine({ imageWhen: "loaded" });
  const refused = c.cli(["setup", "--from", file, "--no-data", "--json"]);
  assert.equal(refused.status, 2);
  assert.ok(refused.doc.reasons.some((r) => r.code === "IMAGE_PULL_FAILED" && /IMPORT_TARBALL_MISMATCH/.test(r.details)));
  assert.ok(!c.dockerCalls().some((call) => call[0] === "load"));
});

test("setup --yes starts a stopped engine whose start command needs no password, waits for it, and never starts it without --yes", async () => {
  const { runSetup, detectSystem, dockerStartRecipe } = await load("core", "lifecycle", "index.js").then(async (m) => ({ ...m, ...(await load("core", "install", "index.js")) }));
  const marker = path.join(tmp("jgates-started-"), "started");
  const m = machine({ imageWhen: "pulled", started: marker });
  const ran = [];
  const executor = {
    run(argv) {
      ran.push(argv);
      fs.writeFileSync(marker, "started");
      return { status: 0 };
    },
    prepare: async () => undefined,
  };
  const without = await runSetup({ env: m.env, version: VERSION, pin: pin({ sizeBytes: 1_000 }), withData: false, executor, locale: "en" });
  assert.equal(without.ready, false);
  assert.equal(without.reasons.length + without.status.reasons.length > 0, true);
  assert.equal(without.status.reasons[0].code, "ENGINE_STOPPED");
  assert.deepEqual(ran, [], "the engine is not started without --yes");

  const recipe = dockerStartRecipe(detectSystem());
  const needsPassword = !recipe.available || recipe.commands.some((c) => c === "sudo" || c.startsWith("sudo "));
  const withYes = await runSetup({ env: m.env, version: VERSION, pin: pin({ sizeBytes: 1_000 }), withData: false, yes: true, executor, startTimeoutMs: 5_000, locale: "en" });
  if (needsPassword) {
    assert.deepEqual(ran, [], "a start command that needs sudo is shown, never run");
    assert.equal(withYes.ready, false);
  } else {
    assert.equal(ran.length, recipe.steps.length);
    assert.equal(withYes.ready, true, JSON.stringify(withYes.reasons) + JSON.stringify(withYes.status.reasons));
  }
});

test("inside the tools image there is nothing to set up and status is ready without an engine", async () => {
  const { runSetup, collectStatus } = await load("core", "lifecycle", "index.js");
  const imageJson = path.join(tmp("jgates-image-json-"), "image.json");
  fs.writeFileSync(imageJson, JSON.stringify({ schemaVersion: 1, jgatesVersion: VERSION, imageVersion: "0.0.0", sourceRevision: "x", tools: {}, runtimes: {}, defaults: {} }));
  const env = { ...process.env, JGATES_IMAGE_JSON: imageJson, JGATES_CONTAINER_RUNTIME: "jgates-no-such-engine" };
  const status = await collectStatus({ env, version: VERSION, projectDir: null });
  assert.equal(status.mode, "in-image");
  assert.equal(status.ready, true);
  const result = await runSetup({ env, version: VERSION, locale: "en" });
  assert.equal(result.ready, true);
  assert.deepEqual(result.steps.map((s) => [s.id, s.state]), [["engine", "skipped"]]);
});

test("status in Portuguese names the problems and what to do; plurals have no parenthesized forms", () => {
  const m = machine({ imageWhen: "pulled" });
  const r = m.cli(["status"], "");
  const pt = spawnSync(process.execPath, [MAIN, "status"], { cwd: m.dir, encoding: "utf8", env: { ...m.env, JGATES_LOCALE: "pt-BR", JGATES_IMAGE_JSON: "" } });
  assert.equal(pt.status, 2);
  assert.match(pt.stdout, /^Não está pronto/);
  assert.match(pt.stdout, /IMAGE_MISSING/);
  assert.match(pt.stdout, /O que fazer: .*jgates setup/);
  assert.equal(r.status, 2);
  for (const locale of ["en", "pt-BR"]) {
    const catalog = JSON.parse(fs.readFileSync(path.join(packageRoot, "src", "i18n", `lifecycle.${locale}.json`), "utf8"));
    for (const [key, text] of Object.entries(catalog)) assert.ok(!/\(s\)|\(es\)|\(ns\)/.test(text), `${locale} ${key}`);
  }
});
