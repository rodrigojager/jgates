import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-59 (fake engine): the Storage screen's server API.
//   - GET /api/storage gives the sizes by label category (tools by version, security data, toolchains, caches and the
//     volumes of each workspace, one of them whose folder is gone);
//   - POST /api/storage/cleanup without `dryRun: false` only lists what would go (labelled objects only, the ones in use
//     marked) and makes no removal call to the engine;
//   - a clean without the confirmation word or without the list is refused and removes nothing; with both it removes only
//     the listed objects that the plan still marks removable: an unlabelled volume asked for by key is left alone;
//   - an uninstall needs the typed word; with a wrong word nothing is removed, with the right one the labelled objects go,
//     the unlabelled ones stay, and the data folder stays while something is in use.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

const WS_ORPHAN = "ws_" + "2".repeat(16);
const sha = (c) => "sha256:" + c.repeat(64);
const managed = (kind, extra = {}) => ({ "org.jgates.managed": "true", "org.jgates.kind": kind, "org.jgates.version": VERSION, ...extra });

const made = [];
const tmp = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function request(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port, method, path: p, agent: false, headers: { Host: `127.0.0.1:${port}`, ...(data ? { "Content-Type": "application/json", "Content-Length": String(data.length) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function startUi(env, cwd) {
  const proc = spawn(process.execPath, [MAIN, "ui", "--cwd", cwd, "--no-open", "--port", "0", "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const ui = { proc, info: null, out: "", err: "" };
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (d) => (ui.err += d));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`jgates ui did not start:\n${ui.out}\n${ui.err}`)), 30_000);
    proc.stdout.on("data", (d) => {
      ui.out += d;
      if (ui.info) return;
      try {
        ui.info = JSON.parse(ui.out);
        clearTimeout(timer);
        resolve(ui);
      } catch {
        // Not complete yet.
      }
    });
    proc.on("exit", (code) => {
      if (ui.info) return;
      clearTimeout(timer);
      reject(new Error(`jgates ui exited with ${code}:\n${ui.out}\n${ui.err}`));
    });
  });
}

async function session(ui) {
  const html = fs.readFileSync(ui.info.launcher, "utf8");
  const href = /href="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
  assert.ok(href, "launcher has no bootstrap link");
  const url = new URL(href);
  const port = ui.info.port;
  const boot = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: url.pathname + url.search, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res));
    }).on("error", reject);
  });
  const cookie = String(boot.headers["set-cookie"]?.[0] ?? "").split(";")[0];
  const s = await request(port, "GET", "/api/session", { headers: { Cookie: cookie } });
  assert.equal(s.status, 200, s.text);
  const origin = `http://127.0.0.1:${port}`;
  return (method, p, body) => request(port, method, p, { headers: method === "GET" ? { Cookie: cookie } : { Cookie: cookie, Origin: origin, "X-JGates-CSRF": s.json.csrfToken }, body });
}

function seed() {
  return {
    images: [
      { id: sha("a"), name: "jgates-tools", tag: "dev", labels: managed("step"), sizeBytes: 800e6, sharedBytes: 700e6, built: true },
      { id: sha("b"), name: "jgates-tools", tag: "0.0.1", labels: managed("step", { "org.jgates.version": "0.0.1" }), sizeBytes: 800e6, sharedBytes: 700e6, built: true },
      { id: sha("9"), name: "someone/else", tag: "1", labels: {}, sizeBytes: 100e6, built: true },
    ],
    containers: [{ id: "c2", name: "jgates-run_0-lint", state: "exited", labels: managed("step", { "org.jgates.workspace": WS_ORPHAN, "org.jgates.run": "run_0" }) }],
    networks: [],
    volumes: [
      { name: "jgates-cache", labels: managed("deps"), sizeBytes: 300e6 },
      { name: "jgates-data", labels: managed("data"), sizeBytes: 2000e6 },
      { name: "jgates-toolchains", labels: managed("toolchain"), sizeBytes: 1000e6 },
      { name: `jgates-${WS_ORPHAN}-src`, labels: managed("sync", { "org.jgates.workspace": WS_ORPHAN }), sizeBytes: 40e6 },
      { name: `jgates-${WS_ORPHAN}-deps-py-abc`, labels: managed("deps", { "org.jgates.workspace": WS_ORPHAN }), sizeBytes: 100e6 },
      // Not JGates's: no label at all. It must survive every call below.
      { name: "someone-elses-volume", labels: {}, sizeBytes: 500e6 },
    ],
  };
}

test("V2-59: storage sizes by label category; clean needs confirmation and removes only the listed labelled objects; uninstall needs the typed word", async () => {
  const dir = tmp("v2-59-");
  const home = path.join(dir, "home");
  const project = path.join(dir, "project");
  const state = path.join(dir, "state");
  const calls = path.join(dir, "calls.jsonl");
  const runtime = path.join(dir, "docker.cjs");
  fs.mkdirSync(path.join(home, "workspaces"), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(project, "mod.py"), "x = 1\n");
  fs.writeFileSync(path.join(state, "objects.json"), JSON.stringify(seed()));
  fs.writeFileSync(runtime, [`process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};`, `process.env.FAKE_DOCKER_STATE = ${JSON.stringify(state)};`, `require(${JSON.stringify(FAKE)});`].join("\n") + "\n");
  fs.writeFileSync(path.join(home, "workspaces.json"), JSON.stringify({ schemaVersion: 1, workspaces: [{ id: WS_ORPHAN, path: path.join(dir, "gone"), name: "old-repo", lastAccess: new Date().toISOString() }] }));
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:0.0.1", SEMANTIC_GATE_HOME: path.join(dir, "keys"), JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  const objects = () => JSON.parse(fs.readFileSync(path.join(state, "objects.json"), "utf8"));
  const dockerCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const removalCalls = () => dockerCalls().filter((c) => c.includes("rm"));
  const volumeNames = () => objects().volumes.map((v) => v.name);

  let ui = null;
  try {
    ui = await startUi(env, project);
    const call = await session(ui);

    // Sizes by category, from the labels.
    const storage = await call("GET", "/api/storage");
    assert.equal(storage.status, 200, storage.text);
    const cat = storage.json.categories;
    assert.equal(cat.engine.state, "ready");
    assert.equal(cat.data.bytes, 2000e6);
    assert.equal(cat.toolchains.bytes, 1000e6);
    assert.equal(cat.caches.bytes, 300e6, "caches: the shared cache volume only");
    assert.ok(cat.tools.some((t) => t.version === VERSION || t.images.some((i) => i.pinned)), "the pinned tools image is listed");
    assert.ok(cat.tools.some((t) => t.version === "0.0.1"), "the previous tools version is listed");
    const orphan = storage.json.workspaces.find((w) => w.id === WS_ORPHAN);
    assert.ok(orphan, "the workspace whose folder is gone is listed");
    assert.equal(orphan.exists, false);
    assert.equal(orphan.engine.bytes, 140e6, "the source copy and the dependencies volumes of the workspace");
    const inReport = JSON.stringify(cat);
    assert.ok(!inReport.includes("someone-elses-volume") && !inReport.includes("someone/else"), "unlabelled objects are not counted");

    // A listing never removes.
    const dry = await call("POST", "/api/storage/cleanup", { mode: "clean" });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.json.dryRun, true);
    const listed = dry.json.items;
    assert.ok(listed.length > 0 && listed.every((i) => typeof i.key === "string" && typeof i.sizeBytes === "number"));
    for (const item of listed) assert.ok(!/someone/.test(item.name), `${item.name} is not JGates's`);
    const pinned = listed.find((i) => i.resource === "image" && i.name.includes("jgates-tools:0.0.1"));
    assert.ok(pinned && pinned.action === "skip" && pinned.reason === "in-use", "the pinned image is listed as in use");
    assert.equal(removalCalls().length, 0, "a listing makes no removal call");

    // A clean needs the confirmation and the list.
    const cachePlan = await call("POST", "/api/storage/cleanup", { mode: "clean", scope: { caches: true } });
    assert.equal(cachePlan.status, 200, cachePlan.text);
    const cacheKey = cachePlan.json.items.find((i) => i.resource === "volume" && i.name === "jgates-cache")?.key;
    assert.ok(cacheKey, "the cache volume is in the clean list");
    const noConfirm = await call("POST", "/api/storage/cleanup", { mode: "clean", scope: { caches: true }, dryRun: false, items: [cacheKey] });
    assert.equal(noConfirm.status, 400, noConfirm.text);
    assert.equal(noConfirm.json.code, "CONFIRMATION_REQUIRED");
    const noList = await call("POST", "/api/storage/cleanup", { mode: "clean", scope: { caches: true }, dryRun: false, confirm: "clean" });
    assert.equal(noList.status, 400, noList.text);
    const wrongWord = await call("POST", "/api/storage/cleanup", { mode: "clean", scope: { caches: true }, dryRun: false, items: [cacheKey], confirm: "uninstall" });
    assert.equal(wrongWord.status, 400, wrongWord.text);
    assert.equal(removalCalls().length, 0, "refused requests remove nothing");

    // With both, only the listed object goes, and a key of an unlabelled volume is ignored.
    const applied = await call("POST", "/api/storage/cleanup", { mode: "clean", scope: { caches: true }, dryRun: false, items: [cacheKey, "volume:someone-elses-volume", "image:" + sha("9")], confirm: "clean" });
    assert.equal(applied.status, 200, applied.text);
    assert.equal(applied.json.applied.removed, 1);
    assert.deepEqual(applied.json.applied.lines.map((l) => l.id), ["jgates-cache"]);
    const removed = removalCalls();
    assert.equal(removed.length, 1, JSON.stringify(removed));
    assert.ok(removed[0].includes("jgates-cache"));
    assert.ok(!volumeNames().includes("jgates-cache"));
    assert.ok(volumeNames().includes("someone-elses-volume") && volumeNames().includes("jgates-data"), "everything else stays");
    assert.ok(objects().images.some((i) => i.name === "someone/else"), "the unlabelled image stays");

    // A scope lists only its own category.
    const toolchains = await call("POST", "/api/storage/cleanup", { mode: "clean", scope: { toolchains: true } });
    assert.equal(toolchains.status, 200, toolchains.text);
    assert.deepEqual(toolchains.json.items.filter((i) => i.action === "remove").map((i) => i.name), ["jgates-toolchains"]);

    // The uninstall needs the typed word.
    const plan = await call("POST", "/api/storage/cleanup", { mode: "uninstall" });
    assert.equal(plan.status, 200, plan.text);
    assert.equal(plan.json.home.path, home);
    const keys = plan.json.items.filter((i) => i.action === "remove").map((i) => i.key);
    assert.ok(keys.length > 0);
    const before = removalCalls().length;
    for (const confirm of [undefined, "", "yes", "clean"]) {
      const refused = await call("POST", "/api/storage/cleanup", { mode: "uninstall", dryRun: false, items: keys, ...(confirm === undefined ? {} : { confirm }) });
      assert.equal(refused.status, 400, `${confirm}: ${refused.text}`);
    }
    assert.equal(removalCalls().length, before, "a wrong word removes nothing");
    assert.ok(fs.existsSync(home));

    const done = await call("POST", "/api/storage/cleanup", { mode: "uninstall", dryRun: false, items: keys, confirm: "uninstall" });
    assert.equal(done.status, 200, done.text);
    const left = objects();
    assert.deepEqual(left.volumes.map((v) => v.name), ["someone-elses-volume"], "only the unlabelled volume is left");
    assert.ok(left.images.some((i) => i.name === "someone/else"), "the unlabelled image is left");
    const skippedLeft = done.json.items.some((i) => i.action === "skip");
    assert.equal(done.json.applied.homeRemoved, !skippedLeft, "the data folder goes only when nothing was skipped as in use");
    assert.equal(fs.existsSync(path.join(home, "workspaces.json")), skippedLeft);
  } finally {
    ui?.proc.kill();
  }
});
