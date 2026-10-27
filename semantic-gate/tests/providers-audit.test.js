import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../dist/config.js";
import {
  CLI_REQUIREMENTS,
  OPENCODE_REVIEW_AGENT,
  callProvider,
  compareVersions,
  openCodeReviewConfig,
  parseVersion,
} from "../dist/providers.js";

// Every CLI here is a fake on PATH and every API a local server: no test reaches a real CLI or spends tokens.

const CLI = path.resolve("dist/cli.js");

const GATE_JSON = JSON.stringify({
  gate: "semantic",
  status: "APPROVED",
  score: 100,
  threshold: 90,
  deterministicSummaryUsed: false,
  objectiveSource: "fake",
  changesReviewed: "fake review",
  hardBlockers: [],
  scoreBreakdown: [],
  commandsExecuted: [],
  findings: [],
  requiredFixPlan: [],
  rerunCommands: [],
  approvalNotes: "ok",
  residualRisks: [],
  contextWarnings: [],
});

/**
 * Writes a fake CLI named `name` into `binDir`. It answers `--version` with `versionOutput` (exit `versionExit`)
 * and, for any other call, reads stdin and prints a gate result. Each call is appended to `<binDir>/<name>.log`.
 */
function installFakeCli(binDir, name, { versionOutput, versionExit = 0 }) {
  const log = path.join(binDir, `${name}.log`);
  const script = path.join(binDir, `${name}-fake.js`);
  fs.writeFileSync(
    script,
    [
      "const fs = require('node:fs');",
      `const log = ${JSON.stringify(log)};`,
      "const args = process.argv.slice(2);",
      "const record = (stdin) => fs.appendFileSync(log, JSON.stringify({ args, stdin, opencodeConfig: process.env.OPENCODE_CONFIG_CONTENT ?? null }) + '\\n');",
      "if (args[0] === '--version') {",
      "  record(null);",
      `  process.stdout.write(${JSON.stringify(versionOutput)});`,
      `  process.exit(${versionExit});`,
      "}",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  record(input);",
      `  console.log(${JSON.stringify(GATE_JSON)});`,
      "});",
    ].join("\n"),
    "utf8",
  );
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, `${name}.cmd`), `@echo off\r\n"%dp0%\\${name}-fake.js" %*\r\n`, "utf8");
  } else {
    const shim = path.join(binDir, name);
    fs.writeFileSync(shim, `#!/usr/bin/env node\nrequire(${JSON.stringify(script)});\n`, "utf8");
    fs.chmodSync(shim, 0o755);
  }
  return () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
}

/** Runs `fn` with `binDir` (when given) first on PATH and the extra env set, restoring everything afterwards. */
async function withPath(binDir, fn, extraEnv = {}) {
  const saved = { PATH: process.env.PATH, Path: process.env.Path };
  for (const key of Object.keys(extraEnv)) saved[key] = process.env[key];
  if (binDir) {
    process.env.PATH = `${binDir}${path.delimiter}${saved.PATH ?? ""}`;
    if (process.platform === "win32") process.env.Path = `${binDir}${path.delimiter}${saved.Path ?? saved.PATH ?? ""}`;
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function tempBin(prefix) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const binDir = path.join(temp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  return { temp, binDir };
}

function request(provider, extra = {}) {
  return {
    system: "SYSTEM PROMPT",
    prompt: "REVIEW PROMPT: return the JSON object.",
    cwd: process.cwd(),
    config: { ...defaultConfig, provider, timeoutMs: 20_000, ...extra },
  };
}

test("opencode runs `opencode run` with the read-only review agent and the prompt on stdin", async () => {
  const { temp, binDir } = tempBin("semantic-gate-opencode-run-");
  const calls = installFakeCli(binDir, "opencode", { versionOutput: "1.19.4\n" });
  try {
    const response = await withPath(binDir, () => callProvider(request("opencode", { model: "opencode/kimi-k3" })), {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "user-theme", agent: { mine: { mode: "primary" } } }),
    });
    assert.match(response.text, /"status":"APPROVED"/);
    const [version, run] = calls();
    assert.deepEqual(version.args, ["--version"]);
    assert.deepEqual(run.args, ["run", "--agent", OPENCODE_REVIEW_AGENT, "--model", "opencode/kimi-k3", "--format", "default"]);
    assert.equal(run.stdin, "REVIEW PROMPT: return the JSON object.");
    const config = JSON.parse(run.opencodeConfig);
    assert.equal(config.theme, "user-theme", "the user's inline config is kept");
    assert.deepEqual(config.agent.mine, { mode: "primary" });
    assert.equal(config.agent[OPENCODE_REVIEW_AGENT].permission, "deny");
    assert.equal(config.agent[OPENCODE_REVIEW_AGENT].mode, "primary");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("opencode 2 runs the review on a private server (--standalone) so the review agent is loaded", async () => {
  const { temp, binDir } = tempBin("semantic-gate-opencode2-run-");
  const calls = installFakeCli(binDir, "opencode", { versionOutput: "opencode v2.1.4\n" });
  try {
    await withPath(binDir, () => callProvider(request("opencode")), { OPENCODE_CONFIG_CONTENT: undefined });
    const run = calls()[1];
    assert.deepEqual(run.args, ["run", "--standalone", "--agent", OPENCODE_REVIEW_AGENT, "--format", "default"]);
    assert.equal(JSON.parse(run.opencodeConfig).agent[OPENCODE_REVIEW_AGENT].permission, "deny");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("gemini-cli runs headless with the prompt on stdin, no --prompt flag and approvals denied", async () => {
  const { temp, binDir } = tempBin("semantic-gate-gemini-run-");
  const calls = installFakeCli(binDir, "gemini", { versionOutput: "0.65.0\n" });
  try {
    await withPath(binDir, () => callProvider(request("gemini-cli", { model: "gemini-3.8-flash" })));
    const run = calls()[1];
    assert.deepEqual(run.args, ["--model", "gemini-3.8-flash", "--approval-mode", "default", "--output-format", "text"]);
    assert.ok(!run.args.includes("--prompt") && !run.args.includes("-p"));
    assert.ok(!run.args.some((arg) => arg.includes("REVIEW PROMPT")), "the prompt is not an argument");
    assert.equal(run.stdin, "REVIEW PROMPT: return the JSON object.");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("claude-code runs --print with every built-in tool and MCP server off", async () => {
  const { temp, binDir } = tempBin("semantic-gate-claude-run-");
  const calls = installFakeCli(binDir, "claude", { versionOutput: "2.1.311 (Claude Code)\n" });
  try {
    await withPath(binDir, () => callProvider(request("claude-code", { model: "claude-sonnet-5-5" })));
    const run = calls()[1];
    assert.deepEqual(run.args, ["--print", "--model", "claude-sonnet-5-5", "--tools", "", "--strict-mcp-config"]);
    assert.equal(run.stdin, "REVIEW PROMPT: return the JSON object.");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("a CLI older than the minimum fails with the version found, the minimum and the update command, before the model runs", async () => {
  const { temp, binDir } = tempBin("semantic-gate-gemini-old-");
  const calls = installFakeCli(binDir, "gemini", { versionOutput: "0.29.3\n" });
  try {
    await assert.rejects(
      withPath(binDir, () => callProvider(request("gemini-cli"))),
      (error) => {
        assert.equal(error.kind, "provider");
        assert.match(error.message, /Gemini CLI 0\.29\.3 is older than the minimum 0\.30\.0/);
        assert.match(error.message, /Update with: npm install -g @google\/gemini-cli@latest/);
        assert.match(error.message, /command: gemini/);
        assert.equal(error.details.classification, "provider-cli-outdated");
        assert.equal(error.details.found, "0.29.3");
        assert.equal(error.details.minimum, CLI_REQUIREMENTS["gemini-cli"].minimum);
        return true;
      },
    );
    assert.deepEqual(
      calls().map((call) => call.args),
      [["--version"]],
      "only the version was read; the model was not called",
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("an unreadable CLI version fails clearly without running the model", async () => {
  const { temp, binDir } = tempBin("semantic-gate-opencode-unreadable-");
  const calls = installFakeCli(binDir, "opencode", { versionOutput: "opencode dev build\n" });
  try {
    await assert.rejects(
      withPath(binDir, () => callProvider(request("opencode"))),
      (error) => {
        assert.match(error.message, /Could not read the OpenCode version: `opencode --version` printed no version number/);
        assert.match(error.message, /needs OpenCode 1\.2\.0 or newer; update with: opencode upgrade/);
        assert.match(error.message, /The model was not called/);
        assert.equal(error.details.classification, "provider-cli-version-unreadable");
        return true;
      },
    );
    assert.deepEqual(calls().map((call) => call.args), [["--version"]]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("a failing `--version` is an unreadable version too", async () => {
  const { temp, binDir } = tempBin("semantic-gate-codex-version-fails-");
  const calls = installFakeCli(binDir, "codex", { versionOutput: "error: unknown flag\n", versionExit: 2 });
  try {
    await assert.rejects(
      withPath(binDir, () => callProvider(request("codex-cli", { model: "gpt-6-astra" }))),
      (error) => {
        assert.match(error.message, /Could not read the Codex CLI version: `codex --version` exited with 2/);
        assert.match(error.message, /0\.122\.0/);
        assert.match(error.message, /npm install -g @openai\/codex@latest/);
        return true;
      },
    );
    assert.deepEqual(calls().map((call) => call.args), [["--version"]]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("a CLI that is not installed fails with the install command", async () => {
  const missing = path.join(os.tmpdir(), "semantic-gate-no-such-dir", "gemini-not-installed");
  await assert.rejects(callProvider(request("gemini-cli", { command: missing })), (error) => {
    assert.match(error.message, /Command not found: .*gemini-not-installed\. Install Gemini CLI with: npm install -g @google\/gemini-cli/);
    assert.equal(error.details.classification, "provider-cli-missing");
    return true;
  });
});

test("semantic-gate run exits 2 and names the versions when the CLI is too old", () => {
  const { temp, binDir } = tempBin("semantic-gate-claude-old-e2e-");
  const calls = installFakeCli(binDir, "claude", { versionOutput: "2.0.76 (Claude Code)\n" });
  const repo = path.join(temp, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1\n", "utf8");
  fs.writeFileSync(path.join(temp, "objective.md"), "Review the small app change.", "utf8");
  assert.equal(spawnSync("git", ["init"], { cwd: repo, encoding: "utf8" }).status, 0);
  try {
    const result = spawnSync(
      process.execPath,
      [CLI, "run", "--cwd", repo, "--objective-file", path.join(temp, "objective.md"), "--provider", "claude-code", "--json"],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          Path: `${binDir}${path.delimiter}${process.env.Path ?? process.env.PATH ?? ""}`,
          SEMANTIC_GATE_HOME: path.join(temp, "home"),
        },
      },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Claude Code 2\.0\.76 is older than the minimum 2\.1\.0/);
    assert.match(result.stderr, /Update with: claude update/);
    assert.deepEqual(calls().map((call) => call.args), [["--version"]]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("version parsing reads the first semver and ignores prefixes and prerelease tags", () => {
  assert.equal(parseVersion("codex-cli 0.164.0"), "0.164.0");
  assert.equal(parseVersion("2.1.311 (Claude Code)"), "2.1.311");
  assert.equal(parseVersion("opencode v2.1.4"), "2.1.4");
  assert.equal(parseVersion("0.66.0-preview.1"), "0.66.0");
  assert.equal(parseVersion("\u001b[1m1.19.4\u001b[0m".replace(/\u001b\[[0-9;]*m/g, "")), "1.19.4");
  assert.equal(parseVersion("dev build"), undefined);
  assert.equal(compareVersions("0.122.0", "0.122.0"), 0);
  assert.equal(compareVersions("0.99.9", "0.122.0"), -1);
  assert.equal(compareVersions("2.0.0", "1.19.4"), 1);
});

test("the opencode inline config rejects a value that is not a JSON object", () => {
  assert.throws(() => openCodeReviewConfig("{ not json"), /OPENCODE_CONFIG_CONTENT is set but is not valid JSON/);
  assert.throws(() => openCodeReviewConfig("[1]"), /must be a JSON object/);
  assert.equal(JSON.parse(openCodeReviewConfig("")).agent[OPENCODE_REVIEW_AGENT].permission, "deny");
});

// ---- HTTP providers -----------------------------------------------------------------------------------------------

async function withServer(handler, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined };
      seen.push(entry);
      const reply = handler(entry);
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, seen);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("anthropic uses API version 2026-10-21, sends no temperature and reads only text blocks", async () => {
  await withServer(
    () => ({
      json: {
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: GATE_JSON },
        ],
        stop_reason: "end_turn",
      },
    }),
    async (baseUrl, seen) => {
      const response = await withPath("", () =>
        callProvider(request("anthropic", { baseUrl, model: "claude-opus-5-5", temperature: 0.2 })),
        { ANTHROPIC_API_KEY: "test-anthropic-key" },
      );
      assert.equal(response.text, GATE_JSON);
      const [call] = seen;
      assert.equal(call.url, "/v1/messages");
      assert.equal(call.headers["anthropic-version"], "2026-10-21");
      assert.equal(call.headers["x-api-key"], "test-anthropic-key");
      assert.equal(call.body.model, "claude-opus-5-5");
      assert.equal(call.body.max_tokens, 16000);
      assert.ok(!("temperature" in call.body) && !("top_p" in call.body) && !("top_k" in call.body));
    },
  );
});

test("gemini sends the key in x-goog-api-key, never in the URL", async () => {
  await withServer(
    () => ({ json: { candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: GATE_JSON }] } }] } }),
    async (baseUrl, seen) => {
      const response = await withPath("", () => callProvider(request("gemini", { baseUrl, model: "gemini-3.8-flash" })), {
        GEMINI_API_KEY: "test-gemini-key",
      });
      assert.equal(response.text, GATE_JSON);
      const [call] = seen;
      assert.equal(call.url, "/models/gemini-3.8-flash:generateContent");
      assert.equal(call.headers["x-goog-api-key"], "test-gemini-key");
      assert.doesNotMatch(call.url, /key=/);
      assert.equal(call.body.generationConfig.responseMimeType, "application/json");
      assert.ok(!("temperature" in call.body.generationConfig));
    },
  );
});

test("openai-compatible sends temperature only when it is configured", async () => {
  await withServer(
    () => ({ json: { choices: [{ message: { content: GATE_JSON } }] } }),
    async (baseUrl, seen) => {
      await withPath("", () => callProvider(request("openai-compatible", { baseUrl, model: "gateway-model" })), {
        SEMANTIC_GATE_API_KEY: "test-gateway-key",
      });
      await withPath("", () => callProvider(request("openai-compatible", { baseUrl, model: "gateway-model", temperature: 0.2 })), {
        SEMANTIC_GATE_API_KEY: "test-gateway-key",
      });
      assert.equal(seen[0].url, "/chat/completions");
      assert.equal(seen[0].headers.authorization, "Bearer test-gateway-key");
      assert.ok(!("temperature" in seen[0].body));
      assert.equal(seen[1].body.temperature, 0.2);
      assert.deepEqual(seen[1].body.response_format, { type: "json_object" });
    },
  );
});

test("ollama passes a configured temperature in options and none by default", async () => {
  await withServer(
    () => ({ json: { message: { content: GATE_JSON } } }),
    async (baseUrl, seen) => {
      await callProvider(request("ollama", { baseUrl, model: "qwen3.8:27b" }));
      await callProvider(request("ollama", { baseUrl, model: "qwen3.8:27b", temperature: 0 }));
      assert.equal(seen[0].url, "/api/chat");
      assert.equal(seen[0].body.stream, false);
      assert.ok(!("options" in seen[0].body));
      assert.deepEqual(seen[1].body.options, { temperature: 0 });
    },
  );
});

test("the default config leaves temperature to the provider", () => {
  assert.ok(!("temperature" in defaultConfig));
});
