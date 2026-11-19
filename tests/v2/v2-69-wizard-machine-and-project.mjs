import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-69 (fake engine): the first three steps of the wizard through the server API (PLAN-guided-flows.md section 2,
// PLAN-defects.md D26, D29).
//   - step 1: the requirements (engine running, memory, free disk on the engine's disk, CPUs), each with its measured
//     value and state; below the recommended they are warnings that do not block "Continuar";
//   - the runtime list (docker, podman, another executable): "Testar" asks an executable without saving it; the choice
//     is saved in the user's preferences.json (theme and language kept) and used by the next engine call of the server
//     and by the CLI of the same data folder; JGATES_CONTAINER_RUNTIME still wins, in the CLI and in the server;
//   - step 2: the tools image (name, version, download and disk size, each tool with version, licence and purpose, the
//     licences as THIRD_PARTY_NOTICES.md lists them) and each security database (name, source, size, used by), the
//     totals and the free space;
//   - step 3: each component with its root, a sentence in the language asked for, the evidence files, language,
//     framework, manager and lockfile with their states, and the managers of each language of the vocabulary (D26).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");

const made = [];
const tmp = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`jgates ui did not start:\n${ui.out}\n${ui.err}`));
    }, 60_000);
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
  if (ui && ui.proc.exitCode === null) {
    const exited = once(ui.proc, "exit");
    ui.proc.kill("SIGTERM");
    await exited;
  }
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

/** A fake engine runtime of its own (its own call log), with the given memory and CPUs. */
function fakeRuntime(dir, name, { memoryMb = 8192, cpus = 4 } = {}) {
  const state = path.join(dir, name);
  fs.mkdirSync(state, { recursive: true });
  const runtime = path.join(state, "docker.cjs");
  const log = path.join(state, "calls.jsonl");
  fs.writeFileSync(
    runtime,
    [
      `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(log)};`,
      `process.env.FAKE_DOCKER_STATE = ${JSON.stringify(state)};`,
      `process.env.FAKE_DOCKER_LABELS = "none";`,
      `process.env.FAKE_DOCKER_MEMORY_MB = ${JSON.stringify(String(memoryMb))};`,
      `process.env.FAKE_DOCKER_CPUS = ${JSON.stringify(String(cpus))};`,
      `require(${JSON.stringify(FAKE)});`,
      ``,
    ].join("\n"),
  );
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { runtime, calls, infos: () => calls().filter((c) => c[0] === "info").length };
}

/** The licence column of the "Tools shipped in the tools image" table, without the parenthesised notes. */
function noticeLicences() {
  const text = fs.readFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  const section = text.slice(text.indexOf("## Tools shipped in the tools image"));
  const out = new Map();
  for (const line of section.split("\n")) {
    const m = /^\| `([^`]+)` \| (.+?) \| <http/.exec(line);
    if (m) out.set(m[1], m[2].replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim());
  }
  return out;
}

test("V2-69: the wizard's steps 1 to 3 give the machine's requirements, the runtime choice, what is downloaded and the project in words", async () => {
  const home = tmp("v2-69-home-");
  const project = tmp("v2-69-project-");
  const engines = tmp("v2-69-engine-");
  // A: the runtime chosen before, with too little memory and one CPU. B: the one the person picks in the wizard.
  const a = fakeRuntime(engines, "a", { memoryMb: 2048, cpus: 1 });
  const b = fakeRuntime(engines, "b");
  fs.writeFileSync(path.join(home, "preferences.json"), `${JSON.stringify({ schemaVersion: 1, theme: "dark", language: "en", containerRuntime: a.runtime }, null, 2)}\n`);
  // Two components: a Python one with its lockfile, a JavaScript one without.
  fs.mkdirSync(path.join(project, "api"));
  fs.writeFileSync(path.join(project, "api", "pyproject.toml"), '[project]\nname = "api"\nversion = "0.1.0"\nrequires-python = ">=3.12"\n');
  fs.writeFileSync(path.join(project, "api", "uv.lock"), 'version = 1\nrequires-python = ">=3.12"\n');
  fs.writeFileSync(path.join(project, "api", "main.py"), "print('hi')\n");
  fs.mkdirSync(path.join(project, "web"));
  fs.writeFileSync(path.join(project, "web", "package.json"), JSON.stringify({ name: "web", version: "1.0.0", dependencies: { express: "^4.0.0" } }, null, 2));
  fs.writeFileSync(path.join(project, "web", "index.js"), "console.log('hi');\n");

  const base = { ...process.env, JGATES_HOME: home, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" };
  delete base.JGATES_CONTAINER_RUNTIME;

  let ui = null;
  let second = null;
  try {
    ui = await startUi(base, project);
    const call = await session(ui);

    // ---- step 1: the requirements, measured, the low ones as warnings ----------------------------------------------
    const check = await call("GET", "/api/setup/docker?locale=en");
    assert.equal(check.status, 200, check.text);
    assert.equal(check.json.ready, true, JSON.stringify(check.json));
    assert.deepEqual(check.json.requirements.map((r) => r.id), ["engine", "memory", "disk", "cpus"]);
    const req = Object.fromEntries(check.json.requirements.map((r) => [r.id, r]));
    assert.equal(req.engine.state, "ok");
    assert.equal(req.engine.value, "27.0.1-fake");
    assert.equal(req.engine.blocking, true);
    assert.equal(req.memory.state, "warn");
    assert.equal(req.memory.value, 2048);
    assert.equal(req.memory.need, 8192);
    assert.equal(req.memory.blocking, false);
    assert.match(req.memory.message, /2 GB of memory.*8 GB recommended/);
    assert.equal(req.cpus.state, "warn");
    assert.equal(req.cpus.value, 1);
    assert.equal(req.cpus.need, 2);
    assert.match(req.cpus.message, /^1 CPU for the engine; 2 recommended/);
    assert.equal(typeof req.disk.value, "number", "the free disk is measured");
    assert.equal(req.disk.need, 15 * 1024);
    assert.ok(["ok", "warn"].includes(req.disk.state), req.disk.state);
    const pt = await call("GET", "/api/setup/docker?locale=pt-BR");
    assert.match(pt.json.requirements.find((r) => r.id === "memory").message, /de memória para o motor; 8 GB recomendados/);
    // Warnings do not block: "Continuar" goes to step 2.
    const advanced = await call("POST", "/api/setup/advance", { step: "docker", locale: "en" });
    assert.equal(advanced.status, 200, advanced.text);
    assert.equal(advanced.json.setup.step, "tools");

    // ---- the runtime: the list, "Testar", the saved choice --------------------------------------------------------
    assert.equal(check.json.runtime.source, "preference");
    assert.equal(check.json.runtime.selected, "custom");
    assert.equal(check.json.runtime.path, a.runtime);
    assert.equal(check.json.runtime.envOverride, null);
    assert.deepEqual(check.json.runtime.options.map((o) => o.id), ["docker", "podman", "custom"]);
    assert.ok(a.infos() > 0, "the preferred runtime answered the server");
    assert.equal(b.infos(), 0);

    const tested = await call("POST", "/api/setup/runtime/test", { path: b.runtime, locale: "en" });
    assert.equal(tested.status, 200, tested.text);
    assert.equal(tested.json.ok, true, JSON.stringify(tested.json));
    assert.equal(tested.json.version, "27.0.1-fake");
    assert.ok(b.infos() > 0, "Testar asked the executable");
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, "preferences.json"), "utf8")).containerRuntime, a.runtime, "Testar saves nothing");
    const missing = await call("POST", "/api/setup/runtime/test", { path: path.join(engines, "nothing-here"), locale: "pt-BR" });
    assert.equal(missing.status, 200, missing.text);
    assert.equal(missing.json.ok, false);
    assert.match(missing.json.message, /Nenhum executável respondeu/);
    const relative = await call("PUT", "/api/setup/runtime", { runtime: "custom", path: "docker.cjs" });
    assert.equal(relative.status, 422, relative.text);
    assert.equal(relative.json.code, "RUNTIME_PATH_INVALID");
    const absent = await call("PUT", "/api/setup/runtime", { runtime: "custom", path: path.join(engines, "nothing-here") });
    assert.equal(absent.status, 422, absent.text);

    const saved = await call("PUT", "/api/setup/runtime", { runtime: "custom", path: b.runtime, locale: "en" });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.runtime.current, b.runtime);
    assert.equal(saved.json.runtime.source, "preference");
    const prefs = JSON.parse(fs.readFileSync(path.join(home, "preferences.json"), "utf8"));
    assert.deepEqual(prefs, { schemaVersion: 1, theme: "dark", language: "en", containerRuntime: b.runtime }, "the other preferences are kept");
    // The theme route keeps the runtime too.
    const theme = await call("PUT", "/api/preferences", { theme: "light" });
    assert.equal(theme.status, 200, theme.text);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, "preferences.json"), "utf8")).containerRuntime, b.runtime);

    // The next engine call of the server uses B.
    const aBefore = a.infos();
    const bBefore = b.infos();
    const again = await call("GET", "/api/setup/docker?locale=en");
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.runtime.current, b.runtime);
    assert.ok(b.infos() > bBefore, "the server asked the chosen runtime");
    assert.equal(a.infos(), aBefore, "the previous runtime was not asked");
    assert.equal(again.json.requirements.find((r) => r.id === "memory").state, "ok", "B has 8 GB");

    // The CLI of the same data folder uses the choice; JGATES_CONTAINER_RUNTIME still wins over it.
    const cli = spawnSync(process.execPath, [MAIN, "status", "--json"], { cwd: project, env: base, encoding: "utf8", timeout: 120_000 });
    assert.ok(cli.stdout.trim().startsWith("{"), `${cli.stdout}\n${cli.stderr}`);
    assert.equal(JSON.parse(cli.stdout).engine.runtime, b.runtime);
    const aCli = a.infos();
    const overridden = spawnSync(process.execPath, [MAIN, "status", "--json"], { cwd: project, env: { ...base, JGATES_CONTAINER_RUNTIME: a.runtime }, encoding: "utf8", timeout: 120_000 });
    assert.equal(JSON.parse(overridden.stdout).engine.runtime, a.runtime, overridden.stderr);
    assert.ok(a.infos() > aCli, "the variable's runtime answered the CLI");

    // ---- step 2: what is downloaded ------------------------------------------------------------------------------
    const tools = await call("GET", "/api/setup/tools?locale=en");
    assert.equal(tools.status, 200, tools.text);
    const image = tools.json.image;
    assert.equal(image.name, "jgates-tools");
    assert.equal(typeof image.version, "string");
    assert.ok(image.downloadBytes > 0 && image.diskBytes > image.downloadBytes, JSON.stringify({ d: image.downloadBytes, s: image.diskBytes }));
    const release = JSON.parse(fs.readFileSync(path.join(root, "jgates", "release", "image-tools.json"), "utf8"));
    assert.deepEqual(image.tools.map((x) => x.name), Object.keys(release.tools).sort((x, y) => x.localeCompare(y, "en")));
    const licences = noticeLicences();
    for (const tool of image.tools) {
      assert.equal(tool.version, release.tools[tool.name], tool.name);
      assert.ok(licences.has(tool.name), `${tool.name} is not in THIRD_PARTY_NOTICES.md`);
      assert.equal(tool.license, licences.get(tool.name), `licence of ${tool.name}`);
      assert.ok(tool.purpose && tool.purposeText && tool.purposeText.length > 5, `purpose of ${tool.name}`);
    }
    assert.equal(image.tools.find((x) => x.name === "ruff").purposeText, "Finds bugs and style problems");
    const databases = tools.json.data.databases;
    assert.deepEqual(databases.map((d) => d.id), ["trivy", "osv", "govulndb", "rustsec", "grype", "kubescape"]);
    for (const d of databases) {
      assert.ok(d.name.length > 2 && d.source.length > 5 && d.sizeBytes > 0 && d.usedBy.length > 2, JSON.stringify(d));
      assert.equal(d.state, "missing", "no data before the image");
    }
    assert.equal(databases.find((d) => d.id === "trivy").usedBy, "Trivy");
    const dataBytes = databases.reduce((sum, d) => sum + d.sizeBytes, 0);
    assert.equal(tools.json.totals.downloadBytes, image.downloadBytes + dataBytes);
    assert.equal(tools.json.totals.diskBytes, image.diskBytes + dataBytes);
    assert.equal(tools.json.totals.pendingDiskBytes, image.diskBytes + dataBytes, "nothing is on the machine yet");
    assert.equal(typeof tools.json.disk.freeMb, "number");
    assert.equal(tools.json.disk.freeBytes, tools.json.disk.freeMb * 1024 * 1024);
    const toolsPt = await call("GET", "/api/setup/tools?locale=pt-BR");
    assert.equal(toolsPt.json.image.tools.find((x) => x.name === "ruff").purposeText, "Encontra erros e problemas de estilo");

    // ---- step 3: the project in words ----------------------------------------------------------------------------
    for (const [locale, words] of [["en", { py: /^Python project in the folder api$/, js: /^JavaScript project with Express in the folder web$/ }], ["pt-BR", { py: /^Projeto Python na pasta api$/, js: /^Projeto JavaScript com Express na pasta web$/ }]]) {
      const info = await call("GET", `/api/setup/project?locale=${locale}`);
      assert.equal(info.status, 200, info.text);
      const byRoot = Object.fromEntries(info.json.components.map((c) => [c.root, c]));
      const py = byRoot.api;
      const js = byRoot.web;
      assert.ok(py && js, JSON.stringify(info.json.components.map((c) => c.root)));
      assert.match(py.sentence, words.py);
      assert.match(js.sentence, words.js);
      for (const c of info.json.components) assert.notEqual(c.sentence.trim(), ".", "never a bare dot");
      assert.ok(py.evidence.includes("api/pyproject.toml"), JSON.stringify(py.evidence));
      assert.equal(py.language, "python");
      assert.deepEqual(py.fields.language, { state: "detected", reason: null });
      assert.equal(py.fields.framework.state, "none");
      assert.equal(py.dependencies.manager, "uv");
      assert.equal(py.fields.manager.state, "detected");
      assert.equal(py.dependencies.lockfile, "api/uv.lock");
      assert.equal(py.fields.lockfile.state, "found");
      assert.equal(js.language, "javascript");
      assert.equal(js.framework, "express");
      assert.equal(js.fields.framework.state, "detected");
      assert.equal(js.dependencies.manager, "npm");
      assert.equal(js.fields.lockfile.state, "missing");
      assert.ok(js.fields.lockfile.reason.length > 10);
      // The managers follow the chosen language (D26).
      const managers = Object.fromEntries(info.json.vocabulary.map((l) => [l.id, l.managers]));
      assert.deepEqual(managers.python, ["uv", "poetry", "pdm", "pipenv", "pip"]);
      assert.deepEqual(managers.typescript, ["npm", "pnpm", "yarn", "bun"]);
      assert.deepEqual(managers.javascript, ["npm", "pnpm", "yarn", "bun"]);
      assert.deepEqual(managers.go, ["go"]);
      assert.deepEqual(managers.rust, ["cargo"]);
      assert.ok(info.json.vocabulary.some((l) => l.managers.length === 0), "a language without a manager has none");
    }

    // ---- JGATES_CONTAINER_RUNTIME wins in the server too ---------------------------------------------------------
    // A server of another project (one of the same project would be joined, not started).
    const other = tmp("v2-69-other-");
    fs.writeFileSync(path.join(other, "mod.py"), "import os\n");
    second = await startUi({ ...base, JGATES_CONTAINER_RUNTIME: a.runtime }, other);
    const call2 = await session(second);
    const aBefore2 = a.infos();
    const env = await call2("GET", "/api/setup/docker?locale=en");
    assert.equal(env.status, 200, env.text);
    assert.equal(env.json.runtime.source, "env");
    assert.equal(env.json.runtime.envOverride, a.runtime);
    assert.equal(env.json.runtime.current, a.runtime);
    assert.ok(a.infos() > aBefore2, "the variable's runtime answered the server");
    // Nothing was pulled, created or run by these steps.
    for (const used of [...a.calls(), ...b.calls()]) assert.ok(!["pull", "run", "load", "create"].includes(used[0]) && !(used[0] === "volume" && used[1] === "create"), JSON.stringify(used));
  } finally {
    await stopUi(ui);
    await stopUi(second);
  }
});
