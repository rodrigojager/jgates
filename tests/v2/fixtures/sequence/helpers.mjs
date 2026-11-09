// Shared setup of the gate-sequence cases (V2-03..V2-08, V2-13, V2-18, V2-30). A Git workspace whose Quality gate is one
// controllable generic-command check (check.mjs, capability lint) plus a trivial second check, a project profile `seq`
// that selects only those, and a Semantic provider that is the scripted mock of semantic-gate (provider: mock, its
// answers in a JSON tool script named by SEMANTIC_GATE_MOCK_TOOL_SCRIPT): a reviewer that reads the subjects, examines
// every dimension of the general review and approves. Provider calls are counted from what each Semantic run recorded
// (outcome.calls): only a Semantic run can call the provider. The cases drive the real CLI (jgates/dist/cli/main.js) in
// child processes and the real server routes; nothing here spends model tokens. JGATES_NO_CACHE=1 keeps every Quality
// run a real execution.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, "..", "..", "..", "..");
export const DIST = path.join(root, "jgates", "dist");
export const MAIN = path.join(DIST, "cli", "main.js");
const CHECK = path.join(here, "check.mjs");
/** Every file the fixture writes: the subjects of a Semantic run of the whole repository. */
export const ALL_FILES = [".jgates/profiles.yml", ".jgates/templates/seq.yml", "evidence.schema.json", "jgates.yml", "src/core/a.js", "src/other/b.js"];
const DIMENSIONS = ["functional-correctness", "tests", "maintainability", "architecture", "performance-reliability", "security"];

export const importDist = (...parts) => import(pathToFileURL(path.join(DIST, ...parts)).href);

const yamlList = (values) => `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;

/** The scripted reviewer: reads the subjects, plans and examines every dimension with them, reports no candidate. */
function reviewerScript(subjects) {
  const read = { toolCalls: subjects.map((p) => ({ name: "read_file", arguments: { path: p } })) };
  const plan = { summary: "Fixture modules and their configuration.", dimensions: DIMENSIONS.map((id) => ({ id, files: subjects, hypotheses: [`${id}: nothing suspicious in the fixture`] })) };
  const hunt = { summary: "Every dimension examined; nothing to report.", dimensions: DIMENSIONS.map((id) => ({ id, state: "examined", reviewed_paths: subjects, checks: [`checked ${id}`] })), candidates: [], gaps: [] };
  const answer = (value) => ({ text: JSON.stringify(value), usage: { inputTokens: 100, outputTokens: 50 } });
  return { contexts: { "evidence-planning": [read, answer(plan)], hunting: [read, answer(hunt)] } };
}

/**
 * Creates the workspace. Options: `prefix` (temp folder names), `profile` (extra YAML lines under profiles.seq),
 * `selection` (extra YAML lines under selection in jgates.yml), `policy` (the text of .jgates/policy.yml),
 * `timeoutSeconds` of every check (execution.timeoutSeconds, default 60), `reviewSubjects` the files the scripted reviewer
 * reads and examines (default: every file of the fixture, the subjects of a whole-repository review).
 */
export function setupSequenceProject(options = {}) {
  const prefix = options.prefix ?? "v2-seq";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-ws-`));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-home-`));
  const aux = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-aux-`));
  const modeFile = path.join(aux, "mode.txt");
  const script = path.join(aux, "reviewer-script.json");
  fs.writeFileSync(script, JSON.stringify(reviewerScript(options.reviewSubjects ?? ALL_FILES)));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write(
    "jgates.yml",
    [
      "schemaVersion: 1",
      "selection:",
      "  profile: seq",
      ...(options.selection ?? []).map((l) => `  ${l}`),
      "templates:",
      "  - id: seq",
      "    source: .jgates/templates/seq.yml",
      "    activation: always",
      "extensions:",
      "  semantic-gate:",
      "    provider: mock",
      "    model: scripted-model",
      "    timeoutSeconds: 60",
      "",
    ].join("\n"),
  );
  write(
    ".jgates/templates/seq.yml",
    [
      "schemaVersion: 1",
      "id: seq",
      "config:",
      "  execution:",
      `    timeoutSeconds: ${options.timeoutSeconds ?? 60}`,
      "  tools:",
      "    seq-check:",
      "      adapter: generic-command",
      "      enabled: true",
      "      capabilities: [lint]",
      `      command: ${JSON.stringify(process.execPath)}`,
      `      args: ${yamlList([CHECK, "{outputDir}", modeFile, "{workspace}"])}`,
      "      config:",
      "        effects: { readsCode: true, writesOutputs: true, mayChangeCode: false, executesProjectCode: true, usesNetwork: false }",
      "        evidence: { kind: json-file, file: evidence.json, schema: evidence.schema.json }",
      "    seq-extra:",
      "      adapter: generic-command",
      "      enabled: true",
      "      capabilities: [lint]",
      `      command: ${JSON.stringify(process.execPath)}`,
      `      args: ["-e", "process.exit(0)"]`,
      "      config:",
      "        effects: { readsCode: false, writesOutputs: false, mayChangeCode: false, executesProjectCode: false, usesNetwork: false }",
      "        evidence: { kind: exit-code }",
      "",
    ].join("\n"),
  );
  write(".jgates/profiles.yml", ["schemaVersion: 1", "profiles:", "  seq:", "    label: Sequence", "    checks:", '      "capability:lint": { enabled: true }', '      "tool:quality-bridge": { enabled: false }', ...(options.profile ?? []).map((l) => `    ${l}`), ""].join("\n"));
  if (options.policy) write(".jgates/policy.yml", options.policy);
  write("evidence.schema.json", JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { const: true } } }));
  write("src/core/a.js", "exports.a = () => 1;\n");
  write("src/other/b.js", "exports.b = () => 2;\n");
  const git = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  fs.writeFileSync(modeFile, "pass");

  const env = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1", NO_COLOR: "1", SEMANTIC_GATE_MOCK_TOOL_SCRIPT: script };
  const parse = (stdout) => {
    try {
      return JSON.parse(stdout);
    } catch {
      return null;
    }
  };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input: "", timeout: 180_000 });
    return { code: r.status, out: r.stdout, err: r.stderr, doc: parse(r.stdout) };
  };
  /** Starts the CLI without waiting; `done` resolves when it exits. */
  const cliAsync = (...args) => {
    const child = spawn(process.execPath, [MAIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const done = new Promise((resolve) => child.on("close", (code) => resolve({ code, out, err, doc: parse(out) })));
    return { child, done };
  };
  /** Provider calls of each Semantic run of the data folder, as each run recorded them. */
  const callsPerRun = () => {
    const out = [];
    for (const ws of listDir(path.join(home, "workspaces"))) {
      const semanticDir = path.join(home, "workspaces", ws, "semantic-runs");
      for (const run of listDir(semanticDir)) {
        try {
          out.push(Number(JSON.parse(fs.readFileSync(path.join(semanticDir, run, "result.json"), "utf8")).semanticRun?.outcome?.calls ?? 0));
        } catch {
          // A run without a readable result cannot prove it made no call: it counts as one.
          out.push(1);
        }
      }
    }
    return out;
  };
  /** Every provider call made so far (0 means the provider was never invoked). */
  const providerCalls = () => callsPerRun().reduce((a, b) => a + b, 0);
  /** How many Semantic runs called the provider (one review each). */
  const reviews = () => callsPerRun().filter((n) => n > 0).length;
  const setMode = (mode) => fs.writeFileSync(modeFile, mode);
  const started = () => fs.existsSync(`${modeFile}.started`);
  // A server shares its environment with the CLI children it starts: while a case uses the routes, this process gets the
  // same data folder, cache setting and scripted model as the CLI (restored on cleanup).
  const savedEnv = { JGATES_HOME: process.env.JGATES_HOME, JGATES_NO_CACHE: process.env.JGATES_NO_CACHE, SEMANTIC_GATE_MOCK_TOOL_SCRIPT: process.env.SEMANTIC_GATE_MOCK_TOOL_SCRIPT };
  const cleanup = () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // A child the API started can still be exiting (Windows refuses to remove the folder it runs in): retry briefly.
    for (const d of [dir, home, aux]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  };
  /** A fake server context for the route handlers (the same workspace, data folder and environment as the CLI). */
  const server = async (version) => {
    process.env.JGATES_HOME = home;
    process.env.JGATES_NO_CACHE = "1";
    process.env.SEMANTIC_GATE_MOCK_TOOL_SCRIPT = script;
    const { workspaceId } = await importDist("core", "ids", "index.js");
    return { home, projectDir: dir, policyMode: false, workspace: { id: workspaceId(dir), path: dir, name: prefix }, version, log: () => undefined };
  };
  return { dir, home, aux, env, cli, cliAsync, providerCalls, reviews, setMode, started, cleanup, server, write };
}

/** Waits until `predicate()` is true (checked every 100 ms) or fails after `ms`. */
export async function waitFor(predicate, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** The folder of a Quality run and the Semantic runs folder of the workspace. */
export function runFolders(home, workspaceId) {
  return { runs: path.join(home, "workspaces", workspaceId, "runs"), semantic: path.join(home, "workspaces", workspaceId, "semantic-runs"), sequences: path.join(home, "workspaces", workspaceId, "sequences") };
}

export const listDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
