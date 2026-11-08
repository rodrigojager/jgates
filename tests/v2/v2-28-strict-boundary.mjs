import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { load, readJson, recordingScript, runInvestigation, setupWorkspace, usage } from "./fixtures/semantic-executor/helpers.mjs";

// V2-28: strict context boundary and insufficient token budget. A selected scope (src/routes) whose subject reads a
// configuration file that is not part of the allowed context. Strict policy with a small token budget: the host
// refuses every expansion and read of that file (no silent expansion), the validator's verdict that needed it is
// limited to needs-validation, the token budget ends before the second validation (unresolved, incomplete) and the
// usage is the model's real report. Bounded policy within its limits: the same request is admitted and recorded with
// its reason, a request beyond the byte limit is still refused, the verdict stands, and the usage is reported again.

const LIMITS_MARKER = "LIMITS-MARKER-v2-28";
const OTHER_MARKER = "OTHER-MARKER-v2-28";
const FILES = {
  "src/routes/orders.js": [
    'const auth = require("../lib/auth");',
    'const fs = require("fs");',
    'const limits = JSON.parse(fs.readFileSync(process.env.LIMITS_FILE || "config/limits.json", "utf8"));',
    "exports.create = (req) => {",
    "  auth.requireUser(req);",
    "  const quantity = Number(req.body.quantity);",
    '  if (quantity > limits.maxQuantity) throw new Error("too many");',
    "  return { quantity, total: quantity * req.body.price };",
    "};",
    "",
  ].join("\n"),
  "src/lib/auth.js": 'exports.requireUser = (req) => {\n  if (!req.user) throw new Error("unauthenticated");\n  return req.user;\n};\n',
  "config/limits.json": `{"maxQuantity": 1000000, "marker": "${LIMITS_MARKER}"}\n`,
  "config/other.json": `${JSON.stringify({ marker: OTHER_MARKER, pad: "x".repeat(5000) })}\n`,
};

const ORDERS = "src/routes/orders.js";
const script = () =>
  recordingScript({
    hunt: [
      { toolCalls: [{ name: "read_file", arguments: { path: ORDERS } }], usage: usage(500, 100) },
      {
        toolCalls: [
          { name: "report_candidate", arguments: { title: "Quantity limit comes from an unread configuration", path: ORDERS, line: 7, severity: "important", category: "reliability", rationale: "The cap depends on config/limits.json." } },
          { name: "report_candidate", arguments: { title: "Price taken from the request body", path: ORDERS, line: 8, severity: "blocking", category: "security", rationale: "The client sets the price." } },
          { name: "request_context", arguments: { path: "config/other.json", reason: "other limits may apply" } },
        ],
        usage: usage(700, 100),
      },
      { text: JSON.stringify({ summary: "Two candidates in the order route.", examined: [ORDERS], gaps: [] }), usage: usage(300, 50) },
    ],
    "validate:C1": [
      { toolCalls: [{ name: "request_context", arguments: { path: "config/limits.json", reason: "the cap is read from it" } }, { name: "read_file", arguments: { path: "config/limits.json" } }], usage: usage(300, 50) },
      (request) => {
        const got = request.messages.at(-1).results.find((r) => r.name === "read_file");
        const evidence = [{ path: ORDERS, line: 7, note: "the cap is compared here" }];
        if (!got.isError) evidence.push({ path: "config/limits.json", line: 1, note: "maxQuantity is effectively unbounded" });
        return { text: JSON.stringify({ candidateId: "C1", confirmation: "confirmed", reason: "The configured cap does not bound the quantity.", evidence }), usage: usage(300, 50) };
      },
    ],
    "validate:C2": [{ text: JSON.stringify({ candidateId: "C2", confirmation: "rejected", reason: "The total is informational; the price is recomputed downstream.", evidence: [{ path: ORDERS, line: 8 }] }), usage: usage(300, 50) }],
  });

const SCOPE = (context) => ({ mode: "selected", subjects: [{ kind: "path", value: "src/routes" }], context });

test("V2-28: strict context and insufficient budget never expand silently, limit the affected claims, expand only under a bounded policy, and report real usage", async () => {
  const ws = setupWorkspace("v2-28", FILES);
  try {
    const { buildSemanticPlan } = await load("core/semantic/index.js");
    const preview = buildSemanticPlan({ workspacePath: ws.dir, home: ws.home, env: ws.env, scope: SCOPE({ policy: "strict" }) }).scope.resolution;
    assert.deepEqual(preview.subjects.map((s) => s.path), [ORDERS]);
    assert.deepEqual(preview.context.map((c) => c.path), ["src/lib/auth.js"], "the configuration files are not allowed context");
    const contextBytes = preview.context.reduce((n, c) => n + c.bytes, 0);

    // ---- strict policy, 2000 tokens ----
    {
      const { script: model, requests } = script();
      const { plan, result, outcome, investigation } = await runInvestigation(ws, { scope: SCOPE({ policy: "strict" }), rigor: "standard", budget: { maxTokens: 2000 }, script: model });
      assert.equal(plan.scope.resolution.policy.context, "strict");
      // No silent expansion: nothing was admitted, the configuration never reached the model.
      assert.deepEqual(investigation.boundary.expansions, []);
      assert.equal(JSON.stringify(requests).includes(LIMITS_MARKER), false);
      assert.equal(JSON.stringify(requests).includes(OTHER_MARKER), false);
      assert.deepEqual(
        investigation.boundary.refusals.map((r) => [r.context, r.tool, r.path, r.code]),
        [
          ["hunt", "request_context", "config/other.json", "OUTSIDE_SCOPE"],
          ["validate:C1", "request_context", "config/limits.json", "OUTSIDE_SCOPE"],
          ["validate:C1", "read_file", "config/limits.json", "OUTSIDE_SCOPE"],
        ],
      );
      // The claim that needed the refused file is limited: the validator said confirmed, the host keeps needs-validation.
      const [c1, c2] = investigation.candidates;
      assert.equal(c1.status, "needs-validation");
      assert.deepEqual(c1.limitations.map((l) => [l.code, l.paths]), [["REQUIRED_CONTEXT_REFUSED", ["config/limits.json"]]]);
      assert.equal(c1.validation.reason, "The configured cap does not bound the quantity.");
      // The token budget: hunting stopped at its share (the reserve kept), the second validation never ran.
      assert.equal(investigation.budget.reserve.tokens, 680);
      assert.deepEqual(investigation.budget.exhausted, { dimension: "tokens", stage: "hunt", message: investigation.budget.exhausted.message });
      assert.equal(investigation.stages[0].state, "budget-exhausted");
      assert.ok(investigation.stages[0].limitations.some((l) => l.code === "CONTEXT_REFUSED"));
      assert.equal(c2.status, "unresolved");
      assert.match(c2.reason, /budget of 2000 token\(s\) is spent \(2100 used\)/);
      assert.deepEqual(requests.map((r) => r.contextLabel), ["hunt", "hunt", "validate:C1", "validate:C1"]);
      // Real usage, exactly as the model reported it.
      assert.deepEqual(investigation.usage.tokens, { input: 1800, output: 300, total: 2100, reported: true, reportedCalls: 4, estimatedCalls: 0, estimated: 0 });
      assert.deepEqual(investigation.usage.byStage, { hunt: { calls: 2, input: 1200, output: 200, estimatedCalls: 0 }, validate: { calls: 2, input: 600, output: 100, estimatedCalls: 0 } });
      assert.equal(outcome.state, "budget-exhausted");
      assert.equal(result.decision, "incomplete");
      assert.equal(result.complete, false);
      // The scope record shows what was examined: the subject, never the refused configuration.
      const scopeRecord = readJson(path.join(result.runDir, "scope.json"));
      assert.deepEqual(scopeRecord.units.examined.map((u) => u.id), [ORDERS]);
      assert.equal(JSON.stringify(scopeRecord.context.allowed).includes("config/"), false);
    }

    // ---- bounded policy within its limits, enough tokens ----
    {
      const { script: model, requests } = script();
      const bounded = SCOPE({ policy: "bounded", maxBytes: contextBytes + 200 });
      const { plan, result, outcome, investigation } = await runInvestigation(ws, { scope: bounded, rigor: "standard", budget: { maxTokens: 10000 }, script: model });
      assert.equal(plan.scope.resolution.policy.context, "bounded");
      // The expansion within the limits is admitted and recorded with its reason; the one beyond the bytes is refused.
      assert.deepEqual(investigation.boundary.expansions.map((e) => [e.path, e.reason]), [["config/limits.json", "the cap is read from it"]]);
      assert.deepEqual(investigation.boundary.refusals.map((r) => [r.context, r.tool, r.path, r.code]), [["hunt", "request_context", "config/other.json", "EXPANSION_LIMIT"]]);
      assert.equal(JSON.stringify(requests).includes(LIMITS_MARKER), true, "the admitted file was read");
      assert.equal(JSON.stringify(requests).includes(OTHER_MARKER), false, "the refused file was never read");
      const [c1, c2] = investigation.candidates;
      assert.equal(c1.status, "confirmed");
      assert.deepEqual(c1.limitations, []);
      assert.ok(c1.validation.evidence.some((e) => e.path === "config/limits.json"));
      assert.equal(c2.status, "rejected");
      assert.equal(investigation.budget.exhausted, null);
      assert.deepEqual([investigation.usage.tokens.input, investigation.usage.tokens.output, investigation.usage.tokens.reported, investigation.usage.calls], [2400, 400, true, 6]);
      assert.equal(outcome.state, "completed", JSON.stringify(outcome.reason));
      assert.equal(investigation.complete, true);
      // A confirmed important finding: the review does not approve.
      assert.equal(outcome.conclusion.status, "NEEDS_CHANGES");
      assert.equal(result.decision, "failed");
      assert.deepEqual(result.findings.map((f) => [f.location.path, f.location.line, f.severity]), [[ORDERS, 7, "important"]]);
    }
  } finally {
    ws.cleanup();
  }
});
