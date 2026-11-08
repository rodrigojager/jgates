import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The general review module (core/semantic-modules/general-review, method `general-review`): the six dimensions of the
// semantic-gate rubric under evidence planning, hypothesis testing and an independent challenge, run through the real
// executor with a scripted fake model (no tokens). The host decides each dimension's state: examined only for files the
// hunting context read, pending (with its reason) for everything else, in full, selected and incremental scope alike.

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const helpers = await import(pathToFileURL(path.join(ROOT, "tests", "v2", "fixtures", "semantic-executor", "helpers.mjs")).href);
const { load, setupWorkspace, readJson } = helpers;
const modules = await load("core/semantic-modules/index.js");
const { buildSemanticPlan, executeSemanticRun } = await load("core/semantic/index.js");
const gr = modules.generalReview;

const DIMENSIONS = ["functional-correctness", "tests", "maintainability", "architecture", "performance-reliability", "security"];
const FILES = {
  "src/app.js": ["exports.total = (items) => {", "  let sum = 0;", "  for (const i of items) sum += i.price;", "  return sum;", "};", ""].join("\n"),
  "src/app.test.js": ['const { total } = require("./app");', 'console.log(total([{ price: 1 }]));', ""].join("\n"),
};

const read = (paths) => ({ toolCalls: paths.map((p) => ({ name: "read_file", arguments: { path: p } })) });
const answer = (value) => ({ text: JSON.stringify(value), usage: { inputTokens: 100, outputTokens: 50 } });
function listed(brief, heading) {
  const at = brief.indexOf(heading);
  if (at < 0) return [];
  const out = [];
  for (const l of brief.slice(at).split("\n").slice(1)) {
    const m = /^ {2}- (.+)$/.exec(l);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

/** A scripted reviewer. `pending` dimensions are reported pending; `overclaim` marks one examined without reading anything. */
function fakeReviewer({ pending = ["performance-reliability"], overclaim = null, omit = [], requests = [] } = {}) {
  return (request) => {
    requests.push({ label: request.contextLabel, brief: request.messages[0].text });
    const stage = request.contextLabel.split(":")[0];
    const turn = request.messages.filter((m) => m.role === "assistant").length;
    const brief = request.messages[0].text;
    const subjects = listed(brief, "Subjects to examine");
    if (stage === "evidence-planning") {
      if (turn === 0) return read(subjects);
      return answer({ summary: "A pricing helper and its test.", dimensions: DIMENSIONS.map((id) => ({ id, files: subjects, hypotheses: [`${id}: a hypothesis to test`] })) });
    }
    if (stage === "hunting") {
      if (turn === 0) return read(subjects);
      const dimensions = DIMENSIONS.filter((id) => !omit.includes(id)).map((id) =>
        pending.includes(id)
          ? { id, state: "pending", reviewed_paths: [], checks: [], reason: "ran out of budget before the loops were examined" }
          : id === overclaim
            ? { id, state: "examined", reviewed_paths: ["src/never-read.js"], checks: ["looked at it"] }
            : { id, state: "examined", reviewed_paths: subjects.filter((p) => !p.endsWith(".test.js")), checks: [`checked ${id}`] },
      );
      return answer({
        summary: "One candidate.",
        dimensions,
        candidates: [{ title: "Items without a price add NaN", path: "src/app.js", line: 3, severity: "important", category: "functional-correctness", rationale: "i.price may be undefined and sum becomes NaN.", hypothesis: "functional-correctness: a hypothesis to test" }],
        gaps: [],
      });
    }
    if (stage === "challenge") {
      if (turn === 0) return read(["src/app.js"]);
      return answer({ candidateId: "C1", confirmation: "confirmed", reason: "No guard on price before the addition.", evidence: [{ path: "src/app.js", line: 3, note: "the addition has no guard" }] });
    }
    return { text: "" };
  };
}

async function run(ws, { scope = null, script }) {
  const plan = buildSemanticPlan({ workspacePath: ws.dir, home: ws.home, env: ws.env, scope, purpose: "general-review" });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.deepEqual(plan.methods.map((m) => m.id), ["general-review"]);
  const result = await executeSemanticRun({ workspacePath: ws.dir, home: ws.home, env: ws.env, version: "0.0.0-test", plan, cancelPollMs: 50, investigation: { deps: { script } } });
  const outcome = result.semanticRun.outcome;
  const coverage = readJson(path.join(result.runDir, "evidence", "general-review", "dimension-coverage.json"));
  return { plan, result, outcome, investigation: outcome.investigation, coverage };
}

const byId = (doc, id) => doc.dimensions.find((d) => d.id === id);

test("registration: the general review is an investigation module with the six dimensions and three stages", () => {
  assert.deepEqual(modules.unavailableModules, []);
  assert.ok(modules.registeredInvestigationModules().some((m) => m.methodId === "general-review" && m.module === "general-review"));
  assert.deepEqual(gr.DIMENSIONS.map((d) => d.id), DIMENSIONS);
  assert.deepEqual(gr.generalReviewModule().stages.map((s) => s.id), ["evidence-planning", "hunting", "challenge"]);
});

test("purpose general-review reports each of the six dimensions as examined or pending with a scripted model", async () => {
  const ws = setupWorkspace("gr-full", FILES);
  try {
    const requests = [];
    const { outcome, investigation, coverage } = await run(ws, { script: fakeReviewer({ requests }) });
    assert.equal(coverage.dimensions.length, 6);
    assert.deepEqual(coverage.dimensions.map((d) => d.id), DIMENSIONS);
    for (const d of coverage.dimensions) assert.ok(d.state === "examined" || d.state === "pending", d.id);
    assert.equal(byId(coverage, "performance-reliability").state, "pending");
    assert.match(byId(coverage, "performance-reliability").reason, /budget/);
    assert.equal(byId(coverage, "security").state, "examined");
    assert.ok(byId(coverage, "security").reviewedPaths.includes("src/app.js"), "files the hunting context read count");
    assert.equal(byId(coverage, "security").reviewedPaths.includes("src/app.test.js"), false, "the script did not list the test file for this dimension");
    assert.equal(byId(coverage, "functional-correctness").candidates.confirmed, 1, "the independent challenge confirmed the candidate");
    // The coverage is also in the investigation record and the pending dimension is a coverage gap.
    assert.equal(investigation.report.examined, 5);
    assert.equal(investigation.report.pending, 1);
    assert.ok(investigation.coverage.gaps.some((g) => g.code === "DIMENSION_PENDING" && /Performance/.test(g.reason)));
    assert.equal(outcome.state, "completed");
    assert.ok(requests.some((r) => r.label.startsWith("challenge")), "a fresh context challenged the candidate");
    assert.match(requests.find((r) => r.label.startsWith("evidence-planning")).brief, /Scope mode: full/);
  } finally {
    ws.cleanup();
  }
});

test("a dimension claimed examined for a file nobody read, or left out of the report, stays pending", async () => {
  const ws = setupWorkspace("gr-honest", FILES);
  try {
    const { coverage } = await run(ws, { script: fakeReviewer({ pending: [], overclaim: "tests", omit: ["architecture"] }) });
    assert.equal(byId(coverage, "tests").state, "pending");
    assert.match(byId(coverage, "tests").reason, /no file listed|never read|read in this context/);
    assert.equal(byId(coverage, "architecture").state, "pending");
    assert.match(byId(coverage, "architecture").reason, /did not report/);
    assert.equal(byId(coverage, "maintainability").state, "examined");
  } finally {
    ws.cleanup();
  }
});

test("the same module runs in selected and incremental scope and retains all six dimensions", async () => {
  const ws = setupWorkspace("gr-scopes", FILES);
  try {
    const selected = await run(ws, { scope: { mode: "selected", subjects: [{ kind: "path", value: "src/app.js" }] }, script: fakeReviewer() });
    assert.deepEqual(selected.coverage.dimensions.map((d) => d.id), DIMENSIONS);
    assert.equal(selected.coverage.scopeMode, "selected");
    assert.equal(byId(selected.coverage, "security").state, "examined");

    const base = ws.git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(ws.dir, "src", "app.js"), `${FILES["src/app.js"]}// reviewed change\n`);
    ws.git("add", "-A");
    ws.git("commit", "-q", "-m", "change");
    const incremental = await run(ws, { scope: { mode: "incremental", base }, script: fakeReviewer({ pending: ["tests", "architecture"] }) });
    assert.deepEqual(incremental.coverage.dimensions.map((d) => d.id), DIMENSIONS);
    assert.equal(incremental.coverage.scopeMode, "incremental");
    assert.deepEqual(incremental.coverage.dimensions.filter((d) => d.state === "pending").map((d) => d.id), ["tests", "architecture"]);
    assert.equal(byId(incremental.coverage, "functional-correctness").state, "examined");
    assert.deepEqual(gr.readDimensionCoverage(incremental.result.runDir).map((d) => d.id), DIMENSIONS);
  } finally {
    ws.cleanup();
  }
});
