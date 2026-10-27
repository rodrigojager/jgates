// The prompts of the semantic gate live in files of templates/ (the code only assembles them). These tests pin the
// default assembly against the prompts captured before the move (tests/fixtures/prompts), the project customization
// (replace/append, the output contract always last), the `prompts` command and the hash of the effective prompts.
// No test calls a real model: the providers are the built-in mock or a local fake command.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI = path.resolve("dist/cli.js");
const FIXTURES = path.resolve("tests/fixtures/prompts");
const { buildPromptChunks, buildSynthesisPrompt, systemPrompt, resolvePrompts, defaultPromptPaths, SYSTEM_FORMAT_LINE } = await import(
  path.resolve("dist/prompt.js")
);
const { defaultConfig } = await import(path.resolve("dist/config.js"));

const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

// The same synthetic context the fixtures were captured with (no git, no temp paths).
const context = {
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
const objective = { text: "Return two from a.", source: "file:objective.md" };
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const OUTPUT_TAIL = "Do not include deterministic findings unless they have a separate semantic consequence. Do not output Markdown.";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, SEMANTIC_GATE_HOME: options.home ?? tempDir("semantic-gate-home-") },
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
}

test("the default prompt files assemble exactly the prompts captured before the move", () => {
  const config = { ...defaultConfig };
  assert.equal(systemPrompt(), fixture("system.txt"));
  assert.equal(systemPrompt(resolvePrompts()), fixture("system.txt"));
  assert.deepEqual(buildPromptChunks(objective, context, config), JSON.parse(fixture("single.json")));
  assert.deepEqual(
    buildPromptChunks(objective, context, { ...config, contextStrategy: "chunked", maxContextChars: 10790 }),
    JSON.parse(fixture("chunked.json")),
  );
  assert.equal(buildSynthesisPrompt(objective, context, [{ status: "APPROVED", score: 95 }], config), fixture("synthesis.txt"));
});

test("the default prompt files exist in templates/ and hold the texts the code assembles", () => {
  const paths = defaultPromptPaths();
  assert.equal(path.basename(paths.system), "system-prompt.md");
  assert.equal(path.basename(paths.review), "semantic-review-skill.md");
  for (const file of Object.values(paths)) assert.ok(fs.statSync(file).isFile(), file);
  assert.equal(fs.readFileSync(paths.system, "utf8").trimEnd(), systemPrompt());
  const prompts = resolvePrompts();
  assert.equal(prompts.review, fs.readFileSync(paths.review, "utf8"));
  assert.deepEqual(prompts.info.system, { source: "default", mode: "default", file: null, sha256: sha256(prompts.system) });
  assert.deepEqual(prompts.info.review, { source: "default", mode: "default", file: null, sha256: sha256(prompts.review) });
});

test("no Portuguese text in the prompt files and in the prompt assembly", () => {
  const files = [...fs.readdirSync("templates").map((f) => path.join("templates", f)), "src/prompt.ts"];
  const portuguese = /[ãõçáéíóúâêôàÃÕÇÁÉÍÓÚÂÊÔ]|\b(não|você|para o|para a|que o|que a|deve|revis[aã]o|crit[eé]rio|arquivo|mudança)\b/i;
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const line = text.split("\n").find((l) => portuguese.test(l));
    assert.equal(line, undefined, `${file} has Portuguese text: ${line}`);
  }
});

test("review in append mode adds the project text after the rubric; the output contract stays last", () => {
  const dir = tempDir("semantic-gate-prompts-");
  const file = path.join(dir, "review.md");
  fs.writeFileSync(file, "## Project Criteria\n\n- Every public function documents its errors.\n");
  const prompts = resolvePrompts({ review: { mode: "append", file } });
  const rubric = fs.readFileSync(defaultPromptPaths().review, "utf8");
  assert.equal(prompts.review, `${rubric.trimEnd()}\n\n## Project Criteria\n\n- Every public function documents its errors.\n`);
  assert.equal(prompts.system, fixture("system.txt"), "the system prompt is untouched");
  const [chunk] = buildPromptChunks(objective, context, { ...defaultConfig }, prompts);
  assert.ok(chunk.prompt.includes("Every public function documents its errors."));
  assert.ok(chunk.prompt.indexOf("Every public function documents its errors.") < chunk.prompt.indexOf("## Objective"));
  assert.ok(chunk.prompt.trimEnd().endsWith(OUTPUT_TAIL), "the output contract closes the prompt");
  assert.ok(chunk.prompt.lastIndexOf("## Output Contract") > chunk.prompt.indexOf("Every public function"));
  // The config route gives the same result.
  assert.deepEqual(buildPromptChunks(objective, context, { ...defaultConfig, prompts: { review: { mode: "append", file } } }), [chunk]);
  assert.deepEqual(prompts.info.review, { source: "custom", mode: "append", file, sha256: sha256(prompts.review) });
});

test("system in replace mode swaps the system prompt; the format instruction stays last", () => {
  const dir = tempDir("semantic-gate-prompts-");
  const file = path.join(dir, "system.md");
  fs.writeFileSync(file, "You are the reviewer of the payments team.\nBe strict about money rounding.\n");
  const prompts = resolvePrompts({ system: { mode: "replace", file } });
  assert.equal(prompts.system, `You are the reviewer of the payments team.\nBe strict about money rounding.\n${SYSTEM_FORMAT_LINE}`);
  assert.ok(!prompts.system.includes("You are semantic-gate"));
  assert.ok(prompts.system.endsWith(SYSTEM_FORMAT_LINE));
  assert.equal(prompts.review, fs.readFileSync(defaultPromptPaths().review, "utf8"), "the rubric is untouched");
  const [chunk] = buildPromptChunks(objective, context, { ...defaultConfig }, prompts);
  assert.deepEqual([chunk], JSON.parse(fixture("single.json")), "the user prompt is the default one");
  assert.ok(chunk.prompt.trimEnd().endsWith(OUTPUT_TAIL));
  // system in append mode keeps the packaged lines and still closes with the format line.
  const appended = resolvePrompts({ system: { mode: "append", file } });
  assert.ok(appended.system.startsWith(fixture("system.txt")));
  assert.ok(appended.system.endsWith(`Be strict about money rounding.\n${SYSTEM_FORMAT_LINE}`));
});

test("the hash of the effective prompts changes when the project file changes", () => {
  const dir = tempDir("semantic-gate-prompts-");
  const file = path.join(dir, "review.md");
  fs.writeFileSync(file, "First criteria.\n");
  const base = resolvePrompts();
  const first = resolvePrompts({ review: { mode: "append", file } });
  assert.equal(resolvePrompts().info.sha256, base.info.sha256, "stable for the same files");
  assert.notEqual(first.info.sha256, base.info.sha256);
  fs.writeFileSync(file, "Second criteria.\n");
  const second = resolvePrompts({ review: { mode: "append", file } });
  assert.notEqual(second.info.sha256, first.info.sha256);
  assert.equal(second.info.system.sha256, first.info.system.sha256);
  assert.match(second.info.sha256, /^[0-9a-f]{64}$/);
});

test("a missing project prompt file is a usage error, not a silent default", () => {
  assert.throws(() => resolvePrompts({ review: { mode: "append", file: path.join(os.tmpdir(), "no-such-prompt.md") } }), /Missing prompts\.review file/);
  assert.throws(() => resolvePrompts({ system: { mode: "merge", file: defaultPromptPaths().system } }), /mode must be replace or append/);
});

test("semantic-gate prompts lists the default files and the project files, which exist", () => {
  const repo = tempDir("semantic-gate-prompts-repo-");
  fs.mkdirSync(path.join(repo, "prompts"));
  fs.writeFileSync(path.join(repo, "prompts", "review.md"), "Project criteria.\n");
  fs.writeFileSync(
    path.join(repo, ".semantic-gate.json"),
    JSON.stringify({ prompts: { review: { mode: "append", file: "prompts/review.md" } } }),
  );
  const result = cli(["prompts", "--cwd", repo, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const listed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(listed.defaults).sort(), ["review", "system"]);
  for (const file of Object.values(listed.defaults)) assert.ok(fs.existsSync(file), file);
  assert.deepEqual(listed.project, [{ kind: "review", mode: "append", file: path.join(repo, "prompts", "review.md"), exists: true }]);

  const text = cli(["prompts", "--cwd", repo]);
  assert.equal(text.status, 0, text.stderr);
  assert.ok(text.stdout.includes(listed.defaults.system));
  assert.ok(text.stdout.includes(listed.defaults.review));
  assert.ok(text.stdout.includes(path.join(repo, "prompts", "review.md")));
  assert.ok(!text.stdout.includes("(missing)"));
});

test("semantic-gate prompts --export copies the files and does not overwrite without --force", () => {
  const out = path.join(tempDir("semantic-gate-export-"), "prompts");
  const first = cli(["prompts", "--export", out]);
  assert.equal(first.status, 0, first.stderr);
  const defaults = defaultPromptPaths();
  for (const file of Object.values(defaults)) {
    assert.equal(fs.readFileSync(path.join(out, path.basename(file)), "utf8"), fs.readFileSync(file, "utf8"));
  }
  const edited = path.join(out, "semantic-review-skill.md");
  fs.writeFileSync(edited, "edited by the user\n");
  const again = cli(["prompts", "--export", out]);
  assert.equal(again.status, 3, "usage error");
  assert.match(again.stderr, /Refusing to overwrite/);
  assert.equal(fs.readFileSync(edited, "utf8"), "edited by the user\n", "nothing was overwritten");
  const forced = cli(["prompts", "--export", out, "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(fs.readFileSync(edited, "utf8"), fs.readFileSync(defaults.review, "utf8"));
});

test("semantic-gate run sends the project prompts to the provider, the output contract last", () => {
  const temp = tempDir("semantic-gate-prompts-run-");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "app.ts"), "export const answer = 42;\n");
  fs.writeFileSync(path.join(repo, "review.md"), "## Project Criteria\n\nCheck the answer constant.\n");
  fs.writeFileSync(path.join(temp, "objective.md"), "Add the answer constant.");
  const received = path.join(temp, "received.txt");
  const fake = path.join(temp, "fake-provider.mjs");
  fs.writeFileSync(
    fake,
    [
      'import fs from "node:fs";',
      'let input = ""; process.stdin.on("data", (c) => (input += c)); process.stdin.on("end", () => {',
      `  fs.writeFileSync(${JSON.stringify(received)}, input);`,
      '  process.stdout.write(JSON.stringify({ status: "APPROVED", score: 95, hardBlockers: [], findings: [] }));',
      "});",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(repo, ".semantic-gate.json"),
    JSON.stringify({ prompts: { review: { mode: "append", file: "review.md" } }, writeReports: false }),
  );
  spawnSync("git", ["init"], { cwd: repo });
  const result = cli([
    "run", "--cwd", repo, "--objective-file", path.join(temp, "objective.md"), "--provider", "command",
    "--command", process.execPath, "--command-args", JSON.stringify([fake]), "--json",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const prompt = fs.readFileSync(received, "utf8");
  assert.ok(prompt.startsWith(`## Semantic Review Rubric\n\n${fs.readFileSync(defaultPromptPaths().review, "utf8").trimEnd()}\n\n## Project Criteria`));
  assert.ok(prompt.includes("Check the answer constant."));
  assert.ok(prompt.trimEnd().endsWith(OUTPUT_TAIL));

  // A project file that does not exist stops the run before any provider call.
  fs.rmSync(received);
  fs.rmSync(path.join(repo, "review.md"));
  const missing = cli([
    "run", "--cwd", repo, "--objective-file", path.join(temp, "objective.md"), "--provider", "command",
    "--command", process.execPath, "--command-args", JSON.stringify([fake]), "--json",
  ]);
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /Missing prompts\.review file/);
  assert.ok(!fs.existsSync(received));
});

test("config rejects a prompts block that is not system/review with mode and file", () => {
  const repo = tempDir("semantic-gate-prompts-bad-");
  fs.writeFileSync(path.join(repo, ".semantic-gate.json"), JSON.stringify({ prompts: { output: { mode: "replace", file: "x.md" } } }));
  const result = cli(["prompts", "--cwd", repo]);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /prompts\.output is not a known prompt/);
  fs.writeFileSync(path.join(repo, ".semantic-gate.json"), JSON.stringify({ prompts: { review: { mode: "merge", file: "x.md" } } }));
  assert.match(cli(["prompts", "--cwd", repo]).stderr, /prompts\.review\.mode must be replace or append/);
});
