import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// The CI policy in the local server: `jgates ui --policy <folder>` edits the policy folder with the same routes as a
// project; GET /api/policy gives the fingerprint of the set, the files and the ready CI snippets; the test against a
// project builds a plan and writes nothing; and with JGATES_POLICY_DIR in the environment the UI of a project cannot
// write its configuration (403), while without the variable everything is editable.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const { readPolicyBundle } = await import(pathToFileURL(path.join(dist, "core", "policy", "index.js")).href);

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const dirs = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const made = (prefix) => {
  const d = tmp(prefix);
  dirs.push(d);
  return d;
};

const cli = (args, env = {}) => spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", timeout: 120_000, env: { ...process.env, NO_COLOR: "1", ...env } });

/** A folder with the configuration `jgates init` writes (a policy, or a project that has its own configuration). */
function configured(home, prefix = "jg-pol-") {
  const dir = made(prefix);
  const init = cli(["init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"], { JGATES_HOME: home });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  return dir;
}

function project(home) {
  const dir = configured(home, "jg-pol-proj-");
  fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  fs.mkdirSync(path.join(dir, "demo"));
  fs.writeFileSync(path.join(dir, "demo", "mod.py"), "import os\n");
  return dir;
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) out[p] = sha(fs.readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

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

async function stopUi(ui) {
  if (!ui || ui.proc.exitCode !== null || ui.proc.signalCode !== null) return;
  const exited = once(ui.proc, "exit");
  ui.proc.kill("SIGTERM");
  await exited;
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
          resolve({ status: res.statusCode, text, json });
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
  const call = (method, p, body) => request(port, method, p, { headers: method === "GET" ? { Cookie: cookie } : { Cookie: cookie, Origin: origin, "X-JGates-CSRF": s.json.csrfToken }, body });
  return { call };
}

async function withUi(args, env, fn) {
  let ui = null;
  try {
    ui = await startUi(args, env);
    await fn({ ui, ...(await session(ui)) });
  } finally {
    await stopUi(ui);
  }
}

test("jgates ui --policy serves the policy: fingerprint, files and the CI snippets with the current hash and command", async () => {
  const home = made("jg-pol-home-");
  const policy = configured(home);
  await withUi(["--policy", policy], { JGATES_HOME: home }, async ({ ui, call }) => {
    assert.equal(ui.info.policy, true);
    assert.equal(ui.info.workspace.path, policy);
    const shell = await call("GET", "/api/shell");
    assert.equal(shell.json.policyMode, true);
    assert.equal(shell.json.mode, "local");

    const r = await call("GET", "/api/policy");
    assert.equal(r.status, 200, r.text);
    const expected = readPolicyBundle(policy);
    assert.ok(expected.ok);
    assert.equal(r.json.editing, true);
    assert.equal(r.json.sha256, expected.bundle.sha256);
    assert.deepEqual(r.json.files.map((f) => f.path), expected.bundle.files.map((f) => f.path));
    assert.ok(r.json.files.some((f) => f.path === "jgates.yml"));
    assert.equal(r.json.count, r.json.files.length);

    assert.equal(r.json.command, 'jgates ci --policy "$JGATES_POLICY_DIR" --sarif jgates.sarif');
    for (const [name, text] of Object.entries(r.json.snippets)) {
      assert.ok(text.includes(expected.bundle.sha256), `${name} snippet has the current hash`);
      assert.ok(text.includes(r.json.command), `${name} snippet has the jgates ci command`);
      assert.ok(text.includes("JGATES_POLICY_DIR") && text.includes("JGATES_POLICY_SHA256"), `${name} snippet names both variables`);
    }
    assert.match(r.json.snippets.github, /uses: actions\/checkout@v4/);
    assert.match(r.json.snippets.github, /vars\.JGATES_POLICY_SHA256/);
    assert.match(r.json.snippets.gitlab, /^jgates:/m);
    assert.ok(r.json.variables.some((v) => v.name === "JGATES_POLICY_SHA256" && v.value === expected.bundle.sha256));
  });
});

test("saving a profile through the screens changes the policy file and the hash shown by the CI policy screen", async () => {
  const home = made("jg-pol-home-");
  const policy = configured(home);
  await withUi(["--policy", policy], { JGATES_HOME: home }, async ({ call }) => {
    const before = (await call("GET", "/api/policy")).json;
    const files = snapshot(policy);
    const profiles = await call("GET", "/api/profiles");
    assert.equal(profiles.status, 200, profiles.text);
    const from = profiles.json.starters[0].ref;
    const created = await call("POST", "/api/profiles", { id: "ci-strict", from, label: "CI strict" });
    assert.equal(created.status, 201, created.text);
    const after = (await call("GET", "/api/policy")).json;
    assert.notEqual(after.sha256, before.sha256);
    assert.notDeepEqual(snapshot(policy), files, "the policy folder was not changed");
    assert.ok(Object.keys(snapshot(policy)).some((f) => f.includes(`${path.sep}.jgates${path.sep}`)));
    assert.equal(after.sha256, readPolicyBundle(policy).bundle.sha256);
    assert.ok(after.snippets.github.includes(after.sha256) && !after.snippets.github.includes(before.sha256));
  });
});

test("testing against a project shows the plan of the policy and changes no file of the project or of the policy", async () => {
  const home = made("jg-pol-home-");
  const policy = configured(home);
  const proj = project(home);
  // The project has its own configuration: the plan must come from the policy only.
  fs.appendFileSync(path.join(proj, "jgates.yml"), "# project-only marker\n");
  await withUi(["--policy", policy], { JGATES_HOME: home }, async ({ call }) => {
    const policyBefore = snapshot(policy);
    const projectBefore = snapshot(proj);
    const r = await call("POST", "/api/policy/test", { project: proj });
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.planHash, /^sha256:[0-9a-f]{64}$/);
    assert.ok(Array.isArray(r.json.willRun) && r.json.willRunCount === r.json.willRun.length);
    assert.ok(r.json.configFiles.includes("jgates.yml"));
    assert.ok(r.json.profile);
    assert.deepEqual(snapshot(policy), policyBefore, "the policy changed");
    assert.deepEqual(snapshot(proj), projectBefore, "the project changed");

    // Relative paths, missing folders and a policy inside the project are refused.
    const relative = await call("POST", "/api/policy/test", { project: "relative/dir" });
    assert.equal(relative.status, 400);
    assert.equal(relative.json.code, "PROJECT_NOT_ABSOLUTE");
    const missing = await call("POST", "/api/policy/test", { project: path.join(proj, "nope") });
    assert.equal(missing.status, 404);
    const inside = await call("POST", "/api/policy/test", { project: policy });
    assert.equal(inside.status, 422, inside.text);
    assert.equal(inside.json.code, "POLICY_INSIDE_PROJECT");
    assert.deepEqual(snapshot(policy), policyBefore);
  });
});

test("in policy mode the project-only routes are unavailable with the reason, and the other servers cannot be opened", async () => {
  const home = made("jg-pol-home-");
  const policy = configured(home);
  await withUi(["--policy", policy], { JGATES_HOME: home }, async ({ call }) => {
    const before = snapshot(policy);
    for (const [method, p, body] of [
      ["POST", "/api/plans", {}],
      ["POST", "/api/runs", {}],
      ["POST", "/api/validations/profile", {}],
      ["POST", "/api/environment/prepare", {}],
      ["POST", "/api/workspaces/open", { path: policy }],
    ]) {
      const r = await call(method, p, body);
      assert.equal(r.status, 409, `${method} ${p}: ${r.text}`);
      assert.equal(r.json.code, "POLICY_MODE_UNAVAILABLE");
      assert.ok(r.json.message && r.json.fix);
    }
    assert.deepEqual(snapshot(policy), before);
  });
});

test("outside the policy mode the CI policy route only says so, and the test against a project is refused", async () => {
  const home = made("jg-pol-home-");
  const proj = project(home);
  await withUi(["--cwd", proj], { JGATES_HOME: home, JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" }, async ({ call }) => {
    const r = await call("GET", "/api/policy");
    assert.equal(r.status, 200);
    assert.equal(r.json.editing, false);
    assert.equal(r.json.mode, "local");
    const t = await call("POST", "/api/policy/test", { project: proj });
    assert.equal(t.status, 409);
    assert.equal(t.json.code, "POLICY_MODE_REQUIRED");
  });
});

// Every route that writes the configuration of the project (path template, sample path, valid or empty body).
const CONFIG_WRITES = [
  ["PUT", "/api/config/execution", {}],
  ["PUT", "/api/config/architecture/rules/domain-independent", {}],
  ["PUT", "/api/config/selection", {}],
  ["PUT", "/api/config/policy", {}],
  ["PUT", "/api/config/yaml/file", {}],
  ["POST", "/api/config/templates", {}],
  ["PUT", "/api/config/templates/base/enabled", {}],
  ["POST", "/api/profiles", {}],
  ["PUT", "/api/profiles/standard/default", {}],
  ["PUT", "/api/profiles/standard/rename", {}],
  ["DELETE", "/api/profiles/standard", undefined],
  ["POST", "/api/tools", {}],
  ["PUT", "/api/tools/ruff-api", {}],
  ["DELETE", "/api/tools/ruff-api", undefined],
  ["PUT", "/api/tools/ruff-api/bindings/config", {}],
  ["POST", "/api/tools/ruff-api/bindings/config/override", {}],
  ["PUT", "/api/forms/ruff-api", {}],
  ["PUT", "/api/documents/ruff-api/config", {}],
  ["POST", "/api/drafts/ruff-api/config/save", {}],
  ["PUT", "/api/pii", {}],
  ["POST", "/api/rules/ruff-api/rename", {}],
  ["PUT", "/api/workspace/settings", {}],
];

test("with JGATES_POLICY_DIR the UI of a project blocks every write route with 403; without it everything is editable", async () => {
  const home = made("jg-pol-home-");
  const proj = project(home);
  const outside = made("jg-pol-ext-");
  const hash = "a".repeat(64);
  await withUi(["--cwd", proj], { JGATES_HOME: home, JGATES_POLICY_DIR: outside, JGATES_POLICY_SHA256: hash }, async ({ call }) => {
    const before = snapshot(proj);
    const shell = await call("GET", "/api/shell");
    assert.equal(shell.json.mode, "governed");
    assert.equal(shell.json.governed.policy, path.basename(outside));
    assert.equal(shell.json.governed.shaPinned, true);
    assert.equal(shell.json.policyMode, false);
    const failures = [];
    for (const [method, p, body] of CONFIG_WRITES) {
      const r = await call(method, p, body);
      if (r.status !== 403 || r.json?.code !== "GOVERNED_LOCKED") failures.push(`${method} ${p}: ${r.status} ${r.json?.code}`);
      else assert.ok(r.json.message && r.json.fix);
    }
    assert.deepEqual(failures, []);
    // Reading, previewing and the user's own preferences stay available.
    assert.equal((await call("GET", "/api/profiles")).status, 200);
    assert.notEqual((await call("POST", "/api/config/yaml/check", {})).status, 403);
    assert.deepEqual(snapshot(proj), before, "a refused write changed the project");
  });
  await withUi(["--cwd", proj], { JGATES_HOME: home, JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" }, async ({ call }) => {
    const shell = await call("GET", "/api/shell");
    assert.equal(shell.json.mode, "local");
    for (const [method, p, body] of CONFIG_WRITES) {
      const r = await call(method, p, body);
      assert.notEqual(r.status, 403, `${method} ${p} is locked without the variable: ${r.text}`);
    }
  });
});

test("jgates ui --policy refuses --cwd, a missing folder and a folder without jgates.yml, with the configuration exit code", () => {
  const home = made("jg-pol-home-");
  const policy = configured(home);
  const empty = made("jg-pol-empty-");
  const both = cli(["ui", "--policy", policy, "--cwd", policy, "--no-open", "--json"], { JGATES_HOME: home });
  assert.equal(both.status, 3);
  assert.equal(JSON.parse(both.stdout).code, "POLICY_WITH_CWD");
  const missing = cli(["ui", "--policy", path.join(empty, "nope"), "--no-open", "--json"], { JGATES_HOME: home });
  assert.equal(missing.status, 3);
  assert.equal(JSON.parse(missing.stdout).code, "POLICY_DIR_MISSING");
  const noRoot = cli(["ui", "--policy", empty, "--no-open", "--json"], { JGATES_HOME: home });
  assert.equal(noRoot.status, 3);
  assert.equal(JSON.parse(noRoot.stdout).code, "POLICY_ROOT_MISSING");
});
