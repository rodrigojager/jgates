import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-52 (fake engine): the PII pre-commit hook goes through the helper container. Nothing runs Python on the host: the hook
// calls `jgates pii check --staged`, which streams the staged files (as a tar on standard input) to one helper container of the
// tools image and reads the findings from its standard output. A staged CPF blocks the commit and its value is never shown, in
// the output or in the docker command; a clean commit goes through. In fix mode the correction is only a proposal until the
// host applies it: `pii fix --staged --dry-run` changes nothing, `--yes` rewrites the file on the host and the commit then
// passes the container check.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const CPF = "529.982.247-25";
const GIT_ENV = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" };

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function writeFixTool(dir) {
  const script = path.join(dir, "fix-tool.mjs");
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
process.stdout.write(JSON.stringify({ jgatesMask: 1, status: "ok", detected: n > 0, changed: changed.length > 0, counts: n > 0 ? { "corp-cpf": n } : {}, files: found }) + "\\n");
`,
  );
  return script;
}

function setup(mode) {
  const project = tmp("v2-52-project-");
  const home = tmp("v2-52-home-");
  const engine = tmp("v2-52-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(runtime, `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nrequire(${JSON.stringify(FAKE)});\n`);
  const env = { ...process.env, ...GIT_ENV, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_LOCALE: "en", NO_COLOR: "1" };
  delete env.JGATES_PYTHON;
  const git = (...args) => spawnSync("git", args, { cwd: project, encoding: "utf8", env });
  assert.equal(git("init", "-q").status, 0);
  fs.writeFileSync(path.join(project, "base.txt"), "nothing personal here\n");
  fs.mkdirSync(path.join(project, ".jgates"), { recursive: true });
  const yml = ["schemaVersion: 1", "hook:", `  mode: ${mode}`];
  if (mode === "fix") {
    const script = writeFixTool(tmp("v2-52-tool-"));
    yml.push("tools:", "  fake:", `    command: ${JSON.stringify(process.execPath)}`, `    args: ${JSON.stringify([script])}`, "    timeoutSeconds: 60", "fix:", "  tools: [fake]", '  excludes: [".jgates/**"]');
  }
  fs.writeFileSync(path.join(project, ".jgates", "pii.yml"), yml.join("\n") + "\n");
  assert.equal(git("add", "-A").status, 0);
  assert.equal(git("commit", "-qm", "base", "--no-verify").status, 0);
  const cli = (...args) => spawnSync(process.execPath, [MAIN, ...args, "--cwd", project], { encoding: "utf8", env, timeout: 120_000 });
  const commit = (file, text) => {
    fs.writeFileSync(path.join(project, file), text);
    assert.equal(git("add", file).status, 0);
    const r = git("commit", "-qm", `add ${file}`);
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const dockerCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const helperRuns = () => dockerCalls().filter((c) => c[0] === "run" && c.includes("org.jgates.kind=helper"));
  const helperLog = () => {
    const file = path.join(engine, "pii-helper.jsonl");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { project, git, cli, commit, helperRuns, helperLog, dockerCalls };
}

test("V2-52: a staged CPF is blocked by the hook through the helper container; a clean commit passes; the value never leaves", () => {
  const p = setup("block");
  const installed = p.cli("hooks", "install", "pre-commit", "--locale", "en");
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);

  const blocked = p.commit("clients.txt", `client: ${CPF}\n`);
  assert.notEqual(blocked.code, 0, blocked.out);
  assert.match(blocked.out, /clients\.txt/);
  assert.match(blocked.out, /commit blocked/);
  assert.ok(!blocked.out.includes(CPF), "the value is never shown");
  assert.ok(!p.git("log", "--format=%s").stdout.includes("add clients.txt"), "no commit was made");

  // The check ran in one helper container under the contract; the staged file went in on standard input.
  const runs = p.helperRuns();
  assert.equal(runs.length, 1, JSON.stringify(runs));
  const run = runs[0];
  const flag = (name) => run[run.indexOf(name) + 1];
  assert.equal(flag("--network"), "none");
  assert.equal(flag("--pull"), "never");
  assert.equal(flag("--cap-drop"), "ALL");
  assert.ok(run.includes("--read-only") && run.includes("--rm") && run.includes("--interactive"));
  assert.ok(run.includes("org.jgates.managed=true"));
  assert.equal(run.filter((a, i) => run[i - 1] === "--mount").length, 0, "nothing from the host is mounted into the helper");
  assert.ok(!run.some((a) => a.includes(p.project) || a.includes(CPF)), "no host path and no value in the docker command");
  assert.deepEqual(p.helperLog().map((l) => l.files), [["clients.txt"]]);

  p.git("reset", "-q");
  fs.rmSync(path.join(p.project, "clients.txt"));
  const clean = p.commit("notes.txt", "plain text\n");
  assert.equal(clean.code, 0, clean.out);
  assert.equal(p.helperRuns().length, 2, "the clean commit was checked in a helper container too");
});

test("V2-52: with the engine stopped the hook blocks the commit (fail closed) and says the detector could not run", () => {
  const p = setup("block");
  assert.equal(p.cli("hooks", "install", "pre-commit", "--locale", "en").status, 0);
  fs.writeFileSync(path.join(p.project, "notes.txt"), "plain text\n");
  assert.equal(p.git("add", "notes.txt").status, 0);
  const r = spawnSync("git", ["commit", "-qm", "notes"], { cwd: p.project, encoding: "utf8", env: { ...process.env, ...GIT_ENV, JGATES_HOME: tmp("v2-52-home2-"), JGATES_CONTAINER_RUNTIME: path.join(p.project, "no-such-engine"), JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_LOCALE: "en", NO_COLOR: "1" } });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /commit blocked/);
  assert.match(r.stdout + r.stderr, /tools image|helper container/);
});

test("V2-52: in fix mode the correction is a proposal until the host applies it after the preview", () => {
  const p = setup("fix");
  assert.equal(p.cli("hooks", "install", "pre-commit", "--locale", "en").status, 0);
  const file = path.join(p.project, "clients.txt");
  fs.writeFileSync(file, `client: ${CPF}\n`);
  assert.equal(p.git("add", "clients.txt").status, 0);

  // 1. The preview (dry run) and a run without --yes outside a terminal change nothing on the host.
  const dry = p.cli("pii", "fix", "--staged", "--dry-run", "--json");
  assert.equal(JSON.parse(dry.stdout).status, "PREVIEW", dry.stdout + dry.stderr);
  assert.equal(dry.status, 1);
  assert.equal(fs.readFileSync(file, "utf8"), `client: ${CPF}\n`, "the preview does not touch the project");
  const pending = p.cli("pii", "fix", "--staged", "--json");
  assert.equal(JSON.parse(pending.stdout).status, "PENDING");
  assert.equal(fs.readFileSync(file, "utf8"), `client: ${CPF}\n`, "without --yes nothing is applied");

  // 2. The check still finds it, in the helper container.
  const before = p.cli("pii", "check", "--staged", "--json");
  assert.equal(before.status, 1, before.stdout + before.stderr);
  assert.equal(JSON.parse(before.stdout).decision, "failed");
  assert.ok(!before.stdout.includes(CPF));
  const runsBefore = p.helperRuns().length;
  assert.ok(runsBefore >= 1);

  // 3. The commit goes through the hook: the host applies the fix, the container check then passes.
  fs.writeFileSync(file, `client: ${CPF}\n`);
  assert.equal(p.git("add", "clients.txt").status, 0);
  const r = p.git("commit", "-qm", "add clients.txt");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(fs.readFileSync(file, "utf8"), /\[CPF\]/, "the host file was corrected");
  const committed = p.git("show", "HEAD:clients.txt").stdout;
  assert.ok(!committed.includes(CPF) && committed.includes("[CPF]"), "the commit has the corrected content");
  assert.ok(p.helperRuns().length > runsBefore, "the check after the fix ran in a helper container");
});
