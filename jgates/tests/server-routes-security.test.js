import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// The security rules of the local server over the whole product (no frontend reads or writes outside the workspace):
// the routes are enumerated from the
// router itself (the same folder scan the server does), so a route added later is swept without editing this file.
// Every route must refuse a request without a session, with a foreign Host, with an unauthorized Origin and a
// cross-site fetch; a route that writes must also refuse a missing Origin or CSRF token; a route that only exists
// for a mutation must refuse GET; and every route that takes a document, run, profile or file id must refuse
// traversal, a symlink out of the root and a hostile id without reading or writing outside. A route with a path
// parameter this file does not know fails the "covered" test below: add the parameter to PARAM_SAMPLES.
// Also here: the supply-chain pins (lockfile, exact image digests, exact Python pins).

const here = path.dirname(fileURLToPath(import.meta.url));
const jgatesDir = path.resolve(here, "..");
const repoDir = path.resolve(jgatesDir, "..");
const dist = path.join(jgatesDir, "dist");
const MAIN = path.join(dist, "cli", "main.js");
const { Router } = await import(pathToFileURL(path.join(dist, "server", "router.js")).href);

const MARKER = "OUTSIDE-ONLY-CONTENT";
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function writeTree(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

// ---- route enumeration -------------------------------------------------------------------------------------------

const RUN_ID = "run_20260101T000000Z_00000000";
const JOB_ID = "job_0123456789abcdef";
/** A well-formed value for each path parameter name; an unknown name fails the coverage test. */
const PARAM_SAMPLES = {
  instance: "ruff-api",
  binding: "config",
  hash: `sha256:${"0".repeat(64)}`,
  runId: RUN_ID,
  name: "stdout.log",
  // `id` depends on the group: a job or run id, a profile, a template, an architecture rule.
  id: (route) => (route.path.startsWith("/api/runs/") ? JOB_ID : "standard"),
};
/** Parameters that name a document, a run, a profile, a template or a rule: the ones traversal is tried on. */
const ID_PARAMS = new Set(Object.keys(PARAM_SAMPLES));

const router = await Router.load();
const routes = router.routes;
const paramsOf = (route) => [...route.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
const isMutation = (route) => route.method !== "GET";
const authOf = (route) => route.auth ?? "session";

function samplePath(route, overrides = {}) {
  return route.path.replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
    if (name in overrides) return encodeURIComponent(overrides[name]);
    const sample = PARAM_SAMPLES[name];
    return encodeURIComponent(typeof sample === "function" ? sample(route) : sample);
  });
}

test("every registered route is classified and its path parameters are known", () => {
  assert.ok(routes.length >= 80, `only ${routes.length} routes were found`);
  const unknown = [];
  for (const route of routes) {
    const auth = authOf(route);
    if (!["session", "bootstrap", "control"].includes(auth)) unknown.push(`${route.method} ${route.path}: auth ${auth}`);
    if (auth === "session" && !route.path.startsWith("/api/")) unknown.push(`${route.method} ${route.path}: session route outside /api`);
    if (auth !== "session" && !route.path.startsWith("/session/") && !route.path.startsWith("/control/")) unknown.push(`${route.method} ${route.path}: ${auth} route outside /session and /control`);
    for (const name of paramsOf(route)) if (!(name in PARAM_SAMPLES)) unknown.push(`${route.method} ${route.path}: unknown path parameter :${name}`);
    if (typeof route.handler !== "function") unknown.push(`${route.method} ${route.path}: no handler`);
    if (isMutation(route) && route.auth === "session" && !route.body && !["DELETE", "POST"].includes(route.method)) unknown.push(`${route.method} ${route.path}: unexpected shape`);
  }
  assert.deepEqual(unknown, [], "these routes are not covered by the route sweep");
  // The folder scan and the files agree: every route module of src has a compiled module that registered something.
  const files = fs.readdirSync(path.join(jgatesDir, "src", "server", "routes")).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 20);
  const keys = routes.map((r) => `${r.method} ${r.path}`);
  assert.equal(new Set(keys).size, keys.length, "duplicate route");
});

// ---- the server -------------------------------------------------------------------------------------------------

const TOOLS = `schemaVersion: 1
tools:
  ruff-api:
    adapter: ruff
    config: pyproject.toml
  escape:
    adapter: x
    config: link.toml
  rules:
    adapter: semgrep
    configFiles:
      rules:
        path: .jgates/rules
        kind: directory
        role: rules
        include: ["*.yml"]
`;

function project() {
  const dir = tmp("jg-sec-");
  const outside = tmp("jg-sec-out-");
  writeTree(dir, {
    "jgates.yml": "schemaVersion: 1\nextends:\n  - .jgates/tools.yml\n",
    ".jgates/tools.yml": TOOLS,
    "pyproject.toml": '[tool.ruff]\nline-length = 88\n',
    ".jgates/rules/a.yml": "rules: []\n",
  });
  writeTree(outside, { "secret.toml": `token = "${MARKER}"\n`, "secret.yml": `token: ${MARKER}\n`, "secret.log": `${MARKER}\n`, "dir/secret.log": `${MARKER}\n` });
  fs.symlinkSync(path.join(outside, "secret.toml"), path.join(dir, "link.toml"));
  fs.symlinkSync(path.join(outside, "secret.yml"), path.join(dir, ".jgates", "rules", "evil.yml"));
  fs.symlinkSync(path.join(outside, "secret.yml"), path.join(dir, ".jgates", "linked.yml"));
  return { dir, outside };
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, entry.name);
      if (entry.isSymbolicLink()) out[p] = `link:${fs.readlinkSync(p)}`;
      else if (entry.isDirectory()) walk(p);
      else out[p] = sha(fs.readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

function startUi(dir, home) {
  const proc = spawn(process.execPath, [MAIN, "ui", "--cwd", dir, "--no-open", "--port", "0", "--json"], {
    env: { ...process.env, JGATES_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
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

async function stopUi(ui) {
  if (!ui || ui.proc.exitCode !== null || ui.proc.signalCode !== null) return;
  const exited = once(ui.proc, "exit");
  ui.proc.kill("SIGTERM");
  await exited;
}

function request(port, method, p, { headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: p,
        agent: false,
        headers: { Host: host ?? `127.0.0.1:${port}`, ...(data ? { "Content-Type": "application/json", "Content-Length": String(data.length) } : {}), ...headers },
      },
      (res) => {
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
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login(ui) {
  const html = fs.readFileSync(ui.info.launcher, "utf8");
  const href = /href="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
  assert.ok(href, "launcher has no bootstrap link");
  const url = new URL(href);
  const r = await request(ui.info.port, "GET", url.pathname + url.search);
  assert.equal(r.status, 200, r.text);
  const cookie = String(r.headers["set-cookie"]?.[0] ?? "").split(";")[0];
  const s = await request(ui.info.port, "GET", "/api/session", { headers: { Cookie: cookie } });
  assert.equal(s.status, 200, s.text);
  return { cookie, csrf: s.json.csrfToken };
}

async function withServer(fn) {
  const p = project();
  const home = tmp("jg-sec-home-");
  let ui = null;
  try {
    ui = await startUi(p.dir, home);
    const auth = await login(ui);
    const origin = `http://127.0.0.1:${ui.info.port}`;
    await fn({ ui, home, auth, origin, port: ui.info.port, ...p });
  } finally {
    await stopUi(ui);
    for (const d of [p.dir, p.outside, home]) fs.rmSync(d, { recursive: true, force: true });
  }
}

/** Body sent to a route that declares one: valid JSON the schema may still refuse, which is also a refusal. */
const bodyFor = (route) => (route.body ? {} : undefined);

// ---- session, Host, Origin, CSRF, GET --------------------------------------------------------------------------

test("every session route refuses no session, a bogus cookie, a foreign Host, a foreign Origin and a cross-site fetch", async () => {
  await withServer(async ({ port, auth, origin, dir, outside }) => {
    const sessionRoutes = routes.filter((r) => authOf(r) === "session");
    const dirBefore = snapshot(dir);
    const outsideBefore = snapshot(outside);
    const failures = [];
    const expect = (label, route, r, statuses, code) => {
      const ok = statuses.includes(r.status) && (code === undefined || r.json?.code === code);
      if (!ok) failures.push(`${label} ${route.method} ${route.path}: got ${r.status} ${String(r.json?.code ?? r.text).slice(0, 80)}`);
      if (r.text.includes(MARKER) || r.text.includes("line-length")) failures.push(`${label} ${route.method} ${route.path}: leaked content`);
    };
    for (const route of sessionRoutes) {
      const p = samplePath(route);
      const body = bodyFor(route);
      const mutationAuth = { Cookie: auth.cookie, Origin: origin, "X-JGates-CSRF": auth.csrf };
      // No session at all (a mutation carries a correct Origin, so only the missing session can refuse it).
      expect("no-session", route, await request(port, route.method, p, { headers: isMutation(route) ? { Origin: origin } : {}, body }), [401], "SESSION_REQUIRED");
      expect("bogus-cookie", route, await request(port, route.method, p, { headers: { Cookie: `jgates_session_${port}=${"A".repeat(43)}`, ...(isMutation(route) ? { Origin: origin } : {}) }, body }), [401], "SESSION_REQUIRED");
      // A foreign Host is refused even with a valid session (DNS rebinding).
      for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1:${port + 1}`]) {
        expect(`host ${host}`, route, await request(port, route.method, p, { host, headers: isMutation(route) ? mutationAuth : { Cookie: auth.cookie }, body }), [421], "HOST_NOT_ALLOWED");
      }
      // A foreign Origin is refused on a read as well as on a write.
      for (const bad of ["http://evil.example", "null", `http://127.0.0.1:${port + 1}`, `https://127.0.0.1:${port}`]) {
        expect(`origin ${bad}`, route, await request(port, route.method, p, { headers: { ...mutationAuth, Origin: bad }, body }), [403], "ORIGIN_NOT_ALLOWED");
      }
      expect("cross-site", route, await request(port, route.method, p, { headers: { ...mutationAuth, "Sec-Fetch-Site": "cross-site" }, body }), [403]);
      expect("same-site", route, await request(port, route.method, p, { headers: { ...mutationAuth, "Sec-Fetch-Site": "same-site" }, body }), [403]);
      if (isMutation(route)) {
        expect("no-origin", route, await request(port, route.method, p, { headers: { Cookie: auth.cookie, "X-JGates-CSRF": auth.csrf }, body }), [403], "ORIGIN_REQUIRED");
        expect("no-csrf", route, await request(port, route.method, p, { headers: { Cookie: auth.cookie, Origin: origin }, body }), [403], "CSRF_INVALID");
        expect("wrong-csrf", route, await request(port, route.method, p, { headers: { Cookie: auth.cookie, Origin: origin, "X-JGates-CSRF": "B".repeat(43) }, body }), [403], "CSRF_INVALID");
        expect("form-body", route, await request(port, route.method, p, { headers: { ...mutationAuth, "Content-Type": "application/x-www-form-urlencoded" }, body: "a=1" }), [403, 415, 400, 413]);
      }
      // A preflight never gets CORS headers.
      const pre = await request(port, "OPTIONS", p, { headers: { Origin: "http://evil.example", "Access-Control-Request-Method": route.method } });
      if (pre.headers["access-control-allow-origin"] || pre.headers["access-control-allow-methods"]) failures.push(`CORS headers on ${route.method} ${route.path}`);
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(snapshot(dir), dirBefore, "a refused request changed the project");
    assert.deepEqual(snapshot(outside), outsideBefore, "a refused request changed the outside folder");
  });
});

test("a route that exists only for a mutation refuses GET, and no GET route changes the project", async () => {
  await withServer(async ({ port, auth, dir, outside }) => {
    const getPaths = new Set(routes.filter((r) => r.method === "GET").map((r) => r.path));
    const failures = [];
    const mutationOnly = routes.filter((r) => authOf(r) === "session" && isMutation(r) && !getPaths.has(r.path));
    assert.ok(mutationOnly.length >= 20);
    for (const route of mutationOnly) {
      const r = await request(port, "GET", samplePath(route), { headers: { Cookie: auth.cookie } });
      if (r.status !== 405 || r.json?.code !== "METHOD_NOT_ALLOWED" || !r.headers.allow || r.headers.allow.includes("GET")) failures.push(`GET ${route.path}: ${r.status} ${r.text.slice(0, 80)}`);
    }
    assert.deepEqual(failures, [], "a mutation route answered a GET");

    // Every GET route, with a session: the project and the outside folder stay byte for byte the same.
    const dirBefore = snapshot(dir);
    const outsideBefore = snapshot(outside);
    for (const route of routes.filter((r) => authOf(r) === "session" && r.method === "GET")) {
      if (route.path === "/api/runs/:id/events" || route.path === "/api/runs/:id/progress") continue; // long polls on a job that does not exist: 404 below
      const r = await request(port, "GET", samplePath(route), { headers: { Cookie: auth.cookie } });
      assert.ok(r.status < 500, `GET ${route.path}: ${r.status} ${r.text.slice(0, 200)}`);
      assert.ok(!r.text.includes(MARKER), `GET ${route.path} leaked outside content`);
    }
    for (const p of [`/api/runs/${JOB_ID}/events`, `/api/runs/${JOB_ID}/progress`]) {
      const r = await request(port, "GET", p, { headers: { Cookie: auth.cookie } });
      assert.ok(r.status >= 400 && r.status < 500, `${p}: ${r.status}`);
    }
    assert.deepEqual(snapshot(dir), dirBefore, "a GET route changed the project");
    assert.deepEqual(snapshot(outside), outsideBefore);
  });
});

test("the editing groups (drafts, forms, pii, rules) refuse without a session, route by route, on reads and writes", async () => {
  await withServer(async ({ port, origin, dir }) => {
    const groups = ["/api/drafts", "/api/forms", "/api/pii", "/api/rules"];
    const editing = routes.filter((r) => groups.some((g) => r.path === g || r.path.startsWith(`${g}/`)));
    for (const g of groups) {
      assert.ok(editing.some((r) => r.path === g || r.path.startsWith(`${g}/`)), `no route under ${g}`);
      assert.ok(editing.some((r) => (r.path === g || r.path.startsWith(`${g}/`)) && r.method === "GET"), `no GET under ${g}`);
    }
    assert.ok(editing.some((r) => r.method === "PUT"), "no PUT among the editing routes");
    assert.ok(editing.some((r) => r.method === "POST"), "no POST among the editing routes");
    assert.ok(editing.some((r) => r.method === "DELETE"), "no DELETE among the editing routes");
    const before = snapshot(dir);
    for (const route of editing) {
      const r = await request(port, route.method, samplePath(route), { headers: isMutation(route) ? { Origin: origin } : {}, body: route.body ? { text: "x = 1\n", expectedRevision: "0".repeat(64) } : undefined });
      assert.equal(r.status, 401, `${route.method} ${route.path}: ${r.text}`);
      assert.equal(r.json.code, "SESSION_REQUIRED");
    }
    assert.deepEqual(snapshot(dir), before, "a refused request wrote something");
  });
});

test("the bootstrap and control routes accept only their own credential", async () => {
  await withServer(async ({ port, ui, home, origin }) => {
    for (const route of routes.filter((r) => authOf(r) === "bootstrap")) {
      for (const token of ["", "?token=x", `?token=${"A".repeat(43)}`, "?token=../../etc/passwd"]) {
        const r = await request(port, route.method, route.path + token);
        assert.ok(r.status === 401 || r.status === 400, `${route.path}${token}: ${r.status}`);
        assert.equal(r.headers["set-cookie"], undefined);
      }
      const rebound = await request(port, route.method, `${route.path}?token=x`, { host: "evil.example" });
      assert.equal(rebound.status, 421);
    }
    const lock = JSON.parse(fs.readFileSync(path.join(home, "workspaces", ui.info.workspace.id, "locks", "ui-server.json"), "utf8"));
    for (const route of routes.filter((r) => authOf(r) === "control")) {
      const none = await request(port, route.method, route.path);
      assert.ok(none.status === 401 || none.status === 403, `no token: ${none.status}`);
      const wrong = await request(port, route.method, route.path, { headers: { "X-JGates-Control": "A".repeat(43) } });
      assert.ok(wrong.status === 401 || wrong.status === 403, `wrong token: ${wrong.status}`);
      // A browser request (it carries an Origin) never passes, even with the right token.
      const browser = await request(port, route.method, route.path, { headers: { "X-JGates-Control": lock.controlToken, Origin: origin } });
      assert.equal(browser.status, 403, browser.text);
      const get = await request(port, "GET", route.path, { headers: { "X-JGates-Control": lock.controlToken } });
      assert.equal(get.status, 405);
    }
    const launchers = fs.readdirSync(path.join(home, "workspaces", ui.info.workspace.id, "server")).filter((f) => f.startsWith("launch-"));
    assert.equal(launchers.length, 0, "a refused control request issued a launcher");
  });
});

// ---- ids: traversal, symlink out of the root, hostile values ----------------------------------------------------

const HOSTILE = [
  "..",
  ".",
  "../../../etc/passwd",
  "..\\..\\..\\windows\\win.ini",
  "/etc/passwd",
  "%2e%2e/%2e%2e/etc/passwd",
  "a\u0000b",
  "con",
  "link.toml",
  "x".repeat(2000),
];

test("traversal and hostile ids fail on every route that takes an id, and nothing outside is read or written", async () => {
  await withServer(async ({ port, auth, origin, dir, outside, home }) => {
    const idRoutes = routes.filter((r) => authOf(r) === "session" && paramsOf(r).some((n) => ID_PARAMS.has(n)));
    assert.ok(idRoutes.length >= 30, `only ${idRoutes.length} routes take an id`);
    const dirBefore = snapshot(dir);
    const outsideBefore = snapshot(outside);
    const homeBefore = snapshot(home);
    const failures = [];
    for (const route of idRoutes) {
      for (const name of paramsOf(route)) {
        for (const value of HOSTILE) {
          const p = samplePath(route, { [name]: value });
          const headers = isMutation(route) ? { Cookie: auth.cookie, Origin: origin, "X-JGates-CSRF": auth.csrf } : { Cookie: auth.cookie };
          const r = await request(port, route.method, p, { headers, body: bodyFor(route) });
          const refused = (r.status >= 400 && r.status < 500) || (r.status === 200 && NEVER_READS_BINDING_FILE.has(`${route.method} ${route.path}`) && /^[a-z0-9][a-z0-9._-]*$/.test(value));
          if (!refused) failures.push(`${route.method} ${route.path} :${name}=${JSON.stringify(value).slice(0, 30)} -> ${r.status}`);
          if (r.text.includes(MARKER) || r.text.includes("root:x:") || r.text.includes("[fonts]")) failures.push(`${route.method} ${route.path} :${name} leaked content`);
        }
      }
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(snapshot(dir), dirBefore, "a hostile id changed the project");
    assert.deepEqual(snapshot(outside), outsideBefore, "a hostile id changed the outside folder");
    const homeAfter = snapshot(home);
    for (const file of Object.keys(homeAfter)) if (!(file in homeBefore) && !file.includes(`${path.sep}logs${path.sep}`) && !file.endsWith(".log")) assert.fail(`a hostile id created ${file}`);
  });
});

// Routes that take a binding id but never open the bound file: the draft read and discard look only at the draft kept in the data
// folder (an unknown but well-formed id has none: 200 with nothing), and the template read returns the static starter text of the format. They may answer 200; they must not leak.
const NEVER_READS_BINDING_FILE = new Set(["GET /api/drafts/:instance/:binding", "DELETE /api/drafts/:instance/:binding", "GET /api/tools/:instance/bindings/:binding/template"]);
// Same for the YAML editor: "check" validates only the text it is sent and "discard draft" removes a draft of the data folder.
const NEVER_READS_PROJECT_FILE = new Set(["POST /api/config/yaml/check", "DELETE /api/config/yaml/draft"]);

test("a binding that is a symlink out of the root is refused on every route with an instance and a binding", async () => {
  await withServer(async ({ port, auth, origin, dir, outside }) => {
    const both = routes.filter((r) => authOf(r) === "session" && paramsOf(r).includes("instance") && paramsOf(r).includes("binding"));
    assert.ok(both.length >= 8, `only ${both.length} routes take an instance and a binding`);
    const dirBefore = snapshot(dir);
    const outsideBefore = snapshot(outside);
    const failures = [];
    for (const route of both) {
      const headers = isMutation(route) ? { Cookie: auth.cookie, Origin: origin, "X-JGates-CSRF": auth.csrf } : { Cookie: auth.cookie };
      const body = route.body ? { expectedRevision: sha(Buffer.from(`token = "${MARKER}"\n`)), text: "pwned = 1\n" } : undefined;
      const r = await request(port, route.method, samplePath(route, { instance: "escape", binding: "config" }), { headers, body });
      if (r.text.includes(MARKER)) failures.push(`${route.method} ${route.path}: leaked the outside file`);
      if (!(r.status >= 400 && r.status < 500) && !NEVER_READS_BINDING_FILE.has(`${route.method} ${route.path}`)) failures.push(`${route.method} ${route.path}: ${r.status} ${r.text.slice(0, 120)}`);
    }
    // A directory binding holding a symlink to an outside file never lists or reads it.
    for (const route of routes.filter((r) => authOf(r) === "session" && r.method === "GET" && (r.path === "/api/rules/:instance" || r.path === "/api/tools/:instance" || r.path === "/api/tools/:instance/effective" || r.path === "/api/forms/:instance"))) {
      const r = await request(port, "GET", samplePath(route, { instance: "rules" }), { headers: { Cookie: auth.cookie } });
      if (r.text.includes(MARKER)) failures.push(`${route.path} (rules): leaked the outside file`);
    }
    assert.deepEqual(failures, []);
    assert.equal(fs.readFileSync(path.join(outside, "secret.toml"), "utf8"), `token = "${MARKER}"\n`);
    assert.deepEqual(snapshot(outside), outsideBefore, "the outside folder changed");
    assert.deepEqual(snapshot(dir), dirBefore, "the project changed");
  });
});

test("the file routes of the YAML editor refuse traversal and a symlink out of the project", async () => {
  await withServer(async ({ port, auth, origin, dir, outside }) => {
    const fileRoutes = routes.filter((r) => authOf(r) === "session" && (r.query?.properties?.file || r.body?.properties?.file));
    assert.ok(fileRoutes.length >= 4, `only ${fileRoutes.length} routes take a file`);
    const dirBefore = snapshot(dir);
    const outsideBefore = snapshot(outside);
    const files = ["../../../etc/passwd", ".jgates/../../x.yml", "/etc/passwd", "..\\x.yml", ".jgates/templates/../../../x.yml", ".jgates/linked.yml", "pyproject.toml", ".git/config"];
    const failures = [];
    for (const route of fileRoutes) {
      for (const file of files) {
        const headers = isMutation(route) ? { Cookie: auth.cookie, Origin: origin, "X-JGates-CSRF": auth.csrf } : { Cookie: auth.cookie };
        const useQuery = Boolean(route.query?.properties?.file);
        const r = await request(port, route.method, samplePath(route) + (useQuery ? `?file=${encodeURIComponent(file)}` : ""), {
          headers,
          body: !useQuery && route.body ? { file, text: "pwned: true\n" } : undefined,
        });
        if (r.text.includes(MARKER)) failures.push(`${route.method} ${route.path} ${file}: leaked the outside file`);
        // Only the linked file may be accepted by the pattern; it must still be refused as it points out of the project.
        if (r.status >= 200 && r.status < 300 && file !== "pyproject.toml" && !(file === ".jgates/linked.yml" && NEVER_READS_PROJECT_FILE.has(`${route.method} ${route.path}`))) failures.push(`${route.method} ${route.path} ${file}: ${r.status}`);
      }
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(snapshot(outside), outsideBefore, "the outside folder changed");
    assert.deepEqual(snapshot(dir), dirBefore, "the project changed");
  });
});

test("a run folder that is a symlink, or a log that is a symlink, is never followed", async () => {
  await withServer(async ({ port, auth, home, ui, outside }) => {
    const runs = path.join(home, "workspaces", ui.info.workspace.id, "runs");
    fs.mkdirSync(runs, { recursive: true });
    const linkRun = "run_20260101T000000Z_00000001";
    const realRun = "run_20260101T000000Z_00000002";
    fs.mkdirSync(path.join(outside, "run-dir", "logs"), { recursive: true });
    fs.writeFileSync(path.join(outside, "run-dir", "result.json"), JSON.stringify({ marker: MARKER }));
    fs.writeFileSync(path.join(outside, "run-dir", "logs", "x.log"), MARKER);
    fs.symlinkSync(path.join(outside, "run-dir"), path.join(runs, linkRun));
    fs.mkdirSync(path.join(runs, realRun, "logs"), { recursive: true });
    fs.writeFileSync(path.join(runs, realRun, "result.json"), JSON.stringify({ schemaVersion: 1, runId: realRun }));
    fs.symlinkSync(path.join(outside, "secret.log"), path.join(runs, realRun, "logs", "evil.log"));
    const before = snapshot(outside);
    const runRoutes = routes.filter((r) => authOf(r) === "session" && r.method === "GET" && paramsOf(r).includes("runId"));
    assert.ok(runRoutes.length >= 4);
    for (const route of runRoutes) {
      for (const [runId, name] of [[linkRun, "x.log"], [realRun, "evil.log"]]) {
        const r = await request(port, "GET", samplePath(route, { runId, name }), { headers: { Cookie: auth.cookie } });
        assert.ok(!r.text.includes(MARKER), `${route.path} (${runId}/${name}) followed a symlink`);
      }
    }
    for (const [p] of [[`/api/history`], [`/api/history/compare?base=${linkRun}&head=${realRun}`]]) {
      const r = await request(port, "GET", p, { headers: { Cookie: auth.cookie } });
      assert.ok(!r.text.includes(MARKER), `${p} followed a symlink`);
    }
    assert.deepEqual(snapshot(outside), before);
  });
});

// ---- supply chain -----------------------------------------------------------------------------------------------

const OPEN_RANGE = /^(\*|latest|next|x|)$|^[<>]=?\s*\d|\|\||\s-\s|^(git|git\+\w+|https?|file|link|github):|\//;

test("supply chain: no jgates dependency is resolved by an open range, and the lockfile pins each one", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(jgatesDir, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(repoDir, "package-lock.json"), "utf8"));
  assert.ok(lock.lockfileVersion >= 2, "the lockfile is missing or too old");
  const entry = lock.packages?.jgates;
  assert.ok(entry, "package-lock.json has no entry for the jgates workspace");
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(Object.keys(declared).length >= 20);
  const problems = [];
  for (const [name, range] of Object.entries(declared)) {
    if (OPEN_RANGE.test(range)) problems.push(`${name}: open or non-registry range "${range}"`);
    if (!/^[\^~]?\d+\.\d+\.\d+$/.test(range)) problems.push(`${name}: "${range}" is not a plain version or a caret/tilde on a full version`);
    if (range.startsWith("^0.0.") || range.startsWith("~0.0.")) problems.push(`${name}: "${range}" is too loose for a 0.0.x`);
    const locked = { ...entry.dependencies, ...entry.devDependencies }[name];
    if (locked !== range) problems.push(`${name}: the lockfile asks for "${locked}" but package.json for "${range}"`);
    const resolved = lock.packages[`jgates/node_modules/${name}`] ?? lock.packages[`node_modules/${name}`];
    if (!resolved) {
      problems.push(`${name}: not resolved in the lockfile`);
      continue;
    }
    if (!/^\d+\.\d+\.\d+$/.test(resolved.version ?? "")) problems.push(`${name}: locked version "${resolved.version}" is not exact`);
    if (!String(resolved.resolved ?? "").startsWith("https://registry.npmjs.org/")) problems.push(`${name}: resolved from ${resolved.resolved}`);
    if (!/^sha(256|384|512)-/.test(resolved.integrity ?? "")) problems.push(`${name}: no integrity hash`);
    if (!resolved.license) problems.push(`${name}: the lockfile has no license`);
  }
  assert.deepEqual(problems, []);
  // The packages the lockfile resolves for the workspace never come from a URL, a git repository or a local path.
  for (const [key, value] of Object.entries(lock.packages)) {
    if (!key.includes("node_modules/") || value.link) continue;
    if (value.resolved && !/^https:\/\/registry\.npmjs\.org\//.test(value.resolved)) assert.fail(`${key} resolves from ${value.resolved}`);
    if (!value.integrity && !value.inBundle) assert.fail(`${key} has no integrity hash`);
  }
});

test("supply chain: Python tools are pinned with == and every image is pinned by digest or by checked version", () => {
  const reqs = fs.readFileSync(path.join(jgatesDir, "dev-tools", "requirements.txt"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.ok(reqs.length >= 5);
  for (const line of reqs) assert.match(line, /^[A-Za-z0-9_.-]+==\d+(\.\d+)*$/, `Python tool not pinned exactly: ${line}`);

  const dockerfiles = [path.join(jgatesDir, "docker", "ruff", "Dockerfile"), path.join(jgatesDir, "docker", "security", "Dockerfile"), path.join(repoDir, "quality-gate", "Dockerfile")];
  for (const file of dockerfiles) {
    const text = fs.readFileSync(file, "utf8");
    const args = Object.fromEntries([...text.matchAll(/^ARG\s+([A-Z0-9_]+)=(\S+)/gm)].map((m) => [m[1], m[2]]));
    const froms = [...text.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]).filter((f) => !/^[a-z0-9-]+$/i.test(f) || f.includes("@") || f.includes(":") || f.includes("$"));
    assert.ok(froms.length >= 1, `${file} has no FROM`);
    for (const from of froms) {
      const image = from.replace(/\$\{(\w+)\}/g, (_, n) => args[n] ?? `\${${n}}`);
      if (/^[a-z0-9-]+$/i.test(image) && froms.length > 1) continue; // a stage name
      assert.match(image, /@sha256:[0-9a-f]{64}$/, `${path.relative(repoDir, file)}: ${from} is not pinned by digest`);
    }
    for (const [name, value] of Object.entries(args)) {
      if (name.endsWith("_SHA256")) assert.match(value, /^[0-9a-f]{64}$/, `${name} in ${file}`);
      if (/_VERSION$/.test(name)) assert.match(value, /^\d+\.\d+(\.\d+)?$/, `${name} in ${file}`);
    }
    // No `latest`, no unpinned install in the image recipes.
    assert.ok(!/:latest\b/.test(text), `${file} uses :latest`);
    for (const m of text.matchAll(/pip install[^\n"]*"([^"]+)"/g)) assert.match(m[1], /==/, `${file}: pip install ${m[1]} is not pinned`);
  }
  // The images carry the dev label that makes them removable without touching other projects.
  for (const file of dockerfiles.slice(0, 2)) assert.match(fs.readFileSync(file, "utf8"), /org\.jgates\.dev="true"/);
});

// ---- the CI policy routes ---------------------------------------------------------------------------------------

test("the CI policy routes are in the sweep: session only, no path parameter, a closed body, and no write outside the policy mode", async () => {
  const find = (method, p) => routes.find((r) => r.method === method && r.path === p);
  const read = find("GET", "/api/policy");
  const test = find("POST", "/api/policy/test");
  assert.ok(read && test, "the CI policy routes are not registered");
  for (const route of [read, test]) {
    assert.equal(authOf(route), "session");
    assert.deepEqual(paramsOf(route), []);
  }
  assert.equal(test.body.additionalProperties, false);
  assert.deepEqual(test.body.required, ["project"]);
  await withServer(async ({ port, auth, origin, dir, outside }) => {
    const before = snapshot(dir);
    const outsideBefore = snapshot(outside);
    const headers = { Cookie: auth.cookie, Origin: origin, "X-JGates-CSRF": auth.csrf };
    // A project server is not a policy editor: the test route refuses any folder, the outside one included.
    for (const folder of [dir, outside, "/", "..", "relative", "a\u0000b"]) {
      const r = await request(port, "POST", "/api/policy/test", { headers, body: { project: folder } });
      assert.ok(r.status >= 400 && r.status < 500, `${folder}: ${r.status}`);
      assert.ok(!r.text.includes(MARKER));
    }
    const extra = await request(port, "POST", "/api/policy/test", { headers, body: { project: dir, extra: 1 } });
    assert.equal(extra.status, 400);
    const state = await request(port, "GET", "/api/policy", { headers: { Cookie: auth.cookie } });
    assert.equal(state.status, 200);
    assert.equal(state.json.editing, false);
    assert.deepEqual(snapshot(dir), before);
    assert.deepEqual(snapshot(outside), outsideBefore);
  });
});
