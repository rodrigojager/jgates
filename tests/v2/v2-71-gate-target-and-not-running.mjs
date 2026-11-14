import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-71 (fake engine): the review's gate and target, and what will not run (PLAN-guided-flows.md sections 3 and 4):
//   - the plan returns every check that will not run as an item with the check and the tool name, the category, the
//     reason (code and sentence), a suggestion when there is one and typed actions, grouped by the kind of reason;
//   - a check that cannot apply to the project (no tool for its languages) carries no action at all;
//   - what a run still needs prepared (tools image, security data, dependencies) is listed apart, one per pending item,
//     each with its network and its action;
//   - Semantic is offered disabled, with the reason and the action, while it is not configured;
//   - the chosen gate and target can be saved as the project's default (jgates.yml > selection), and read back.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const KINDS = ["preparation", "configuration", "not-applicable", "turned-off"];
const ACTION_TYPES = ["prepare-tools", "prepare-tool", "prepare-data", "prepare-codeql", "prepare-dependencies", "start-services", "configure", "add-tool", "enable", "include-in-run", "learn-more"];

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

const allItems = (review) => review.notRunning.groups.flatMap((g) => g.items);

test("V2-71: the plan lists every check that will not run with its reason and actions, apart from the pending preparations, and the gate and target can be saved", async () => {
  const home = tmp("v2-71-home-");
  const project = tmp("v2-71-project-");
  const engine = tmp("v2-71-engine-");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(
    runtime,
    [`process.env.FAKE_DOCKER_LOG = ${JSON.stringify(path.join(engine, "calls.jsonl"))};`, `process.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};`, `process.env.FAKE_DOCKER_LABELS = "none";`, `require(${JSON.stringify(FAKE)});`, ``].join("\n"),
  );
  // A Python project with its dependencies: the strict profile asks for more than this project can do today.
  fs.writeFileSync(path.join(project, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\nrequires-python = ">=3.11"\n');
  fs.writeFileSync(path.join(project, "requirements.txt"), "requests==2.31.0\n");
  fs.mkdirSync(path.join(project, "app"));
  fs.writeFileSync(path.join(project, "app", "main.py"), "def add(a, b):\n    return a + b\n");
  const env = { ...process.env, JGATES_HOME: home, JGATES_IMAGE_JSON: "", JGATES_CONTAINER_RUNTIME: runtime, JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" };
  const init = spawnSync(process.execPath, [MAIN, "init", "--cwd", project, "--profile", "strict", "--no-interactive", "--json"], { env, encoding: "utf8" });
  assert.equal(init.status, 0, `${init.stdout}${init.stderr}`);

  let ui = null;
  try {
    ui = await startUi(env, project);
    const call = await session(ui);

    // ---- what will not run, as items ---------------------------------------------------------------------------------
    const built = await call("POST", "/api/plans", {});
    assert.equal(built.status, 201, built.text);
    const review = built.json.review;
    assert.ok(review.notRunning.total > 0, "the strict profile asks for checks this project cannot run yet");
    assert.equal(review.notRunning.total, allItems(review).length);
    assert.deepEqual(review.notRunning.groups.map((g) => g.kind), KINDS.filter((k) => review.notRunning.groups.some((g) => g.kind === k)), "groups in the fixed order of the kinds");
    for (const group of review.notRunning.groups) {
      assert.ok(KINDS.includes(group.kind), group.kind);
      assert.equal(group.count, group.items.length);
      for (const item of group.items) {
        const where = `${item.selector}: `;
        assert.equal(item.kind, group.kind, where + "its group");
        assert.ok(item.check && item.check !== item.selector, where + `named by what is checked, not by its selector (${item.check})`);
        assert.ok(Array.isArray(item.tools), where + "tools");
        for (const tool of item.tools) assert.ok(tool.id && tool.name, where + "a tool has its id and name");
        assert.ok(item.category === null || typeof item.category === "string", where + "category");
        assert.match(item.reasonCode, /^[A-Z_]+$/, where + "reason code");
        assert.ok(item.reason.length > 10, where + "reason text");
        assert.ok(item.suggestion === null || item.suggestion.length > 5, where + "a suggestion or none");
        for (const action of item.actions) {
          assert.ok(ACTION_TYPES.includes(action.type), where + `action ${action.type}`);
          assert.ok(action.label.length > 1, where + "the action has its text");
        }
      }
    }

    // A check no tool covers for the languages of the project cannot apply: plain information, no action, no suggestion.
    const tests = allItems(review).find((i) => i.reasonCode === "NO_TOOL_FOR_LANGUAGES");
    assert.ok(tests, `a check without a tool for this stack: ${allItems(review).map((i) => `${i.selector}:${i.reasonCode}`).join(", ")}`);
    assert.equal(tests.kind, "not-applicable");
    assert.deepEqual(tests.actions, [], "a check that cannot apply to the project carries no action");
    assert.equal(tests.suggestion, null);
    for (const item of allItems(review).filter((i) => i.kind === "not-applicable")) assert.deepEqual(item.actions, [], `${item.selector} cannot apply, so it has no action`);

    // CodeQL is customer supplied: its own typed action opens the preparation with the terms.
    const codeql = allItems(review).find((i) => i.reasonCode === "CUSTOMER_SUPPLIED");
    assert.ok(codeql, "CodeQL is listed");
    assert.equal(codeql.kind, "preparation");
    assert.equal(codeql.actions[0].type, "prepare-codeql");
    assert.equal(codeql.actions[0].route, "environment");
    assert.ok(codeql.tools.length > 0 && codeql.suggestion);

    // A check that needs files or settings: "configure" names the field to focus, and the template when it is not in jgates.yml yet.
    const configure = allItems(review).filter((i) => i.actions.some((a) => a.type === "configure"));
    assert.ok(configure.length >= 3, `checks to configure: ${configure.length}`);
    const withField = configure.find((i) => i.actions[0].field);
    assert.ok(withField, "a check that needs a setting says which one");
    assert.ok(withField.actions[0].fields.includes(withField.actions[0].field));
    assert.equal(withField.kind, "configuration");
    assert.ok(configure.some((i) => i.actions[0].template || (i.actions[0].files ?? []).length > 0), "a check that needs a template or files names them");
    // The links to the official pages are an action of their own, never a replacement for the others.
    for (const item of allItems(review)) assert.ok(item.actions.filter((a) => a.type === "learn-more").every((a) => /^https?:\/\//.test(a.url)), `${item.selector}: learn more is an official page`);

    // A check turned off for this run only comes back with one click: the typed action carries what to include.
    const skipped = await call("POST", "/api/plans", { skip: ["capability:lint"] });
    assert.equal(skipped.status, 201, skipped.text);
    const off = allItems(skipped.json.review).find((i) => i.selector === "capability:lint");
    assert.ok(off, `lint turned off for the run: ${allItems(skipped.json.review).map((i) => i.selector).join(", ")}`);
    assert.equal(off.kind, "turned-off");
    assert.equal(off.reasonCode, "DISABLED_FOR_RUN");
    assert.equal(off.actions[0].type, "include-in-run");
    assert.ok(off.actions[0].selectors.includes("capability:lint"));

    // ---- what is left to prepare, apart -------------------------------------------------------------------------------
    assert.ok(Array.isArray(review.preparations));
    const ids = review.preparations.map((p) => p.id);
    assert.deepEqual(ids, ["tools", "data", "dependencies"].filter((id) => ids.includes(id)), "fixed order");
    assert.ok(ids.includes("tools"), "the fake engine has no tools image yet");
    assert.ok(ids.includes("dependencies"), "the dependencies are not installed yet");
    for (const prep of review.preparations) {
      assert.equal(prep.action.type, { tools: "prepare-tools", data: "prepare-data", dependencies: "prepare-dependencies" }[prep.id]);
      assert.ok(prep.label && prep.detail, prep.id);
      assert.equal(prep.network, "bridge", `${prep.id} downloads, so it uses the network`);
      assert.ok(Array.isArray(prep.affects));
    }
    // The preparations are not listed again as checks that will not run.
    for (const item of allItems(review)) assert.ok(!["prepare-data", "prepare-dependencies"].includes(item.actions[0]?.type), `${item.selector} is not a preparation`);
    // A preview (the plans of the customize panel) asks the engine for nothing.
    const preview = await call("POST", "/api/plans", { preview: true });
    assert.deepEqual(preview.json.review.preparations, []);

    // ---- the gate and the target ---------------------------------------------------------------------------------------
    const choose = await call("GET", "/api/validations/choose");
    assert.equal(choose.status, 200, choose.text);
    assert.equal(choose.json.gates.semantic.configured, false);
    assert.equal(choose.json.gates.semantic.reason.code, "SEMANTIC_NOT_CONFIGURED");
    assert.ok(choose.json.gates.semantic.reason.message.length > 10);
    assert.equal(choose.json.gates.semantic.action.type, "configure");
    assert.equal(choose.json.gates.semantic.action.route, "semantic/setup?step=provider");
    assert.deepEqual(choose.json.saved, { gates: null, scope: null, paths: [] }, "nothing saved yet");

    // ---- save the choice as the project's default ----------------------------------------------------------------------
    const text = () => fs.readFileSync(path.join(project, "jgates.yml"), "utf8");
    const before = text();
    const refused = await call("PUT", "/api/validations/selection", { gates: ["quality"], scope: "paths" });
    assert.equal(refused.status, 422, "a folder target needs a folder");
    assert.equal(refused.json.code ?? refused.json.error?.code, "PATHS_REQUIRED");
    assert.equal(text(), before, "a refused save writes nothing");
    const bad = await call("PUT", "/api/validations/selection", { gates: ["nothing"], scope: "full" });
    assert.equal(bad.status, 400, bad.text);

    const saved = await call("PUT", "/api/validations/selection", { gates: ["semantic", "quality"], scope: "paths", paths: ["app"] });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.json.saved, { gates: ["quality", "semantic"], scope: "paths", paths: ["app"] }, "Quality always first");
    assert.match(text(), /selection:/);
    assert.match(text(), /scope: paths/);
    assert.match(text(), /- app/);
    const again = await call("GET", "/api/validations/choose");
    assert.deepEqual(again.json.saved, { gates: ["quality", "semantic"], scope: "paths", paths: ["app"] });

    // Another default replaces it, and a scope that is not "paths" leaves no folder behind.
    const replaced = await call("PUT", "/api/validations/selection", { gates: ["quality"], scope: "changed" });
    assert.equal(replaced.status, 200, replaced.text);
    assert.doesNotMatch(text(), /paths:/);
    const last = await call("GET", "/api/validations/choose");
    assert.deepEqual(last.json.saved, { gates: ["quality"], scope: "changed", paths: [] });
    // The file is still a valid configuration: the plan builds.
    const rebuilt = await call("POST", "/api/plans", {});
    assert.equal(rebuilt.status, 201, rebuilt.text);
  } finally {
    await stopUi(ui);
  }
});
