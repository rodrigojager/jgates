// V2-84: a reproduced finding shows as confirmed by execution on the run it came from, asked for from the terminal. An
// earlier security audit left three findings needs-validation (tests/v2/fixtures/reproduction). `jgates semantic run
// --method confirm-by-reproduction --from <that run>` (scripted model, fake engine replaying the reproducers' container
// runs) prints first how many findings it tries, the model calls it may spend and that the tests run in a container
// without network. Afterwards the earlier run, never rewritten, shows through `jgates semantic status`, the history and
// the views the screens read: the finding whose reproducer failed for the defect as confirmed, with the evidence basis
// execution and the reproduction run; the one whose reproducer passed and the one whose reproducer did not load as
// needs-validation with "reproduction attempted" and the reason, never rejected. The reproducer that reproduced is a
// regression proposal that only `jgates regressions incorporate <id> --approve` applies. Without the method nothing
// executes and no model call is spent, and no test process starts on the host in any part of the case.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as R from "./fixtures/reproduction/helpers.mjs";

const { TESTS, LINES, SEED_RUN, read, answer, readJson, treeHash } = R;
const { workspaceId } = await R.load("core/ids/index.js");
const { semanticRunsDir } = await R.load("core/semantic/index.js");
const { reproduction } = await R.load("core/semantic-modules/index.js");
const views = await R.load("server/routes/semantic-views.js");
const runsRoutes = await R.load("server/routes/semantic-runs.js");
const METHOD = "confirm-by-reproduction";

/** The JSON tool script of the mock provider: a reproducer per finding (C1 to C3 of the reproduction run), one assessment. */
function reproductionScript() {
  const repro = (p, test) => [read([p]), answer({ summary: `One reproducer for the finding in ${p}.`, defect: `the behavior the finding in ${p} describes`, test })];
  return {
    contexts: {
      "reproducer:C1": repro("src/pricing.py", TESTS.discountBound),
      "reproducer:C2": repro("src/inventory.py", TESTS.reserveLimit),
      "reproducer:C3": repro("src/auth.py", TESTS.tokenExpiry),
      "assessment:C1": [
        read(["src/pricing.py"]),
        answer({ candidateId: "C1", cause: "defect", reason: "The failing assertion is the negative total the finding describes, on the line it cites.", evidence: [{ path: "src/pricing.py", line: LINES["src/pricing.py"], note: "percent is never bounded" }] }),
      ],
    },
  };
}

/**
 * A module preloaded into every node process the CLI starts (NODE_OPTIONS): a host process that would run a test
 * (node:test, the permission model, pytest) is refused and logged. The container engine client itself is let through.
 */
const GUARD = String.raw`"use strict";
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const log = process.env.V2_84_HOST_TEST_LOG;
const engine = process.env.JGATES_CONTAINER_RUNTIME ? path.resolve(process.env.JGATES_CONTAINER_RUNTIME) : null;
const isNode = (c) => c === process.execPath || /(^|[\\/])node(\.exe)?$/i.test(c);
function isTest(command, args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const c = String(command);
  if (engine && (path.resolve(c) === engine || (list[0] && path.resolve(list[0]) === engine))) return false;
  const text = [c, ...list].join(" ");
  if (isNode(c) && list.some((a) => a.startsWith("--test") || a.startsWith("--permission") || /\.test\.(mjs|cjs|js)$/.test(a))) return true;
  if (/(^|[\\/])(pytest|py\.test)(\.exe)?$/i.test(c) || /(^|[\\/\s])python[0-9.]*(\.exe)?\s.*-m\s+pytest\b/i.test(text)) return true;
  return /--test-reporter|\bpytest\b|(^|[\\/\s])test_[a-z0-9_]+\.py\b/.test(text);
}
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "fork", "exec", "execSync"]) {
  const original = cp[name];
  cp[name] = function guarded(command, args, ...rest) {
    const call = name === "fork" ? [process.execPath, [command, ...(Array.isArray(args) ? args : [])]] : [command, args];
    if (isTest(call[0], call[1])) {
      if (log) fs.appendFileSync(log, JSON.stringify({ pid: process.pid, via: name, command: String(command), args: Array.isArray(args) ? args.map(String) : [] }) + "\n");
      throw new Error("a test was about to run as a host process (" + name + " " + String(command) + ")");
    }
    return original.call(this, command, args, ...rest);
  };
}
syncBuiltinESMExports();
`;

/** The guard's variables for the CLI processes of a workspace, and the attempts it logged so far. */
function hostGuard(ws) {
  const file = path.join(ws.root, "host-test-guard.cjs");
  const log = path.join(ws.root, "host-tests.jsonl");
  fs.writeFileSync(file, GUARD);
  fs.writeFileSync(log, "");
  const env = { NODE_OPTIONS: `--require "${file.replace(/\\/g, "/")}"`, V2_84_HOST_TEST_LOG: log };
  const attempts = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { env, attempts };
}

/** The Semantic run folders of the workspace. */
const runFolders = (ws) => {
  const dir = semanticRunsDir(ws.home, workspaceId(ws.dir));
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith("sem_")).sort() : [];
};

/** A server context for the route handlers the screens call (same workspace and data folder as the CLI). */
function serverFor(ws) {
  return { home: ws.home, projectDir: ws.dir, policyMode: false, workspace: { id: workspaceId(ws.dir), path: ws.dir, name: "v2-84" }, version: "0.0.0-test", log: () => undefined };
}
const route = (routes, method, routePath) => {
  const found = routes.find((r) => r.method === method && r.path === routePath);
  assert.ok(found, `route ${method} ${routePath} exists`);
  return found;
};

const byCandidate = (findings) => Object.fromEntries(findings.map((f) => [f.candidateId, f]));

test("V2-84: confirm by reproduction, asked for from the terminal, shows each needs-validation finding of the earlier run as confirmed by execution or as reproduction attempted, without rewriting it and without any host test process", async () => {
  const { ws, seed } = await R.reproductionWorkspace("v2-84");
  const guard = hostGuard(ws);
  const cli = R.cliFor(ws);
  const run = (args, options = {}) => cli(args, { ...options, env: { ...guard.env, ...(options.env ?? {}) } });
  try {
    // The guard itself: a node process started with it refuses a host test and logs the attempt.
    const probe = spawnSync(process.execPath, ["-e", "try { require('node:child_process').spawnSync('pytest', ['-q', 'test_probe.py']); } catch (e) { process.exit(7); }"], { env: { ...ws.env, ...guard.env }, encoding: "utf8" });
    assert.equal(probe.status, 7, probe.stderr);
    assert.equal(guard.attempts().length, 1, "the guard logs a refused host test");
    fs.writeFileSync(path.join(ws.root, "host-tests.jsonl"), "");

    const projectBefore = treeHash(ws.dir);
    const seedBefore = treeHash(seed.dir);
    const seedResultBefore = fs.readFileSync(seed.file);

    // 1. Without the method, nothing reproduces: no purpose plans it, --from alone is refused, nothing runs or is spent.
    for (const purpose of ["general-review", "security"]) {
      const planned = run(["semantic", "plan", "--cwd", ws.dir, "--purpose", purpose, "--json"]);
      assert.equal(planned.code, 0, planned.err);
      assert.ok(!planned.doc.plan.methods.some((m) => m.id === METHOD), `${purpose} never plans ${METHOD}`);
      assert.equal(planned.doc.plan.reproduction, undefined);
    }
    const listed = run(["semantic", "methods", "--cwd", ws.dir, "--json"]);
    assert.deepEqual(listed.doc.methods.find((m) => m.id === METHOD).purposes, [], "no purpose selects it");
    const alone = run(["semantic", "run", "--cwd", ws.dir, "--from", SEED_RUN, "--json"], { script: reproductionScript() });
    assert.equal(alone.code, 3, alone.out);
    assert.equal(alone.doc.code, "REPRODUCTION_WITHOUT_METHOD");
    const findingAlone = run(["semantic", "run", "--cwd", ws.dir, "--method", METHOD, "--finding", "C1", "--json"], { script: reproductionScript() });
    assert.equal(findingAlone.doc.code, "FINDING_WITHOUT_FROM");
    assert.deepEqual(runFolders(ws), [SEED_RUN], "no Semantic run was started");
    assert.deepEqual(R.testContainers(ws), [], "nothing was executed");

    // 2. The plan says, before anything starts, how many findings it tries, the call budget and the container.
    const previewText = run(["semantic", "plan", "--cwd", ws.dir, "--method", METHOD, "--from", SEED_RUN, "--finding", "C2"]);
    assert.equal(previewText.code, 0, previewText.err);
    assert.match(previewText.out, new RegExp(`Confirm by reproduction from ${SEED_RUN}: 1 finding, up to 24 model calls; the project's tests run in a container without network\\.`));
    assert.match(previewText.out, /A failed reproduction never rejects a finding and never lowers its severity\./);

    // 3. The reproduction of every needs-validation finding of the earlier run, from the terminal (--json).
    const repro = run(["semantic", "run", "--cwd", ws.dir, "--method", METHOD, "--from", SEED_RUN, "--json"], { script: reproductionScript() });
    assert.ok(repro.doc, `one JSON document: ${repro.out.slice(0, 400)} ${repro.err.slice(0, 400)}`);
    const result = repro.doc;
    assert.equal(repro.code, result.exitCode);
    assert.equal(result.semanticRun.outcome.state, "completed", result.semanticRun.outcome.reason);
    assert.deepEqual(result.semanticRun.methods, [METHOD]);
    // The same numbers the text prints first: the findings it tries, the budget, the container without network.
    assert.deepEqual(
      { from: result.reproduction.from, seedRun: result.reproduction.seedRun, findingsToTry: result.reproduction.findingsToTry, maxCalls: result.reproduction.budget.maxCalls, execution: result.reproduction.execution },
      { from: SEED_RUN, seedRun: SEED_RUN, findingsToTry: 3, maxCalls: 24, execution: { where: "container", network: "none", host: false, runners: ["node:test", "pytest"] } },
    );
    const calls = result.semanticRun.outcome.calls;
    assert.ok(calls > 0 && calls <= result.reproduction.budget.maxCalls, `${calls} model calls within the budget`);
    const reproRun = result.runId;
    const doc = readJson(path.join(result.runDir, reproduction.REPRODUCTION_FILE));
    assert.equal(doc.seedRun.runId, SEED_RUN);
    assert.deepEqual(Object.fromEntries(doc.findings.map((f) => [f.finding.candidateId, [f.outcome, f.reason]])), { C1: ["reproduced", null], C2: ["attempted", "REPRODUCER_PASSED"], C3: ["attempted", "REPRODUCER_DID_NOT_LOAD"] });

    // Every reproducer ran in a container without network, never on the host.
    const containers = R.testContainers(ws);
    assert.equal(containers.length, 3);
    for (const c of containers) {
      assert.equal(c.network, "none");
      assert.equal(c.labels["org.jgates.test-runner"], "pytest");
      assert.ok(c.mounts.every((m) => !String(m.src).startsWith(ws.dir)), "the project folder is never mounted");
    }

    // 4. The earlier run as `jgates semantic status` shows it: confirmed by execution, or reproduction attempted.
    const status = run(["semantic", "status", SEED_RUN, "--cwd", ws.dir, "--json"]);
    assert.equal(status.code, 0, status.err);
    const linked = byCandidate(status.doc.run.reproduction.findings);
    assert.deepEqual(Object.keys(linked).sort(), ["C1", "C2", "C3"], "the needs-validation findings (the confirmed and the rejected ones are not reproduced)");
    assert.deepEqual(
      [linked.C1.state, linked.C1.confirmation, linked.C1.recordedConfirmation, linked.C1.evidenceBasis, linked.C1.reproductionRunId, linked.C1.record, linked.C1.severity],
      ["confirmed", "confirmed", "needs-validation", "execution", reproRun, reproduction.REPRODUCTION_FILE, "blocking"],
    );
    assert.deepEqual([linked.C2.state, linked.C2.confirmation, linked.C2.reason, linked.C2.reproductionRunId, linked.C2.severity], ["attempted", "needs-validation", "REPRODUCER_PASSED", reproRun, "important"]);
    assert.deepEqual([linked.C3.state, linked.C3.confirmation, linked.C3.reason, linked.C3.reproductionRunId], ["attempted", "needs-validation", "REPRODUCER_DID_NOT_LOAD", reproRun]);
    for (const f of status.doc.run.reproduction.findings) {
      assert.notEqual(f.confirmation, "rejected", `${f.candidateId} is never rejected`);
      assert.equal(f.evidenceBasis === "execution", f.state === "confirmed", `${f.candidateId}: the basis execution only with a confirmation`);
    }
    const statusText = run(["semantic", "status", SEED_RUN, "--cwd", ws.dir]);
    assert.match(statusText.out, new RegExp(`C1  confirmed by execution \\(run ${reproRun}\\)  A discount above 100%`));
    assert.match(statusText.out, new RegExp(`C2  needs validation, reproduction attempted \\(run ${reproRun}\\): the reproducer passed, so the defect was not shown`));
    assert.match(statusText.out, /C3  needs validation, reproduction attempted .*: the reproducer did not run to a verdict/);

    // 5. One finding, in text: the cost comes first, then the run; a later attempt never undoes the confirmation.
    const one = run(["semantic", "run", "--cwd", ws.dir, "--method", METHOD, "--from", SEED_RUN, "--finding", "C2"], { script: reproductionScript() });
    const costAt = one.out.indexOf(`Confirm by reproduction from ${SEED_RUN}: 1 finding, up to 24 model calls; the project's tests run in a container without network.`);
    assert.ok(costAt >= 0, one.out);
    assert.ok(costAt < one.out.indexOf("Run sem_"), "the cost is printed before the run");
    const secondRun = /Run (sem_[0-9A-Za-z_]+):/.exec(one.out)?.[1];
    assert.ok(secondRun && secondRun !== reproRun, one.out);
    assert.equal(R.testContainers(ws).length, 4, "one more container, for C2 only");

    // 6. The history and the views the screens read return the same state and the reproduction run.
    const history = run(["semantic", "history", "--cwd", ws.dir, "--json"]);
    const seedEntry = history.doc.runs.find((r) => r.runId === SEED_RUN);
    const h = byCandidate(seedEntry.reproduction.findings);
    assert.deepEqual([h.C1.state, h.C1.reproductionRunId, h.C2.state, h.C2.reproductionRunId, h.C2.runs, h.C3.state], ["confirmed", reproRun, "attempted", secondRun, [reproRun, secondRun], "attempted"]);
    assert.deepEqual(seedEntry.reproduction.counts, { confirmed: 1, attempted: 2, none: 0 });
    assert.equal(history.doc.runs.find((r) => r.runId === reproRun).reproduction.reproduces, SEED_RUN, "the reproduction run names the run it starts from");
    const historyText = run(["semantic", "history", "--cwd", ws.dir]);
    assert.match(historyText.out, /1 confirmed by execution, 2 reproductions attempted/);

    const server = serverFor(ws);
    const report = route(views.routes, "GET", "/api/semantic/runs/:id/report").handler({ params: { id: SEED_RUN }, query: {}, server }).json.report;
    const r = byCandidate(report.reproduction.findings);
    assert.deepEqual([r.C1.state, r.C1.confirmation, r.C1.evidenceBasis, r.C1.reproductionRunId], ["confirmed", "confirmed", "execution", reproRun]);
    assert.deepEqual([r.C2.state, r.C2.reason, r.C3.state, r.C3.reason], ["attempted", "REPRODUCER_PASSED", "attempted", "REPRODUCER_DID_NOT_LOAD"]);
    const view = route(views.routes, "GET", "/api/semantic/runs/:id/reproduction").handler({ params: { id: SEED_RUN }, query: {}, server }).json.reproduction;
    assert.deepEqual(view.findings.map((f) => [f.candidateId, f.state, f.reproductionRunId]), [["C1", "confirmed", reproRun], ["C2", "attempted", secondRun], ["C3", "attempted", reproRun]]);
    const apiHistory = route(runsRoutes.routes, "GET", "/api/semantic/runs").handler({ params: {}, query: {}, server }).json.runs;
    assert.equal(byCandidate(apiHistory.find((x) => x.runId === SEED_RUN).reproduction.findings).C1.reproductionRunId, reproRun);
    const apiRun = route(runsRoutes.routes, "GET", "/api/semantic/runs/:id").handler({ params: { id: SEED_RUN }, query: {}, server }).json.run;
    assert.equal(byCandidate(apiRun.reproduction.findings).C1.evidenceBasis, "execution");

    // 7. The reproducer that reproduced is a regression proposal; only --approve would apply it.
    assert.equal(linked.C1.proposal, `${reproRun}/P1`);
    const proposals = run(["regressions", "list", "--cwd", ws.dir, "--json"]);
    assert.deepEqual(proposals.doc.proposals.map((p) => [p.ref, p.method, p.file, p.incorporated]), [[`${reproRun}/P1`, METHOD, "test_discount_bound.py", null]]);
    const unapproved = run(["regressions", "incorporate", `${reproRun}/P1`, "--cwd", ws.dir, "--json"]);
    assert.equal(unapproved.code, 3);
    assert.equal(unapproved.doc.code, "APPROVAL_REQUIRED");

    // 8. Nothing changed where it must not: the project, the earlier run (byte for byte), and no host test process.
    assert.equal(treeHash(ws.dir), projectBefore, "the project folder is byte for byte the same");
    assert.equal(treeHash(seed.dir), seedBefore, "the files of the earlier run are byte-identical");
    assert.deepEqual(fs.readFileSync(seed.file), seedResultBefore);
    assert.deepEqual(guard.attempts(), [], "no test process started on the host");
    for (const args of R.engineCalls(ws).filter((a) => a[0] === "run")) assert.ok(args.some((a, i) => args[i - 1] === "--network" && a === "none"), "no container has a network");
  } finally {
    ws.cleanup();
  }
});
