import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// jgates hooks install | uninstall pre-commit (D8): the hook is written in a temporary Git repository, stops a commit with
// a synthetic CPF in block mode, lets it through corrected in fix mode (a fake correction tool), falls back to blocking in
// fix mode without a tool, and never touches a hook of the user's or a repository with core.hooksPath. No network, no model.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const MAIN = path.join(repo, "jgates", "dist", "cli", "main.js");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const MARK = "# jgates-hook: pre-commit";
const CPF = "529.982.247-25";
const WINDOWS_ONLY = process.platform === "win32" ? false : "needs Windows (Git Bash runs the hook with the Windows paths)";

const dirs = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
};

const GIT_ENV = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" };

function writeTool(dir) {
  const script = path.join(dir, "fake-fix-tool.mjs");
  fs.writeFileSync(
    script,
    `import fs from "node:fs";
import path from "node:path";
const dir = process.env.JGATES_MASK_DIR;
const mode = process.env.JGATES_MASK_MODE;
const list = fs.readFileSync(process.env.JGATES_MASK_FILES, "utf8").split("\\n").filter(Boolean);
const re = /\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}/g;
let n = 0;
const found = [];
const changed = [];
for (const f of list) {
  const p = path.join(dir, f);
  const text = fs.readFileSync(p, "utf8");
  const hits = (text.match(re) ?? []).length;
  if (hits === 0) continue;
  n += hits;
  found.push(f);
  if (mode === "fix") {
    fs.writeFileSync(p, text.replace(re, "[CPF]"));
    changed.push(f);
  }
}
process.stdout.write("fake tool\\n" + JSON.stringify({ jgatesMask: 1, status: "ok", detected: n > 0, changed: changed.length > 0, counts: n > 0 ? { "corp-cpf": n } : {}, files: found }) + "\\n");
`,
  );
  return script;
}

function project({ hookMode = null, tool = false } = {}) {
  const dir = tmp("jgates-hooks-");
  const home = tmp("jgates-hooks-home-");
  const aux = tmp("jgates-hooks-aux-");
  const env = { ...process.env, ...GIT_ENV, JGATES_HOME: home, JGATES_PYTHON: PYTHON, NO_COLOR: "1" };
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8", env });
  assert.equal(git("init", "-q").status, 0);
  fs.writeFileSync(path.join(dir, "base.txt"), "nothing personal here\n");
  assert.equal(git("add", "-A").status, 0);
  assert.equal(git("commit", "-qm", "base", "--no-verify").status, 0);
  if (hookMode || tool) {
    const lines = ["schemaVersion: 1"];
    if (hookMode) lines.push("hook:", `  mode: ${hookMode}`);
    if (tool) {
      const script = writeTool(aux);
      lines.push("tools:", "  fake:", `    command: ${JSON.stringify(process.execPath)}`, `    args: ${JSON.stringify([script])}`, "    timeoutSeconds: 60");
      lines.push("fix:", "  tools: [fake]", '  excludes: [".jgates/**"]');
    }
    fs.mkdirSync(path.join(dir, ".jgates"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".jgates", "pii.yml"), lines.join("\n") + "\n");
    git("add", "-A");
    git("commit", "-qm", "config", "--no-verify");
  }
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [MAIN, "hooks", ...args, "--cwd", dir, "--locale", "en"], { encoding: "utf8", env, timeout: 120_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const hookFile = path.join(dir, ".git", "hooks", "pre-commit");
  const commit = (file, text) => {
    fs.writeFileSync(path.join(dir, file), text);
    assert.equal(git("add", file).status, 0);
    const r = git("commit", "-qm", `add ${file}`);
    return { code: r.status, out: r.stdout + r.stderr };
  };
  return { dir, cli, git, hookFile, commit, env };
}

test("install writes the marked hook; block mode stops a commit with a synthetic CPF and lets a clean one through", () => {
  const p = project();
  const r = p.cli("install", "pre-commit");
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /Hook written/);
  const text = fs.readFileSync(p.hookFile, "utf8");
  assert.ok(text.includes(MARK));
  assert.ok(text.includes("pii check --staged"));
  if (process.platform !== "win32") assert.ok((fs.statSync(p.hookFile).mode & 0o111) !== 0, "the hook is executable");

  const blocked = p.commit("clients.txt", `client: ${CPF}\n`);
  assert.notEqual(blocked.code, 0, blocked.out);
  assert.match(blocked.out, /clients\.txt/);
  assert.match(blocked.out, /commit blocked/);
  assert.ok(!blocked.out.includes(CPF), "the value is never shown");
  assert.equal(p.git("log", "--oneline").stdout.trim().split("\n").length, 1, "no commit was made");

  p.git("reset", "-q");
  fs.rmSync(path.join(p.dir, "clients.txt"));
  const clean = p.commit("notes.txt", "plain text\n");
  assert.equal(clean.code, 0, clean.out);

  // A second install updates the hook it wrote (the mark), without complaint.
  assert.equal(JSON.parse(p.cli("install", "pre-commit", "--json").out).status, "UPDATED");
});

test("fix mode: the commit goes on with the CPF corrected by the fake tool", () => {
  const p = project({ hookMode: "fix", tool: true });
  assert.equal(p.cli("install", "pre-commit").code, 0);
  assert.ok(fs.readFileSync(p.hookFile, "utf8").includes("pii fix --staged --yes"));

  const r = p.commit("clients.txt", `client: ${CPF}\n`);
  assert.equal(r.code, 0, r.out);
  const committed = p.git("show", "HEAD:clients.txt").stdout;
  assert.ok(!committed.includes(CPF), "the committed content has no CPF");
  assert.match(committed, /\[CPF\]/);
});

test("fix mode without a correction tool falls back to blocking, with the explanation", () => {
  const p = project({ hookMode: "fix" });
  assert.equal(p.cli("install", "pre-commit").code, 0);

  const clean = p.commit("notes.txt", "plain text\n");
  assert.equal(clean.code, 0, clean.out);

  const r = p.commit("clients.txt", `client: ${CPF}\n`);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /no correction tool/);
  assert.match(r.out, /commit blocked/);
  assert.ok(!p.git("log", "--format=%s").stdout.includes("add clients.txt"));
});

test("mode off writes no hook", () => {
  const p = project({ hookMode: "off" });
  const r = p.cli("install", "pre-commit", "--json");
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).status, "OFF");
  assert.ok(!fs.existsSync(p.hookFile));
});

test("an existing hook or core.hooksPath: install changes nothing and shows the line; uninstall removes only the marked hook", () => {
  const p = project();
  fs.mkdirSync(path.dirname(p.hookFile), { recursive: true });
  const own = "#!/bin/sh\necho mine\n";
  fs.writeFileSync(p.hookFile, own);
  const existing = p.cli("install", "pre-commit");
  assert.equal(existing.code, 0, existing.err);
  assert.match(existing.out, /already exists/);
  assert.match(existing.out, /pii check --staged \|\| exit 1/);
  assert.equal(fs.readFileSync(p.hookFile, "utf8"), own);
  const foreign = p.cli("uninstall", "pre-commit");
  assert.equal(foreign.code, 0);
  assert.match(foreign.out, /not written by jgates/);
  assert.equal(fs.readFileSync(p.hookFile, "utf8"), own, "uninstall leaves a hook without the mark");

  // core.hooksPath set: nothing is written anywhere.
  fs.rmSync(p.hookFile);
  const custom = path.join(p.dir, "my-hooks");
  fs.mkdirSync(custom);
  p.git("config", "core.hooksPath", custom);
  const viaPath = p.cli("install", "pre-commit", "--json");
  const doc = JSON.parse(viaPath.out);
  assert.equal(doc.status, "MANUAL");
  assert.equal(doc.reason, "core.hooksPath");
  assert.match(doc.line, /pii check --staged \|\| exit 1/);
  assert.deepEqual(fs.readdirSync(custom), []);
  assert.ok(!fs.existsSync(p.hookFile));
  p.git("config", "--unset", "core.hooksPath");

  // The marked hook is removed.
  assert.equal(p.cli("install", "pre-commit").code, 0);
  assert.ok(fs.existsSync(p.hookFile));
  const removed = p.cli("uninstall", "pre-commit");
  assert.match(removed.out, /Hook removed/);
  assert.ok(!fs.existsSync(p.hookFile));
  assert.equal(JSON.parse(p.cli("uninstall", "pre-commit", "--json").out).status, "NOT_INSTALLED");
});

test("usage errors: unknown hook, unknown action and a folder outside Git", () => {
  const p = project();
  assert.equal(p.cli("install", "post-commit").code, 3);
  assert.equal(p.cli("remove", "pre-commit").code, 3);
  const outside = tmp("jgates-hooks-nogit-");
  const r = spawnSync(process.execPath, [MAIN, "hooks", "install", "pre-commit", "--cwd", outside, "--json"], { encoding: "utf8", env: { ...p.env, GIT_CEILING_DIRECTORIES: path.dirname(outside) } });
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stdout).code, "NOT_A_GIT_REPOSITORY");
});

test("a hook whose jgates is gone blocks the commit and says how to recover", () => {
  const p = project();
  assert.equal(p.cli("install", "pre-commit").code, 0);
  const text = fs.readFileSync(p.hookFile, "utf8").replace(/JGATES_MAIN='[^']*'/, "JGATES_MAIN='/nonexistent/main.js'");
  fs.writeFileSync(p.hookFile, text);
  const r = p.commit("notes.txt", "plain text\n");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /was not found/);
});

test("Windows: the hook runs in Git Bash with forward-slash paths", { skip: WINDOWS_ONLY }, () => {
  const p = project();
  assert.equal(p.cli("install", "pre-commit").code, 0);
  assert.ok(!/\\/.test(fs.readFileSync(p.hookFile, "utf8").match(/JGATES_MAIN='([^']*)'/)[1]));
  assert.notEqual(p.commit("clients.txt", `client: ${CPF}\n`).code, 0);
});

test("an invalid pii.yml or an unknown hook.mode: install exits 3 with the file and the field, and writes no hook", () => {
  const cases = [
    ["schemaVersion: 1\nhook:\n  mode: sideways\n", /hook\.mode|mode/],
    ["schemaVersion: 1\nhook: [unclosed\n", /pii\.yml/],
  ];
  for (const [yml, field] of cases) {
    const p = project();
    fs.mkdirSync(path.join(p.dir, ".jgates"), { recursive: true });
    fs.writeFileSync(path.join(p.dir, ".jgates", "pii.yml"), yml);
    const r = p.cli("install", "pre-commit");
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.err, /\.jgates\/pii\.yml/);
    assert.match(r.err, field);
    assert.ok(!fs.existsSync(p.hookFile), "no hook was written");
    const j = p.cli("install", "pre-commit", "--json");
    assert.equal(j.code, 3);
    assert.equal(JSON.parse(j.out).code, "INVALID_CONFIG");
    assert.ok(!fs.existsSync(p.hookFile));
  }
});
