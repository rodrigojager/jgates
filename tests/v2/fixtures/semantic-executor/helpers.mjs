// Shared setup of the investigation executor cases (V2-10, V2-16, V2-17, V2-28): a temporary Git repository with the
// given files and a jgates.yml whose semantic provider is the scripted mock (or an agent CLI wrapper), a temporary
// JGATES_HOME, and a runner that builds the Semantic plan and executes the run in-process with the built-in
// investigation module. Every model answer is scripted: no test spends model tokens.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..", "..", "..");
export const load = (rel) => import(pathToFileURL(path.join(ROOT, "jgates", "dist", rel)).href);
export const loadGate = (rel) => import(pathToFileURL(path.join(ROOT, "semantic-gate", "dist", rel)).href);
export const FIXTURES = here;

const GIT_ENV = { GIT_AUTHOR_NAME: "Executor Test", GIT_AUTHOR_EMAIL: "executor@example.invalid", GIT_COMMITTER_NAME: "Executor Test", GIT_COMMITTER_EMAIL: "executor@example.invalid" };

/**
 * A workspace inside its own parent folder (so "../x" from the workspace is a file the test owns), with the files given
 * (relative path -> text) committed, and a semantic provider block.
 */
export function setupWorkspace(prefix, files, { provider = "mock", extra = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const dir = path.join(root, "ws");
  const home = path.join(root, "home");
  fs.mkdirSync(dir);
  fs.mkdirSync(home);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  fs.writeFileSync(path.join(dir, "jgates.yml"), ["extensions:", "  semantic-gate:", `    provider: ${provider}`, "    model: scripted-model", "    timeoutSeconds: 60", ...extra, ""].join("\n"));
  const env = { ...process.env, ...GIT_ENV, JGATES_HOME: home, NO_COLOR: "1", JGATES_LOCALE: "en" };
  const git = (...args) => {
    const r = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", env });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return { root, dir, home, env, git, cleanup };
}

/** Builds the plan (scope, rigor, budget) and runs one Semantic run with the investigation module and a scripted model. */
export async function runInvestigation(ws, { scope = null, rigor = "standard", budget = null, script, agentCli, signal, runId, onEvent } = {}) {
  const { buildSemanticPlan, executeSemanticRun } = await load("core/semantic/index.js");
  const { INVESTIGATION_MODULE } = await load("core/semantic-executor/index.js");
  const plan = buildSemanticPlan({ workspacePath: ws.dir, home: ws.home, env: ws.env, scope, rigor, budget });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const result = await executeSemanticRun({
    workspacePath: ws.dir,
    home: ws.home,
    env: ws.env,
    version: "0.0.0-test",
    plan,
    ...(runId ? { runId } : {}),
    ...(signal ? { signal } : {}),
    ...(onEvent ? { onEvent } : {}),
    cancelPollMs: 50,
    investigation: { module: INVESTIGATION_MODULE, deps: script ? { script } : {}, ...(agentCli ? { agentCli } : {}) },
  });
  return { plan, result, outcome: result.semanticRun.outcome, investigation: result.semanticRun.outcome.investigation };
}

/** A scripted model by context label that records every request it receives (the mock provider calls it). */
export function recordingScript(contexts) {
  const requests = [];
  const script = (request) => {
    requests.push(JSON.parse(JSON.stringify({ contextLabel: request.contextLabel, system: request.system, messages: request.messages, toolChoice: request.toolChoice, tools: request.tools.map((t) => t.name) })));
    const label = request.contextLabel;
    const turns = contexts[label] ?? contexts[label.split(":")[0]] ?? [];
    const index = request.messages.filter((m) => m.role === "assistant").length;
    const turn = turns[index];
    return typeof turn === "function" ? turn(request) : (turn ?? { text: "" });
  };
  return { script, requests };
}

export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

export function readEvents(runDir) {
  return fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

/** Every text file under a folder, concatenated (to prove a value never reached any artifact). */
export function allText(dir) {
  let out = "";
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out += allText(p);
    else out += fs.readFileSync(p, "utf8");
  }
  return out;
}

export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

export async function until(check, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export const usage = (inputTokens, outputTokens) => ({ inputTokens, outputTokens });
