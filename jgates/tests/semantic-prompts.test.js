import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Prompts of the semantic gate in files (semantic-gate/templates), customized per project through
// extensions.semantic-gate.prompts (system and review, mode replace|append, file in the config folder: the workspace,
// or the CI policy in governed mode). The output contract always closes the prompt. The sha256 of the prompts in
// effect goes to $.semantic.prompts and $.provenance.semanticPrompts. The provider is always a fake: no model tokens.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const DIST = path.join(repo, "jgates", "dist");
const MAIN = path.join(DIST, "cli", "main.js");
const FIXTURES = path.join(repo, "semantic-gate", "tests", "fixtures", "prompts");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const { createPiiFixture, removePiiFixture } = require(path.join(repo, "tests", "fixtures", "jgates", "pii-fixture.js"));
const load = (rel) => import(pathToFileURL(path.join(DIST, rel)).href);
const { runSemanticReview, readSemanticState, loadGate } = await load("adapters/semantic-gate/index.js");
const validateResult = new Ajv2020({ strict: true, allErrors: true }).compile(JSON.parse(fs.readFileSync(path.join(here, "..", "schemas", "result", "result.schema.json"), "utf8")));

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const APPROVED = JSON.stringify({ status: "APPROVED", score: 100, findings: [], hardBlockers: [], requiredFixPlan: [], approvalNotes: "fake" });
const OUTPUT_TAIL = "Do not include deterministic findings unless they have a separate semantic consequence. Do not output Markdown.";
const FORMAT_LINE = "Return valid JSON only. Do not include Markdown fences.";
const RUBRIC = fs.readFileSync(path.join(repo, "semantic-gate", "templates", "semantic-review-skill.md"), "utf8");

// The synthetic context the semantic-gate fixtures were captured with.
const CONTEXT = {
  repoRoot: "/repo",
  scope: "changed",
  paths: [],
  excludes: ["dist/**"],
  includes: [],
  ignoreFiles: [".semantic-gateignore"],
  statusShort: " M src/app.ts\n?? src/new.ts",
  diffStat: " src/app.ts | 2 +-",
  stagedDiffStat: "",
  commandsExecuted: [],
  changedFiles: [
    { path: "src/app.ts", changeKinds: ["modified"], diff: "-return 1;\n+return 2;", content: "export const a = () => 2;\n" },
    { path: "src/new.ts", changeKinds: ["untracked"], content: "export const b = 3;\n", truncated: true },
  ],
  warnings: ["one warning"],
};

/** A folder with jgates.yml (the semantic block given as YAML lines) and the given extra files. */
function configFolder(semantic = [], files = {}) {
  const dir = tmp("jgates-prompts-");
  fs.writeFileSync(path.join(dir, "jgates.yml"), ["schemaVersion: 1", "extensions:", "  semantic-gate:", "    provider: command", "    model: fake-model", '    objective: "Return two from a."', ...semantic.map((l) => `    ${l}`), ""].join("\n"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

/** One review over the synthetic context; the fake provider records what it would send. */
async function review(workspace, options = {}) {
  const real = await loadGate();
  const gate = { ...real, collectGitReviewContext: async () => structuredClone(CONTEXT) };
  const calls = [];
  const callProvider = async (request) => {
    calls.push({ system: request.system, prompt: request.prompt });
    return { text: APPROVED, raw: null };
  };
  const outcome = await runSemanticReview(workspace, { env: process.env, ...options }, { loadGate: async () => gate, callProvider });
  return { outcome, calls };
}

test("with the default files the prompt sent is the one captured before the move", async () => {
  const dir = configFolder();
  try {
    const { outcome, calls } = await review(dir);
    assert.equal(outcome.state, "completed", outcome.reason);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].system, fs.readFileSync(path.join(FIXTURES, "system.txt"), "utf8"));
    // The fixture was built with an objective file; here the objective comes from jgates.yml.
    const [expected] = JSON.parse(fs.readFileSync(path.join(FIXTURES, "single.json"), "utf8"));
    assert.equal(calls[0].prompt, expected.prompt.replace("Source: file:objective.md", "Source: jgates.yml"));
    const { resolvePrompts } = await import(pathToFileURL(path.join(repo, "semantic-gate", "dist", "prompt.js")).href);
    const defaults = resolvePrompts().info;
    assert.deepEqual(outcome.prompts, {
      sha256: defaults.sha256,
      system: { source: "default", mode: "default", file: null, sha256: sha256(calls[0].system) },
      review: { source: "default", mode: "default", file: null, sha256: sha256(RUBRIC) },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review in append mode adds the project text; system in replace mode swaps it; the format instruction stays last", async () => {
  const dir = configFolder(
    ["prompts:", "  system: { mode: replace, file: prompts/system.md }", "  review: { mode: append, file: prompts/review.md }"],
    { "prompts/system.md": "You review payment code.\n", "prompts/review.md": "## Project Criteria\n\n- Money is never a float.\n" },
  );
  try {
    const { outcome, calls } = await review(dir);
    assert.equal(outcome.state, "completed", outcome.reason);
    const [{ system, prompt }] = calls;
    assert.equal(system, `You review payment code.\n${FORMAT_LINE}`);
    assert.ok(prompt.startsWith(`## Semantic Review Rubric\n\n${RUBRIC.trimEnd()}\n\n## Project Criteria\n\n- Money is never a float.\n`));
    assert.ok(prompt.indexOf("Money is never a float.") < prompt.indexOf("## Objective"));
    assert.ok(prompt.lastIndexOf("## Output Contract") > prompt.indexOf("Money is never a float."));
    assert.ok(prompt.trimEnd().endsWith(OUTPUT_TAIL));
    assert.equal(outcome.prompts.system.source, "project");
    assert.deepEqual(
      { system: { ...outcome.prompts.system, sha256: null }, review: { ...outcome.prompts.review, sha256: null } },
      {
        system: { source: "project", mode: "replace", file: "prompts/system.md", sha256: null },
        review: { source: "project", mode: "append", file: "prompts/review.md", sha256: null },
      },
    );
    assert.equal(outcome.prompts.system.sha256, sha256(system));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the hash of the effective prompts changes when the project file changes", async () => {
  const dir = configFolder(["prompts:", "  review: { mode: append, file: review.md }"], { "review.md": "First rule.\n" });
  try {
    const first = (await review(dir)).outcome.prompts;
    const again = (await review(dir)).outcome.prompts;
    assert.deepEqual(again, first, "same files, same hashes");
    fs.writeFileSync(path.join(dir, "review.md"), "Second rule.\n");
    const second = (await review(dir)).outcome.prompts;
    assert.notEqual(second.sha256, first.sha256);
    assert.notEqual(second.review.sha256, first.review.sha256);
    assert.equal(second.system.sha256, first.system.sha256);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("in governed mode the prompt files come from the policy folder", async () => {
  const workspace = configFolder([], { "review.md": "Workspace text that must not be used.\n" });
  const policy = configFolder(["prompts:", "  review: { mode: replace, file: review.md }"], { "review.md": "Policy rubric.\n" });
  try {
    const { outcome, calls } = await review(workspace, { configDir: policy });
    assert.equal(outcome.state, "completed", outcome.reason);
    assert.ok(calls[0].prompt.startsWith("## Semantic Review Rubric\n\nPolicy rubric.\n"));
    assert.ok(!calls[0].prompt.includes("Workspace text"));
    assert.deepEqual({ ...outcome.prompts.review, sha256: null }, { source: "policy", mode: "replace", file: "review.md", sha256: null });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(policy, { recursive: true, force: true });
  }
});

test("a prompts block that is wrong, missing or outside the config folder sends nothing", async () => {
  const outside = tmp("jgates-prompts-outside-");
  fs.writeFileSync(path.join(outside, "x.md"), "outside\n");
  const cases = [
    [["prompts:", "  review: { mode: append, file: missing.md }"], /prompts\.review\.file does not exist/],
    [["prompts:", `  review: { mode: append, file: ${JSON.stringify(path.join(outside, "x.md"))} }`], /must stay inside the configuration folder/],
    [["prompts:", "  review: { mode: append, file: ../x.md }"], /must stay inside the configuration folder/],
    [["prompts:", "  review: { mode: merge, file: r.md }"], /prompts\.review\.mode must be replace or append/],
    [["prompts:", "  output: { mode: replace, file: r.md }"], /prompts\.output is not a known prompt/],
    [["prompts: [a]"], /prompts must be a mapping/],
  ];
  try {
    for (const [lines, problem] of cases) {
      const dir = configFolder(lines, { "r.md": "x\n" });
      try {
        const state = readSemanticState(dir);
        assert.equal(state.state, "invalid", lines.join(" "));
        assert.ok(state.problems.some((p) => problem.test(p)), `${lines.join(" ")}: ${state.problems.join("; ")}`);
        const { outcome, calls } = await review(dir);
        assert.equal(outcome.state, "not-configured");
        assert.equal(calls.length, 0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("jgates run --semantic records the prompt hash in the provenance, and it changes with the project file", () => {
  const fixture = createPiiFixture();
  const home = tmp("jgates-prompts-home-");
  const aux = tmp("jgates-prompts-aux-");
  const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON };
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input: "", timeout: 120_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  try {
    const init = cli(["init", "--cwd", fixture.dir, "--profile", "minimal", "--no-interactive", "--json"]);
    assert.equal(init.code, 0, init.out + init.err);
    const fake = path.join(aux, "fake-provider.mjs");
    fs.writeFileSync(fake, `for await (const c of process.stdin) void c;\nprocess.stdout.write(${JSON.stringify(APPROVED)});\n`);
    const configFile = path.join(fixture.dir, "jgates.yml");
    const block = [
      "extensions:",
      "  semantic-gate:",
      "    provider: command",
      `    command: ${JSON.stringify(process.execPath)}`,
      `    commandArgs: [${JSON.stringify(fake)}]`,
      "    model: fake-model",
      "    prompts:",
      "      review: { mode: append, file: .jgates/semantic-review.md }",
      "",
    ].join("\n");
    fs.writeFileSync(configFile, `${fs.readFileSync(configFile, "utf8").replace(/\n*$/, "\n")}${block}`);
    fs.mkdirSync(path.join(fixture.dir, ".jgates"), { recursive: true });
    fs.writeFileSync(path.join(fixture.dir, ".jgates", "semantic-review.md"), "Check the record format.\n");
    spawnSync("git", ["init", "-q"], { cwd: fixture.dir });
    const run = () => cli(["run", "--cwd", fixture.dir, "--no-interactive", "--json", "--only", "tool:builtin-pii", "--semantic"]);

    const first = run();
    assert.ok(first.doc, first.out + first.err);
    assert.equal(first.doc.semantic.state, "completed", first.doc.semantic.reason);
    assert.ok(validateResult(first.doc), JSON.stringify(validateResult.errors));
    const recorded = first.doc.provenance.semanticPrompts;
    assert.deepEqual(recorded, first.doc.semantic.prompts);
    assert.match(recorded.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual({ ...recorded.review, sha256: null }, { source: "project", mode: "append", file: ".jgates/semantic-review.md", sha256: null });
    assert.equal(recorded.system.source, "default");
    const onDisk = JSON.parse(fs.readFileSync(path.join(first.doc.runDir, "result.json"), "utf8"));
    assert.deepEqual(onDisk.provenance.semanticPrompts, recorded);

    fs.writeFileSync(path.join(fixture.dir, ".jgates", "semantic-review.md"), "Check the record format and the totals.\n");
    const second = run();
    assert.equal(second.doc.semantic.state, "completed", second.doc.semantic.reason);
    assert.notEqual(second.doc.provenance.semanticPrompts.sha256, recorded.sha256);
    assert.notEqual(second.doc.provenance.semanticPrompts.review.sha256, recorded.review.sha256);
    assert.equal(second.doc.provenance.semanticPrompts.system.sha256, recorded.system.sha256);

    // Without --semantic the provenance has no prompts.
    const plain = cli(["run", "--cwd", fixture.dir, "--no-interactive", "--json", "--only", "tool:builtin-pii"]);
    assert.ok(plain.doc, plain.out + plain.err);
    assert.equal(plain.doc.provenance.semanticPrompts, undefined);
  } finally {
    removePiiFixture(fixture.dir);
    for (const d of [home, aux]) fs.rmSync(d, { recursive: true, force: true });
  }
});
