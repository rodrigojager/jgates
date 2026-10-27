import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseCli } from "../dist/args.js";
import { initProjectConfig, loadEffectiveConfig, writeConfigValue } from "../dist/config.js";

const CLI = path.resolve("dist/cli.js");

test("parseCli keeps objective file and provider flags without shell-sensitive objective text", () => {
  const parsed = parseCli([
    "run",
    "--objective-file",
    "C:/tmp/objective with spaces.md",
    "--provider",
    "openrouter",
    "--model=anthropic/claude-sonnet-5.5",
    "--reasoning-effort",
    "high",
    "--codex-sandbox",
    "read-only",
    "--codex-bypass-sandbox",
    "--no-codex-skip-git-repo-check",
    "--json",
  ]);

  assert.equal(parsed.command, "run");
  assert.equal(parsed.options.objectiveFile, "C:/tmp/objective with spaces.md");
  assert.equal(parsed.options.provider, "openrouter");
  assert.equal(parsed.options.model, "anthropic/claude-sonnet-5.5");
  assert.equal(parsed.options.reasoningEffort, "high");
  assert.equal(parsed.options.codexSandbox, "read-only");
  assert.equal(parsed.options.codexBypassSandbox, true);
  assert.equal(parsed.options.codexSkipGitRepoCheck, false);
  assert.equal(parsed.options.json, true);
});

test("config precedence is flags over env over project over global", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-config-"));
  const home = path.join(temp, "home");
  const project = path.join(temp, "project");
  fs.mkdirSync(project, { recursive: true });

  const oldHome = process.env.SEMANTIC_GATE_HOME;
  const oldProvider = process.env.SEMANTIC_GATE_PROVIDER;
  const oldReasoningEffort = process.env.SEMANTIC_GATE_REASONING_EFFORT;
  const oldCodexSandbox = process.env.SEMANTIC_GATE_CODEX_SANDBOX;
  const oldCodexSkipGitRepoCheck = process.env.SEMANTIC_GATE_CODEX_SKIP_GIT_REPO_CHECK;
  process.env.SEMANTIC_GATE_HOME = home;
  process.env.SEMANTIC_GATE_PROVIDER = "anthropic";
  process.env.SEMANTIC_GATE_REASONING_EFFORT = "high";
  process.env.SEMANTIC_GATE_CODEX_SANDBOX = "read-only";
  process.env.SEMANTIC_GATE_CODEX_SKIP_GIT_REPO_CHECK = "false";

  try {
    writeConfigValue(project, "global", "provider", "openrouter");
    writeConfigValue(project, "global", "threshold", 80);
    initProjectConfig(project);
    writeConfigValue(project, "project", "threshold", 91);

    const config = loadEffectiveConfig(project, { threshold: 95, provider: "mock" });
    assert.equal(config.provider, "mock");
    assert.equal(config.threshold, 95);

    const envConfig = loadEffectiveConfig(project, {});
    assert.equal(envConfig.provider, "anthropic");
    assert.equal(envConfig.reasoningEffort, "high");
    assert.equal(envConfig.codexSandbox, "read-only");
    assert.equal(envConfig.codexSkipGitRepoCheck, false);
    assert.equal(envConfig.threshold, 91);
  } finally {
    restoreEnv("SEMANTIC_GATE_HOME", oldHome);
    restoreEnv("SEMANTIC_GATE_PROVIDER", oldProvider);
    restoreEnv("SEMANTIC_GATE_REASONING_EFFORT", oldReasoningEffort);
    restoreEnv("SEMANTIC_GATE_CODEX_SANDBOX", oldCodexSandbox);
    restoreEnv("SEMANTIC_GATE_CODEX_SKIP_GIT_REPO_CHECK", oldCodexSkipGitRepoCheck);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("status shows effective provider model threshold and config paths", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-gate-status-"));
  const home = path.join(temp, "home");
  const project = path.join(temp, "project");
  fs.mkdirSync(project, { recursive: true });

  const oldHome = process.env.SEMANTIC_GATE_HOME;
  const oldProvider = process.env.SEMANTIC_GATE_PROVIDER;

  try {
    process.env.SEMANTIC_GATE_HOME = home;
    delete process.env.SEMANTIC_GATE_PROVIDER;
    writeConfigValue(project, "global", "provider", "codex-cli");
    writeConfigValue(project, "global", "model", "gpt-5.5");
    writeConfigValue(project, "global", "threshold", 88);
    initProjectConfig(project);
    writeConfigValue(project, "project", "threshold", 93);

    const text = spawnSync(process.execPath, [CLI, "status"], {
      cwd: project,
      encoding: "utf8",
      env: {
        ...process.env,
        SEMANTIC_GATE_HOME: home,
      },
    });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Provider: codex-cli/);
    assert.match(text.stdout, /Model: gpt-5\.5/);
    assert.match(text.stdout, /Threshold: 93/);
    assert.match(text.stdout, /Codex sandbox: read-only/);
    assert.match(text.stdout, /Codex skip git repo check: true/);
    assert.match(text.stdout, /Credential: not required/);

    const json = spawnSync(process.execPath, [CLI, "status", "--json"], {
      cwd: project,
      encoding: "utf8",
      env: {
        ...process.env,
        SEMANTIC_GATE_HOME: home,
      },
    });
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.provider, "codex-cli");
    assert.equal(parsed.model, "gpt-5.5");
    assert.equal(parsed.threshold, 93);
    assert.equal(parsed.codexSandbox, "read-only");
    assert.equal(parsed.codexSkipGitRepoCheck, true);
    assert.equal(parsed.credential.source, "not-required");
    assert.equal(parsed.configFiles.project, path.join(project, ".semantic-gate.json"));
  } finally {
    restoreEnv("SEMANTIC_GATE_HOME", oldHome);
    restoreEnv("SEMANTIC_GATE_PROVIDER", oldProvider);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
