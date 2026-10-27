import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The same operation through the CLI and through the API (what the UI calls) writes the same bytes:
// creating the same profile gives a byte for byte equal profiles.yml.

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(here, "..", "dist", "cli", "main.js");
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function project(home) {
  const dir = tmp("jg-eq-ws-");
  fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  const init = spawnSync(process.execPath, [MAIN, "init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"], { env: { ...process.env, JGATES_HOME: home }, encoding: "utf8" });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  return dir;
}

function startUi(dir, home) {
  const proc = spawn(process.execPath, [MAIN, "ui", "--cwd", dir, "--no-open", "--port", "0", "--json"], { env: { ...process.env, JGATES_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.setEncoding("utf8");
  let out = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`jgates ui did not start: ${out}`)), 30_000);
    proc.stdout.on("data", (d) => {
      out += d;
      try {
        const info = JSON.parse(out);
        clearTimeout(timer);
        resolve({ proc, info });
      } catch {
        // Not complete yet.
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`jgates ui exited with ${code}: ${out}`));
    });
  });
}

function request(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: "127.0.0.1", port, method, path: p, agent: false, headers: { Host: `127.0.0.1:${port}`, ...(data ? { "Content-Type": "application/json", "Content-Length": String(data.length) } : {}), ...headers } },
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

/** Opens the bootstrap link of the launcher file and returns a function that sends mutating requests with that session. */
async function session(ui) {
  const html = fs.readFileSync(ui.info.launcher, "utf8");
  const href = /href="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
  assert.ok(href, "launcher has no bootstrap link");
  const url = new URL(href);
  const boot = await request(ui.info.port, "GET", url.pathname + url.search);
  assert.equal(boot.status, 200, boot.text);
  const cookie = String(boot.headers["set-cookie"]?.[0] ?? "").split(";")[0];
  const info = await request(ui.info.port, "GET", "/api/session", { headers: { Cookie: cookie } });
  assert.equal(info.status, 200, info.text);
  const headers = { Cookie: cookie, Origin: `http://127.0.0.1:${ui.info.port}`, "X-JGates-CSRF": info.json.csrfToken };
  return (method, p, body) => request(ui.info.port, method, p, { headers, body });
}

async function stopUi(ui) {
  if (!ui || ui.proc.exitCode !== null || ui.proc.signalCode !== null) return;
  const exited = once(ui.proc, "exit");
  ui.proc.kill("SIGTERM");
  await exited;
}

/** Two equal projects: one is edited by the CLI, the other through the API of a running `jgates ui`. */
async function withPair(fn) {
  const homeCli = tmp("jg-eq-home-");
  const homeApi = tmp("jg-eq-home-");
  const cliDir = project(homeCli);
  const apiDir = project(homeApi);
  let ui = null;
  try {
    assert.equal(fs.readFileSync(path.join(cliDir, ".jgates", "profiles.yml"), "utf8"), fs.readFileSync(path.join(apiDir, ".jgates", "profiles.yml"), "utf8"), "the starting point is the same");
    ui = await startUi(apiDir, homeApi);
    const send = await session(ui);
    const cli = (args) => {
      const r = spawnSync(process.execPath, [MAIN, ...args, "--cwd", cliDir, "--no-interactive", "--json"], { env: { ...process.env, JGATES_HOME: homeCli }, encoding: "utf8" });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return JSON.parse(r.stdout);
    };
    const profiles = (dir) => fs.readFileSync(path.join(dir, ".jgates", "profiles.yml"));
    await fn({ cli, send, cliProfiles: () => profiles(cliDir), apiProfiles: () => profiles(apiDir) });
  } finally {
    await stopUi(ui);
    for (const d of [cliDir, apiDir, homeCli, homeApi]) fs.rmSync(d, { recursive: true, force: true });
  }
}

test("creating the same profile by the CLI and by the API gives a byte for byte equal profiles.yml", async () => {
  await withPair(async ({ cli, send, cliProfiles, apiProfiles }) => {
    cli(["profiles", "create", "equivalente", "--from", "standard", "--label", "Equivalente", "--description", "Mesmo perfil pelos dois caminhos."]);
    const made = await send("POST", "/api/profiles", { id: "equivalente", from: "standard", label: "Equivalente", description: "Mesmo perfil pelos dois caminhos." });
    assert.equal(made.status, 201, made.text);
    assert.ok(cliProfiles().includes("equivalente:"), "the profile is in the file");
    assert.deepEqual(apiProfiles(), cliProfiles());
  });
});

test("saving a reduced selection as a profile (--skip on the CLI, 'Salvar como perfil' on the API) gives a byte for byte equal profiles.yml", async () => {
  await withPair(async ({ cli, send, cliProfiles, apiProfiles }) => {
    cli(["profiles", "create", "sem-unitarios", "--from", "strict", "--skip", "capability:unit", "--label", "Sem unitários"]);
    const made = await send("POST", "/api/validations/profile", { mode: "create", id: "sem-unitarios", from: "strict", label: "Sem unitários", skip: ["capability:unit"] });
    assert.equal(made.status, 201, made.text);
    const text = cliProfiles().toString("utf8");
    assert.match(text, /sem-unitarios:[\s\S]*capability:unit:[\s\S]*enabled: false/);
    assert.deepEqual(apiProfiles(), cliProfiles());
  });
});
