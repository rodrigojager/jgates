import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Runtime API checks: Schemathesis (Tests, api-contract) and ZAP (Security, dast) run only against an explicit target.
// Without one both stages are blocked with the reason, never passed. Against the local fixture server
// (tests/fixtures/runtime-api/server.mjs), whose "violating" mode breaks its OpenAPI contract and leaves security
// headers out, Schemathesis reports contract violations with a curl reproduction and ZAP reports the missing headers;
// the "conforming" twin gives none. The active ZAP scan is refused unless the instance explicitly allows it, and then
// the plan lists its effects. The real tools run when present (Schemathesis: JGATES_SCHEMATHESIS, the JGates
// environment or `st` on PATH; ZAP: Docker with the ghcr.io/zaproxy/zaproxy:stable image); otherwise the test says so
// and the parsers read the recorded real reports (Schemathesis 4.33.1, ZAP 2.17.0).

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FIXTURES = path.join(here, "fixtures", "runtime-api");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const st = await load("adapters", "schemathesis", "index.js");
const zap = await load("adapters", "zap", "index.js");
const manifests = await load("adapters", "manifests.js");
const matrix = await load("core", "matrix", "index.js");

const stProbe = st.probeSchemathesis(process.env);
const REAL_ST = stProbe.executable !== null && stProbe.version !== null;
const zapProbe = zap.probeZap(process.env);
const REAL_ZAP = zapProbe.problem === null;

const recorded = (name) => fs.readFileSync(path.join(FIXTURES, "recorded", name), "utf8");

/** Starts the fixture target in its own process (the CLI runs synchronously, so it cannot share this event loop). */
function startTarget(mode, token = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(FIXTURES, "server.mjs"), mode], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, FIXTURE_TOKEN: token } });
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const m = /listening (\S+)/.exec(buffer);
      if (m) resolve({ url: m[1], stop: () => child.kill() });
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`fixture server exited with ${code}`)));
  });
}

/** A workspace with the fixture spec, initialized by the real CLI, and the given tools.yml. */
function setup(tools, { env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-rt-ws-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-rt-home-"));
  fs.copyFileSync(path.join(FIXTURES, "openapi.yaml"), path.join(dir, "openapi.yaml"));
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  const runEnv = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1", NO_COLOR: "1", JGATES_LOCALE: "en", JGATES_SCHEMATHESIS: stProbe.executable ?? path.join(home, "no-st"), ...env };
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: runEnv, input: "", timeout: 600_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  const init = cli(["init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), tools);
  return {
    dir,
    home,
    cli,
    plan: () => cli(["plan", "--cwd", dir, "--json"]),
    run: (only) => cli(["run", "--cwd", dir, "--only", `tool:${only}`, "--no-interactive", "--json"]),
    cleanup: () => [dir, home].forEach((d) => fs.rmSync(d, { recursive: true, force: true })),
  };
}

// A runtime check is opt-in: the instance turns itself on (enabled: true); no template activates it by evidence.
const stTool = (extra = "") => `  schemathesis:\n    adapter: schemathesis\n    enabled: true\n    capabilities: [api-contract]\n${extra}`;
const zapTool = (extra = "") => `  zap:\n    adapter: zap\n    enabled: true\n    capabilities: [dast]\n${extra}`;
const toolsYml = (...tools) => `schemaVersion: 1\ntools:\n${tools.join("")}`;
const stageOf = (doc, id) => doc?.stages?.find((s) => s.id === id);
const itemOf = (planned, id) => planned.doc?.plan?.groups?.willRun?.find((i) => i.id === id);
const stOpts = { stageId: "schemathesis#api-contract", version: "4.33.1", specPath: "openapi.yaml", target: "http://127.0.0.1:1" };

test("runtime checks without a target: Schemathesis and ZAP are blocked with the reason, never passed", () => {
  const ws = setup(toolsYml(stTool(), zapTool()));
  try {
    const planned = ws.plan();
    for (const id of ["schemathesis#api-contract", "zap#dast"]) {
      const item = itemOf(planned, id);
      assert.ok(item, `${id} is planned: ${planned.out}${planned.err}`);
      assert.equal(item.availability.status, "unavailable", id);
      assert.match(item.availability.reason, /target/, id);
      assert.equal(item.network, true, id);
    }
    for (const [only, id] of [["schemathesis", "schemathesis#api-contract"], ["zap", "zap#dast"]]) {
      const result = ws.run(only);
      const stage = stageOf(result.doc, id);
      assert.ok(stage, `${id}: ${result.out}${result.err}`);
      assert.equal(stage.state, "blocked", id);
      assert.equal(stage.nativeStatus, "no-target", id);
      assert.match(stage.reason, /tools\.<instance>\.target/, id);
      assert.notEqual(result.doc.decision, "passed", id);
      assert.equal(result.doc.findings.length, 0, id);
    }
  } finally {
    ws.cleanup();
  }
});

test("schemathesis: a target violating its OpenAPI schema yields findings with a reproduction and the conforming twin none [proves: schemathesis#api-contract]", async (t) => {
  // The recorded real reports of Schemathesis 4.33.1 against the fixture server: always parsed.
  const bad = st.parseSchemathesisReports(recorded("schemathesis-violating.json"), recorded("schemathesis-violating.junit.xml"), stOpts);
  assert.equal(bad.ok, true, bad.problem);
  assert.deepEqual(bad.findings.map((f) => f.ruleId).sort(), ["ST101", "ST103", "ST108"]);
  for (const f of bad.findings) {
    assert.equal(f.tool, "schemathesis");
    assert.equal(f.category, "api-contract");
    assert.equal(f.blocking, true);
    assert.match(f.message, /GET \/users\/\{id\}/);
    assert.match(f.evidence, /^reproduce: curl -X GET http:\/\/127\.0\.0\.1:\d+\/users\/\d+/);
  }
  assert.equal(bad.findings.find((f) => f.ruleId === "ST101").normalizedSeverity, "critical");
  assert.match(bad.findings.find((f) => f.ruleId === "ST108").message, /password/);
  const good = st.parseSchemathesisReports(recorded("schemathesis-conforming.json"), recorded("schemathesis-conforming.junit.xml"), stOpts);
  assert.equal(good.ok, true, good.problem);
  assert.deepEqual(good.findings, []);
  assert.equal(good.errors.length, 0);
  assert.ok(good.tested > 0);

  if (!REAL_ST) {
    t.diagnostic(`Schemathesis is not installed (${stProbe.detail}): the live run did not happen; only the recorded Schemathesis 4.33.1 reports were parsed. Install it with jgates doctor --fix or pip install schemathesis.`);
    return;
  }
  // The real tool through the real plan and run, against the two fixture targets.
  const violating = await startTarget("violating");
  const conforming = await startTarget("conforming");
  const wsBad = setup(toolsYml(stTool(`    target: ${violating.url}\n    seed: 42\n    maxExamples: 30\n`)));
  const wsGood = setup(toolsYml(stTool(`    target: ${conforming.url}\n    seed: 42\n    maxExamples: 30\n`)));
  try {
    const failed = wsBad.run("schemathesis");
    assert.equal(failed.doc?.decision, "failed", failed.out + failed.err);
    const live = failed.doc.findings.filter((f) => f.tool === "schemathesis");
    assert.ok(live.some((f) => f.ruleId === "ST108"), JSON.stringify(live));
    assert.ok(live.some((f) => f.ruleId === "ST101"), JSON.stringify(live));
    for (const f of live) assert.ok(f.evidence.includes(`curl -X GET ${violating.url}/users/`), f.evidence);
    assert.equal(stageOf(failed.doc, "schemathesis#api-contract").state, "completed");
    const passed = wsGood.run("schemathesis");
    assert.equal(passed.doc?.decision, "passed", passed.out + passed.err);
    assert.equal(passed.doc.findings.filter((f) => f.tool === "schemathesis").length, 0);
    const stage = stageOf(passed.doc, "schemathesis#api-contract");
    assert.equal(stage.state, "completed");
    assert.notEqual(stage.interpreted, false);
    assert.match(stage.reason, /0 contract violation/);
    // Schemathesis works in the run folder: nothing (its .schemathesis cache, .hypothesis) is written in the workspace.
    for (const ws of [wsBad, wsGood]) assert.deepEqual(fs.readdirSync(ws.dir).filter((n) => /schemathesis|hypothesis/.test(n)), []);
    assert.equal(fs.existsSync(path.join(here, "..", "..", ".schemathesis")), false, "no cache in the repository root");
  } finally {
    violating.stop();
    conforming.stop();
    wsBad.cleanup();
    wsGood.cleanup();
  }
});

test("schemathesis reports: fail-closed on unfinished runs, unexplained failures, network errors and other documents", () => {
  const json = JSON.parse(recorded("schemathesis-violating.json"));
  const junit = recorded("schemathesis-violating.junit.xml");
  for (const [name, j, x] of [
    ["not json", "nope", junit],
    ["not a run report", "{}", junit],
    ["unfinished", JSON.stringify({ ...json, complete: false, stop_reason: "interrupted" }), junit],
    ["no junit", JSON.stringify(json), ""],
    ["failure not explained", JSON.stringify(json), recorded("schemathesis-conforming.junit.xml")],
  ]) {
    const parsed = st.parseSchemathesisReports(j, x, stOpts);
    assert.equal(parsed.ok, false, name);
    assert.deepEqual(parsed.findings, [], name);
  }
  // A network error is reported as such (the adapter turns it into an error stage), with nothing tested.
  const down = st.parseSchemathesisReports(JSON.stringify({ ...json, failures: [], errors: [{ title: "Network Error", count: 1 }], operations: { ...json.operations, tested: 0 } }), recorded("schemathesis-conforming.junit.xml"), stOpts);
  assert.equal(down.ok, true);
  assert.equal(down.tested, 0);
  assert.match(down.errors.join(" "), /Network Error/);
});

test("schemathesis plan: target, seed, examples, time bounds and auth reach the plan; the secret never does", () => {
  const ws = setup(toolsYml(stTool("    target: http://127.0.0.1:8765/\n    seed: 7\n    maxExamples: 12\n    requestTimeoutSeconds: 3\n    auth:\n      header: Authorization\n      valueEnv: FIXTURE_API_TOKEN\n")), { env: { FIXTURE_API_TOKEN: "Bearer s3cr3t-value" } });
  try {
    const planned = ws.plan();
    const item = itemOf(planned, "schemathesis#api-contract");
    assert.ok(item, planned.out + planned.err);
    assert.equal(item.category, "tests");
    assert.deepEqual(item.capabilities, ["api-contract"]);
    const args = item.command.args.join(" ");
    for (const part of ["--url http://127.0.0.1:8765", "--seed 7", "--max-examples 12", "--request-timeout 3", "--report json,junit"]) assert.ok(args.includes(part), `${part} in ${args}`);
    assert.ok(item.conditions.some((c) => /Authorization/.test(c) && /FIXTURE_API_TOKEN/.test(c)), item.conditions.join(" | "));
    // The stage bound is the plan's execution limit of the item.
    assert.ok(item.conditions.some((c) => c.includes(`${item.limits.timeoutSeconds} s for the stage`)), item.conditions.join(" | "));
    assert.equal(planned.out.includes("s3cr3t-value"), false, "the secret is not in the plan");
  } finally {
    ws.cleanup();
  }
  const badSettings = st.schemathesisSettings({ tool: "s", config: { tools: { s: { target: "ftp://x", spec: "../x.yaml", auth: { header: "A", valueEnv: "1BAD" }, seed: -1, maxExamples: 0, checks: ["rm_rf"] } } } });
  assert.equal(badSettings.problems.length, 6);
  const creds = st.schemathesisSettings({ tool: "s", config: { tools: { s: { target: "http://user:pw@localhost:1" } } } });
  assert.equal(creds.problems.length, 1);
});

test("schemathesis auth: the header value comes from its environment variable, a missing variable blocks, and the secret is not kept", async (t) => {
  if (!REAL_ST) {
    t.diagnostic(`Schemathesis is not installed (${stProbe.detail}): the authenticated live run did not happen.`);
    return;
  }
  const token = "fixture-token-3c1f9a";
  const target = await startTarget("conforming", token);
  const tools = toolsYml(stTool(`    target: ${target.url}\n    maxExamples: 10\n    auth:\n      header: Authorization\n      valueEnv: FIXTURE_API_TOKEN\n`));
  const withToken = setup(tools, { env: { FIXTURE_API_TOKEN: `Bearer ${token}` } });
  const without = setup(tools, { env: { FIXTURE_API_TOKEN: "" } });
  try {
    const passed = withToken.run("schemathesis");
    assert.equal(passed.doc?.decision, "passed", passed.out + passed.err);
    const runDir = path.join(withToken.home, "workspaces");
    const leaked = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : fs.readFileSync(path.join(d, e.name), "latin1").includes(token) && leaked.push(e.name)));
    walk(runDir);
    assert.deepEqual(leaked, [], "the secret is not stored in the run folder");
    const blocked = without.run("schemathesis");
    const stage = stageOf(blocked.doc, "schemathesis#api-contract");
    assert.equal(stage.state, "blocked");
    assert.equal(stage.nativeStatus, "no-auth");
    assert.match(stage.reason, /FIXTURE_API_TOKEN/);
    assert.notEqual(blocked.doc.decision, "passed");
  } finally {
    target.stop();
    withToken.cleanup();
    without.cleanup();
  }
});

test("zap: the passive API scan of a target missing security headers yields alerts and the hardened twin none [proves: zap#dast]", async (t) => {
  // The recorded real report of ZAP 2.17.0 (zap-api-scan.py -S) against the violating fixture: always parsed.
  const low = zap.parseZapReport(recorded("zap-api-violating.json"), { stageId: "zap#dast", blockingRisk: "low" });
  assert.equal(low.ok, true, low.problem);
  // The missing nosniff (10021) and CORP (90004) headers are low-risk alerts; the informational one (10049) never blocks.
  const blockingOf = (findings) => [...new Set(findings.filter((f) => f.blocking).map((f) => f.ruleId.split("-")[0]))].sort();
  assert.deepEqual(blockingOf(low.findings), ["10021", "90004"]);
  assert.ok(low.findings.filter((f) => !f.blocking).every((f) => f.normalizedSeverity === "info"));
  for (const f of low.findings.filter((x) => x.blocking)) {
    assert.equal(f.tool, "zap");
    assert.equal(f.category, "dast");
    assert.equal(f.normalizedSeverity, "low");
    assert.equal(f.blocking, true);
    assert.match(f.evidence, /^reproduce: GET http:\/\/host\.docker\.internal:\d+\/users\//);
  }
  const medium = zap.parseZapReport(recorded("zap-api-violating.json"), { stageId: "zap#dast", blockingRisk: "medium" });
  assert.equal(medium.findings.every((f) => f.blocking === false), true, "low alerts do not block at medium");

  if (!REAL_ZAP) {
    t.diagnostic(`ZAP is not available (${zapProbe.problem}: ${zapProbe.detail}): the live scan did not run; only the recorded ZAP 2.17.0 report was parsed. Pull it with docker pull ghcr.io/zaproxy/zaproxy:stable.`);
    return;
  }
  const violating = await startTarget("violating");
  const conforming = await startTarget("conforming");
  const settings = (url) => `    target: ${url}\n    spec: openapi.yaml\n    blockingRisk: low\n`;
  const wsBad = setup(toolsYml(zapTool(settings(violating.url))));
  const wsGood = setup(toolsYml(zapTool(settings(conforming.url))));
  try {
    const failed = wsBad.run("zap");
    assert.equal(failed.doc?.decision, "failed", failed.out + failed.err);
    const live = failed.doc.findings.filter((f) => f.tool === "zap");
    assert.deepEqual(blockingOf(live), ["10021", "90004"], JSON.stringify(live));
    // The URLs the container saw are mapped back to the target the plan names.
    for (const f of live) assert.ok(f.evidence.includes(`${violating.url}/users/`), f.evidence);
    const passed = wsGood.run("zap");
    assert.equal(passed.doc?.decision, "passed", passed.out + passed.err);
    // The hardened twin: no alert of risk low or higher (informational notes may remain and never block).
    assert.deepEqual(blockingOf(passed.doc.findings.filter((f) => f.tool === "zap")), []);
    assert.ok(passed.doc.findings.filter((f) => f.tool === "zap").every((f) => f.normalizedSeverity === "info"));
    assert.equal(stageOf(passed.doc, "zap#dast").state, "completed");
    // --rm and the run-owned name: no ZAP container is left behind.
    const left = spawnSync("docker", ["ps", "-a", "--filter", "label=org.jgates.adapter=zap", "--format", "{{.Names}}"], { encoding: "utf8" });
    assert.equal(left.stdout.trim(), "");
  } finally {
    violating.stop();
    conforming.stop();
    wsBad.cleanup();
    wsGood.cleanup();
  }
});

test("zap active mode: refused unless explicitly allowed, and then the plan lists its effects", () => {
  // mode: active alone is refused: the plan is blocked with the reason and the run never starts a scan.
  const refused = setup(toolsYml(zapTool("    target: http://127.0.0.1:8765\n    mode: active\n")));
  try {
    const planned = refused.plan();
    const blocker = planned.doc?.plan?.blockers?.find((b) => b.items?.includes("zap#dast")) ?? planned.doc?.blockers?.find((b) => b.items?.includes("zap#dast"));
    assert.ok(blocker, planned.out + planned.err);
    assert.match(blocker.message, /allowActive: true/);
    const run = refused.run("zap");
    assert.notEqual(run.code, 0);
    assert.notEqual(run.doc?.decision, "passed");
    assert.equal((run.doc?.findings ?? []).length, 0);
  } finally {
    refused.cleanup();
  }
  assert.ok(zap.zapSettings({ tool: "z", config: { tools: { z: { target: "http://127.0.0.1:1", mode: "active", allowActive: false } } } }).problems.length === 1);

  // Explicitly allowed: the plan says ACTIVE, lists the effects on the target and runs the attack script.
  const allowed = setup(toolsYml(zapTool("    target: http://127.0.0.1:8765\n    spec: openapi.yaml\n    mode: active\n    allowActive: true\n")));
  try {
    const planned = allowed.plan();
    const item = itemOf(planned, "zap#dast");
    assert.ok(item, planned.out + planned.err);
    assert.equal(item.category, "security");
    assert.ok(item.conditions.some((c) => /ACTIVE/.test(c)), item.conditions.join(" | "));
    assert.ok(item.conditions.some((c) => /attack payloads/.test(c)), item.conditions.join(" | "));
    assert.ok(item.conditions.some((c) => /change or delete data/.test(c)), item.conditions.join(" | "));
    assert.ok(item.command.args.includes("zap-api-scan.py") && !item.command.args.includes("-S"), item.command.args.join(" "));
    assert.ok(item.command.args.includes("never") && item.command.args.includes("--rm"));
    assert.ok(item.command.args.includes("http://host.docker.internal:8765"), item.command.args.join(" "));
  } finally {
    allowed.cleanup();
  }
  // Passive: the safe API scan (-S) or the baseline, never the attack scripts.
  const passive = zap.zapScript({ mode: "passive", spec: "openapi.yaml", spiderMinutes: 1 }, "http://localhost:3000");
  assert.ok(passive.includes("-S") && passive.includes("http://host.docker.internal:3000"));
  assert.equal(zap.zapScript({ mode: "passive", spec: null, spiderMinutes: 2 }, "https://staging.example.test")[0], "zap-baseline.py");
  assert.equal(zap.zapScript({ mode: "active", spec: null, spiderMinutes: 2 }, "https://staging.example.test")[0], "zap-full-scan.py");
});

test("zap report: fail-closed on other documents and on a report without any scanned site", () => {
  for (const bad of ["", "nope", "{}", JSON.stringify({ "@programName": "ZAP", site: [] }), JSON.stringify({ "@programName": "ZAP", site: [{ "@name": "x", alerts: [{ name: "no plugin" }] }] })]) {
    const parsed = zap.parseZapReport(bad, { stageId: "zap#dast", blockingRisk: "medium" });
    assert.equal(parsed.ok, false, bad);
    assert.deepEqual(parsed.findings, []);
  }
  // Confidence 0 is ZAP's own false-positive mark; an unknown risk blocks.
  const doc = { "@programName": "ZAP", "@version": "2.17.0", site: [{ "@name": "http://t", alerts: [
    { pluginid: "1", alert: "fp", riskcode: "3", confidence: "0", instances: [] },
    { pluginid: "2", alert: "odd", riskcode: "9", confidence: "2", instances: [{ uri: "http://t/a", method: "GET" }] },
  ] }] };
  const parsed = zap.parseZapReport(JSON.stringify(doc), { stageId: "zap#dast", blockingRisk: "high" });
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].blocking, true);
});

test("runtime API manifests: catalog domains, capabilities, distribution and matrix rows", () => {
  const all = manifests.builtinManifests();
  const s = all.find((m) => m.id === "schemathesis");
  const z = all.find((m) => m.id === "zap");
  assert.deepEqual([s.categories, s.capabilities], [["tests"], ["api-contract"]]);
  assert.deepEqual([z.categories, z.capabilities], [["security"], ["dast"]]);
  assert.equal(s.distribution.spdx, "MIT");
  assert.equal(z.distribution.mode, "customer-supplied");
  assert.equal(z.distribution.spdx, "Apache-2.0");
  for (const m of [s, z]) {
    assert.equal(m.effects.usesNetwork, true);
    assert.equal(m.effects.needsService, true);
    assert.equal(m.effects.mayChangeCode, false);
    assert.equal(m.stackSupport[0].state, "validated");
  }
  const built = matrix.buildMatrix();
  assert.deepEqual(matrix.verifyMatrix(built).filter((p) => /schemathesis|zap/.test(p)), []);
  const rows = JSON.stringify(built);
  assert.ok(rows.includes("schemathesis") && rows.includes("api-contract") && rows.includes("dast"));
});
