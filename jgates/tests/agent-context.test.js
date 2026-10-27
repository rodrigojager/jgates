import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Safe context for a coding agent: `jgates report <runId> --agent-context --json` and the "Copiar para o agente"
// button of the UI call the same builder. The text freezes the policy, marks tool output as data, gives the command that
// reproduces the run and never carries a secret or personal value of the fixture.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const mod = await import(pathToFileURL(path.join(dist, "core", "agent-context", "index.js")).href);
const ids = await import(pathToFileURL(path.join(dist, "core", "ids", "index.js")).href);

// Values that must never reach the agent.
const SECRET = "AKIAIOSFODNN7EXAMPLE";
const TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
const EMAIL = "maria.silva@example.com";
const CPF = "123.456.789-09";
const MASKED = "api_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCY";

function fixtureResult(runId) {
  return {
    schemaVersion: 1,
    runId,
    tool: "jgates",
    version: "0.0.0",
    startedAt: "2026-10-26T10:00:00.000Z",
    finishedAt: "2026-10-26T10:00:05.000Z",
    workspace: { id: "ws_x", path: "/tmp/x" },
    runDir: "/tmp/x/run",
    selection: { adapter: "plan", options: {}, overrides: [{ id: "unit", reason: "faster" }], profile: "minimal", scope: "workspace" },
    decision: "passed",
    complete: true,
    reduced: true,
    exitCode: 0,
    requirements: [],
    stages: [
      { id: "ruff#lint", state: "completed", label: "Ruff" },
      { id: "pytest#unit", state: "disabled", reason: "turned off for this run" },
    ],
    findings: [
      { stageId: "gitleaks", tool: "gitleaks", ruleId: "aws-access-key", category: "secrets", severity: "high", normalizedSeverity: "high", message: `Found ${SECRET} in config`, location: { path: "src/settings.py", line: 3 }, evidence: `key = ${SECRET}`, blocking: true, waived: false },
      { stageId: "builtin-pii", tool: "builtin-pii", ruleId: "pii.email", category: "pii", severity: "medium", normalizedSeverity: "medium", message: `Email ${EMAIL} and CPF ${CPF}`, location: { path: "data/users.csv", line: 2 }, evidence: EMAIL, blocking: false, waived: false },
      { stageId: "ruff#lint", tool: "ruff", ruleId: "F401", category: "lint", severity: "low", normalizedSeverity: "low", message: `unused import; token ${TOKEN} ${MASKED} contact ${EMAIL}`, location: { path: "demo/mod.py", line: 1 }, remediation: "Remove the import.", blocking: false, waived: false },
    ],
    metrics: [
      { id: "findings.total", unit: "count", value: 3, scope: "workspace", origin: "jgates" },
      { id: "coverage.lines", label: "Coverage", unit: "percent", measured: false, reason: "no report", scope: "workspace", origin: "pytest" },
    ],
    architecture: [{ tool: "dependency-cruiser", status: "partial", verified: false, nodes: 3, edges: 2, unresolved: 1, unresolvedSample: [{ from: "web/a.ts", specifier: "@app/x" }] }],
    unsatisfied: [],
    warnings: [],
    blockingViolations: 1,
    disabled: [{ id: "pytest#unit", origin: "run", reason: "faster" }],
    workspaceChanges: { checked: true, added: [], modified: [], removed: [] },
    artifacts: { result: "result.json", logs: [], outputs: [] },
  };
}

const RUN_ID = "run_20261026T100000Z_0a1b2c3d";

test("the context freezes the policy, marks tool output as data and names the reproduction command", () => {
  const ctx = mod.buildAgentContext(fixtureResult(RUN_ID));
  const text = ctx.text;
  assert.match(text, /Não altere os critérios de aprovação/);
  assert.match(text, /Não edite jgates\.yml/);
  assert.ok(text.includes(mod.DATA_BEGIN) && text.includes(mod.DATA_END));
  const begin = text.indexOf(mod.DATA_BEGIN, text.indexOf("Tudo entre") + 40);
  const end = text.lastIndexOf(mod.DATA_END);
  const data = text.slice(begin, end);
  assert.match(data, /F401/);
  assert.match(data, /pytest#unit/);
  assert.match(text, /Aprovação reduzida: 1 verificação/);
  assert.match(text, /jgates run --profile minimal --scope workspace --json/);
  assert.match(text, new RegExp(`jgates report ${RUN_ID} --format json`));
  // A metric that was not measured is never a zero.
  assert.match(text, /coverage\.lines: não medida \(no report\)/);
  assert.doesNotMatch(text, /coverage\.lines: 0/);
  assert.match(text, /dependency-cruiser: grafo partial, 1 dependência/);
});

test("no secret or personal value of the fixture reaches the context", () => {
  const text = mod.buildAgentContext(fixtureResult(RUN_ID)).text;
  for (const value of [SECRET, TOKEN, EMAIL, CPF, "wJalrXUtnFEMI", "maria.silva"]) assert.ok(!text.includes(value), `leaked: ${value}`);
  // The sensitive findings stay (rule and place), without their description.
  assert.match(text, /aws-access-key em src\/settings\.py:3/);
  assert.match(text, /pii\.email em data\/users\.csv:2/);
});

test("report --agent-context --json prints the same text the builder gives (the UI route uses the same builder)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-ac-home-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-ac-ws-"));
  try {
    const wid = ids.workspaceId(ws);
    const runDir = path.join(home, "workspaces", wid, "runs", RUN_ID);
    fs.mkdirSync(runDir, { recursive: true });
    const result = fixtureResult(RUN_ID);
    fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result));
    const env = { ...process.env, JGATES_HOME: home };
    const json = spawnSync(process.execPath, [MAIN, "report", RUN_ID, "--agent-context", "--json", "--cwd", ws], { encoding: "utf8", env });
    assert.equal(json.status, 0, json.stdout + json.stderr);
    const doc = JSON.parse(json.stdout);
    assert.equal(doc.runId, RUN_ID);
    assert.equal(doc.agentContext.text, mod.buildAgentContext(result).text);
    const plain = spawnSync(process.execPath, [MAIN, "report", RUN_ID, "--agent-context", "--cwd", ws], { encoding: "utf8", env });
    assert.equal(plain.status, 0, plain.stdout + plain.stderr);
    assert.equal(plain.stdout, doc.agentContext.text);
    for (const value of [SECRET, TOKEN, EMAIL, CPF]) assert.ok(!json.stdout.includes(value) && !json.stderr.includes(value));
    const sarif = spawnSync(process.execPath, [MAIN, "report", RUN_ID, "--agent-context", "--format", "sarif", "--cwd", ws], { encoding: "utf8", env });
    assert.equal(sarif.status, 3, sarif.stdout + sarif.stderr);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("a partial or cancelled result says that no approval was issued", () => {
  const result = { ...fixtureResult(RUN_ID), decision: "cancelled", partial: true, complete: false, reduced: false, disabled: [], stopped: { cause: "cancelled", detail: "cancelled" } };
  const text = mod.buildAgentContext(result).text;
  assert.match(text, /nenhuma aprovação foi emitida/);
  assert.match(text, /Decisão: cancelled/);
});
