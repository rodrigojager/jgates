import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// The local server of `jgates ui`: every request is checked
// before any route reads or writes, the bootstrap secret works once and never leaks, documents are resolved by id.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const require = createRequire(import.meta.url);
const mainFixture = require("../../tests/fixtures/jgates/main-fixture.js");
const { findOnPath } = await import(pathToFileURL(path.join(dist, "core", "bridge", "index.js")).href);

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function writeTree(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

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
const PYPROJECT = "[tool.ruff]\nline-length = 88\n\n[tool.pytest.ini_options]\naddopts = \"-q\"\n";
const OUTSIDE_TEXT = "token = \"OUTSIDE-ONLY-CONTENT\"\n";

/** A project with real bindings, a binding that is a symlink to a file outside, and a directory binding. */
function documentsProject() {
  const dir = tmp("jg-srv-");
  const outside = tmp("jg-srv-out-");
  writeTree(dir, {
    "jgates.yml": "schemaVersion: 1\nextends:\n  - .jgates/tools.yml\n",
    ".jgates/tools.yml": TOOLS,
    "pyproject.toml": PYPROJECT,
    ".jgates/rules/a.yml": "rules: []\n",
  });
  writeTree(outside, { "secret.toml": OUTSIDE_TEXT, "secret.yml": OUTSIDE_TEXT });
  fs.symlinkSync(path.join(outside, "secret.toml"), path.join(dir, "link.toml"));
  fs.symlinkSync(path.join(outside, "secret.yml"), path.join(dir, ".jgates", "rules", "evil.yml"));
  return {
    dir,
    outside,
    cleanup() {
      for (const d of [dir, outside]) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

/** Starts `jgates ui --no-open --port 0 --json` and resolves once its JSON document is on stdout. */
function startUi(dir, home, { args = [], env = {} } = {}) {
  const proc = spawn(process.execPath, [MAIN, "ui", "--cwd", dir, "--no-open", "--port", "0", "--json", ...args], {
    env: { ...process.env, JGATES_HOME: home, ...env },
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

async function stopUi(ui, signal = "SIGTERM") {
  if (!ui || ui.proc.exitCode !== null || ui.proc.signalCode !== null) return;
  const exited = once(ui.proc, "exit");
  ui.proc.kill(signal);
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
        headers: {
          Host: host ?? `127.0.0.1:${port}`,
          ...(data ? { "Content-Type": "application/json", "Content-Length": String(data.length) } : {}),
          ...headers,
        },
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

/** Path and query of the bootstrap link inside a launcher file. */
function bootstrapPath(launcher) {
  const html = fs.readFileSync(launcher, "utf8");
  const href = /href="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
  assert.ok(href, "launcher has no bootstrap link");
  const url = new URL(href);
  return { path: url.pathname + url.search, secret: url.searchParams.get("token"), port: Number(url.port) };
}

async function login(ui, launcher = ui.info.launcher) {
  const { path: p, secret } = bootstrapPath(launcher);
  const r = await request(ui.info.port, "GET", p);
  assert.equal(r.status, 200, r.text);
  const cookie = String(r.headers["set-cookie"]?.[0] ?? "").split(";")[0];
  assert.match(cookie, /^jgates_session_\d+=/);
  const s = await request(ui.info.port, "GET", "/api/session", { headers: { Cookie: cookie } });
  assert.equal(s.status, 200, s.text);
  return { cookie, csrf: s.json.csrfToken, secret, bootstrap: r };
}

const origin = (ui) => `http://127.0.0.1:${ui.info.port}`;
const mutationHeaders = (ui, auth) => ({ Cookie: auth.cookie, Origin: origin(ui), "X-JGates-CSRF": auth.csrf });

async function withServer(fn, { project = documentsProject } = {}) {
  const p = project();
  const home = tmp("jg-srv-home-");
  let ui = null;
  try {
    ui = await startUi(p.dir, home);
    await fn({ ui, home, ...p });
  } finally {
    await stopUi(ui);
    p.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("the server listens only on loopback and a non-loopback --host is refused", async () => {
  await withServer(async ({ ui, home }) => {
    assert.equal(ui.info.status, "OK");
    assert.equal(ui.info.host, "127.0.0.1");
    assert.equal(ui.info.reused, false);
    assert.equal(ui.info.url, `http://127.0.0.1:${ui.info.port}/`);
    assert.ok(!ui.info.url.includes("token"), "the printed URL carries no secret");
    const lock = JSON.parse(fs.readFileSync(path.join(home, "workspaces", ui.info.workspace.id, "locks", "ui-server.json"), "utf8"));
    assert.equal(lock.host, "127.0.0.1");
    assert.equal(lock.port, ui.info.port);
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(home, "workspaces", ui.info.workspace.id, "locks", "ui-server.json")).mode & 0o777, 0o600);

    // Any non-loopback address of this machine has nothing listening on that port.
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((a) => a && a.family === "IPv4" && !a.internal);
    if (external) {
      const error = await new Promise((resolve) => {
        const socket = net.connect({ host: external.address, port: ui.info.port, timeout: 3000 });
        socket.on("connect", () => {
          socket.destroy();
          resolve(null);
        });
        socket.on("timeout", () => {
          socket.destroy();
          resolve(new Error("timeout"));
        });
        socket.on("error", (e) => resolve(e));
      });
      assert.ok(error, `the server answered on ${external.address}`);
    }
  });

  const dir = tmp("jg-srv-host-");
  const home = tmp("jg-srv-host-home-");
  try {
    for (const host of ["0.0.0.0", "192.168.0.10", "::"]) {
      const r = spawnSync(process.execPath, [MAIN, "ui", "--cwd", dir, "--no-open", "--host", host, "--json"], { encoding: "utf8", env: { ...process.env, JGATES_HOME: home }, timeout: 20_000 });
      assert.equal(r.status, 3, r.stdout + r.stderr);
      assert.equal(JSON.parse(r.stdout).code, "HOST_NOT_LOOPBACK");
    }
  } finally {
    for (const d of [dir, home]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("a request without a session is refused", async () => {
  await withServer(async ({ ui }) => {
    for (const p of ["/api/workspace", "/api/tools", "/api/documents/ruff-api/config", "/api/plans/last", "/"]) {
      const r = await request(ui.info.port, "GET", p);
      assert.equal(r.status, 401, `${p}: ${r.text}`);
      assert.ok(!r.text.includes("line-length"), "no document content without a session");
    }
    const bogus = await request(ui.info.port, "GET", "/api/workspace", { headers: { Cookie: `jgates_session_${ui.info.port}=${"A".repeat(43)}` } });
    assert.equal(bogus.status, 401);
    assert.equal(bogus.json.code, "SESSION_REQUIRED");
    // A mutation without a session writes nothing.
    const before = fs.readFileSync(path.join(ui.info.workspace.path, "pyproject.toml"));
    const put = await request(ui.info.port, "PUT", "/api/documents/ruff-api/config", { headers: { Origin: origin(ui) }, body: { expectedRevision: sha(before), text: "x = 1\n" } });
    assert.equal(put.status, 401);
    assert.deepEqual(fs.readFileSync(path.join(ui.info.workspace.path, "pyproject.toml")), before);
  });
});

test("a different Host is refused, also with a valid session (DNS rebinding)", async () => {
  await withServer(async ({ ui, home }) => {
    const auth = await login(ui);
    const ok = await request(ui.info.port, "GET", "/api/workspace", { headers: { Cookie: auth.cookie } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.workspace.id, ui.info.workspace.id);
    for (const host of ["evil.example", `evil.example:${ui.info.port}`, `127.0.0.1:${ui.info.port + 1}`, `127.0.0.1.nip.io:${ui.info.port}`, `[::1]:${ui.info.port}`]) {
      const r = await request(ui.info.port, "GET", "/api/workspace", { host, headers: { Cookie: auth.cookie } });
      assert.equal(r.status, 421, `Host ${host}: ${r.text}`);
      assert.equal(r.json.code, "HOST_NOT_ALLOWED");
      assert.ok(!r.text.includes(ui.info.workspace.path));
    }
    // No Host at all (HTTP/1.0 over a raw socket) is refused the same way.
    const raw = await new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: ui.info.port }, () => socket.write(`GET /api/workspace HTTP/1.0\r\nCookie: ${auth.cookie}\r\n\r\n`));
      let text = "";
      socket.setEncoding("utf8");
      socket.on("data", (d) => (text += d));
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
    });
    assert.match(raw, /^HTTP\/1\.[01] 421/);
    assert.ok(!raw.includes(ui.info.workspace.path));
    // A fresh, valid bootstrap secret sent under a rebound name is refused and stays unused.
    const lock = JSON.parse(fs.readFileSync(path.join(home, "workspaces", ui.info.workspace.id, "locks", "ui-server.json"), "utf8"));
    const issued = await request(ui.info.port, "POST", "/control/bootstrap", { headers: { "X-JGates-Control": lock.controlToken } });
    const bootstrap = bootstrapPath(issued.json.launcher);
    const rebound = await request(ui.info.port, "GET", bootstrap.path, { host: `evil.example:${ui.info.port}` });
    assert.equal(rebound.status, 421);
    assert.equal(rebound.headers["set-cookie"], undefined);
    const proper = await request(ui.info.port, "GET", bootstrap.path);
    assert.equal(proper.status, 200);
  });
});

test("an unauthorized Origin, a cross-site fetch and a missing CSRF token are refused; there is no CORS", async () => {
  await withServer(async ({ ui, dir }) => {
    const auth = await login(ui);
    const file = path.join(dir, "pyproject.toml");
    const before = fs.readFileSync(file);
    const body = { expectedRevision: sha(before), text: "[tool.ruff]\nline-length = 100\n" };
    const put = (headers) => request(ui.info.port, "PUT", "/api/documents/ruff-api/config", { headers, body });

    for (const bad of ["http://evil.example", "null", `http://127.0.0.1:${ui.info.port + 1}`, `https://127.0.0.1:${ui.info.port}`]) {
      const r = await put({ ...mutationHeaders(ui, auth), Origin: bad });
      assert.equal(r.status, 403, `Origin ${bad}: ${r.text}`);
      assert.equal(r.json.code, "ORIGIN_NOT_ALLOWED");
      assert.equal(r.headers["access-control-allow-origin"], undefined);
      const read = await request(ui.info.port, "GET", "/api/documents/ruff-api/config", { headers: { Cookie: auth.cookie, Origin: bad } });
      assert.equal(read.status, 403);
      assert.ok(!read.text.includes("line-length"));
    }
    const crossSite = await request(ui.info.port, "GET", "/api/documents/ruff-api/config", { headers: { Cookie: auth.cookie, "Sec-Fetch-Site": "cross-site" } });
    assert.equal(crossSite.status, 403);

    const noOrigin = await put({ Cookie: auth.cookie, "X-JGates-CSRF": auth.csrf });
    assert.equal(noOrigin.status, 403);
    assert.equal(noOrigin.json.code, "ORIGIN_REQUIRED");
    const noCsrf = await put({ Cookie: auth.cookie, Origin: origin(ui) });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.json.code, "CSRF_INVALID");
    const wrongCsrf = await put({ ...mutationHeaders(ui, auth), "X-JGates-CSRF": "B".repeat(43) });
    assert.equal(wrongCsrf.status, 403);
    const formPost = await request(ui.info.port, "PUT", "/api/documents/ruff-api/config", {
      headers: { ...mutationHeaders(ui, auth), "Content-Type": "application/x-www-form-urlencoded" },
      body: JSON.stringify(body),
    });
    assert.equal(formPost.status, 415);
    assert.deepEqual(fs.readFileSync(file), before, "no refused request wrote the file");

    const preflight = await request(ui.info.port, "OPTIONS", "/api/documents/ruff-api/config", {
      headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "PUT" },
    });
    assert.equal(preflight.status, 405);
    assert.equal(preflight.headers["access-control-allow-origin"], undefined);
    assert.equal(preflight.headers["access-control-allow-methods"], undefined);

    // The same request with every check satisfied goes through (the refusals above were the checks, not the route).
    const good = await put(mutationHeaders(ui, auth));
    assert.equal(good.status, 200, good.text);
    assert.equal(fs.readFileSync(file, "utf8"), body.text);
    assert.match(good.headers["content-security-policy"], /default-src 'none'/);
    assert.match(good.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(good.headers["x-content-type-options"], "nosniff");
  });
});

test("a mutation by GET is refused and changes nothing", async () => {
  await withServer(async ({ ui, home }) => {
    const auth = await login(ui);
    const plans = path.join(home, "workspaces", ui.info.workspace.id, "plans");
    for (const p of ["/api/plans", "/api/runs", "/api/runs/job_0123456789abcdef/cancel", "/api/documents/ruff-api/config/preview", "/api/documents/ruff-api/config/validate", "/control/bootstrap"]) {
      const r = await request(ui.info.port, "GET", p, { headers: { Cookie: auth.cookie } });
      assert.equal(r.status, 405, `${p}: ${r.text}`);
      assert.equal(r.json.code, "METHOD_NOT_ALLOWED");
      assert.ok(r.headers.allow && !r.headers.allow.includes("GET"));
    }
    assert.ok(!fs.existsSync(plans), "no plan was created by a GET");
    const launchers = fs.readdirSync(path.join(home, "workspaces", ui.info.workspace.id, "server")).filter((f) => f.startsWith("launch-"));
    assert.equal(launchers.length, 0, "no launcher was issued by a GET");
    // Inputs are checked against the route schema: unknown fields and unknown query parameters are refused.
    const extraField = await request(ui.info.port, "POST", "/api/plans", { headers: mutationHeaders(ui, auth), body: { profile: "standard", shell: "rm -rf /" } });
    assert.equal(extraField.status, 400);
    assert.equal(extraField.json.code, "INPUT_INVALID");
    const extraQuery = await request(ui.info.port, "GET", "/api/workspace?debug=1", { headers: { Cookie: auth.cookie } });
    assert.equal(extraQuery.status, 400);
    const big = await request(ui.info.port, "POST", "/api/plans", { headers: mutationHeaders(ui, auth), body: { profile: "x".repeat(70 * 1024) } });
    assert.equal(big.status, 413);
    assert.ok(!fs.existsSync(plans));
  });
});

test("the bootstrap secret works once and never shows up in stdout, stderr or the server log", async () => {
  const p = documentsProject();
  const home = tmp("jg-srv-home-");
  let ui = null;
  try {
    ui = await startUi(p.dir, home);
    const launcher = ui.info.launcher;
    if (process.platform !== "win32") assert.equal(fs.statSync(launcher).mode & 0o777, 0o600);
    const auth = await login(ui);
    assert.ok(auth.secret && auth.secret.length >= 43);
    const setCookie = String(auth.bootstrap.headers["set-cookie"]?.[0] ?? "");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.equal(auth.bootstrap.headers["cache-control"], "no-store");
    assert.equal(auth.bootstrap.headers["referrer-policy"], "no-referrer");
    assert.ok(!auth.bootstrap.text.includes(auth.secret), "the page after the exchange does not carry the secret");
    assert.match(auth.bootstrap.text, /url=\/"/);
    assert.ok(!fs.existsSync(launcher), "the launcher is removed once its secret is used");

    // Second use of the same secret: refused, no session, no echo.
    const again = await request(ui.info.port, "GET", `/session/bootstrap?token=${auth.secret}`);
    assert.equal(again.status, 401);
    assert.equal(again.json.code, "BOOTSTRAP_INVALID");
    assert.equal(again.headers["set-cookie"], undefined);
    assert.ok(!again.text.includes(auth.secret));
    // A malformed or made-up secret is refused the same way.
    for (const token of ["x", "A".repeat(43), "../../etc"]) {
      const r = await request(ui.info.port, "GET", `/session/bootstrap?token=${encodeURIComponent(token)}`);
      assert.ok(r.status === 401 || r.status === 400, r.text);
      assert.equal(r.headers["set-cookie"], undefined);
    }
    // The session works.
    const ws = await request(ui.info.port, "GET", "/api/workspace", { headers: { Cookie: auth.cookie } });
    assert.equal(ws.status, 200);
    await request(ui.info.port, "GET", "/api/nothing-here", { headers: { Cookie: auth.cookie } });

    await stopUi(ui);
    const log = fs.readFileSync(ui.info.log, "utf8");
    assert.match(log, /GET \/session\/bootstrap 200/);
    assert.match(log, /GET \/session\/bootstrap 401/);
    const sessionId = auth.cookie.split("=")[1];
    for (const [name, text] of [["stdout", ui.out], ["stderr", ui.err], ["server log", log]]) {
      assert.ok(!text.includes(auth.secret), `the bootstrap secret is in ${name}`);
      assert.ok(!text.includes(sessionId), `the session id is in ${name}`);
      assert.ok(!text.includes(auth.csrf), `the CSRF token is in ${name}`);
    }
    const remaining = fs.readdirSync(path.join(home, "workspaces", ui.info.workspace.id, "server")).filter((f) => f.startsWith("launch-"));
    assert.deepEqual(remaining, [], "stopping the server removes the pending launchers");
    assert.ok(!fs.existsSync(path.join(home, "workspaces", ui.info.workspace.id, "locks", "ui-server.json")), "stopping the server removes its lock");
  } finally {
    await stopUi(ui);
    p.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a forged document id, a traversal or a symlink out of the root fails without reading or writing outside", async () => {
  await withServer(async ({ ui, outside }) => {
    const auth = await login(ui);
    const get = (p) => request(ui.info.port, "GET", p, { headers: { Cookie: auth.cookie } });
    const noLeak = (r) => assert.ok(!r.text.includes("OUTSIDE-ONLY-CONTENT"), `outside content leaked: ${r.text}`);

    const real = await get("/api/documents/ruff-api/config");
    assert.equal(real.status, 200, real.text);
    assert.equal(real.json.document.text, PYPROJECT);
    assert.equal(real.json.document.revision, sha(PYPROJECT));

    const cases = [
      ["/api/documents/ruff-api/..%2F..%2Fetc%2Fpasswd", 400],
      ["/api/documents/..%2F..%2Fetc/config", 400],
      ["/api/documents/ruff-api/%2e%2e", [400, 404]],
      ["/api/documents/ruff-api/config%00", 400],
      [`/api/documents/ruff-api/${encodeURIComponent(path.join(outside, "secret.toml"))}`, 400],
      ["/api/documents/rules/rules?entry=..%2F..%2F..%2Fsecret.yml", 400],
      ["/api/documents/rules/rules?entry=sub%2F..%2F..%2Fsecret.yml", 400],
      [`/api/documents/rules/rules?entry=${encodeURIComponent(path.join(outside, "secret.yml"))}`, 400],
      ["/api/documents/rules/rules?entry=..%5C..%5Csecret.yml", 400],
      ["/api/documents/ghost/config", 404],
      ["/api/documents/ruff-api/nope", 404],
      ["/api/documents/rules/rules?entry=missing.yml", 404],
    ];
    for (const [p, status] of cases) {
      const r = await get(p);
      assert.ok([status].flat().includes(r.status), `${p}: ${r.status} ${r.text}`);
      noLeak(r);
    }
    // Dot segments in the raw path are normalized away and never reach a document route.
    const dotted = await get("/api/documents/ruff-api/config/../../../../etc/passwd");
    assert.ok(dotted.status === 404 || dotted.status === 400, dotted.text);
    assert.ok(!/root:/.test(dotted.text));

    // A binding that is a symlink to a file outside the root: refused for reading and writing.
    const link = await get("/api/documents/escape/config");
    assert.equal(link.status, 403, link.text);
    assert.equal(link.json.code, "BINDING_REFUSED");
    noLeak(link);
    const outsideFile = path.join(outside, "secret.toml");
    const put = await request(ui.info.port, "PUT", "/api/documents/escape/config", {
      headers: mutationHeaders(ui, auth),
      body: { expectedRevision: sha(OUTSIDE_TEXT), text: "token = \"overwritten\"\n" },
    });
    assert.equal(put.status, 403, put.text);
    noLeak(put);
    for (const action of ["validate", "preview"]) {
      const r = await request(ui.info.port, "POST", `/api/documents/escape/config/${action}`, { headers: mutationHeaders(ui, auth), body: { text: "a = 1\n" } });
      assert.equal(r.status, 403, r.text);
      noLeak(r);
    }
    // An entry of a directory binding that is a symlink to a file outside the root.
    const evil = await get("/api/documents/rules/rules?entry=evil.yml");
    assert.ok(evil.status === 403 || evil.status === 404, evil.text);
    noLeak(evil);
    const evilPut = await request(ui.info.port, "PUT", "/api/documents/rules/rules", {
      headers: mutationHeaders(ui, auth),
      body: { entry: "evil.yml", expectedRevision: sha(OUTSIDE_TEXT), text: "rules: [x]\n" },
    });
    assert.ok(evilPut.status === 403 || evilPut.status === 404, evilPut.text);
    // A traversal in the body is refused by the schema.
    const bodyTraversal = await request(ui.info.port, "PUT", "/api/documents/rules/rules", {
      headers: mutationHeaders(ui, auth),
      body: { entry: "../../secret.yml", expectedRevision: null, text: "x: 1\n" },
    });
    assert.equal(bodyTraversal.status, 400);
    assert.equal(fs.readFileSync(outsideFile, "utf8"), OUTSIDE_TEXT);
    assert.equal(fs.readFileSync(path.join(outside, "secret.yml"), "utf8"), OUTSIDE_TEXT);
    assert.deepEqual(fs.readdirSync(outside).sort(), ["secret.toml", "secret.yml"], "nothing was created outside");
  });
});

test("saving with an outdated expectedRevision returns a conflict and leaves the file intact", async () => {
  await withServer(async ({ ui, dir }) => {
    const auth = await login(ui);
    const file = path.join(dir, "pyproject.toml");
    const read = await request(ui.info.port, "GET", "/api/documents/ruff-api/config", { headers: { Cookie: auth.cookie } });
    const base = read.json.document;

    const local = base.text.replace("line-length = 88", "line-length = 120");
    const preview = await request(ui.info.port, "POST", "/api/documents/ruff-api/config/preview", { headers: mutationHeaders(ui, auth), body: { text: local } });
    assert.equal(preview.status, 200, preview.text);
    assert.match(preview.json.preview.diff, /-line-length = 88/);
    assert.match(preview.json.preview.diff, /\+line-length = 120/);
    assert.equal(fs.readFileSync(file, "utf8"), PYPROJECT, "preview writes nothing");

    // Someone else changes the file between the read and the save.
    const external = PYPROJECT.replace("line-length = 88", "line-length = 99");
    fs.writeFileSync(file, external);
    const save = await request(ui.info.port, "PUT", "/api/documents/ruff-api/config", {
      headers: mutationHeaders(ui, auth),
      body: { expectedRevision: base.revision, text: local, baseText: base.text },
    });
    assert.equal(save.status, 409, save.text);
    assert.equal(save.json.code, "REVISION_CONFLICT");
    assert.equal(save.json.conflict.base.revision, base.revision);
    assert.equal(save.json.conflict.base.text, base.text);
    assert.equal(save.json.conflict.local.text, local);
    assert.equal(save.json.conflict.current.text, external);
    assert.equal(save.json.conflict.current.revision, sha(external));
    assert.equal(fs.readFileSync(file, "utf8"), external, "the file keeps the external version");

    // Saving from the current revision works and writes exactly the text.
    const retry = await request(ui.info.port, "PUT", "/api/documents/ruff-api/config", {
      headers: mutationHeaders(ui, auth),
      body: { expectedRevision: sha(external), text: local },
    });
    assert.equal(retry.status, 200, retry.text);
    assert.equal(retry.json.save.status, "saved");
    assert.equal(fs.readFileSync(file, "utf8"), local);
    const validate = await request(ui.info.port, "POST", "/api/documents/ruff-api/config/validate", { headers: mutationHeaders(ui, auth), body: {} });
    assert.equal(validate.status, 200, validate.text);
  });
});

test("a second jgates ui for the same workspace reuses the open server; a stale lock is replaced", async () => {
  const p = documentsProject();
  const home = tmp("jg-srv-home-");
  let first = null;
  let third = null;
  try {
    first = await startUi(p.dir, home);
    const second = spawnSync(process.execPath, [MAIN, "ui", "--cwd", p.dir, "--no-open", "--port", "0", "--json"], {
      encoding: "utf8",
      env: { ...process.env, JGATES_HOME: home },
      timeout: 30_000,
    });
    assert.equal(second.status, 0, second.stdout + second.stderr);
    const info = JSON.parse(second.stdout);
    assert.equal(info.reused, true);
    assert.equal(info.port, first.info.port);
    assert.equal(info.pid, first.info.pid);
    assert.notEqual(info.launcher, first.info.launcher);
    // The launcher of the second call opens a session on the first server; the first launcher still works once too.
    const viaSecond = await login(first, info.launcher);
    assert.notEqual(viaSecond.secret, bootstrapPath(first.info.launcher).secret);
    assert.ok(!second.stdout.includes(viaSecond.secret) && !second.stderr.includes(viaSecond.secret));
    await login(first);
    // The same folder through a symlink is the same workspace.
    const alias = path.join(tmp("jg-srv-alias-"), "ws");
    fs.symlinkSync(p.dir, alias);
    const viaAlias = JSON.parse(spawnSync(process.execPath, [MAIN, "ui", "--cwd", alias, "--no-open", "--json"], { encoding: "utf8", env: { ...process.env, JGATES_HOME: home }, timeout: 30_000 }).stdout);
    assert.equal(viaAlias.reused, true);
    assert.equal(viaAlias.port, first.info.port);
    fs.rmSync(path.dirname(alias), { recursive: true, force: true });

    // The first server dies without cleaning up: its lock stays behind and is detected as stale.
    await stopUi(first, "SIGKILL");
    const lockPath = path.join(home, "workspaces", first.info.workspace.id, "locks", "ui-server.json");
    assert.ok(fs.existsSync(lockPath));
    third = await startUi(p.dir, home);
    assert.equal(third.info.reused, false);
    assert.notEqual(third.info.pid, first.info.pid);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, third.info.pid);
    const auth = await login(third);
    const ws = await request(third.info.port, "GET", "/api/workspace", { headers: { Cookie: auth.cookie } });
    assert.equal(ws.status, 200);
  } finally {
    await stopUi(first);
    await stopUi(third);
    p.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the control channel refuses browsers and wrong tokens", async () => {
  await withServer(async ({ ui, home }) => {
    const lock = JSON.parse(fs.readFileSync(path.join(home, "workspaces", ui.info.workspace.id, "locks", "ui-server.json"), "utf8"));
    const wrong = await request(ui.info.port, "POST", "/control/bootstrap", { headers: { "X-JGates-Control": "C".repeat(43) } });
    assert.equal(wrong.status, 403);
    const browser = await request(ui.info.port, "POST", "/control/bootstrap", { headers: { "X-JGates-Control": lock.controlToken, Origin: origin(ui) } });
    assert.equal(browser.status, 403);
    const fetchMeta = await request(ui.info.port, "POST", "/control/bootstrap", { headers: { "X-JGates-Control": lock.controlToken, "Sec-Fetch-Site": "same-origin" } });
    assert.equal(fetchMeta.status, 403);
    const ok = await request(ui.info.port, "POST", "/control/bootstrap", { headers: { "X-JGates-Control": lock.controlToken } });
    assert.equal(ok.status, 200);
    assert.ok(fs.existsSync(ok.json.launcher));
    assert.ok(!ok.text.includes("token="), "the control answer carries the launcher path, not the secret");
  });
});

test("workspace and tools routes describe the workspace by ids", async () => {
  await withServer(async ({ ui }) => {
    const auth = await login(ui);
    const ws = await request(ui.info.port, "GET", "/api/workspace", { headers: { Cookie: auth.cookie } });
    assert.equal(ws.json.root, ui.info.workspace.path);
    assert.equal(ws.json.configFile, "jgates.yml");
    const tools = await request(ui.info.port, "GET", "/api/tools", { headers: { Cookie: auth.cookie } });
    assert.equal(tools.status, 200);
    const ids = tools.json.instances.map((i) => i.id).sort();
    assert.deepEqual(ids, ["escape", "ruff-api", "rules"]);
    const one = await request(ui.info.port, "GET", "/api/tools/ruff-api", { headers: { Cookie: auth.cookie } });
    assert.equal(one.json.instance.bindings[0].id, "config");
    const missing = await request(ui.info.port, "GET", "/api/tools/ghost", { headers: { Cookie: auth.cookie } });
    assert.equal(missing.status, 404);
  });
});

const PYTHON = findOnPath("python") ?? findOnPath("python3");
const NO_DOCKER = { DOCKER_CONTEXT: "", DOCKER_HOST: "tcp://127.0.0.1:1", GITHUB_BASE_REF: "", GITHUB_HEAD_REF: "", GITHUB_SHA: "", GITLAB_CI: "" };

test("plan and run routes: the run executes the reviewed plan and its result carries the same hash", async () => {
  assert.ok(PYTHON, "python not found on PATH: put the repository .venv/bin first on PATH");
  const { dir } = mainFixture.createMainFixture();
  const home = tmp("jg-srv-run-home-");
  const emptyBin = tmp("jg-srv-run-bin-");
  const env = { ...NO_DOCKER, JGATES_HOME: home, JGATES_PYTHON: PYTHON, PATH: emptyBin };
  let ui = null;
  try {
    const init = spawnSync(process.execPath, [MAIN, "init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"], { encoding: "utf8", env: { ...process.env, ...env } });
    assert.equal(init.status, 0, init.stdout + init.stderr);
    ui = await startUi(dir, home, { env });
    const auth = await login(ui);
    const headers = mutationHeaders(ui, auth);

    const created = await request(ui.info.port, "POST", "/api/plans", { headers, body: {} });
    assert.equal(created.status, 201, created.text);
    const planHash = created.json.planHash;
    assert.match(planHash, /^sha256:[0-9a-f]{64}$/);
    const read = await request(ui.info.port, "GET", `/api/plans/${encodeURIComponent(planHash)}`, { headers: { Cookie: auth.cookie } });
    assert.equal(read.json.plan.planHash, planHash);
    const last = await request(ui.info.port, "GET", "/api/plans/last", { headers: { Cookie: auth.cookie } });
    assert.equal(last.json.planHash, planHash);

    const unknown = await request(ui.info.port, "POST", "/api/runs", { headers, body: { planHash: `sha256:${"0".repeat(64)}` } });
    assert.equal(unknown.status, 404);
    const command = await request(ui.info.port, "POST", "/api/runs", { headers, body: { planHash, command: "echo hi" } });
    assert.equal(command.status, 400, "the frontend never sends commands");

    const started = await request(ui.info.port, "POST", "/api/runs", { headers, body: { planHash } });
    assert.equal(started.status, 202, started.text);
    const jobId = started.json.run.id;
    const again = await request(ui.info.port, "POST", "/api/runs", { headers, body: { planHash } });
    assert.ok(again.status === 409 || again.status === 202, again.text);
    if (again.status === 202) await request(ui.info.port, "POST", `/api/runs/${again.json.run.id}/cancel`, { headers });

    let cursor = 0;
    const events = [];
    for (let i = 0; i < 200; i++) {
      const r = await request(ui.info.port, "GET", `/api/runs/${jobId}/events?cursor=${cursor}&wait=5000`, { headers: { Cookie: auth.cookie } });
      assert.equal(r.status, 200, r.text);
      events.push(...r.json.events);
      cursor = r.json.cursor;
      if (r.json.done) break;
    }
    assert.equal(events[0].type, "started");
    const job = (await request(ui.info.port, "GET", `/api/runs/${jobId}`, { headers: { Cookie: auth.cookie } })).json.run;
    assert.equal(job.state, "finished", JSON.stringify(job.error));
    assert.ok(events.some((e) => e.type === "finished"));
    assert.equal(job.result.selection.planHash, planHash);
    const stored = await request(ui.info.port, "GET", `/api/runs/${job.runId}`, { headers: { Cookie: auth.cookie } });
    assert.equal(stored.status, 200);
    assert.equal(stored.json.result.selection.planHash, planHash);
    const runPlan = JSON.parse(fs.readFileSync(path.join(job.result.runDir, "plan.json"), "utf8"));
    assert.equal(runPlan.planHash, planHash);

    const cancelDone = await request(ui.info.port, "POST", `/api/runs/${jobId}/cancel`, { headers });
    assert.equal(cancelDone.status, 409);
    const noSession = await request(ui.info.port, "GET", `/api/runs/${jobId}/events`, {});
    assert.equal(noSession.status, 401, "the event feed needs a session too");
    const forged = await request(ui.info.port, "GET", "/api/runs/..%2F..%2Fetc", { headers: { Cookie: auth.cookie } });
    assert.equal(forged.status, 400);
  } finally {
    await stopUi(ui);
    mainFixture.removeFixture(dir);
    for (const d of [home, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
  }
});
