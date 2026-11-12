import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-57 (fake engine): the states catalogue, read through the server API only.
//   - GET /api/reasons lists every reason code with a text in pt-BR and en and an action label in both languages; the
//     action is a command, an official link or a UI route, and `none` only where the person has nothing to click (a
//     stopped engine shows its start recipe, a refused host execution is a defect, a pull in progress needs nothing);
//   - every reason code that the environment state (engine stopped, image missing, image of another version, advisory
//     data, CodeQL, dependencies) and a real plan (customer-supplied CodeQL) actually raise is in the catalogue, and the
//     text they carry is the catalogue's text, in both languages;
//   - every action kind a plan can carry (prepare-tool, prepare-image, prepare-codeql, ...) and every toolchain action
//     (use-default-version, fix-version-file) has a label in both languages;
//   - no text of the catalogue uses a parenthesized plural, and the raw engine text is never the main message.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const PINNED = `registry.example.test/jgates/jgates-tools@sha256:${"ab".repeat(32)}`;
const LOCALES = ["en", "pt-BR"];
const NONE_ALLOWED = new Set(["ENGINE_STOPPED", "IMAGE_PULLING", "HOST_EXECUTION_REFUSED"]);

const made = [];
const tmp = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
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

const longestLiteral = (template) => template.split(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/).sort((a, b) => b.length - a.length)[0].trim();

test("V2-57: every reason code in the plan and environment results has pt-BR and en text and an action or help link, through the server API", async () => {
  const home = tmp("v2-57-home-");
  const project = tmp("v2-57-project-");
  const engine = tmp("v2-57-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  // The image of the fake engine: absent, of this release, or of another one, by marker files the test writes.
  fs.writeFileSync(
    runtime,
    `const fs = require("node:fs");\nconst path = require("node:path");\nprocess.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nconst mode = fs.existsSync(path.join(${JSON.stringify(engine)}, "image-mode")) ? fs.readFileSync(path.join(${JSON.stringify(engine)}, "image-mode"), "utf8").trim() : "none";\nprocess.env.FAKE_DOCKER_LABELS = mode === "current" ? ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))} : mode === "old" ? ${JSON.stringify(JSON.stringify({ "org.jgates.version": "0.0.1" }))} : "none";\nrequire(${JSON.stringify(FAKE)});\n`,
  );
  const setImage = (mode) => fs.writeFileSync(path.join(engine, "image-mode"), mode);
  const lost = path.join(engine, "daemon.lost");
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: PINNED, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "" };
  fs.writeFileSync(path.join(project, "mod.py"), "import os\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  const init = spawnSync(process.execPath, [MAIN, "init", "--cwd", project, "--profile", "strict", "--no-interactive", "--json"], { env, encoding: "utf8", timeout: 120_000 });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  fs.writeFileSync(path.join(project, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  codeql:\n    adapter: codeql\n    enabled: true\n    capabilities: [dataflow]\n    language: python\n    suite: security-extended\n");

  let ui = null;
  try {
    ui = await startUi(env, project);
    const call = await session(ui);

    // The catalogue.
    const catalogueResponse = await call("GET", "/api/reasons");
    assert.equal(catalogueResponse.status, 200, catalogueResponse.text);
    const catalogue = catalogueResponse.json;
    const byCode = new Map(catalogue.reasons.map((r) => [r.code, r]));
    for (const code of ["ENGINE_NOT_INSTALLED", "ENGINE_STOPPED", "ENGINE_LOW_MEMORY", "DISK_LOW", "IMAGE_MISSING", "IMAGE_PULLING", "IMAGE_PULL_FAILED", "IMAGE_VERSION_MISMATCH", "EXTENSION_OUTDATED", "DEPENDENCIES_NOT_READY", "DEPENDENCIES_FAILED", "DATA_STALE", "DATA_MISSING", "SERVICES_NOT_READY", "SERVICES_REQUIRED", "CUSTOMER_SUPPLIED", "ENGINE_LOST", "HOST_EXECUTION_REFUSED", "NOT_APPLICABLE_TO_PROJECT", "UNSUPPORTED_PLATFORM", "TOOL_MISSING"]) {
      assert.ok(byCode.has(code), `${code} is in the catalogue`);
    }
    for (const reason of catalogue.reasons) {
      for (const locale of LOCALES) {
        assert.ok(reason.text[locale]?.length > 8, `${reason.code}: text in ${locale}`);
        assert.ok(reason.action.label[locale]?.length > 2, `${reason.code}: action label in ${locale}`);
        assert.ok(!/\(s\)|\(es\)|\(ns\)/.test(reason.text[locale] + reason.action.label[locale]), `${reason.code}: no parenthesized plural in ${locale}`);
      }
      assert.notEqual(reason.text.en, reason.text["pt-BR"], `${reason.code}: the two languages are different texts`);
      if (reason.action.kind === "command") assert.match(reason.action.command, /^jgates /, reason.code);
      else if (reason.action.kind === "link") assert.match(reason.action.url, /^https:\/\//, reason.code);
      else if (reason.action.kind === "route") assert.ok(reason.action.route.length > 0, reason.code);
      else assert.ok(NONE_ALLOWED.has(reason.code), `${reason.code} has no action and no help link`);
    }
    for (const action of catalogue.planActions) for (const locale of LOCALES) assert.ok(action.label[locale]?.length > 2, `plan action ${action.kind} in ${locale}`);
    for (const action of catalogue.toolchainActions) for (const locale of LOCALES) assert.ok(action.label[locale]?.length > 2, `toolchain action ${action.id} in ${locale}`);
    const planKinds = new Set(catalogue.planActions.map((a) => a.kind));
    for (const kind of ["prepare-tool", "prepare-image", "prepare-codeql", "add-files", "add-template", "configure-tool", "enable-check"]) assert.ok(planKinds.has(kind), `plan action ${kind}`);
    assert.deepEqual(catalogue.toolchainActions.map((a) => a.id).sort(), ["fix-version-file", "use-default-version"]);

    // The codes the environment raises, in every state the fake engine can be put in.
    const seen = new Map(); // code -> messages seen per locale
    const note = (reason, locale) => {
      assert.ok(reason && typeof reason.code === "string", JSON.stringify(reason));
      const list = seen.get(reason.code) ?? [];
      list.push({ locale, reason });
      seen.set(reason.code, list);
    };
    const reasonsOf = (state) => [...state.reasons, ...state.warnings, ...Object.values(state.sections).flatMap((s) => s.reasons)];
    const states = [
      { name: "engine stopped", prepare: () => fs.writeFileSync(lost, "") },
      { name: "image missing", prepare: () => { fs.rmSync(lost, { force: true }); setImage("none"); } },
      { name: "image of another version", prepare: () => setImage("old") },
      { name: "image of this release", prepare: () => setImage("current") },
    ];
    for (const state of states) {
      state.prepare();
      for (const locale of LOCALES) {
        // The machine changed behind the server's back: the screen's "check again" (fresh=1) asks the engine anew
        // instead of the server's cached facts (ADR-0010).
        const r = await call("GET", `/api/environment/state?locale=${locale}&fresh=1`);
        assert.equal(r.status, 200, `${state.name}: ${r.text}`);
        assert.ok(Object.keys(r.json.sections).length >= 7, state.name);
        for (const reason of reasonsOf(r.json)) note(reason, locale);
      }
    }
    for (const code of ["ENGINE_STOPPED", "IMAGE_MISSING", "IMAGE_VERSION_MISMATCH", "DATA_MISSING", "CUSTOMER_SUPPLIED"]) assert.ok(seen.has(code), `the environment raised ${code}`);

    // The codes a real plan carries (CodeQL is customer supplied and not prepared).
    const plans = [];
    for (const locale of LOCALES) {
      const local = { ...env, JGATES_LOCALE: locale };
      const cli = spawnSync(process.execPath, [MAIN, "plan", "--cwd", project, "--only", "tool:codeql", "--json"], { env: local, encoding: "utf8", timeout: 120_000, input: "" });
      let doc = null;
      try {
        doc = JSON.parse(cli.stdout);
      } catch {
        doc = null;
      }
      assert.ok(doc, `plan (${locale}): ${cli.stdout}${cli.stderr}`);
      plans.push({ locale, doc: doc.plan ?? doc });
    }
    const api = await call("POST", "/api/plans", { only: ["tool:codeql"], preview: true });
    assert.ok(api.status === 201 || api.status === 200, api.text);
    plans.push({ locale: "en", doc: api.json.plan });
    const planActionKinds = new Set();
    for (const { locale, doc } of plans) {
      for (const entry of doc.groups?.notApplicableRequirements ?? []) {
        assert.ok(entry.message?.length > 0, "a not-applicable entry has its message");
        if (entry.action?.kind) planActionKinds.add(entry.action.kind);
        if (byCode.has(entry.reasonCode)) {
          note({ code: entry.reasonCode, message: entry.message }, locale);
        }
      }
    }
    assert.ok(planActionKinds.has("configure-tool") && planActionKinds.has("add-files"), `the plan carried actions: ${[...planActionKinds].join(", ")}`);
    for (const kind of planActionKinds) assert.ok(kind === "none" || planKinds.has(kind), `plan action kind ${kind} is in the catalogue`);

    // Every code seen is in the catalogue, and the message it carried is the catalogue's text (same words).
    for (const [code, list] of seen) {
      const entry = byCode.get(code);
      assert.ok(entry, `${code} (raised by the environment or the plan) is in the catalogue`);
      for (const { locale, reason } of list) {
        const anchor = longestLiteral(entry.text[locale]);
        if (anchor.length >= 12) assert.ok(reason.message.includes(anchor), `${code} (${locale}): "${reason.message}" carries the catalogue text "${anchor}"`);
        assert.ok(!/Cannot connect to the Docker daemon|Is the docker daemon running/.test(reason.message), `${code}: the raw engine text is not the main message`);
        if (reason.action) {
          assert.equal(reason.action.kind, entry.action.kind, code);
          assert.equal(reason.action.label, entry.action.label[locale], `${code}: the label of the action is the catalogue's, in ${locale}`);
        }
      }
    }
  } finally {
    if (ui && ui.proc.exitCode === null) {
      const exited = once(ui.proc, "exit");
      ui.proc.kill("SIGTERM");
      await exited;
    }
  }
});
