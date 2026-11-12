import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// A screen that asks for a configuration file can create it: the server starts architecture.yml, pii.yml,
// dependencies.yml and policy.yml from their templates, valid against their schemas, and the YAML routes then list and
// open the new file. Anything else is refused, and an existing file is never overwritten.

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(here, "..", "dist", "cli", "main.js");
const FILES = [".jgates/architecture.yml", ".jgates/pii.yml", ".jgates/dependencies.yml", ".jgates/policy.yml"];

const dirs = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const made = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

function startUi(args, env) {
  const proc = spawn(process.execPath, [MAIN, "ui", ...args, "--no-open", "--port", "0", "--json"], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
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

test("the server creates the four configuration files from their templates; the YAML routes list and open them", async () => {
  const home = made("jg-create-home-");
  const proj = made("jg-create-proj-");
  const init = spawnSync(process.execPath, [MAIN, "init", "--cwd", proj, "--profile", "minimal", "--no-interactive", "--json"], { encoding: "utf8", timeout: 120_000, env: { ...process.env, NO_COLOR: "1", JGATES_HOME: home } });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  for (const f of FILES) assert.equal(fs.existsSync(path.join(proj, f)), false, `${f} should not exist yet`);

  const ui = await startUi(["--cwd", proj], { JGATES_HOME: home, JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" });
  try {
    const call = await session(ui);
    const before = (await call("GET", "/api/config/yaml")).json.files.map((f) => f.file);
    for (const f of FILES) assert.ok(!before.includes(f), `${f} is not listed before`);
    assert.equal((await call("GET", `/api/config/yaml/file?file=${encodeURIComponent(".jgates/architecture.yml")}`)).status, 404);

    for (const f of FILES) {
      const r = await call("POST", "/api/config/yaml/create", { file: f });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.json.exists, true);
      assert.equal(r.json.file, f);
      assert.match(r.json.text, /schemaVersion: 1/);
      assert.ok(fs.existsSync(path.join(proj, f)), `${f} was written`);
      // Valid against its schema: the check of the same text finds nothing in this file.
      const check = await call("POST", "/api/config/yaml/check", { file: f, text: r.json.text });
      assert.equal(check.status, 200, check.text);
      assert.deepEqual(check.json.diagnostics.filter((d) => d.inThisFile), [], f);
      // Open through the file route.
      const opened = await call("GET", `/api/config/yaml/file?file=${encodeURIComponent(f)}`);
      assert.equal(opened.status, 200, opened.text);
      assert.equal(opened.json.text, r.json.text);
      // A second create never overwrites.
      assert.equal((await call("POST", "/api/config/yaml/create", { file: f })).status, 409);
    }
    const after = (await call("GET", "/api/config/yaml")).json.files;
    for (const f of FILES) assert.ok(after.some((x) => x.file === f && x.exists), `${f} is listed after`);

    // The architecture screen now sees its file, valid and empty.
    const arch = await call("GET", "/api/config/architecture");
    assert.equal(arch.json.exists, true);
    assert.equal(arch.json.valid, true);

    // Only the four known files can be created.
    assert.equal((await call("POST", "/api/config/yaml/create", { file: ".jgates/other.yml" })).status, 400);
    assert.equal((await call("POST", "/api/config/yaml/create", { file: "../x.yml" })).status, 400);
  } finally {
    if (ui.proc.exitCode === null) {
      const exited = once(ui.proc, "exit");
      ui.proc.kill("SIGTERM");
      await exited;
    }
  }
});
