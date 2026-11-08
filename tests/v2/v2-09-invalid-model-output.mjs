import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (name) => import(pathToFileURL(path.join(root, "semantic-gate", "dist", name)).href);

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v2-09-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "v2@example.invalid");
  git("config", "user.name", "V2 Tests");
  fs.writeFileSync(path.join(dir, "app.js"), "exports.answer = () => 42;\n", "utf8");
  return dir;
}

async function review(dir, mockResponse) {
  const { runSemanticGate } = await dist("run.js");
  const { defaultConfig } = await dist("config.js");
  const previous = process.env.SEMANTIC_GATE_MOCK_RESPONSE;
  process.env.SEMANTIC_GATE_MOCK_RESPONSE = mockResponse;
  try {
    const config = { ...defaultConfig, provider: "mock", scope: "full", writeReports: false };
    const { result } = await runSemanticGate({ cwd: dir, config, objective: { text: "Add the answer helper.", source: "v2-09" } });
    return result;
  } finally {
    if (previous === undefined) delete process.env.SEMANTIC_GATE_MOCK_RESPONSE;
    else process.env.SEMANTIC_GATE_MOCK_RESPONSE = previous;
  }
}

test("V2-09: empty, malformed and unknown-evidence model output is never favorable", async () => {
  const dir = workspace();
  try {
    const unknownFile = JSON.stringify({
      status: "APPROVED",
      score: 100,
      scoreBreakdown: [{ category: "functional", weight: 25, score: 25, observations: "ok" }],
      findings: [{ severity: "nit", category: "maintainability", path: "src/does-not-exist.ts", message: "Rename this." }],
    });
    const cases = [
      ["empty object", "{}", "empty-output"],
      ["malformed text", "Looks great, ship it!", "malformed-output"],
      ["unknown file", unknownFile, "unknown-evidence"],
    ];
    for (const [label, response, reasonCode] of cases) {
      const result = await review(dir, response);
      assert.equal(result.gate, "semantic", label);
      assert.equal(result.status, "INVALID", label);
      assert.equal(result.reasonCode, reasonCode, label);
      assert.notEqual(result.status, "APPROVED", label);
      assert.ok(result.score < result.threshold, `${label}: score ${result.score} must stay below the threshold`);
      assert.ok(result.reasons.length > 0, label);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
