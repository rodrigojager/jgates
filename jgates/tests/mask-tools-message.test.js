import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// The message of a tool status can echo what the tool found. JGates masks it (built-in shapes and secrets) before it
// shows it, in pii fix, pii check and the semantic gate result, in text and in JSON. Values are synthetic and assembled
// from parts so the repository gates do not flag this source.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const DIST = path.resolve(here, "..", "dist");
const MAIN = path.join(DIST, "cli", "main.js");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const { runSemanticReview, loadGate } = await import(pathToFileURL(path.join(DIST, "adapters", "semantic-gate", "index.js")).href);

const join = (...parts) => parts.join("");
const CPF = join("529", ".982", ".247", "-25");
const TOKEN_VALUE = join("s3cr", "etValue", "42xyz");
const MESSAGE = `found ${CPF} and ${join("api", "_token")}=${TOKEN_VALUE} in the file`;
const GIT_ENV = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" };

const dirs = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
};

function project() {
  const dir = tmp("jgates-msg-");
  const home = tmp("jgates-msg-home-");
  const aux = tmp("jgates-msg-aux-");
  const script = path.join(aux, "tool.mjs");
  fs.writeFileSync(script, `process.stdout.write(JSON.stringify({ jgatesMask: 1, status: "error", detected: false, changed: false, message: ${JSON.stringify(MESSAGE)} }) + "\\n");\n`);
  const env = { ...process.env, ...GIT_ENV, JGATES_HOME: home, JGATES_PYTHON: PYTHON, NO_COLOR: "1" };
  const git = (...args) => assert.equal(spawnSync("git", args, { cwd: dir, encoding: "utf8", env }).status, 0);
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "base.txt"), "nothing personal here\n");
  fs.mkdirSync(path.join(dir, ".jgates"));
  fs.writeFileSync(
    path.join(dir, ".jgates", "pii.yml"),
    ["schemaVersion: 1", "tools:", "  fake:", `    command: ${JSON.stringify(process.execPath)}`, `    args: ${JSON.stringify([script])}`, "    timeoutSeconds: 60", "fix:", "  tools: [fake]", '  excludes: [".jgates/**"]', ""].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "jgates.yml"),
    ["schemaVersion: 1", "extensions:", "  semantic-gate:", "    provider: command", "    model: fake-model", "    masking:", "      tools: [fake]", ""].join("\n"),
  );
  git("add", "-A");
  git("commit", "-qm", "base");
  fs.writeFileSync(path.join(dir, "clients.txt"), `client: ${CPF}\n`);
  git("add", "clients.txt");
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args, "--cwd", dir, "--locale", "en"], { encoding: "utf8", env, input: "", timeout: 180_000 });
    return { code: r.status, text: r.stdout + r.stderr };
  };
  return { dir, cli };
}

function assertMasked(text, where) {
  assert.ok(!text.includes(CPF), `${where} shows the CPF`);
  assert.ok(!text.includes(TOKEN_VALUE), `${where} shows the token`);
}

for (const cmd of [["pii", "fix", "--yes"], ["pii", "check"]]) {
  for (const json of [false, true]) {
    test(`${cmd.slice(0, 2).join(" ")} ${json ? "(JSON)" : "(text)"}: the tool message is shown masked`, () => {
      const p = project();
      const r = p.cli([...cmd, ...(json ? ["--json"] : [])]);
      assertMasked(r.text, cmd.join(" "));
      if (cmd[1] === "fix") {
        assert.match(r.text, /reported an error/, r.text);
        assert.match(r.text, /\[MASKED:cpf\]/);
        assert.match(r.text, /\[MASKED:secret\]/);
      }
    });
  }
}

test("the semantic gate result shows the tool message masked", async () => {
  const p = project();
  const real = await loadGate();
  const gate = {
    ...real,
    collectGitReviewContext: async () => ({
      repoRoot: "/repo", scope: "changed", paths: [], excludes: [], includes: [], ignoreFiles: [], statusShort: " M a.js", diffStat: "", stagedDiffStat: "", commandsExecuted: [],
      changedFiles: [{ changeKinds: ["unstaged"], path: "a.js", diff: "+x\n" }], warnings: [],
    }),
  };
  const r = await runSemanticReview(p.dir, { env: process.env }, { loadGate: async () => gate, callProvider: async () => ({ text: "{}", raw: null }) });
  assert.equal(r.state, "unavailable", JSON.stringify(r));
  assert.match(r.reason, /reported an error/);
  assert.match(r.reason, /\[MASKED:cpf\]/);
  assertMasked(JSON.stringify(r), "the semantic result");
});
