import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-70 (fake engine): the wizard's profile step embeds the profile editor and works on a draft (ADR-0008,
// PLAN-guided-flows.md section 2 step 4, PLAN-defects.md D10), on a project without jgates.yml:
//   - the step returns every profile of the draft (the three starters) with its plan count in the unit the rest of the
//     UI uses ("steps", the same number the plan gives), by category in the strip's order, and a mascot snapshot;
//   - one profile of the draft reads as Configuração > Perfil reads it (categories in one fixed order, editable);
//   - a switch changes the draft and the counts the step returns, and the mascots of the selected profile follow it;
//   - a profile is created from another one and customized, all before any configuration file exists;
//   - nothing is written to the project until the step is confirmed; then jgates.yml and .jgates/profiles.yml hold
//     exactly the draft (the files the preview showed), and the plan of the chosen profile counts what the step said.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const ORDER = ["quality", "security", "dependencies", "tests", "architecture", "infrastructure", "custom"];

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

/** Every file of the project with its bytes (what "nothing is written" compares). */
function snapshot(dir) {
  const out = new Map();
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else out.set(child, fs.readFileSync(path.join(dir, child), "utf8"));
    }
  };
  walk("");
  return out;
}

/** The changes the category switch sends to turn a category off: the category and each capability that is on. */
function categoryOff(view, id) {
  const category = view.categories.find((c) => c.id === id);
  assert.ok(category, `category ${id} in ${view.categories.map((c) => c.id)}`);
  return [{ selector: category.selector, enabled: false }, ...category.capabilities.filter((c) => c.enabled && c.locked.length === 0).map((c) => ({ selector: c.selector, enabled: false }))];
}

const countOf = (profiles, id) => profiles.find((p) => p.id === id);
const categoryCount = (profile, id) => profile.categories.find((c) => c.id === id)?.count ?? 0;

test("V2-70: the wizard's profile step edits a draft (switches, a new profile) and writes it only when confirmed", async () => {
  const home = tmp("v2-70-home-");
  const project = tmp("v2-70-project-");
  const engine = tmp("v2-70-engine-");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(
    runtime,
    [`process.env.FAKE_DOCKER_LOG = ${JSON.stringify(path.join(engine, "calls.jsonl"))};`, `process.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};`, `process.env.FAKE_DOCKER_LABELS = "none";`, `require(${JSON.stringify(FAKE)});`, ``].join("\n"),
  );
  // A Python project with its dependencies and a secret-looking file: security, quality and dependencies have checks.
  fs.writeFileSync(path.join(project, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\nrequires-python = ">=3.11"\n');
  fs.writeFileSync(path.join(project, "requirements.txt"), "requests==2.31.0\n");
  fs.mkdirSync(path.join(project, "app"));
  fs.writeFileSync(path.join(project, "app", "__init__.py"), "");
  fs.writeFileSync(path.join(project, "app", "main.py"), "def add(a, b):\n    return a + b\n");
  const env = { ...process.env, JGATES_HOME: home, JGATES_IMAGE_JSON: "", JGATES_CONTAINER_RUNTIME: runtime, JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" };

  let ui = null;
  try {
    ui = await startUi(env, project);
    const call = await session(ui);
    for (const step of ["docker", "tools", "project"]) {
      const answer = await call("POST", "/api/setup/advance", { step, locale: "en", ...(step === "project" ? { services: { use: false } } : {}) });
      assert.equal(answer.status, 200, answer.text);
    }
    const before = snapshot(project);
    const untouched = (when) => {
      assert.deepEqual([...snapshot(project).keys()].sort(), [...before.keys()].sort(), `${when}: no file was added to the project`);
      for (const [file, text] of before) assert.equal(fs.readFileSync(path.join(project, file), "utf8"), text, `${when}: ${file} is unchanged`);
    };

    // ---- the step: every profile of the draft with its count, in the plan's unit, and the mascots ------------------
    const first = await call("GET", "/api/setup/profiles");
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(first.json.profiles.map((p) => p.id), ["minimal", "standard", "strict"]);
    assert.equal(first.json.draft.mode, "new");
    assert.equal(first.json.selected, first.json.recommended, "the recommended profile is preselected");
    assert.deepEqual(first.json.categoryOrder, ORDER);
    for (const p of first.json.profiles) {
      assert.equal(p.error, null, `${p.id}: ${p.error}`);
      assert.equal(p.unit, "steps", "the count is in plan steps, like the plan and the profile's plan view");
      assert.equal(p.starter, true);
      assert.ok(p.total > 0, `${p.id} runs something`);
      assert.equal(p.categories.reduce((n, c) => n + c.count, 0), p.total, `${p.id}: the categories add up`);
      const ids = p.categories.map((c) => c.id);
      assert.deepEqual(ids, [...ids].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)), `${p.id}: categories in the strip's order`);
    }
    assert.equal(first.json.mascots.context, "configuration");
    assert.deepEqual(first.json.mascots.domains.map((d) => d.domain), ORDER.slice(0, 6));
    assert.equal(first.json.plan.profile.id, first.json.selected, "the capability states are the selected profile's");
    assert.equal(first.json.plan.counts.unit, "steps");
    assert.equal(first.json.plan.counts.steps, countOf(first.json.profiles, first.json.selected).total, "one number per profile");
    untouched("reading the step");

    // ---- one profile as Configuração > Perfil shows it ------------------------------------------------------------
    const standardView = await call("GET", "/api/setup/profile?profile=standard");
    assert.equal(standardView.status, 200, standardView.text);
    assert.deepEqual(standardView.json.categories.map((c) => c.id), ORDER, "categories in one fixed order");
    assert.deepEqual(standardView.json.categories.slice(0, 6).map((c) => c.label), ["Quality", "Security", "Dependencies", "Tests", "Architecture", "Infrastructure"]);
    assert.equal(standardView.json.profile.editable, true, "the draft's starter profiles are the project's, so they can be edited");
    assert.equal(standardView.json.counts.unit, "capabilities", "the view names its own unit");

    // ---- a switch changes the draft and the counts ---------------------------------------------------------------
    const standardBefore = countOf(first.json.profiles, "standard");
    const securityBefore = categoryCount(standardBefore, "security");
    assert.ok(securityBefore > 0, `standard runs security checks here: ${JSON.stringify(standardBefore.categories)}`);
    const chosen = await call("PUT", "/api/setup/profile/choice", { profile: "standard" });
    assert.equal(chosen.status, 200, chosen.text);
    assert.equal(chosen.json.selected, "standard");
    const switched = await call("PUT", "/api/setup/profile/selection", { profile: "standard", changes: categoryOff(standardView.json, "security") });
    assert.equal(switched.status, 200, switched.text);
    assert.equal(switched.json.view.categories.find((c) => c.id === "security").enabled, false, "the answer carries the updated view");
    const afterSwitch = await call("GET", "/api/setup/profiles");
    assert.equal(afterSwitch.status, 200, afterSwitch.text);
    assert.equal(afterSwitch.json.selected, "standard");
    assert.equal(afterSwitch.json.draft.chosen, true);
    assert.equal(afterSwitch.json.draft.edited, true);
    const standardAfter = countOf(afterSwitch.json.profiles, "standard");
    assert.equal(categoryCount(standardAfter, "security"), 0, "no security check runs any more");
    assert.equal(standardAfter.total, standardBefore.total - securityBefore, "the count follows the switch");
    assert.equal(afterSwitch.json.mascots.domains.find((d) => d.domain === "security").selection, "disabled", "the mascots follow the selection");
    assert.notEqual(afterSwitch.json.mascots.planHash, first.json.mascots.planHash);
    untouched("a switch");

    // ---- a profile created from another one and customized -------------------------------------------------------
    const created = await call("POST", "/api/setup/profile", { id: "rapido", from: "standard", label: "Rápido", description: "Only what is quick." });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.view.profile.ref, "rapido");
    assert.equal(created.json.view.profile.editable, true);
    const taken = await call("POST", "/api/setup/profile", { id: "rapido", from: "minimal" });
    assert.equal(taken.status, 409, taken.text);
    assert.equal(taken.json.code, "PROFILE_EXISTS");
    const quality = created.json.view.categories.find((c) => c.id === "quality");
    const qualityOn = quality.capabilities.find((c) => c.enabled);
    assert.ok(qualityOn, JSON.stringify(quality.capabilities.map((c) => [c.id, c.enabled])));
    const customized = await call("PUT", "/api/setup/profile/selection", { profile: "rapido", changes: [{ selector: qualityOn.selector, enabled: false }] });
    assert.equal(customized.status, 200, customized.text);
    const picked = await call("PUT", "/api/setup/profile/choice", { profile: "rapido" });
    assert.equal(picked.status, 200, picked.text);
    const withNew = await call("GET", "/api/setup/profiles");
    assert.deepEqual(withNew.json.profiles.map((p) => p.id), ["minimal", "standard", "strict", "rapido"]);
    const rapido = countOf(withNew.json.profiles, "rapido");
    assert.equal(rapido.label, "Rápido");
    assert.equal(rapido.extends, "standard");
    assert.equal(rapido.starter, false);
    assert.equal(rapido.unit, "steps");
    assert.equal(rapido.error, null, rapido.error);
    assert.ok(rapido.total < standardAfter.total, `rapido runs less than standard (${rapido.total} < ${standardAfter.total})`);
    assert.equal(categoryCount(rapido, "security"), 0, "rapido inherits standard's switches from the draft");
    assert.equal(withNew.json.selected, "rapido");
    assert.equal(withNew.json.plan.profile.id, "rapido");
    untouched("creating and customizing a profile");

    // ---- confirmed: the project holds exactly the draft ----------------------------------------------------------
    const preview = await call("POST", "/api/setup/config/preview", {});
    assert.equal(preview.status, 200, preview.text);
    const draftFiles = Object.fromEntries(preview.json.files.map((f) => [f.file, f.text]));
    assert.deepEqual(Object.keys(draftFiles).sort(), [".jgates/profiles.yml", "jgates.yml"]);
    assert.match(draftFiles["jgates.yml"], /profile: rapido/);
    assert.match(draftFiles[".jgates/profiles.yml"], /rapido:/);
    untouched("the preview");
    const confirmed = await call("POST", "/api/setup/advance", { step: "profile", locale: "en" });
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.equal(confirmed.json.setup.step, "dependencies");
    assert.deepEqual([...confirmed.json.written].sort(), [".jgates/profiles.yml", "jgates.yml"]);
    assert.equal(confirmed.json.setup.choices.profile, "rapido");
    for (const [file, text] of Object.entries(draftFiles)) assert.equal(fs.readFileSync(path.join(project, file), "utf8"), text, `${file} holds exactly the draft`);
    const added = [...snapshot(project).keys()].filter((f) => !before.has(f)).sort();
    assert.deepEqual(added, [".jgates/profiles.yml", "jgates.yml"], "nothing else was written to the project");

    // The plan of the chosen profile counts what the step said, in the same unit.
    const planned = await call("POST", "/api/plans", { profile: "rapido", preview: true });
    assert.equal(planned.status, 201, planned.text);
    assert.equal(planned.json.plan.groups.willRun.length, rapido.total, "the step's count is the plan's");
    const perfil = await call("GET", "/api/config/profile?profile=rapido");
    assert.equal(perfil.status, 200, perfil.text);
    assert.equal(perfil.json.categories.find((c) => c.id === "security").enabled, false, "Configuração > Perfil shows the switch made in the wizard");

    // The draft is gone: the step, opened again, starts from the project's own files.
    const again = await call("GET", "/api/setup/profiles");
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.draft.mode, "existing");
    assert.equal(again.json.draft.edited, false);
    assert.equal(again.json.selected, "rapido");
  } finally {
    await stopUi(ui);
  }
});
