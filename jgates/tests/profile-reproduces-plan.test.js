import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// A reduced run from the UI ("Personalizar esta validação"): turning "Testes unitários" off for one run takes the
// stage out of the plan and marks the plan as reduced; "Salvar como perfil" creates the profile, and the next plan built
// with that profile has the same items as the reduced one. The calls are the ones the screens make (POST /api/plans,
// POST /api/validations/profile); the browser side is in tests/ui/validations-plan.spec.ts and tests/ui/trail.spec.ts.

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(here, "..", "dist", "cli", "main.js");
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

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

/** Everything under the directory (relative path -> bytes), to prove that a plan changes no file. */
function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = path.join(rel, e.name);
      if (e.isDirectory()) walk(child);
      else out[child] = fs.readFileSync(path.join(dir, child)).toString("base64");
    }
  };
  walk(".");
  return out;
}

const willRun = (plan) => plan.groups.willRun.map((i) => i.id).sort();
const UNIT = "quality-bridge.project-tests#unit";

test("a reduced plan has no unit stage, the saved profile gives the same items, and no project file changes", async () => {
  const home = tmp("jg-reduced-home-");
  const dir = tmp("jg-reduced-ws-");
  fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  const init = spawnSync(process.execPath, [MAIN, "init", "--cwd", dir, "--profile", "strict", "--no-interactive", "--json"], { env: { ...process.env, JGATES_HOME: home }, encoding: "utf8" });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  let ui = null;
  try {
    ui = await startUi(dir, home);
    const send = await session(ui);
    const before = snapshot(dir);

    // Escolher: the profile as it is, then with "Testes unitários" off for this run only (the panel's skip).
    const full = await send("POST", "/api/plans", { profile: "strict", scope: "full", preview: true });
    assert.equal(full.status, 201, full.text);
    assert.ok(willRun(full.json.plan).includes(UNIT), "the unit stage is in the plan of the whole profile");
    assert.equal(full.json.plan.selection.reduced, false);

    const reduced = await send("POST", "/api/plans", { profile: "strict", scope: "full", skip: ["capability:unit"], preview: true });
    assert.equal(reduced.status, 201, reduced.text);
    assert.ok(!willRun(reduced.json.plan).includes(UNIT), "the unit stage left the plan");
    assert.equal(reduced.json.plan.selection.reduced, true, "the plan is marked as reduced");
    assert.deepEqual(willRun(reduced.json.plan), willRun(full.json.plan).filter((id) => id !== UNIT), "nothing else left the plan");
    assert.deepEqual(snapshot(dir), before, "building the plans changed no project file");

    // Salvar como perfil: the profile is created, and the plan built with it has the same items as the reduced one.
    const made = await send("POST", "/api/validations/profile", { mode: "create", id: "sem-unitarios", from: "strict", label: "Sem unitários", skip: ["capability:unit"] });
    assert.equal(made.status, 201, made.text);
    assert.match(fs.readFileSync(path.join(dir, ".jgates", "profiles.yml"), "utf8"), /sem-unitarios:[\s\S]*capability:unit:[\s\S]*enabled: false/);
    const next = await send("POST", "/api/plans", { profile: "sem-unitarios", scope: "full", preview: true });
    assert.equal(next.status, 201, next.text);
    assert.deepEqual(willRun(next.json.plan), willRun(reduced.json.plan), "the saved profile reproduces the reduced plan");
    assert.equal(next.json.plan.profile?.id ?? next.json.plan.profile, "sem-unitarios");
  } finally {
    await stopUi(ui);
    for (const d of [dir, home]) fs.rmSync(d, { recursive: true, force: true });
  }
});
