import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-92 (fake engine, server): the ASVS coverage map through the local server and through the terminal give the same
// answers (PLAN-asvs.md sections 5 and 6). GET /api/coverage/asvs returns the map `jgates coverage asvs --json` returns for
// the same request (rows, totals, runs, level, filters, the source block), in the language asked for, and refuses what the
// command refuses with the same codes. POST /api/coverage/asvs/decisions with `preview: true` answers with the entry and the
// diff of .jgates/asvs.json and leaves the file byte for byte as it was; the write adds that entry and nothing else, the
// undo restores the file byte for byte, a "not applicable" entry can be removed (and put back), and the level can be
// recorded. A reason of 3 to 300 characters is required; a stale revision, an unknown target and a repeated entry are
// refused with nothing written. In governed mode every write is refused with 403 GOVERNED_LOCKED while the map is still
// served. The project is not a git repository and the fake engine sleeps 3 s before every call (the delay switch of V2-64):
// no route of this case calls the engine or git, so every answer arrives within the limits of V2-64 and the engine records
// no call.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = path.join(root, "jgates", "dist");
const MAIN = path.join(DIST, "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const MAP_PACK = path.join(root, "jgates", "packs", "asvs", "jgates-asvs-map", "5.0.0");
const VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const { workspaceId } = await import(pathToFileURL(path.join(DIST, "core", "ids", "index.js")).href);
const asvs = await import(pathToFileURL(path.join(DIST, "core", "coverage", "asvs", "index.js")).href);
const FILE = ".jgates/asvs.json";
const DELAY_MS = 3000;
const MAP_MS = 2000;
const WRITE_MS = 500;

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

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
    const started = performance.now();
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
        resolve({ status: res.statusCode, text, json, ms: performance.now() - started });
      });
    });
    req.on("error", (error) => reject(new Error(`${method} ${p} after ${Math.round(performance.now() - started)} ms: ${error.message}`)));
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
    const timer = setTimeout(() => reject(new Error(`jgates ui did not start:\n${ui.out}\n${ui.err}`)), 60_000);
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

async function stop(ui) {
  if (ui && ui.proc.exitCode === null) {
    const exited = once(ui.proc, "exit");
    ui.proc.kill("SIGTERM");
    await exited;
  }
}

/** The fake engine behind the delay switch (the file delay-ms in its state folder, read at every call). */
function wrapper(engine) {
  return `const fs = require("node:fs");
const path = require("node:path");
const state = ${JSON.stringify(engine)};
process.env.FAKE_DOCKER_STATE = state;
process.env.FAKE_DOCKER_LOG = path.join(state, "calls.jsonl");
process.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": VERSION }))};
const file = path.join(state, "delay-ms");
const delay = Number(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : 0);
if (delay > 0) {
  fs.appendFileSync(path.join(state, "asked.jsonl"), JSON.stringify(process.argv.slice(2, 4)) + "\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}
require(${JSON.stringify(FAKE)});
`;
}

// ---- the fixture: five level-1 requirements with entries of their own, stored runs ------------------------------------

const data = asvs.loadAsvs("5.0.0");
const level1 = asvs.asvsRequirements(data, { level: 1 });
const sections = [];
for (const r of level1) if (!sections.some((x) => x.section === r.section)) sections.push(r);
const R = { examined: sections[0], unexamined: sections[1], awaiting: sections[2], unsupported: sections[3], target: sections[4] };
assert.equal(new Set(Object.values(R).map((r) => r?.id)).size, 5, "five distinct level-1 requirements");

function fixtureMapping() {
  const dir = tmp("v2-92-map-");
  const versionDir = path.join(dir, "5.0.0");
  fs.cpSync(MAP_PACK, versionDir, { recursive: true });
  const set = (requirement, patch) => {
    const file = path.join(versionDir, `${asvs.chapterFileStem(requirement.chapter)}.json`);
    const doc = readJson(file);
    Object.assign(doc.entries.find((e) => e.requirement === requirement.id), patch);
    writeJson(file, doc);
  };
  const check = (id) => ({ unit: "semantic-method", id, covers: "a construct this check reads", misses: "what it does not model", depth: "partial" });
  const reviewed = (id) => ({ status: "reviewed", evidence: "repository", subdimensions: ["business-logic"], checks: [check(id)], why: "It bears on the requirement for a reason of its own.", review: { by: "independent context", date: "2026-11-14" } });
  set(R.examined, reviewed("differential-review"));
  set(R.unexamined, reviewed("variant-analysis"));
  set(R.awaiting, { status: "pending", evidence: "deployment", checks: [], subdimensions: [] });
  set(R.unsupported, { status: "pending", evidence: "repository", checks: [], subdimensions: [] });
  set(R.target, { status: "pending", evidence: "repository", checks: [], subdimensions: [] });
  return dir;
}

const COMMIT = "1111111111111111111111111111111111111111";
const OTHER_COMMIT = "2222222222222222222222222222222222222222";
const RUN = "run_20261114T100000Z_aaaaaaaa";
const SEM_SAME = "sem_20261114T110000Z_0a0a0a0a";
const SEM_OTHER = "sem_20261101T110000Z_0b0b0b0b";
const stamp = { schemaVersion: 1, tool: "jgates", version: "2.0.0", requirements: [], unsatisfied: [], warnings: [], blockingViolations: 0, disabled: [], complete: true, reduced: false, findings: [], stages: [] };

function storeRuns(home, project) {
  const ws = path.join(home, "workspaces", workspaceId(project));
  const quality = path.join(ws, "runs", RUN);
  writeJson(path.join(quality, "result.json"), { ...stamp, runId: RUN, gate: "quality", startedAt: "2026-11-14T10:00:00.000Z", finishedAt: "2026-11-14T10:00:01.000Z", decision: "passed", exitCode: 0, workspaceChanges: { checked: true, added: [], modified: [], removed: [] }, artifacts: { result: "result.json", logs: [], outputs: [], plan: "plan.json" } });
  writeJson(path.join(quality, "plan.json"), { schemaVersion: 1, kind: "jgates-plan", groups: { willRun: [], notApplicableOrDisabled: [] } });
  writeJson(path.join(quality, "run.json"), { schemaVersion: 1, gate: "quality", runId: RUN, source: { commit: COMMIT, dirty: false, dirtyContentHash: null } });
  const semantic = (runId, startedAt, commit) => {
    const dir = path.join(ws, "semantic-runs", runId);
    writeJson(path.join(dir, "result.json"), {
      ...stamp,
      runId,
      gate: "semantic",
      startedAt,
      finishedAt: startedAt,
      decision: "passed",
      exitCode: 0,
      workspaceChanges: { checked: false, added: [], modified: [], removed: [] },
      artifacts: { result: "result.json", logs: [], outputs: [] },
      semanticRun: { schemaVersion: 1, enforcement: "advisory", methods: ["differential-review"], outcome: { requested: true, state: "completed", separateFromDecision: true, provider: "scripted", model: "fixture" }, source: { id: "fixture", basis: "git", traceable: true }, quality: null },
    });
    writeJson(path.join(dir, "run.json"), { schemaVersion: 1, gate: "semantic", runId, source: { commit, dirty: false, dirtyContentHash: null } });
  };
  semantic(SEM_SAME, "2026-11-14T11:00:00.000Z", COMMIT);
  semantic(SEM_OTHER, "2026-11-01T11:00:00.000Z", OTHER_COMMIT);
}

/** A project that is not a git repository, a data folder with the stored runs, the fixture mapping and the delayed fake engine. */
function setup(extraEnv = {}) {
  const dir = tmp("v2-92-");
  const home = path.join(dir, "home");
  const project = path.join(dir, "project");
  const engine = path.join(dir, "engine");
  const runtime = path.join(engine, "docker.cjs");
  for (const d of [home, project, engine]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(runtime, wrapper(engine));
  fs.writeFileSync(path.join(engine, "objects.json"), JSON.stringify({ containers: [], volumes: [], networks: [], images: [] }));
  storeRuns(home, project);
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", JGATES_ASVS_MAP_DIR: fixtureMapping(), JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "", ...extraEnv };
  delete env.JGATES_PYTHON;
  const cli = (args, over = {}) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env: { ...env, ...over }, input: "", timeout: 120_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const json = (args, over) => {
    const r = cli([...args, "--json"], over);
    try {
      return { ...r, doc: JSON.parse(r.out) };
    } catch {
      assert.fail(`no JSON from ${args.join(" ")}: ${r.out}\n${r.err}`);
    }
  };
  const calls = () => {
    const file = path.join(engine, "calls.jsonl");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "") : [];
  };
  return { dir, home, project, engine, env, cli, json, calls, file: path.join(project, FILE) };
}

const text = (p) => (fs.existsSync(p.file) ? fs.readFileSync(p.file, "utf8") : null);
/** What the map says, without what only the process adds (the tool, its version and where the workspace is). */
const mapOf = (doc) => {
  const { tool, version, workspace, schemaVersion, status, ...rest } = doc;
  return rest;
};
const row = (doc, requirement) => doc.requirements.find((r) => r.id === requirement.id);

test("V2-92: the route returns the map of `jgates coverage asvs --json`, in the language asked, and refuses what the command refuses", { timeout: 600_000 }, async () => {
  const p = setup();
  let ui = null;
  try {
    ui = await startUi(p.env, p.project);
    const call = await session(ui);

    const same = async (label, query, args, over) => {
      const api = await call("GET", `/api/coverage/asvs${query}`);
      assert.equal(api.status, 200, `${label}: ${api.text}`);
      const cli = p.json(["coverage", "asvs", "--cwd", p.project, ...args], over);
      assert.equal(cli.code, 0, `${label}: ${cli.out}${cli.err}`);
      assert.deepEqual(mapOf(api.json), mapOf(cli.doc), `${label}: the route and the command give the same map`);
      return api.json;
    };

    const base = await same("default", "", []);
    assert.equal(base.kind, "asvs-coverage-map");
    assert.equal(base.requirements.length, 70);
    assert.equal(base.level, 1);
    assert.equal(base.levelSource, "default");
    assert.equal(base.runs.quality.runId, RUN);
    assert.deepEqual(base.runs.semantic.map((s) => s.runId), [SEM_SAME]);
    assert.equal(base.source.licence, "CC BY-SA 4.0");
    assert.equal(base.source.version, "5.0.0");
    assert.equal(row(base, R.examined).state, "examined");
    assert.equal(row(base, R.examined).basis, "ai-source-review");
    assert.equal(row(base, R.examined).text, R.examined.text, "the official text, unchanged");
    assert.equal(row(base, R.unexamined).state, "unexamined");
    assert.equal(row(base, R.awaiting).state, "awaiting-evidence");
    assert.equal(row(base, R.unsupported).state, "unsupported");
    assert.equal(base.totals.rows, 70);

    assert.equal((await same("level 2", "?level=2", ["--level", "2"])).requirements.length, 253);
    assert.equal((await same("level 3", "?level=3", ["--level", "3"])).requirements.length, 345);
    const narrowed = await same("state", "?state=awaiting-evidence", ["--state", "awaiting-evidence"]);
    assert.ok(narrowed.requirements.every((r) => r.state === "awaiting-evidence"));
    assert.equal(narrowed.totals.rows, 70, "the state filter narrows the rows listed, not the totals");
    await same("chapter", `?chapter=${R.examined.chapter}`, ["--chapter", R.examined.chapter]);
    const det = await same("deterministic only", "?deterministicOnly=true", ["--deterministic-only"]);
    assert.equal(det.deterministicOnly, true);
    assert.equal(row(det, R.examined).state, "unexamined", "what only the Semantic run examined is no longer examined");
    const differ = await same("another revision", `?semanticRuns=${SEM_OTHER}`, ["--semantic-run", SEM_OTHER]);
    assert.ok(differ.warnings.some((w) => w.code === "REVISIONS_DIFFER"));

    // The language of the screen that asked: the route gives what the command gives with that language.
    const pt = await same("pt-BR", "?lang=pt-BR", [], { JGATES_LOCALE: "pt-BR" });
    assert.match(pt.statement, /^Este mapa mostra o que foi examinado/);
    assert.notEqual(pt.statement, base.statement);
    assert.equal(row(pt, R.examined).textLanguage, "en");
    assert.equal(row(pt, R.examined).text, R.examined.text, "the requirement text is never translated");

    // What the command refuses, the route refuses with the same code and message.
    const refusals = [
      ["?level=4", ["--level", "4"], 422],
      ["?run=run_nope", ["--run", "run_nope"], 404],
      ["?state=wrong", ["--state", "wrong"], 422],
      ["?chapter=V99", ["--chapter", "V99"], 422],
    ];
    for (const [query, args, status] of refusals) {
      const api = await call("GET", `/api/coverage/asvs${query}`);
      const cli = p.json(["coverage", "asvs", "--cwd", p.project, ...args]);
      assert.equal(api.status, status, api.text);
      assert.equal(cli.code, 3);
      assert.equal(api.json.code, cli.doc.code, query);
      assert.equal(api.json.message, cli.doc.message, query);
    }
    assert.deepEqual(p.calls(), [], "the map reads stored files only: no engine call");
  } finally {
    await stop(ui);
  }
});

test("V2-92: the preview writes nothing; the write adds that entry only; the undo and the removal restore the file byte for byte; the level is recorded", { timeout: 600_000 }, async () => {
  const p = setup();
  const before = '{\n  "$comment": "team file",\n  "notApplicable": [\n    { "id": "V17", "reason": "no WebRTC in this product", "recorded": "2026-11-01" }\n  ]\n}\n';
  fs.mkdirSync(path.dirname(p.file), { recursive: true });
  fs.writeFileSync(p.file, before);
  let ui = null;
  try {
    ui = await startUi(p.env, p.project);
    const call = await session(ui);
    const body = { action: "not-applicable", id: R.target.id, reason: "no such feature in this product" };

    // Preview: the entry and the diff of the file, the same diff as the command's; the file is byte for byte as it was.
    const preview = await call("POST", "/api/coverage/asvs/decisions", { ...body, preview: true });
    assert.equal(preview.status, 200, preview.text);
    assert.deepEqual([preview.json.preview, preview.json.written], [true, false]);
    assert.equal(preview.json.entry.id, R.target.id);
    assert.ok(preview.json.diff.includes(`+++ b/${FILE}`) && preview.json.diff.includes(`"id": "${R.target.id}"`), preview.json.diff);
    assert.equal(text(p), before, "the preview wrote nothing");
    const cliPreview = p.json(["coverage", "asvs", "not-applicable", R.target.id, "--reason", body.reason, "--preview", "--cwd", p.project]);
    assert.equal(cliPreview.doc.diff, preview.json.diff, "the same diff as the command");
    assert.equal(text(p), before);

    // Write: the file changes by that entry and nothing else; the map shows the state; the undo comes with the answer.
    const written = await call("POST", "/api/coverage/asvs/decisions", body);
    assert.equal(written.status, 200, written.text);
    assert.deepEqual([written.json.preview, written.json.written], [false, true]);
    assert.ok(written.json.undo.token && written.json.undo.expectedRevision);
    const after = text(p);
    const cut = before.indexOf("\n  ]");
    assert.equal(after.slice(0, cut), before.slice(0, cut), "everything before the end of the list is the same bytes");
    assert.ok(after.endsWith(before.slice(cut)), "everything after the list is the same bytes");
    assert.deepEqual(readJson(p.file).notApplicable.at(-1), { id: R.target.id, reason: body.reason, recorded: written.json.entry.recorded });
    const map = (await call("GET", "/api/coverage/asvs")).json;
    assert.equal(row(map, R.target).state, "not-applicable");
    assert.equal(row(map, R.target).decision.reason, body.reason);
    assert.equal(map.totals.notApplicable, 1);
    assert.equal(map.decisions.revision, written.json.revision);
    const cliMap = p.json(["coverage", "asvs", "--cwd", p.project]);
    assert.deepEqual(mapOf(map), mapOf(cliMap.doc), "the command reads the entry the route wrote");

    // Refused with nothing written: a repeated entry, a stale revision, an unknown target, a bad reason.
    const refused = async (label, payload, status, code) => {
      const r = await call("POST", "/api/coverage/asvs/decisions", payload);
      assert.equal(r.status, status, `${label}: ${r.text}`);
      assert.equal(r.json.code, code, label);
      assert.equal(text(p), after, `${label}: nothing written`);
    };
    await refused("repeated", body, 409, "ASVS_ALREADY_NOT_APPLICABLE");
    await refused("stale revision", { ...body, id: R.unsupported.id, expectedRevision: "0".repeat(64) }, 409, "ASVS_FILE_CHANGED");
    await refused("unknown target", { ...body, id: "V99.9.9" }, 404, "ASVS_TARGET_UNKNOWN");
    await refused("no reason", { action: "not-applicable", id: R.unsupported.id }, 422, "ASVS_REASON_INVALID");
    await refused("two characters", { ...body, id: R.unsupported.id, reason: "ab" }, 422, "ASVS_REASON_INVALID");
    await refused("301 characters", { ...body, id: R.unsupported.id, reason: "x".repeat(301) }, 422, "ASVS_REASON_INVALID");
    await refused("control character", { ...body, id: R.unsupported.id, reason: "bad\treason" }, 422, "ASVS_REASON_INVALID");
    await refused("nothing to remove", { action: "remove", id: R.unsupported.id }, 404, "ASVS_DECISION_NOT_FOUND");

    // Undo puts the file back byte for byte; the same request writes the same bytes again.
    const undone = await call("POST", "/api/coverage/asvs/undo", { undo: written.json.undo });
    assert.equal(undone.status, 200, undone.text);
    assert.equal(text(p), before, "the undo restores the file byte for byte");
    assert.equal(row((await call("GET", "/api/coverage/asvs")).json, R.target).state, "unsupported");
    const again = await call("POST", "/api/coverage/asvs/decisions", body);
    assert.equal(again.status, 200, again.text);
    assert.equal(text(p), after, "the same request writes the same bytes");
    const stale = await call("POST", "/api/coverage/asvs/undo", { undo: { ...written.json.undo, expectedRevision: "0".repeat(64) } });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(text(p), after);

    // Removal: the entry goes out, the file is as before, the undo puts it back.
    const removed = await call("POST", "/api/coverage/asvs/decisions", { action: "remove", id: R.target.id });
    assert.equal(removed.status, 200, removed.text);
    assert.equal(text(p), before, "removing the entry leaves the file as it was");
    const restored = await call("POST", "/api/coverage/asvs/undo", { undo: removed.json.undo });
    assert.equal(restored.status, 200, restored.text);
    assert.equal(text(p), after);
    assert.equal((await call("POST", "/api/coverage/asvs/decisions", { action: "remove", id: R.target.id })).status, 200);

    // The level: previewed, recorded, shown as the project's choice, and the same when the command reads it.
    const levelPreview = await call("POST", "/api/coverage/asvs/decisions", { action: "level", level: 2, preview: true });
    assert.equal(levelPreview.status, 200, levelPreview.text);
    assert.equal(levelPreview.json.level, 2);
    assert.equal(text(p), before);
    const level = await call("POST", "/api/coverage/asvs/decisions", { action: "level", level: 2 });
    assert.equal(level.status, 200, level.text);
    assert.equal(readJson(p.file).level, 2);
    const projectMap = (await call("GET", "/api/coverage/asvs")).json;
    assert.deepEqual([projectMap.level, projectMap.levelSource, projectMap.requirements.length], [2, "project", 253]);
    assert.deepEqual(mapOf(projectMap), mapOf(p.json(["coverage", "asvs", "--cwd", p.project]).doc));
    assert.equal((await call("POST", "/api/coverage/asvs/decisions", { action: "level", level: 2 })).json.code, "ASVS_LEVEL_UNCHANGED");
    assert.equal((await call("POST", "/api/coverage/asvs/decisions", { action: "level", level: 4 })).json.code, "ASVS_LEVEL_INVALID");
    assert.equal((await call("POST", "/api/coverage/asvs/undo", { undo: level.json.undo })).status, 200);
    assert.equal(text(p), before);

    // A file that cannot be parsed is reported and never rewritten.
    const broken = '{ "notApplicable": [ { "id": "V1" ';
    fs.writeFileSync(p.file, broken);
    const bad = await call("POST", "/api/coverage/asvs/decisions", body);
    assert.equal(bad.status, 422, bad.text);
    assert.equal(bad.json.code, "ASVS_FILE_INVALID");
    assert.equal(text(p), broken, "a file that cannot be parsed is not rewritten");
    assert.ok((await call("GET", "/api/coverage/asvs")).json.decisions.problem, "the map reports the problem of the file");
    assert.deepEqual(p.calls(), [], "no engine call");
  } finally {
    await stop(ui);
  }
});

test("V2-92: in governed mode every write is refused with 403 and the map is still served", { timeout: 600_000 }, async () => {
  const p = setup({ JGATES_POLICY_DIR: "/etc/policies/company-policy", JGATES_POLICY_SHA256: "a".repeat(64) });
  let ui = null;
  try {
    ui = await startUi(p.env, p.project);
    const call = await session(ui);
    const get = await call("GET", "/api/coverage/asvs");
    assert.equal(get.status, 200, get.text);
    assert.equal(get.json.requirements.length, 70);
    const attempts = [
      ["POST", "/api/coverage/asvs/decisions", { action: "not-applicable", id: R.target.id, reason: "no such feature in this product" }],
      ["POST", "/api/coverage/asvs/decisions", { action: "not-applicable", id: R.target.id, reason: "no such feature in this product", preview: true }],
      ["POST", "/api/coverage/asvs/decisions", { action: "level", level: 2 }],
      ["POST", "/api/coverage/asvs/decisions", { action: "remove", id: R.target.id }],
      ["POST", "/api/coverage/asvs/undo", { undo: { file: FILE, expectedRevision: "0".repeat(64), previous: null } }],
    ];
    for (const [method, route, payload] of attempts) {
      const r = await call(method, route, payload);
      assert.equal(r.status, 403, `${route} ${JSON.stringify(payload)}: ${r.text}`);
      assert.equal(r.json.code, "GOVERNED_LOCKED");
    }
    assert.equal(text(p), null, "nothing was written");
    assert.deepEqual(p.calls(), []);
  } finally {
    await stop(ui);
  }
});

test("V2-92: with the engine slow (3 s per call) no route of the map waits on it and neither the engine nor git is called", { timeout: 600_000 }, async (t) => {
  const p = setup();
  let ui = null;
  try {
    ui = await startUi(p.env, p.project);
    const call = await session(ui);
    // Warm up once (the official file is read and checked the first time), then make the engine slow.
    assert.equal((await call("GET", "/api/coverage/asvs")).status, 200);
    const calledBefore = p.calls().length;
    fs.writeFileSync(path.join(p.engine, "delay-ms"), String(DELAY_MS));
    const slow = call("GET", "/api/overview").then(
      (r) => r,
      (error) => ({ status: 0, text: String(error) }),
    );
    const asked = path.join(p.engine, "asked.jsonl");
    const startedAt = performance.now();
    while (!fs.existsSync(asked) && performance.now() - startedAt < DELAY_MS) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(asked), "the overview asked the engine");

    const timed = [];
    const within = (label, r, limit) => {
      timed.push({ label, ms: Math.round(r.ms) });
      assert.ok(r.ms < limit, `${label} took ${Math.round(r.ms)} ms while the engine was slow: ${JSON.stringify(timed)}`);
    };
    const map = await call("GET", "/api/coverage/asvs?level=3");
    within("map", map, MAP_MS);
    assert.equal(map.status, 200, map.text);
    assert.equal(map.json.requirements.length, 345);
    const body = { action: "not-applicable", id: R.target.id, reason: "no such feature in this product" };
    const preview = await call("POST", "/api/coverage/asvs/decisions", { ...body, preview: true });
    within("preview", preview, WRITE_MS);
    assert.equal(preview.status, 200, preview.text);
    const write = await call("POST", "/api/coverage/asvs/decisions", body);
    within("write", write, WRITE_MS);
    assert.equal(write.status, 200, write.text);
    const undo = await call("POST", "/api/coverage/asvs/undo", { undo: write.json.undo });
    within("undo", undo, WRITE_MS);
    assert.equal(undo.status, 200, undo.text);
    assert.equal(text(p), null, "the undo took away the file the write created");
    t.diagnostic(`ASVS routes while the engine took ${DELAY_MS} ms per call: ${JSON.stringify(timed)}`);

    // The routes asked nothing of the engine (only the overview did, and it is still waiting) and the project is no repository.
    const asks = fs.readFileSync(asked, "utf8").split("\n").filter((l) => l.trim() !== "");
    assert.equal(asks.length >= 1, true);
    const settled = await Promise.race([slow.then(() => true), new Promise((r) => setTimeout(() => r(false), 0))]);
    assert.equal(settled, false, "the overview was still waiting on the engine");
    assert.equal(p.calls().length, calledBefore, "no call reached the engine from the ASVS routes");
    assert.equal(fs.existsSync(path.join(p.project, ".git")), false, "no git repository was made or needed");
  } finally {
    await stop(ui);
  }
});
