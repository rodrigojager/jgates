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

// Invalid configuration: the error has file and line, what was typed survives in a draft in the data
// folder (the project file does not change until the save), a deliberately saved invalid file blocks the next plan, and
// a run uses exactly the version of the document the person chose (checked by the document hash in the plan).

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const RUFF = path.join(VENV_BIN, process.platform === "win32" ? "ruff.exe" : "ruff");
const drafts = await import(pathToFileURL(path.join(dist, "core", "drafts", "index.js")).href);
const { tomlStructuredAvailable } = await import(pathToFileURL(path.join(dist, "core", "codecs", "toml", "index.js")).href);
if (!process.env.JGATES_PYTHON && fs.existsSync(PYTHON)) process.env.JGATES_PYTHON = PYTHON;

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const PYPROJECT = `[project]
name = "demo"
version = "0.1.0"

[tool.pytest.ini_options]
addopts = "-q"

[tool.ruff.lint]
select = ["E", "F"]
`;
const MODULE = "import os\n\n\ndef check(value):\n    return value == None\n";
// The error is inside the Ruff section: the list is never closed (line 9 of the file below).
const BROKEN = PYPROJECT.replace('select = ["E", "F"]', 'select = ["E", "F"');
const BROKEN_LINE = 9;
const VALID_EDIT = PYPROJECT.replace('select = ["E", "F"]', 'select = ["E", "F"]\nignore = ["F401"]');

function project() {
  const dir = tmp("jg-inv-ws-");
  const home = tmp("jg-inv-home-");
  const emptyBin = tmp("jg-inv-bin-");
  fs.mkdirSync(path.join(dir, "demo"));
  fs.writeFileSync(path.join(dir, "pyproject.toml"), PYPROJECT);
  fs.writeFileSync(path.join(dir, "demo", "__init__.py"), "");
  fs.writeFileSync(path.join(dir, "demo", "mod.py"), MODULE);
  const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON, JGATES_RUFF: RUFF, PATH: emptyBin };
  const init = spawnSync(process.execPath, [MAIN, "init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"], { env, encoding: "utf8", timeout: 120_000 });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  ruff:\n    adapter: ruff\n    config: pyproject.toml\n");
  return {
    dir,
    home,
    env,
    pyproject: path.join(dir, "pyproject.toml"),
    cleanup() {
      for (const d of [dir, home, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

function startUi(p) {
  const proc = spawn(process.execPath, [MAIN, "ui", "--cwd", p.dir, "--no-open", "--port", "0", "--json"], { env: p.env, stdio: ["ignore", "pipe", "pipe"] });
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

function raw(port, method, p, { headers = {}, body } = {}) {
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

async function withServer(fn) {
  assert.ok(tomlStructuredAvailable(), "Python with tomlkit not found: create the .venv (python3 -m venv .venv && .venv/bin/pip install -e quality-gate) or set JGATES_PYTHON");
  assert.ok(fs.existsSync(RUFF), "ruff is not installed in the repository .venv: run `npm --prefix jgates run setup:dev-tools`");
  const p = project();
  let ui = null;
  try {
    ui = await startUi(p);
    const html = fs.readFileSync(ui.info.launcher, "utf8");
    const href = /href="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
    const url = new URL(href);
    const boot = await raw(ui.info.port, "GET", url.pathname + url.search);
    assert.equal(boot.status, 200, boot.text);
    const cookie = String(boot.headers["set-cookie"]?.[0] ?? "").split(";")[0];
    const session = await raw(ui.info.port, "GET", "/api/session", { headers: { Cookie: cookie } });
    const origin = `http://127.0.0.1:${ui.info.port}`;
    const call = (method, p2, body) =>
      raw(ui.info.port, method, p2, { headers: { Cookie: cookie, ...(method === "GET" ? {} : { Origin: origin, "X-JGates-CSRF": session.json.csrfToken }) }, ...(body !== undefined ? { body } : {}) });
    await fn({ ...p, ui, call, wsId: ui.info.workspace.id });
  } finally {
    await stopUi(ui);
    p.cleanup();
  }
}

const planOnlyRuff = (call) => call("POST", "/api/plans", { only: ["tool:ruff"] });

async function runAndWait(call, planHash) {
  const started = await call("POST", "/api/runs", { planHash });
  assert.equal(started.status, 202, started.text);
  const id = started.json.run.id;
  for (let i = 0; i < 240; i++) {
    const r = await call("GET", `/api/runs/${id}`);
    if (r.json.run.state !== "running") return r.json.run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("the run did not finish");
}

test("the text typed over a broken Ruff section is kept as a draft in the data folder and the project file does not change", async () => {
  await withServer(async ({ call, home, wsId, pyproject, dir }) => {
    const before = fs.readFileSync(pyproject);
    // The error comes with the line, validated from the text (nothing is written).
    const check = await call("POST", "/api/documents/ruff/config/validate", { text: BROKEN });
    assert.equal(check.status, 200, check.text);
    assert.equal(check.json.validation.status, "invalid");
    assert.equal(check.json.validation.errors[0].line, BROKEN_LINE, JSON.stringify(check.json.validation.errors));

    const opened = await call("GET", "/api/documents/ruff/config");
    const saved = await call("PUT", "/api/drafts/ruff/config", { text: BROKEN, baseRevision: opened.json.document.revision });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.saved, true);

    // In the data folder, private, and nowhere in the project.
    const folder = path.join(home, "workspaces", wsId, "drafts");
    const files = fs.readdirSync(folder).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(folder, files[0])).mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(pyproject), before, "the project file is untouched");
    assert.ok(!fs.readdirSync(dir).some((f) => /draft/i.test(f)), "no draft file in the project");

    // "Reload": a new read gives back the typed text, with the error and its line.
    const again = await call("GET", "/api/drafts/ruff/config");
    assert.equal(again.json.draft.text, BROKEN);
    assert.equal(again.json.draft.baseRevision, opened.json.document.revision);
    assert.equal(again.json.draft.validation.status, "invalid");
    assert.equal(again.json.draft.validation.errors[0].line, BROKEN_LINE);
    assert.equal(drafts.listDrafts(home, wsId)[0].text, BROKEN, "the core reads the same draft");

    // A text equal to the disk is not a draft.
    const same = await call("PUT", "/api/drafts/ruff/config", { text: PYPROJECT, baseRevision: opened.json.document.revision });
    assert.equal(same.json.saved, false);
    assert.equal((await call("GET", "/api/drafts/ruff/config")).json.draft, null);
    assert.deepEqual(fs.readFileSync(pyproject), before);

    // Discarding removes it.
    await call("PUT", "/api/drafts/ruff/config", { text: BROKEN, baseRevision: opened.json.document.revision });
    const gone = await call("DELETE", "/api/drafts/ruff/config");
    assert.equal(gone.json.removed, true);
    assert.deepEqual(fs.readdirSync(folder).filter((f) => f.endsWith(".json")), []);
  });
});

test("saving an invalid file on purpose blocks the next plan with the file and the line; a valid one unblocks it", async () => {
  await withServer(async ({ call, pyproject }) => {
    const good = await planOnlyRuff(call);
    assert.equal(good.status, 201, good.text);
    assert.equal(good.json.approvable, true, JSON.stringify(good.json.plan.blockers));

    const opened = await call("GET", "/api/documents/ruff/config");
    // Without the explicit choice the save is refused and nothing is written.
    const refused = await call("PUT", "/api/documents/ruff/config", { expectedRevision: opened.json.document.revision, text: BROKEN });
    assert.equal(refused.status, 422, refused.text);
    assert.equal(fs.readFileSync(pyproject, "utf8"), PYPROJECT);

    const saved = await call("PUT", "/api/documents/ruff/config", { expectedRevision: opened.json.document.revision, text: BROKEN, allowInvalid: true });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(fs.readFileSync(pyproject, "utf8"), BROKEN);

    const blocked = await planOnlyRuff(call);
    assert.equal(blocked.status, 201, blocked.text);
    assert.equal(blocked.json.approvable, false);
    const blocker = blocked.json.plan.blockers.find((b) => b.code === "CONFIG_INVALID");
    assert.ok(blocker, JSON.stringify(blocked.json.plan.blockers));
    assert.match(blocker.message, new RegExp(`pyproject\\.toml:${BROKEN_LINE}`));
    assert.deepEqual(blocker.items, ["ruff"]);
    // Executar is refused for that plan.
    const run = await call("POST", "/api/runs", { planHash: blocked.json.planHash });
    assert.equal(run.status, 422);
    assert.equal(run.json.code, "PLAN_NOT_APPROVABLE");

    // Fixing the file unblocks the plan.
    const fresh = await call("GET", "/api/documents/ruff/config");
    await call("PUT", "/api/documents/ruff/config", { expectedRevision: fresh.json.document.revision, text: PYPROJECT });
    const ok = await planOnlyRuff(call);
    assert.equal(ok.json.approvable, true, JSON.stringify(ok.json.plan.blockers));
  });
});

test("an unsaved edit of a document the plan uses: use the saved version or save it, and the run uses exactly that one (hash in the plan)", async () => {
  await withServer(async ({ call, home, pyproject, wsId }) => {
    const savedBytes = fs.readFileSync(pyproject);
    const opened = await call("GET", "/api/documents/ruff/config");
    await call("PUT", "/api/drafts/ruff/config", { text: VALID_EDIT, baseRevision: opened.json.document.revision });

    const planA = await planOnlyRuff(call);
    assert.equal(planA.json.approvable, true, JSON.stringify(planA.json.plan.blockers));
    const hashA = planA.json.planHash;
    const entryA = planA.json.plan.inputs.configFiles.find((f) => f.file === "pyproject.toml");
    assert.equal(entryA.sha256, `sha256:${sha(savedBytes)}`, "the plan names the saved version, not the draft");

    // The review lists the pending draft with the hash the plan has for the document.
    const offers = await call("GET", `/api/drafts?plan=${encodeURIComponent(hashA)}`);
    assert.equal(offers.status, 200, offers.text);
    assert.equal(offers.json.drafts.length, 1);
    const offer = offers.json.drafts[0];
    assert.equal(offer.usedByPlan, true);
    assert.equal(offer.planSha256, entryA.sha256);
    assert.equal(offer.relPath, "pyproject.toml");
    assert.match(offer.diff, /\+ignore = \["F401"\]/);

    // Use the saved version: the run executes plan A, the file on disk is still the saved one, and the draft is kept.
    const runA = await runAndWait(call, hashA);
    assert.equal(runA.state, "finished", JSON.stringify(runA));
    const resultA = JSON.parse(fs.readFileSync(path.join(home, "workspaces", wsId, "runs", runA.runId, "result.json"), "utf8"));
    assert.equal(resultA.selection.planHash, hashA);
    const planFileA = JSON.parse(fs.readFileSync(path.join(home, "workspaces", wsId, "runs", runA.runId, "plan.json"), "utf8"));
    assert.equal(planFileA.inputs.configFiles.find((f) => f.file === "pyproject.toml").sha256, `sha256:${sha(savedBytes)}`);
    assert.deepEqual(fs.readFileSync(pyproject), savedBytes);
    assert.equal(resultA.findings.filter((f) => /F401/.test(JSON.stringify(f))).length > 0, true, "the saved version does not ignore F401");
    assert.equal((await call("GET", "/api/drafts/ruff/config")).json.draft.text, VALID_EDIT);

    // Save the draft: the file becomes the draft, the draft is gone and the next plan names the new hash.
    const save = await call("POST", "/api/drafts/ruff/config/save", {});
    assert.equal(save.status, 200, save.text);
    assert.equal(save.json.save.status, "saved");
    assert.equal(fs.readFileSync(pyproject, "utf8"), VALID_EDIT);
    assert.equal((await call("GET", "/api/drafts/ruff/config")).json.draft, null);
    assert.deepEqual((await call("GET", "/api/drafts")).json.drafts, []);

    const planB = await planOnlyRuff(call);
    assert.notEqual(planB.json.planHash, hashA);
    const hashB = planB.json.planHash;
    const entryB = planB.json.plan.inputs.configFiles.find((f) => f.file === "pyproject.toml");
    assert.equal(entryB.sha256, `sha256:${sha(fs.readFileSync(pyproject))}`);
    const runB = await runAndWait(call, hashB);
    assert.equal(runB.state, "finished", JSON.stringify(runB));
    const resultB = JSON.parse(fs.readFileSync(path.join(home, "workspaces", wsId, "runs", runB.runId, "result.json"), "utf8"));
    assert.equal(resultB.selection.planHash, hashB);
    assert.equal(resultB.findings.filter((f) => /F401/.test(JSON.stringify(f))).length, 0, "the saved draft ignores F401");
  });
});

test("a draft typed over an older revision is saved as a conflict, never over the newer file", async () => {
  await withServer(async ({ call, pyproject }) => {
    const opened = await call("GET", "/api/documents/ruff/config");
    await call("PUT", "/api/drafts/ruff/config", { text: VALID_EDIT, baseRevision: opened.json.document.revision });
    const external = PYPROJECT.replace('"-q"', '"-qq"');
    fs.writeFileSync(pyproject, external);
    const status = await call("GET", "/api/drafts/ruff/config");
    assert.equal(status.json.draft.stale, true);
    const save = await call("POST", "/api/drafts/ruff/config/save", {});
    assert.equal(save.status, 409, save.text);
    assert.equal(save.json.code, "REVISION_CONFLICT");
    assert.equal(fs.readFileSync(pyproject, "utf8"), external, "the newer file is kept");
    assert.equal((await call("GET", "/api/drafts/ruff/config")).json.draft.text, VALID_EDIT, "the draft is kept too");
  });
});
