import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { readEvents, readJson, recordingScript, runInvestigation, setupWorkspace, usage } from "./fixtures/semantic-executor/helpers.mjs";

// V2-10: the budget ends before the required validation. The investigation executor reserves validation capacity
// before hunting; a scripted model hunts, reports candidates and wants to keep going. (a) One hunting call reports real
// usage beyond the whole token budget: the budget ends right after hunting, no validation call is ever sent, every
// candidate stays unresolved, the coverage gaps are listed and the run is incomplete. (b) A call budget: hunting is
// stopped at its share (the model is asked to conclude, its extra tool calls are not executed), the reserved call goes
// to the validation of the first candidate, the others stay unresolved, and the run is incomplete, never favorable.

const FILES = {
  "src/app.js": [
    'const db = require("./db");',
    "exports.find = (req) => {",
    '  return db.query("SELECT * FROM users WHERE id = " + req.query.id);',
    "};",
    'exports.remove = (req) => db.query("DELETE FROM users WHERE id = " + req.params.id);',
    "",
  ].join("\n"),
  "src/db.js": ["exports.query = (sql) => {", "  return { sql };", "};", ""].join("\n"),
  "src/util.js": "exports.noop = () => {};\n",
};

const report = (title, p, line, severity = "blocking") => ({ name: "report_candidate", arguments: { title, path: p, line, severity, category: "security", rationale: `${title}: user input reaches the query text.` } });

test("V2-10: a budget that ends after hunting leaves the candidates unresolved, lists the coverage gaps and ends incomplete", async () => {
  // (a) The token budget ends right after hunting: one hunting call reported more than the whole budget.
  {
    const ws = setupWorkspace("v2-10a", FILES);
    try {
      const { script, requests } = recordingScript({
        hunt: [
          { toolCalls: [{ name: "read_file", arguments: { path: "src/app.js" } }, report("SQL injection in find", "src/app.js", 3), report("SQL injection in remove", "src/app.js", 5)], usage: usage(1100, 100) },
          { text: JSON.stringify({ summary: "never reached" }), usage: usage(10, 10) },
        ],
        validate: [{ text: JSON.stringify({ candidateId: "C1", confirmation: "confirmed", reason: "never reached", evidence: [{ path: "src/app.js", line: 3 }] }), usage: usage(10, 10) }],
      });
      const { result, outcome, investigation } = await runInvestigation(ws, { rigor: "standard", budget: { maxTokens: 1000 }, script });
      assert.equal(result.decision, "incomplete", JSON.stringify(outcome.reason));
      assert.equal(result.exitCode, 2);
      assert.equal(result.complete, false);
      assert.equal(outcome.state, "budget-exhausted");
      assert.equal(outcome.conclusion.status, "INCOMPLETE");
      // Only the hunting call was sent: the validation never started, it was not silently skipped either.
      assert.deepEqual(requests.map((r) => r.contextLabel), ["hunt"]);
      assert.equal(investigation.usage.calls, 1);
      assert.deepEqual(investigation.budget.exhausted.dimension, "tokens");
      assert.equal(investigation.budget.exhausted.stage, "hunt");
      assert.equal(investigation.budget.reserve.tokens, 340, "a third of the tokens was reserved for validation before hunting");
      const [hunt, validate] = investigation.stages;
      assert.equal(hunt.state, "budget-exhausted");
      assert.equal(validate.state, "budget-exhausted");
      assert.deepEqual(validate.contexts.map((c) => [c.label, c.status, c.turns]), [["validate:C1", "budget", 0], ["validate:C2", "budget", 0]]);
      assert.deepEqual(investigation.candidates.map((c) => [c.id, c.status, c.confirmation]), [["C1", "unresolved", null], ["C2", "unresolved", null]]);
      for (const c of investigation.candidates) assert.match(c.reason, /not validated: the budget of 1000 token\(s\) is spent/);
      const gaps = investigation.coverage.gaps;
      assert.deepEqual(gaps.filter((g) => g.code === "NOT_VALIDATED").map((g) => g.candidate), ["C1", "C2"]);
      assert.ok(gaps.some((g) => g.code === "NOT_EXAMINED" && g.path === "src/db.js"), JSON.stringify(gaps));
      assert.deepEqual(gaps.filter((g) => g.code === "STAGE_INCOMPLETE").map((g) => g.stage), ["hunt", "validate"]);
      // Candidates are not findings of a completed review: the result lists none as confirmed.
      assert.deepEqual(result.findings, []);
      assert.equal(result.stages.find((s) => s.id === "semantic-review").state, "blocked");
    } finally {
      ws.cleanup();
    }
  }

  // (b) A call budget: hunting stops at its share, the reserve validates the first candidate, the rest stay unresolved.
  {
    const ws = setupWorkspace("v2-10b", FILES);
    try {
      const { script, requests } = recordingScript({
        hunt: [
          {
            toolCalls: [{ name: "read_file", arguments: { path: "src/app.js" } }, { name: "read_file", arguments: { path: "src/db.js" } }, report("SQL injection in find", "src/app.js", 3), report("SQL injection in remove", "src/app.js", 5)],
            usage: usage(400, 80),
          },
          {
            // The model would keep hunting (a tool call) but this is the last call of the hunting share.
            text: JSON.stringify({
              summary: "Two injections in src/app.js; the query helper returns unbounded results.",
              examined: ["src/app.js", "src/db.js", "src/util.js"],
              gaps: [{ path: "src/util.js", reason: "not read before the budget share ended" }],
              candidates: [{ title: "Unbounded query result", path: "src/db.js", line: 2, severity: "important", category: "reliability", rationale: "No limit on returned rows." }],
            }),
            toolCalls: [{ name: "read_file", arguments: { path: "src/util.js" } }],
            usage: usage(900, 150),
          },
        ],
        "validate:C1": [{ text: JSON.stringify({ candidateId: "C1", confirmation: "confirmed", reason: "The id is concatenated into the SQL text.", evidence: [{ path: "src/app.js", line: 3, note: "string concatenation" }] }), usage: usage(500, 60) }],
        validate: [{ text: JSON.stringify({ candidateId: "C2", confirmation: "rejected", reason: "never reached", evidence: [{ path: "src/app.js", line: 5 }] }), usage: usage(10, 10) }],
      });
      const { result, outcome, investigation } = await runInvestigation(ws, { rigor: "quick", budget: { maxCalls: 3 }, script });
      assert.equal(result.decision, "incomplete", JSON.stringify(outcome.reason));
      assert.equal(result.exitCode, 2);
      assert.equal(outcome.state, "budget-exhausted");
      assert.deepEqual(investigation.budget.limits.maxCalls, 3);
      assert.equal(investigation.budget.reserve.calls, 1, "one call was reserved for validation before hunting");

      // Hunting was asked to conclude at its share of 2 calls: its second request offered no tool use, and the tool call
      // the model still made was not executed.
      assert.deepEqual(requests.map((r) => [r.contextLabel, r.toolChoice]), [["hunt", "auto"], ["hunt", "none"], ["validate:C1", "none"]]);
      assert.match(requests[1].messages.at(-1).text, /last model call your budget allows/);
      const [hunt, validate] = investigation.stages;
      assert.equal(hunt.state, "completed");
      assert.equal(hunt.contexts[0].forced, "budget-share");
      assert.ok(hunt.contexts[0].notes.some((n) => /1 tool call\(s\) on the final turn were not executed/.test(n)));
      assert.ok(hunt.limitations.some((l) => l.code === "BUDGET_SHARE_REACHED"));
      // A claim about a file the context never read is dropped.
      assert.ok(hunt.contexts[0].artifact.problems.some((p) => /src\/util\.js.*never read/.test(p)), JSON.stringify(hunt.contexts[0].artifact));

      // The reserved call validated C1 in a fresh context; C2 and C3 were never validated and stay unresolved.
      assert.equal(validate.state, "budget-exhausted");
      assert.deepEqual(investigation.candidates.map((c) => [c.id, c.status]), [["C1", "confirmed"], ["C2", "unresolved"], ["C3", "unresolved"]]);
      const c1 = investigation.candidates[0];
      assert.deepEqual(c1.validation.evidence, [{ path: "src/app.js", line: 3, note: "string concatenation" }]);
      assert.equal(requests[2].messages.filter((m) => m.role === "assistant").length, 0, "the validation context starts fresh, without the hunting conversation");
      assert.equal(JSON.stringify(requests[2].messages).includes("Two injections"), false);
      for (const c of investigation.candidates.slice(1)) assert.match(c.reason, /budget of 3 call\(s\) is spent/);
      const gaps = investigation.coverage.gaps;
      assert.deepEqual(gaps.filter((g) => g.code === "NOT_VALIDATED").map((g) => g.candidate), ["C2", "C3"]);
      assert.ok(gaps.some((g) => g.code === "NOT_EXAMINED" && g.path === "src/util.js"));
      assert.ok(gaps.some((g) => g.code === "DECLARED_BY_MODEL" && g.path === "src/util.js"));
      assert.ok(gaps.some((g) => g.code === "STAGE_INCOMPLETE" && g.stage === "validate"));

      // Real usage, as the model reported it.
      assert.equal(investigation.usage.calls, 3);
      assert.deepEqual([investigation.usage.tokens.input, investigation.usage.tokens.output, investigation.usage.tokens.reported], [1800, 290, true]);
      assert.equal(outcome.calls, 3);

      // The partial evidence is on disk and listed; the events show the stages in order.
      const record = readJson(path.join(result.runDir, "evidence", "investigation.json"));
      assert.deepEqual(record.candidates.map((c) => c.status), ["confirmed", "unresolved", "unresolved"]);
      assert.ok(result.artifacts.outputs.includes("evidence/investigation.json"));
      for (const f of investigation.artifacts.contexts) assert.ok(fs.existsSync(path.join(result.runDir, f)), f);
      const stageEvents = readEvents(result.runDir).filter((e) => e.type === "stage" && String(e.data.stageId).startsWith("investigation/"));
      assert.deepEqual(stageEvents.map((e) => `${e.data.stageId}:${e.data.state}`), ["investigation/hunt:running", "investigation/hunt:completed", "investigation/validate:running", "investigation/validate:budget-exhausted"]);
    } finally {
      ws.cleanup();
    }
  }
});
