import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI = path.resolve("dist/cli.js");

test("semantic-gate run reviews git changes with objective file and mock provider", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-e2e-"));
  const repo = path.join(temp, "repo");
  const home = path.join(temp, "home");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "app.ts"), "export function answer() { return 42; }\n", "utf8");
  fs.writeFileSync(
    path.join(temp, "objective.md"),
    "Implement answer helper with special chars: aspas \" simples ' unicode-like ascii & symbols <> {} []",
    "utf8",
  );

  run("git", ["init"], repo);

  const result = spawnSync(
    process.execPath,
    [
      CLI,
      "run",
      "--cwd",
      repo,
      "--objective-file",
      path.join(temp, "objective.md"),
      "--provider",
      "mock",
      "--json",
    ],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        SEMANTIC_GATE_HOME: home,
      },
    },
  );

  try {
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.gate, "semantic");
    assert.equal(parsed.status, "APPROVED");
    assert.equal(parsed.deterministicSummaryUsed, false);
    assert.equal(parsed.scoreAppliesTo, "changed-files");
    assert.equal(parsed.objectiveSource, `file:${path.join(temp, "objective.md")}`);
    assert.ok(parsed.reports.jsonPath.endsWith(path.join(".quality", "semantic-gate", "semantic-result.json")));
    assert.equal(fs.existsSync(parsed.reports.jsonPath), true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("semantic-gate run with no changed files returns approved empty-result payload", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-e2e-empty-"));
  const repo = path.join(temp, "repo");
  const home = path.join(temp, "home");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(temp, "objective.md"), "Validate empty scope behavior.", "utf8");

  run("git", ["init"], repo);

  const result = spawnSync(
    process.execPath,
    [
      CLI,
      "run",
      "--cwd",
      repo,
      "--objective-file",
      path.join(temp, "objective.md"),
      "--provider",
      "mock",
      "--scope",
      "changed",
      "--json",
      "--no-interactive",
    ],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        SEMANTIC_GATE_HOME: home,
      },
    },
  );

  try {
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.gate, "semantic");
    assert.equal(parsed.status, "APPROVED");
    assert.equal(parsed.score, 100);
    assert.equal(parsed.scoreAppliesTo, "changed-files");
    assert.equal(Array.isArray(parsed.findings), true);
    assert.equal(parsed.findings.length, 0);
    assert.equal(parsed.hardBlockers.length, 0);
    assert.equal(parsed.commandsExecuted.length > 0, true);
    assert.equal(Array.isArray(parsed.contextWarnings), true);
    assert.equal(parsed.contextWarnings.some((entry) => String(entry).includes("No files matched scope=changed")), true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("semantic-gate run passes model and reasoning effort to codex-cli provider", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-codex-e2e-"));
  const repo = path.join(temp, "repo");
  const home = path.join(temp, "home");
  const binDir = path.join(temp, "bin");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1\n", "utf8");
  fs.writeFileSync(path.join(temp, "objective.md"), "Review the small app change.", "utf8");

  const fakeCodexJs = path.join(binDir, "fake-codex.js");
  const invocationPath = path.join(temp, "codex-invocation.json");
  fs.writeFileSync(
    fakeCodexJs,
    [
      // The provider reads `codex --version` before the review; a fake CLI answers it like the real one.
      "if (process.argv[2] === '--version') { console.log('codex-cli 0.164.0'); process.exit(0); }",
      "const fs = require('node:fs');",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { input += chunk; });",
      "process.stdin.on('end', () => {",
      `  fs.writeFileSync(${JSON.stringify(invocationPath)}, JSON.stringify({ args: process.argv.slice(2), sawPrompt: input.includes('Review the small app change.') }, null, 2));`,
      "  console.log(JSON.stringify({",
      "    gate: 'semantic',",
      "    status: 'APPROVED',",
      "    score: 100,",
      "    threshold: 90,",
      "    deterministicSummaryUsed: false,",
      "    objectiveSource: 'fake-codex',",
      "    changesReviewed: 'fake codex review',",
      "    hardBlockers: [],",
      "    scoreBreakdown: [",
      "      { category: 'functional', weight: 25, score: 25, observations: 'ok' },",
      "      { category: 'tests', weight: 20, score: 20, observations: 'ok' },",
      "      { category: 'security', weight: 20, score: 20, observations: 'ok' },",
      "      { category: 'maintainability', weight: 15, score: 15, observations: 'ok' },",
      "      { category: 'architecture', weight: 10, score: 10, observations: 'ok' },",
      "      { category: 'performance', weight: 10, score: 10, observations: 'ok' }",
      "    ],",
      "    commandsExecuted: [],",
      "    findings: [],",
      "    requiredFixPlan: [],",
      "    rerunCommands: [],",
      "    approvalNotes: 'ok',",
      "    residualRisks: [],",
      "    contextWarnings: []",
      "  }));",
      "});",
    ].join("\n"),
    "utf8",
  );

  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "codex.cmd"), `@echo off\r\n"%dp0%\\fake-codex.js" %*\r\n`, "utf8");
  } else {
    const codexPath = path.join(binDir, "codex");
    fs.writeFileSync(codexPath, `#!/usr/bin/env node\nrequire(${JSON.stringify(fakeCodexJs)});\n`, "utf8");
    fs.chmodSync(codexPath, 0o755);
  }

  run("git", ["init"], repo);

  const result = spawnSync(
    process.execPath,
    [
      CLI,
      "run",
      "--cwd",
      repo,
      "--objective-file",
      path.join(temp, "objective.md"),
      "--provider",
      "codex-cli",
      "--model",
      "gpt-5.5",
      "--reasoning-effort",
      "high",
      "--json",
    ],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        Path: `${binDir}${path.delimiter}${process.env.Path ?? process.env.PATH ?? ""}`,
        SEMANTIC_GATE_HOME: home,
      },
    },
  );

  try {
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, "APPROVED");
    const invocation = JSON.parse(fs.readFileSync(invocationPath, "utf8"));
    assert.deepEqual(invocation.args, [
      "exec",
      "-m",
      "gpt-5.5",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-c",
      'model_reasoning_effort="high"',
      "-",
    ]);
    assert.equal(invocation.sawPrompt, true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("semantic-gate classifies codex-cli provider network failures", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-codex-network-"));
  const repo = path.join(temp, "repo");
  const home = path.join(temp, "home");
  const binDir = path.join(temp, "bin");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1\n", "utf8");
  fs.writeFileSync(path.join(temp, "objective.md"), "Review the small app change.", "utf8");

  const fakeCodexJs = path.join(binDir, "fake-codex-network.js");
  fs.writeFileSync(
    fakeCodexJs,
    [
      "if (process.argv[2] === '--version') { console.log('codex-cli 0.164.0'); process.exit(0); }",
      "console.error('+      throw new SemanticGateError(\"Provider HTTP error 500.\", \"provider\", json);');",
      "console.error('2026-07-03T04:48:35Z ERROR failed to connect to websocket: os error 10013, url: wss://api.openai.com/v1/responses');",
      "console.error('ERROR: stream disconnected before completion: error sending request for url (https://api.openai.com/v1/responses)');",
      "process.exit(1);",
    ].join("\n"),
    "utf8",
  );

  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "codex.cmd"), `@echo off\r\nnode "%dp0%\\fake-codex-network.js" %*\r\n`, "utf8");
  } else {
    const codexPath = path.join(binDir, "codex");
    fs.writeFileSync(codexPath, `#!/usr/bin/env node\nrequire(${JSON.stringify(fakeCodexJs)});\n`, "utf8");
    fs.chmodSync(codexPath, 0o755);
  }

  run("git", ["init"], repo);

  const result = spawnSync(
    process.execPath,
    [
      CLI,
      "run",
      "--cwd",
      repo,
      "--objective-file",
      path.join(temp, "objective.md"),
      "--provider",
      "codex-cli",
      "--model",
      "gpt-5.5",
      "--json",
    ],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        Path: `${binDir}${path.delimiter}${process.env.Path ?? process.env.PATH ?? ""}`,
        SEMANTIC_GATE_HOME: home,
      },
    },
  );

  try {
    assert.equal(result.status, 2);
    assert.match(result.stderr, /provider network connection failed/);
    assert.match(result.stderr, /"classification": "provider-network"/);
    assert.match(result.stderr, /api\.openai\.com\/v1\/responses/);
    assert.doesNotMatch(result.stderr, /SemanticGateError/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("semantic-gate does not classify prompt context as provider network failure", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-codex-timeout-"));
  const repo = path.join(temp, "repo");
  const home = path.join(temp, "home");
  const binDir = path.join(temp, "bin");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1\n", "utf8");
  fs.writeFileSync(path.join(temp, "objective.md"), "Review the small app change.", "utf8");

  const fakeCodexJs = path.join(binDir, "fake-codex-timeout.js");
  fs.writeFileSync(
    fakeCodexJs,
    [
      "if (process.argv[2] === '--version') { console.log('codex-cli 0.164.0'); process.exit(0); }",
      "console.error('+      \"console.error(\\'ERROR failed to connect to wss://api.openai.com/v1/responses\\');\",');",
      "console.error('269:    /api\\\\.openai\\\\.com|\\\\/v1\\\\/responses|websocket/.test(text)');",
      "console.error('\\u001b[7msemantic-gate\\\\src\\\\providers.ts:331:\\u001b[0m return /failed to connect|wss:\\\\/\\\\//i.test(line);');",
      "process.exit(124);",
    ].join("\n"),
    "utf8",
  );

  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "codex.cmd"), `@echo off\r\nnode "%dp0%\\fake-codex-timeout.js" %*\r\n`, "utf8");
  } else {
    const codexPath = path.join(binDir, "codex");
    fs.writeFileSync(codexPath, `#!/usr/bin/env node\nrequire(${JSON.stringify(fakeCodexJs)});\n`, "utf8");
    fs.chmodSync(codexPath, 0o755);
  }

  run("git", ["init"], repo);

  const result = spawnSync(
    process.execPath,
    [
      CLI,
      "run",
      "--cwd",
      repo,
      "--objective-file",
      path.join(temp, "objective.md"),
      "--provider",
      "codex-cli",
      "--model",
      "gpt-5.5",
      "--json",
    ],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        Path: `${binDir}${path.delimiter}${process.env.Path ?? process.env.PATH ?? ""}`,
        SEMANTIC_GATE_HOME: home,
      },
    },
  );

  try {
    assert.equal(result.status, 2);
    assert.match(result.stderr, /provider timed out/);
    assert.match(result.stderr, /"classification": "provider-timeout"/);
    assert.doesNotMatch(result.stderr, /"classification": "provider-network"/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stderr}`);
}

test("semantic-gate codex-cli passes the requested sandbox mode and bypasses only on explicit option", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-codex-sandbox-"));
  const repo = path.join(temp, "repo");
  const home = path.join(temp, "home");
  const binDir = path.join(temp, "bin");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1\n", "utf8");
  fs.writeFileSync(path.join(temp, "objective.md"), "Review the small app change.", "utf8");

  const invocationPath = path.join(temp, "codex-invocation.json");
  const fakeCodexJs = path.join(binDir, "fake-codex-sandbox.js");
  fs.writeFileSync(
    fakeCodexJs,
    [
      "if (process.argv[2] === '--version') { console.log('codex-cli 0.164.0'); process.exit(0); }",
      "const fs = require('node:fs');",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      `  fs.writeFileSync(${JSON.stringify(invocationPath)}, JSON.stringify(process.argv.slice(2)));`,
      "  console.log(JSON.stringify({",
      "    status: 'APPROVED', score: 100, summary: 'ok', categoryScores: [],",
      "    commandsExecuted: [], findings: [], requiredFixPlan: [], rerunCommands: [],",
      "    approvalNotes: 'ok', residualRisks: [], contextWarnings: []",
      "  }));",
      "});",
    ].join("\n"),
    "utf8",
  );
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "codex.cmd"), `@echo off\r\nnode "%~dp0fake-codex-sandbox.js" %*\r\n`, "utf8");
  } else {
    const codexPath = path.join(binDir, "codex");
    fs.writeFileSync(codexPath, `#!/usr/bin/env node\nrequire(${JSON.stringify(fakeCodexJs)});\n`, "utf8");
    fs.chmodSync(codexPath, 0o755);
  }
  run("git", ["init"], repo);

  const runWith = (extra) => {
    fs.rmSync(invocationPath, { force: true });
    const result = spawnSync(
      process.execPath,
      [CLI, "run", "--cwd", repo, "--objective-file", path.join(temp, "objective.md"), "--provider", "codex-cli", "--model", "gpt-5.5", "--json", ...extra],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          Path: `${binDir}${path.delimiter}${process.env.Path ?? process.env.PATH ?? ""}`,
          SEMANTIC_GATE_HOME: home,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(fs.readFileSync(invocationPath, "utf8"));
  };

  try {
    const sandboxOf = (args) => args[args.indexOf("--sandbox") + 1];
    assert.equal(sandboxOf(runWith([])), "read-only");
    assert.equal(sandboxOf(runWith(["--codex-sandbox", "workspace-write"])), "workspace-write");
    assert.equal(sandboxOf(runWith(["--codex-sandbox", "danger-full-access"])), "danger-full-access");
    const plain = runWith([]);
    assert.equal(plain.includes("--dangerously-bypass-approvals-and-sandbox"), false);
    const bypass = runWith(["--codex-bypass-sandbox"]);
    assert.equal(bypass.includes("--dangerously-bypass-approvals-and-sandbox"), true);
    assert.equal(bypass.includes("--sandbox"), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
