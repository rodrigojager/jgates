import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listStoredApiKeys, resolveApiKey, setStoredApiKey } from "../dist/credentials.js";

const CLI = path.resolve("dist/cli.js");

test("stored API keys are user-local, never shown in list output, and env vars take precedence", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-auth-"));
  const oldHome = process.env.SEMANTIC_GATE_HOME;
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.SEMANTIC_GATE_HOME = temp;
  delete process.env.OPENROUTER_API_KEY;

  try {
    setStoredApiKey("openrouter", "stored-openrouter-key");
    assert.equal(resolveApiKey({ provider: "openrouter" }), "stored-openrouter-key");

    process.env.OPENROUTER_API_KEY = "env-openrouter-key";
    assert.equal(resolveApiKey({ provider: "openrouter" }), "env-openrouter-key");

    const listed = listStoredApiKeys();
    const openrouter = listed.find((item) => item.provider === "openrouter");
    assert.equal(openrouter?.configured, true);
    assert.equal(openrouter?.source, "env");
    // The listing never carries any part of a value: a fixed mask, and the store's value is reported as present.
    assert.equal(openrouter?.masked, "********");
    assert.equal(openrouter?.stored, true);
    assert.doesNotMatch(JSON.stringify(listed), /env-openrouter-key|stored-openrouter-key|env-|-key"/);
  } finally {
    restoreEnv("SEMANTIC_GATE_HOME", oldHome);
    restoreEnv("OPENROUTER_API_KEY", oldKey);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("claude aliases resolve to the anthropic credential and CLAUDE_API_KEY fallback", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-claude-auth-"));
  const oldHome = process.env.SEMANTIC_GATE_HOME;
  const oldAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const oldClaudeKey = process.env.CLAUDE_API_KEY;
  process.env.SEMANTIC_GATE_HOME = temp;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_API_KEY;

  try {
    setStoredApiKey("claude", "stored-claude-key");
    assert.equal(resolveApiKey({ provider: "anthropic" }), "stored-claude-key");
    assert.equal(resolveApiKey({ provider: "claude" }), "stored-claude-key");

    process.env.CLAUDE_API_KEY = "env-claude-key";
    assert.equal(resolveApiKey({ provider: "anthropic" }), "env-claude-key");

    const listed = listStoredApiKeys();
    const anthropic = listed.find((item) => item.provider === "anthropic");
    assert.equal(anthropic?.configured, true);
    assert.equal(anthropic?.source, "env");
    assert.equal(anthropic?.envName, "CLAUDE_API_KEY");
  } finally {
    restoreEnv("SEMANTIC_GATE_HOME", oldHome);
    restoreEnv("ANTHROPIC_API_KEY", oldAnthropicKey);
    restoreEnv("CLAUDE_API_KEY", oldClaudeKey);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("auth set accepts API key on stdin and never prints the raw key", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-auth-cli-"));
  const result = spawnSync(process.execPath, [CLI, "auth", "set", "openai", "--key-stdin"], {
    cwd: path.resolve("."),
    input: "sk-test-secret\n",
    encoding: "utf8",
    env: {
      ...process.env,
      SEMANTIC_GATE_HOME: temp,
    },
  });

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Stored API key for openai/);
    assert.doesNotMatch(result.stdout, /sk-test-secret/);

    const list = spawnSync(process.execPath, [CLI, "auth", "list"], {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        SEMANTIC_GATE_HOME: temp,
      },
    });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /"masked": "\*{8}"/);
    assert.doesNotMatch(list.stdout, /sk-test-secret|sk-t|cret/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("models list opencode-api uses OpenAI-compatible endpoint and OPENCODE_API_KEY", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-opencode-api-models-"));
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer opencode-key");
    if (request.url === "/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "opencode/model-a" }, { id: "opencode/model-b" }] }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const result = await runCli(
      process.execPath,
      [
        CLI,
        "models",
        "list",
        "opencode-api",
        "--base-url",
        `http://127.0.0.1:${address.port}`,
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          SEMANTIC_GATE_HOME: path.join(temp, "home"),
          OPENCODE_API_KEY: "opencode-key",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /opencode\/model-a/);
    assert.match(result.stdout, /opencode\/model-b/);
  } finally {
    await closeServer(server);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("models list and set-default use provider model list", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-models-"));
  const project = path.join(temp, "project");
  fs.mkdirSync(project, { recursive: true });

  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-key");
    if (request.url === "/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const list = await runCli(
      process.execPath,
      [CLI, "models", "list", "openai-compatible", "--base-url", baseUrl, "--api-key-env", "TEST_KEY"],
      {
        cwd: project,
        encoding: "utf8",
        env: {
          ...process.env,
          SEMANTIC_GATE_HOME: path.join(temp, "home"),
          TEST_KEY: "test-key",
        },
      },
    );
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /model-a/);
    assert.match(list.stdout, /model-b/);

    const setDefault = await runCli(
      process.execPath,
      [
        CLI,
        "models",
        "set-default",
        "openai-compatible",
        "model-b",
        "--base-url",
        baseUrl,
        "--api-key-env",
        "TEST_KEY",
      ],
      {
        cwd: project,
        encoding: "utf8",
        env: {
          ...process.env,
          SEMANTIC_GATE_HOME: path.join(temp, "home"),
          TEST_KEY: "test-key",
        },
      },
    );
    assert.equal(setDefault.status, 0, setDefault.stderr);
    assert.match(setDefault.stdout, /openai-compatible \/ model-b/);
  } finally {
    await closeServer(server);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("models list openrouter can use public model endpoint without API key", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-openrouter-models-"));
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, undefined);
    if (request.url === "/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "openrouter/model-a" }, { id: "openrouter/model-b" }] }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const result = await runCli(
      process.execPath,
      [
        CLI,
        "models",
        "list",
        "openrouter",
        "--base-url",
        `http://127.0.0.1:${address.port}`,
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          SEMANTIC_GATE_HOME: path.join(temp, "home"),
          OPENROUTER_API_KEY: "",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /openrouter\/model-a/);
    assert.match(result.stdout, /openrouter\/model-b/);
  } finally {
    await closeServer(server);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("models list codex-cli reads current catalog from codex debug models", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-codex-models-"));
  const fakeCodex = path.join(temp, "fake-codex.js");
  fs.writeFileSync(
    fakeCodex,
    'if (process.argv[2] === "debug" && process.argv[3] === "models") { console.log(JSON.stringify({ models: [{ slug: "gpt-5.5", display_name: "GPT-5.5" }, { slug: "gpt-5-codex", display_name: "GPT-5 Codex" }] })); process.exit(0); } process.exit(1);\n',
    "utf8",
  );

  try {
    const result = await runCli(process.execPath, [
      CLI,
      "models",
      "list",
      "codex-cli",
      "--model-list-command",
      process.execPath,
      "--model-list-args",
      JSON.stringify([fakeCodex, "debug", "models"]),
    ], {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        SEMANTIC_GATE_HOME: path.join(temp, "home"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /gpt-5\.5/);
    assert.match(result.stdout, /gpt-5-codex/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("models list opencode reads current catalog from opencode models", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-opencode-models-"));
  const fakeOpenCode = path.join(temp, "fake-opencode.js");
  fs.writeFileSync(
    fakeOpenCode,
    'if (process.argv[2] === "models") { console.log("opencode/gpt-5.5\\nopencode-go/kimi-k2.7-code\\nopenrouter/openai/gpt-5.5"); process.exit(0); } process.exit(1);\n',
    "utf8",
  );

  try {
    const result = await runCli(process.execPath, [
      CLI,
      "models",
      "list",
      "opencode",
      "--model-list-command",
      process.execPath,
      "--model-list-args",
      JSON.stringify([fakeOpenCode, "models"]),
    ], {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        SEMANTIC_GATE_HOME: path.join(temp, "home"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /opencode\/gpt-5\.5/);
    assert.match(result.stdout, /opencode-go\/kimi-k2\.7-code/);
    assert.match(result.stdout, /openrouter\/openai\/gpt-5\.5/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function runCli(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
