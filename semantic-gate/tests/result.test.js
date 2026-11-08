import assert from "node:assert/strict";
import test from "node:test";

import { normalizeGateResult, normalizeProviderText, parseProviderResult } from "../dist/result.js";

function context() {
  return {
    config: {
      threshold: 90,
      scope: "changed",
      output: "json",
      includeUntracked: true,
      maxContextChars: 1000,
      maxFileChars: 1000,
      maxDiffChars: 1000,
      contextStrategy: "auto",
      outputDir: ".quality/semantic-gate",
      writeReports: false,
      timeoutMs: 1000,
      temperature: 0,
      commandPromptMode: "stdin",
      commandOutput: "text",
    },
    objective: { text: "Implement feature", source: "file:objective.md" },
    gitContext: {
      repoRoot: "/repo",
      statusShort: " M src/a.ts",
      diffStat: "",
      stagedDiffStat: "",
      commandsExecuted: [],
      changedFiles: [{ path: "src/a.ts", changeKinds: ["unstaged"] }],
      warnings: [],
    },
    provider: "mock",
  };
}

const breakdown = [{ category: "functional", weight: 25, score: 25, observations: "ok" }];

test("parseProviderResult accepts fenced JSON and normalizeGateResult enforces semantic contract", () => {
  const parsed = parseProviderResult(`\`\`\`json
{
  "status": "APPROVED",
  "score": 100,
  "deterministicSummaryUsed": true,
  "scoreBreakdown": [{ "category": "functional", "weight": 25, "score": 25, "observations": "ok" }],
  "findings": []
}
\`\`\``);

  const result = normalizeGateResult(parsed, context());

  assert.equal(result.gate, "semantic");
  assert.equal(result.deterministicSummaryUsed, false);
  assert.equal(result.status, "APPROVED");
  assert.equal(result.threshold, 90);
  assert.equal(result.scoreAppliesTo, "changed-files");
});

test("blocking findings force rejection and cap score", () => {
  const result = normalizeGateResult(
    {
      status: "APPROVED",
      score: 98,
      scoreBreakdown: breakdown,
      findings: [
        {
          severity: "blocking",
          category: "functional",
          path: "src/a.ts",
          line: 3,
          message: "Common error path reports success.",
          confirmation: "confirmed",
        },
      ],
    },
    context(),
  );

  assert.equal(result.status, "REJECTED");
  assert.equal(result.score, 69);
  assert.equal(result.hardBlockers.length, 1);
  assert.equal(result.findings[0].severity, "blocking");
  assert.equal(result.findings[0].confirmation, "confirmed");
});

test("an empty object is an invalid outcome with a reason code, never score 100 / APPROVED", () => {
  const result = normalizeGateResult({}, context());
  assert.equal(result.status, "INVALID");
  assert.equal(result.reasonCode, "empty-output");
  assert.notEqual(result.score, 100);
  assert.ok(result.reasons.length > 0);
});

test("missing required fields, bad values and non-objects are invalid", () => {
  const missing = normalizeGateResult({ status: "APPROVED" }, context());
  assert.equal(missing.status, "INVALID");
  assert.equal(missing.reasonCode, "missing-field");

  const badScore = normalizeGateResult({ status: "APPROVED", score: "high", findings: [], scoreBreakdown: breakdown }, context());
  assert.equal(badScore.reasonCode, "invalid-field");

  const badStatus = normalizeGateResult({ status: "INVALID", score: 100, findings: [], scoreBreakdown: breakdown }, context());
  assert.equal(badStatus.status, "INVALID");
  assert.equal(badStatus.reasonCode, "invalid-field");

  assert.equal(normalizeGateResult([], context()).reasonCode, "not-an-object");
  assert.equal(normalizeGateResult(null, context()).status, "INVALID");
});

test("a finding citing a file outside the review context is invalid evidence", () => {
  const result = normalizeGateResult(
    {
      status: "APPROVED",
      score: 100,
      scoreBreakdown: breakdown,
      findings: [{ severity: "nit", category: "maintainability", path: "src/ghost.ts", message: "Looks odd." }],
    },
    context(),
  );
  assert.equal(result.status, "INVALID");
  assert.equal(result.reasonCode, "unknown-evidence");
});

test("normalizeProviderText turns empty and malformed text into invalid outcomes", () => {
  assert.equal(normalizeProviderText("", context()).reasonCode, "empty-output");
  const malformed = normalizeProviderText("sure, looks good to me!", context());
  assert.equal(malformed.status, "INVALID");
  assert.equal(malformed.reasonCode, "malformed-output");
});
