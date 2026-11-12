import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The guided saves through the server API change only what was edited: Serviços keeps `services.profiles` and every
// comment, a component can be declared, corrected and removed after the wizard wrote `dependencies.manager`, a profile
// or a tool rename keeps the entry as written (and updates the `tool:<old>` selectors), Execução has no `runner` and
// reverting the last override removes the empty block, and "usar como alvo" changes the existing instances in tools.yml.

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(here, "..", "dist", "cli", "main.js");

const dirs = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const made = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), "utf8");

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
  return (method, p, body) => request(port, method, p, { headers: method === "GET" ? { Cookie: cookie } : { Cookie: cookie, Origin: origin, "X-JGates-CSRF": s.json.csrfToken }, body });
}

async function withProject(files, fn) {
  const home = made("jg-cw-home-");
  const dir = made("jg-cw-proj-");
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  let ui = null;
  try {
    ui = await startUi(["--cwd", dir], { JGATES_HOME: home, JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" });
    await fn({ dir, call: await session(ui) });
  } finally {
    await stopUi(ui);
  }
}

const ROOT = `# Root comment
schemaVersion: 2
extends:
  - .jgates/profiles.yml
selection:
  profile: minimal # the default
`;

const PROFILES = `# Profiles of the project
schemaVersion: 1
profiles:
  minimal:
    # why minimal exists
    label: Minimal # label comment
    checks:
      capability:lint:
        enabled: true
      tool:ruff-main:
        enabled: true # keep ruff
  strict:
    extends: minimal
    label: Strict
`;

const TOOLS = `# Tools of the project
schemaVersion: 1
tools:
  # the python linter
  ruff-main:
    adapter: ruff # adapter comment
    capabilities:
      - lint
  zap-api:
    adapter: zap
    target: https://example.test
  st:
    adapter: schemathesis
    target: http://old.example
`;

const COMPOSE = `services:
  app:
    image: example/app:1
    ports:
      - "8080:8080"
  db:
    image: postgres:16
`;

test("Serviços saves only its own keys: services.profiles and every comment stay, the targets of the existing instances change and show in the diff", async () => {
  const root = `${ROOT}# before services
services:
  # keep this comment
  profiles: [dev] # hand-written
  timeoutSeconds: 300
# after services
templates:
  - id: base
    source: builtin:base
    activation: always
`;
  await withProject({ "jgates.yml": root, ".jgates/profiles.yml": PROFILES, ".jgates/tools.yml": TOOLS, "docker-compose.yml": COMPOSE }, async ({ dir, call }) => {
    const view = await call("GET", "/api/services");
    assert.equal(view.status, 200, view.text);

    // A compose file that does not exist is refused in plain words, never as a raw ENOENT.
    const missing = await call("POST", "/api/services/discover", { compose: ["docker-compose.yml", "nope/compose.yml"] });
    assert.equal(missing.status, 422, missing.text);
    assert.equal(missing.json.error?.code ?? missing.json.code, "COMPOSE_FILE_MISSING");
    assert.ok(!/ENOENT/.test(missing.text), missing.text);

    const input = {
      compose: ["docker-compose.yml"],
      roles: { app: "application", db: "dependency" },
      target: { port: 8080, path: "/api" },
      build: "forbid",
      writableBinds: [],
      allowHostEffects: [],
      timeoutSeconds: 120,
      setTargets: true,
    };
    const preview = await call("POST", "/api/services/preview", input);
    assert.equal(preview.status, 200, preview.text);
    assert.deepEqual(
      preview.json.targets.map((x) => [x.tool, x.after]).sort(),
      [
        ["st", "service:app:8080/api"],
        ["zap-api", "service:app:8080/api"],
      ],
    );
    assert.match(preview.json.diff, /\.jgates\/tools\.yml/);
    assert.match(preview.json.diff, /service:app:8080\/api/);

    const saved = await call("PUT", "/api/services", { ...input, revision: view.json.revision });
    assert.equal(saved.status, 200, saved.text);
    const after = read(dir, "jgates.yml");
    for (const keep of ["# Root comment", "# the default", "# before services", "# keep this comment", "profiles: [dev] # hand-written", "# after services", "activation: always"]) assert.ok(after.includes(keep), `${keep}\n${after}`);
    assert.match(after, /compose:\s*\n\s*- docker-compose\.yml/);
    assert.match(after, /service: app/);
    assert.ok(!/timeoutSeconds/.test(after), "the default timeout is not written");
    const tools = read(dir, ".jgates/tools.yml");
    for (const keep of ["# Tools of the project", "# the python linter", "adapter: ruff # adapter comment"]) assert.ok(tools.includes(keep), `${keep}\n${tools}`);
    assert.equal((tools.match(/target: service:app:8080\/api/g) ?? []).length, 2, tools);
    assert.ok(!tools.includes("example.test") && !tools.includes("old.example"));
  });
});

const WORKSPACE = `# Workspace of the project
schemaVersion: 1
discovery:
  mode: auto # mode comment
components:
  # the api
  - id: api
    path: services/api
    language: python
    dependencies:
      manager: uv # written by the wizard
    kind: library # hand-written key
  # the web
  - id: web
    path: web
    language: typescript
`;

test("Workspace components: declare, correct and remove after the wizard wrote dependencies.manager, keeping comments and hand-written keys", async () => {
  await withProject({ "jgates.yml": ROOT, ".jgates/profiles.yml": PROFILES, ".jgates/workspace.yml": WORKSPACE, "services/api/pyproject.toml": '[project]\nname = "api"\n', "web/package.json": "{}\n" }, async ({ dir, call }) => {
    let settings = (await call("GET", "/api/workspace/settings")).json;
    assert.equal(settings.components.length, 2);
    const [api, web] = settings.components;

    // Correct: the entry goes back with its dependencies; only the framework changes.
    let r = await call("PUT", "/api/workspace/settings", { expectedRevision: settings.revision, components: [{ ...api, framework: "fastapi", dependencies: { manager: "uv" } }, web] });
    assert.equal(r.status, 200, r.text);
    let text = read(dir, ".jgates/workspace.yml");
    for (const keep of ["# Workspace of the project", "# mode comment", "# the api", "# the web", "manager: uv # written by the wizard", "kind: library # hand-written key"]) assert.ok(text.includes(keep), `${keep}\n${text}`);
    assert.match(text, /framework: fastapi/);

    // Declare a new one (appended).
    settings = r.json;
    r = await call("PUT", "/api/workspace/settings", { expectedRevision: settings.revision, components: [...settings.components, { id: "tools", path: "tools", language: "python", dependencies: { manager: "pip" } }] });
    assert.equal(r.status, 200, r.text);
    text = read(dir, ".jgates/workspace.yml");
    assert.match(text, /id: tools/);
    for (const keep of ["# the api", "# the web", "kind: library # hand-written key"]) assert.ok(text.includes(keep), `${keep}\n${text}`);

    // Rename an id in place keeps the entry (comments included).
    settings = r.json;
    r = await call("PUT", "/api/workspace/settings", { expectedRevision: settings.revision, components: settings.components.map((c) => (c.id === "web" ? { ...c, id: "frontend" } : c)) });
    assert.equal(r.status, 200, r.text);
    text = read(dir, ".jgates/workspace.yml");
    assert.match(text, /id: frontend/);
    assert.ok(!/id: web\b/.test(text));
    assert.ok(text.includes("# the web"), text);

    // Remove one.
    settings = r.json;
    r = await call("PUT", "/api/workspace/settings", { expectedRevision: settings.revision, components: settings.components.filter((c) => c.id !== "tools") });
    assert.equal(r.status, 200, r.text);
    text = read(dir, ".jgates/workspace.yml");
    assert.ok(!/id: tools/.test(text));
    for (const keep of ["# Workspace of the project", "# the api", "# the web", "manager: uv # written by the wizard", "kind: library # hand-written key"]) assert.ok(text.includes(keep), `${keep}\n${text}`);
  });
});

test("renaming a profile or a tool keeps the entry as written; a tool rename updates the tool:<old> selectors of the profiles", async () => {
  await withProject({ "jgates.yml": ROOT, ".jgates/profiles.yml": PROFILES, ".jgates/tools.yml": TOOLS }, async ({ dir, call }) => {
    const renamedTool = await call("PUT", "/api/tools/ruff-main", { name: "ruff-api" });
    assert.equal(renamedTool.status, 200, renamedTool.text);
    const tools = read(dir, ".jgates/tools.yml");
    for (const keep of ["# the python linter", "adapter: ruff # adapter comment", "# Tools of the project"]) assert.ok(tools.includes(keep), `${keep}\n${tools}`);
    assert.match(tools, /^ {2}ruff-api:/m);
    assert.ok(!/ruff-main/.test(tools));
    const profiles = read(dir, ".jgates/profiles.yml");
    assert.ok(profiles.includes("tool:ruff-api:\n        enabled: true # keep ruff"), profiles);
    assert.ok(!profiles.includes("tool:ruff-main"), profiles);

    const renamedProfile = await call("PUT", "/api/profiles/minimal/rename", { to: "base" });
    assert.equal(renamedProfile.status, 200, renamedProfile.text);
    const after = read(dir, ".jgates/profiles.yml");
    for (const keep of ["# Profiles of the project", "# why minimal exists", "label: Minimal # label comment", "enabled: true # keep ruff"]) assert.ok(after.includes(keep), `${keep}\n${after}`);
    assert.match(after, /^ {2}base:/m);
    assert.match(after, /extends: base/);
    assert.match(read(dir, "jgates.yml"), /profile: base # the default/);
  });
});

test("Execução: no runner in the API, and reverting the last override removes the empty execution block", async () => {
  const root = `${ROOT}# before execution
execution:
  concurrency: 2
# after execution
`;
  await withProject({ "jgates.yml": root, ".jgates/profiles.yml": PROFILES }, async ({ dir, call }) => {
    let view = await call("GET", "/api/config/execution");
    assert.equal(view.status, 200, view.text);
    assert.ok(!view.json.fields.some((f) => f.key === "runner"));
    const concurrency = view.json.fields.find((f) => f.key === "concurrency");
    assert.equal(concurrency.explicit, true);
    assert.equal(concurrency.value, 2);
    assert.equal(concurrency.default, 1);
    assert.equal(view.json.fields.find((f) => f.key === "network").explicit, false);

    const refused = await call("PUT", "/api/config/execution", { expectedRevision: view.json.revision, changes: { runner: "container" } });
    assert.equal(refused.status, 400, refused.text);

    const reverted = await call("PUT", "/api/config/execution", { expectedRevision: view.json.revision, changes: { concurrency: null } });
    assert.equal(reverted.status, 200, reverted.text);
    const text = read(dir, "jgates.yml");
    assert.ok(!/execution/.test(text.replace(/# (before|after) execution/g, "")), text);
    assert.ok(text.includes("# before execution") && text.includes("# after execution") && text.includes("# Root comment"), text);
    assert.equal(reverted.json.fields.find((f) => f.key === "concurrency").explicit, false);

    // A second revert of the same value changes nothing.
    const again = await call("PUT", "/api/config/execution", { expectedRevision: reverted.json.revision, changes: { concurrency: null } });
    assert.equal(again.status, 200, again.text);
    assert.equal(read(dir, "jgates.yml"), text);

    // One override of two: only that key goes.
    view = again;
    const set = await call("PUT", "/api/config/execution", { expectedRevision: view.json.revision, changes: { concurrency: 3 } });
    assert.equal(set.status, 200, set.text);
    const both = await call("PUT", "/api/config/execution", { expectedRevision: set.json.revision, changes: { failFast: true } });
    assert.equal(both.status, 200, both.text);
    const one = await call("PUT", "/api/config/execution", { expectedRevision: both.json.revision, changes: { concurrency: null } });
    assert.equal(one.status, 200, one.text);
    const kept = read(dir, "jgates.yml");
    assert.match(kept, /execution:\s*\n\s+failFast: true/);
    assert.ok(!/concurrency/.test(kept), kept);
  });
});
