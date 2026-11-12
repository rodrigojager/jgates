import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// The project cache of the local server (PLAN-performance.md P2-P5, core/cache/project.ts). The route handlers run in
// this process against a temporary project, with the container mode and a fake engine that records every call:
//   - two consecutive GET /api/config/profile walk the project tree once (the listings of a folder only discovery reads
//     are counted), build no plan and ask the engine nothing;
//   - a file edited by hand, a folder discovery reads that gains a component, and a write of the server each show at the
//     next request (the write answers with the updated view itself);
//   - GET /api/setup/profiles computes the three starter profiles with one discovery, and keeps them;
//   - PUT /api/config/templates/:id/enabled builds its view once.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (p) => pathToFileURL(path.resolve(here, "..", "dist", p)).href;
const MAIN = path.resolve(here, "..", "dist", "cli", "main.js");
const FAKE = path.join(here, "docker", "fake-docker.cjs");
const VERSION = JSON.parse(fs.readFileSync(path.resolve(here, "..", "..", "package.json"), "utf8")).version;
const PINNED = `registry.example.test/jgates/jgates-tools@sha256:${"cd".repeat(32)}`;

const dirs = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
const made = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

// Container mode with the fake engine: an engine call would be recorded in calls.jsonl.
const engine = made("jg-cache-engine-");
const runtime = path.join(engine, "docker.cjs");
const calls = path.join(engine, "calls.jsonl");
fs.writeFileSync(
  runtime,
  `process.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};
process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};
process.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": VERSION }))};
require(${JSON.stringify(FAKE)});
`,
);
fs.writeFileSync(path.join(engine, "objects.json"), JSON.stringify({ containers: [], volumes: [], networks: [], images: [] }));
const home = made("jg-cache-home-");
Object.assign(process.env, {
  JGATES_HOME: home,
  JGATES_IMAGE_JSON: "",
  JGATES_CONTAINER_RUNTIME: runtime,
  JGATES_TOOLS_IMAGE: PINNED,
  JGATES_LOCALE: "en",
  JGATES_POLICY_DIR: "",
  JGATES_POLICY_SHA256: "",
  NO_COLOR: "1",
});
const engineCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0);

// Every listing of a folder by the discovery's walk (core/discovery/walk.js), by path: one walk of the project tree lists
// each of its folders once. (Adapters that look for their own files list folders too; they are not discovery.)
const listings = new Map();
const realReaddir = fs.readdirSync;
fs.readdirSync = function (p, ...rest) {
  if (/[\\/]core[\\/]discovery[\\/]walk\.js/.test(new Error().stack ?? "")) {
    const key = path.resolve(String(p)).toLowerCase();
    listings.set(key, (listings.get(key) ?? 0) + 1);
  }
  return realReaddir.call(this, p, ...rest);
};
const listed = (dir) => listings.get(path.resolve(dir).toLowerCase()) ?? 0;

// Every process this test process starts (an engine or Git call of a handler would be one).
const cp = createRequire(import.meta.url)("node:child_process");
let spawns = 0;
for (const name of ["spawn", "spawnSync", "execFileSync", "execSync", "execFile"]) {
  const original = cp[name];
  cp[name] = function (...args) {
    spawns++;
    return original.apply(this, args);
  };
}
(await import("node:module")).syncBuiltinESMExports();

/** A Python project with its configuration (standard profile) and a sub-package only discovery walks into. */
function project() {
  const dir = made("jg-cache-proj-");
  fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  fs.mkdirSync(path.join(dir, "pkg", "deep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "pkg", "__init__.py"), "");
  fs.writeFileSync(path.join(dir, "pkg", "deep", "mod.py"), "def add(a, b):\n    return a + b\n");
  const init = spawnSync(process.execPath, [MAIN, "init", "--cwd", dir, "--profile", "standard", "--no-interactive", "--json"], { env: process.env, encoding: "utf8", timeout: 120_000 });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  return dir;
}

async function routesOf(...files) {
  const all = [];
  for (const f of files) all.push(...(await import(dist(`server/routes/${f}.js`))).routes);
  return (method, p) => {
    const route = all.find((r) => r.method === method && r.path === p);
    assert.ok(route, `${method} ${p}`);
    return route;
  };
}

function context(dir) {
  return { projectDir: dir, policyMode: false, workspace: { id: "ws_cachetest0000000", path: dir, name: "demo" }, home, version: VERSION, plans: new Map(), log: () => undefined };
}

const call = async (route, server, { params = {}, query = {}, body } = {}) => {
  const started = performance.now();
  const result = await route.handler({ params, query, body, session: null, server, raw: null });
  return { ...result, ms: performance.now() - started };
};

const { projectCacheStats } = await import(dist("core/cache/project.js"));
const computed = (kind) => projectCacheStats().computed[kind] ?? 0;

test("the profile view: one walk for two requests, no plan and no engine; a file edited by hand, a new component and a server write show at once", async () => {
  const dir = project();
  const server = context(dir);
  const route = await routesOf("config", "profiles");
  const get = route("GET", "/api/config/profile");
  const pkg = path.join(dir, "pkg", "deep");

  const before = { walks: listed(pkg), spawns, engine: engineCalls(), inventory: computed("inventory"), views: computed("config-view") };
  const first = await call(get, server);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(listed(pkg) - before.walks, 1, "the first request walks the tree once");
  const second = await call(get, server);
  assert.equal(listed(pkg) - before.walks, 1, "the second request does not walk the tree again");
  assert.deepEqual(second.json, first.json);
  assert.equal(computed("inventory") - before.inventory, 1, "one discovery");
  assert.equal(computed("config-view") - before.views, 1, "the second view comes from the cache");
  assert.equal(spawns, before.spawns, "no process (engine, Git) was started for the view");
  assert.equal(engineCalls(), before.engine, "the engine was not asked");
  assert.ok(!("plan" in first.json) && !("mascots" in first.json), "the view builds no plan: the plan part has its own endpoint");
  assert.equal(first.json.profile.ref, "standard");
  assert.ok(first.json.categories.length > 0);
  assert.ok(second.ms < 300, `a cached view answers at once (${Math.round(second.ms)} ms)`);

  // A configuration file edited by hand: the next view has it.
  const profiles = path.join(dir, ".jgates", "profiles.yml");
  // profiles: is the last mapping of the file init wrote: the new profile goes at its end.
  fs.appendFileSync(profiles, "  mine:\n    label: Mine\n    extends: builtin:standard\n    checks:\n      capability:format-check:\n        enabled: false\n");
  const mine = await call(get, server, { query: { profile: "mine" } });
  assert.equal(mine.status, 200, JSON.stringify(mine.json));
  assert.equal(mine.json.profile.editable, true);
  const format = mine.json.categories.flatMap((c) => c.capabilities).find((c) => c.id === "format-check");
  assert.equal(format.enabled, false, "the hand-written switch is in the view");

  // A new component in a folder discovery reads: the inventory is computed again.
  const scopes = (view) => view.policy.coverage.scopes.map((s) => s.scope);
  const inventories = computed("inventory");
  fs.mkdirSync(path.join(dir, "web"));
  fs.writeFileSync(path.join(dir, "web", "package.json"), JSON.stringify({ name: "web", version: "1.0.0", scripts: { test: "node --test" } }));
  const grown = await call(get, server, { query: { profile: "mine" } });
  assert.equal(computed("inventory") - inventories, 1, "the new folder made discovery run again");
  assert.ok(scopes(grown.json).length > scopes(mine.json).length, `the new component has its coverage scope: ${JSON.stringify(scopes(grown.json))}`);

  // A write of the server answers with the updated view; the next GET is that same view, from the cache.
  const put = route("PUT", "/api/config/selection");
  const views = computed("config-view");
  const written = await call(put, server, { body: { profile: "mine", changes: [{ selector: "capability:format-check", enabled: true }] } });
  assert.equal(written.status, 200, JSON.stringify(written.json));
  assert.equal(written.json.view.profile.ref, "mine");
  assert.equal(written.json.view.categories.flatMap((c) => c.capabilities).find((c) => c.id === "format-check").enabled, true, "the answer carries the updated view");
  const after = await call(get, server, { query: { profile: "mine" } });
  assert.deepEqual(after.json, written.json.view, "GET answers what the write answered");
  assert.equal(computed("config-view") - views, 1, "the write built the view once; the GET after it came from the cache");

  // Profile writes answer with the updated list and view.
  const created = await call(route("POST", "/api/profiles"), server, { body: { id: "copy", from: "mine" } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.view.profile.ref, "copy");
  assert.ok(created.json.profiles.profiles.some((p) => p.id === "copy"), "the answer carries the updated list");
  const list = await call(route("GET", "/api/profiles"), server);
  assert.deepEqual(list.json, created.json.profiles);
  assert.equal(spawns, before.spawns, "no process was started by the views and the writes");
  assert.equal(engineCalls(), before.engine);
});

test("GET /api/setup/profiles counts the three starter profiles with one discovery and keeps them; a template switch builds its view once", async () => {
  const dir = project();
  const server = context(dir);
  const route = await routesOf("setup", "templates");
  const pkg = path.join(dir, "pkg", "deep");

  const walks = listed(pkg);
  const first = await call(route("GET", "/api/setup/profiles"), server);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.deepEqual(
    first.json.profiles.map((p) => p.id),
    ["minimal", "standard", "strict"],
  );
  for (const p of first.json.profiles) assert.equal(p.error, null, JSON.stringify(p));
  assert.ok(first.json.profiles.every((p) => p.total > 0), JSON.stringify(first.json.profiles));
  assert.equal(listed(pkg) - walks, 1, "three plans, one discovery");
  const second = await call(route("GET", "/api/setup/profiles"), server);
  assert.deepEqual(second.json.profiles, first.json.profiles);
  assert.equal(listed(pkg) - walks, 1, "the counts are kept while the project does not change");
  assert.ok(second.ms < first.ms, `kept counts answer faster (${Math.round(first.ms)} ms, then ${Math.round(second.ms)} ms)`);

  // The template switch: the view the person saw comes from the cache, the one after the write is built once.
  const list = await call(route("GET", "/api/config/templates"), server);
  assert.equal(list.status, 200);
  const optional = list.json.templates.find((t) => !t.required && t.origin === "builtin");
  assert.ok(optional, JSON.stringify(list.json.templates.map((t) => [t.id, t.required])));
  const views = computed("templates-view");
  const put = await call(route("PUT", "/api/config/templates/:id/enabled"), server, { params: { id: optional.id }, body: { enabled: !optional.enabled, expectedRevision: list.json.revision } });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.equal(computed("templates-view") - views, 1, "the switch built its view once");
  assert.equal(put.json.templates.find((t) => t.id === optional.id).enabled, !optional.enabled);
  const again = await call(route("GET", "/api/config/templates"), server);
  assert.deepEqual(again.json, put.json);
  assert.equal(computed("templates-view") - views, 1, "the GET after the switch came from the cache");
});
