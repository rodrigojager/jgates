import assert from "node:assert/strict";
import test from "node:test";

import { normalizeGateResult, parseProviderResult } from "../dist/result.js";

test("parseProviderResult accepts fenced JSON and normalizeGateResult enforces semantic contract", () => {
  const parsed = parseProviderResult(`\`\`\`json
{
  "status": "APPROVED",
  "score": 100,
  "deterministicSummaryUsed": true,
  "findings": []
}
\`\`\``);

  const result = normalizeGateResult(parsed, {
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
  });

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
      findings: [
        {
          severity: "blocking",
          category: "functional",
          path: "src/a.ts",
          line: 3,
          message: "Common error path reports success.",
        },
      ],
    },
    {
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
      objective: { text: "Implement feature", source: "stdin" },
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
    },
  );

  assert.equal(result.status, "REJECTED");
  assert.equal(result.score, 69);
  assert.equal(result.hardBlockers.length, 1);
});
