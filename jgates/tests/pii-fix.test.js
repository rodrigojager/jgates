import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// jgates pii check and jgates pii fix (D8): detection without changes, correction only through a configured tool (a
// fake one here), applied atomically after confirmation, with the originals kept for --undo and deleted by gc when
// they expire. No value found may reach the output. Git repositories are temporary; no network, no model.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const MAIN = path.join(repo, "jgates", "dist", "cli", "main.js");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");

// A synthetic CPF with valid check digits (no real person), in the two shapes the output must never show.
const CPF = "529.982.247-25";
const CPF_DIGITS = "52998224725";

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
function git(dir, ...args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** The fake correction tool: replaces CPF-shaped values by [CPF]; the first argument picks a misbehavior. */
function writeTool(dir) {
  const script = path.join(dir, "fake-fix-tool.mjs");
  fs.writeFileSync(
    script,
    `import fs from "node:fs";
import path from "node:path";
const [behavior = "mask", target] = process.argv.slice(2);
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
const status = (s) => process.stdout.write("fake tool\\n" + JSON.stringify({ jgatesMask: 1, status: "ok", detected: n > 0, changed: changed.length > 0, counts: n > 0 ? { "corp-cpf": n } : {}, files: found, ...s }) + "\\n");
switch (behavior) {
  case "mask": status({}); break;
  case "touch-project": fs.appendFileSync(target, "edited meanwhile\\n"); status({}); break;
  case "create": fs.writeFileSync(path.join(dir, "new.txt"), "x"); status({}); break;
  case "fail": process.stderr.write("crashed"); process.exit(2);
  case "liar": status({ changed: false }); break;
  default: process.exit(9);
}
`,
  );
  return script;
}

/** A Git repository with one commit (base.txt) and the pii.yml lines given; returns helpers bound to it. */
function project({ tool = null, retentionDays = null, extraPii = [] } = {}) {
  const dir = tmp("jgates-pii-fix-");
  const home = tmp("jgates-pii-fix-home-");
  const aux = tmp("jgates-pii-fix-aux-");
  const script = writeTool(aux);
  git(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, "base.txt"), "nothing personal here\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  const writePii = (behavior, args = []) => {
    fs.mkdirSync(path.join(dir, ".jgates"), { recursive: true });
    const lines = ["schemaVersion: 1", ...extraPii];
    if (behavior) {
      lines.push("tools:", "  fake:", `    command: ${JSON.stringify(process.execPath)}`, `    args: ${JSON.stringify([script, behavior, ...args])}`, "    timeoutSeconds: 60");
      lines.push("fix:", "  tools: [fake]", "  excludes: [\".jgates/**\"]");
      if (retentionDays !== null) lines.push(`  backupRetentionDays: ${retentionDays}`);
    }
    fs.writeFileSync(path.join(dir, ".jgates", "pii.yml"), lines.join("\n") + "\n");
  };
  if (tool || extraPii.length > 0) writePii(tool);
  const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON, NO_COLOR: "1" };
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args, "--cwd", dir], { encoding: "utf8", env, input: "", timeout: 180_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const read = (rel) => fs.readFileSync(path.join(dir, rel), "utf8");
  return { dir, home, cli, write, read, writePii, git: (...a) => git(dir, ...a) };
}

function walk(dir) {
  const out = [];
  const visit = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== ".git") visit(p);
      } else out.push(p);
    }
  };
  if (fs.existsSync(dir)) visit(dir);
  return out.sort();
}
const snapshot = (dir) => Object.fromEntries(walk(dir).map((f) => [path.relative(dir, f), crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")]));
const noValue = (text, where) => {
  assert.ok(!text.includes(CPF), `${where} shows the CPF`);
  assert.ok(!text.includes(CPF_DIGITS), `${where} shows the CPF digits`);
};
const fixDirs = (home) => {
  const root = path.join(home, "workspaces");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap((id) => {
    const p = path.join(root, id, "pii-fix");
    return fs.existsSync(p) ? fs.readdirSync(p).filter((n) => n !== ".work").map((n) => path.join(p, n)) : [];
  });
};

test("pii check finds a synthetic CPF, exits 1 with file and count, never shows the value and changes nothing", () => {
  const p = project();
  p.write("clients.txt", `client: ${CPF}\n`);
  p.write("notes/other.txt", "plain text\n");
  const before = snapshot(p.dir);

  const json = p.cli(["pii", "check", "--json"]);
  assert.equal(json.code, 1, json.err + json.out);
  assert.equal(json.doc.status, "FINDINGS");
  assert.equal(json.doc.decision, "failed");
  assert.equal(json.doc.scope.kind, "default");
  assert.deepEqual(json.doc.files, [{ path: "clients.txt", counts: { cpf: 1 }, detectors: ["builtin-pii"] }]);
  assert.deepEqual(json.doc.counts, { cpf: 1 });
  noValue(json.out + json.err, "pii check --json");

  const text = p.cli(["pii", "check", "--locale", "en"]);
  assert.equal(text.code, 1);
  assert.match(text.out, /clients\.txt\s+cpf 1/);
  noValue(text.out + text.err, "pii check (text)");

  // The same with --all and with the path named; a path without findings passes.
  assert.equal(p.cli(["pii", "check", "--all", "--json"]).code, 1);
  assert.equal(p.cli(["pii", "check", "clients.txt", "--json"]).code, 1);
  const clean = p.cli(["pii", "check", "notes", "--json"]);
  assert.equal(clean.code, 0, clean.out);
  assert.equal(clean.doc.status, "OK");
  assert.equal(clean.doc.scope.files, 1);

  assert.deepEqual(snapshot(p.dir), before, "pii check changes no file");
  for (const f of walk(p.home)) noValue(fs.readFileSync(f, "utf8"), `data folder file ${f}`);
});

test("pii check without findings exits 0; the tools of fix.tools run in check mode and add their counts", () => {
  const p = project({ tool: "mask" });
  p.write("clean.txt", "nothing to see\n");
  const ok = p.cli(["pii", "check", "--json"]);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.equal(ok.doc.decision, "passed");
  assert.deepEqual(ok.doc.detectors.map((d) => [d.id, d.state]), [["builtin-pii", "completed"], ["fake", "completed"]]);

  p.write("clients.txt", `client: ${CPF}\n`);
  const before = snapshot(p.dir);
  const found = p.cli(["pii", "check", "--json"]);
  assert.equal(found.code, 1);
  assert.deepEqual(found.doc.counts, { cpf: 1, "corp-cpf": 1 });
  assert.deepEqual(found.doc.files[0].detectors.sort(), ["builtin-pii", "fake"]);
  assert.deepEqual(snapshot(p.dir), before);
  noValue(found.out, "pii check with a tool");

  // A tool that fails in check mode leaves the check incomplete (2) when nothing was found.
  const failing = project({ tool: "fail" });
  failing.write("clean.txt", "nothing\n");
  const r = failing.cli(["pii", "check", "--json"]);
  assert.equal(r.code, 2, r.out);
  assert.equal(r.doc.decision, "incomplete");
});

test("pii fix --yes applies the change of the tool, keeps the original and --undo restores it byte for byte; --dry-run changes nothing", () => {
  const p = project({ tool: "mask" });
  const original = `client: ${CPF}\r\nsecond line ${CPF}\n`;
  p.write("clients.txt", original);
  p.write("clean.txt", "nothing\n");
  fs.chmodSync(path.join(p.dir, "clients.txt"), 0o640);
  const before = snapshot(p.dir);

  const dry = p.cli(["pii", "fix", "--dry-run", "--json"]);
  assert.equal(dry.code, 1, dry.out + dry.err);
  assert.equal(dry.doc.mode, "dry-run");
  assert.deepEqual(dry.doc.changes, [{ path: "clients.txt" }]);
  assert.deepEqual(dry.doc.counts, { "corp-cpf": 2 });
  assert.deepEqual(snapshot(p.dir), before, "--dry-run changes nothing");
  assert.deepEqual(fixDirs(p.home), [], "--dry-run keeps no original");
  noValue(dry.out, "pii fix --dry-run");

  // Without --yes and without a terminal nothing is applied.
  const pending = p.cli(["pii", "fix", "--json"]);
  assert.equal(pending.code, 1);
  assert.equal(pending.doc.mode, "pending");
  assert.deepEqual(snapshot(p.dir), before);

  // --diff shows the change on the terminal only.
  const diff = p.cli(["pii", "fix", "--dry-run", "--diff", "--locale", "en"]);
  assert.match(diff.out, /\+client: \[CPF\]/);
  assert.equal(p.cli(["pii", "fix", "--diff", "--json"]).code, 3, "--diff does not go with --json");

  const applied = p.cli(["pii", "fix", "--yes", "--json"]);
  assert.equal(applied.code, 0, applied.out + applied.err);
  assert.equal(applied.doc.mode, "applied");
  assert.deepEqual(applied.doc.applied, ["clients.txt"]);
  noValue(applied.out + applied.err, "pii fix --yes");
  assert.equal(p.read("clients.txt"), "client: [CPF]\r\nsecond line [CPF]\n");
  assert.equal(p.read("clean.txt"), "nothing\n");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(p.dir, "clients.txt")).mode & 0o777, 0o640, "the mode of the file is kept");

  const [kept] = fixDirs(p.home);
  assert.equal(path.basename(kept), applied.doc.fixId);
  assert.equal(fs.readFileSync(path.join(kept, "originals", "clients.txt"), "utf8"), original);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(kept).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(kept, "originals", "clients.txt")).mode & 0o777, 0o600);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(kept, "manifest.json"), "utf8"));
  noValue(JSON.stringify(manifest), "the manifest");
  const days = (Date.parse(manifest.expiresAt) - Date.parse(manifest.createdAt)) / 86_400_000;
  assert.equal(Math.round(days), 7, "7 days by default");
  assert.equal(fs.readdirSync(path.join(p.home, "workspaces", path.basename(path.dirname(path.dirname(kept))), "pii-fix", ".work")).length, 0, "the temporary copy is removed");

  const undo = p.cli(["pii", "fix", "--undo", "--json"]);
  assert.equal(undo.code, 0, undo.out + undo.err);
  assert.deepEqual(undo.doc.restored, ["clients.txt"]);
  assert.ok(fs.readFileSync(path.join(p.dir, "clients.txt")).equals(Buffer.from(original)), "byte for byte");
  assert.deepEqual(snapshot(p.dir), before);
  assert.deepEqual(fixDirs(p.home), [], "the originals go once restored");
  const again = p.cli(["pii", "fix", "--undo", "--json"]);
  assert.equal(again.code, 3);
  assert.equal(again.doc.code, "NOTHING_TO_UNDO");
});

test("pii fix --undo <fixId> restores that fix and skips a file changed since the fix", () => {
  const p = project({ tool: "mask" });
  p.write("a.txt", `a ${CPF}\n`);
  p.write("b.txt", `b ${CPF}\n`);
  const first = p.cli(["pii", "fix", "--yes", "--json"]);
  assert.equal(first.code, 0, first.out);
  p.write("b.txt", "edited by hand after the fix\n");
  assert.equal(p.cli(["pii", "fix", "--undo", "nope", "--json"]).code, 3);
  const undo = p.cli(["pii", "fix", "--undo", first.doc.fixId, "--json"]);
  assert.equal(undo.code, 1);
  assert.deepEqual(undo.doc.restored, ["a.txt"]);
  assert.deepEqual(undo.doc.skipped, [{ path: "b.txt", reason: "changed-since-fix" }]);
  assert.equal(p.read("a.txt"), `a ${CPF}\n`);
  assert.equal(p.read("b.txt"), "edited by hand after the fix\n");
  noValue(undo.out, "pii fix --undo");
});

test("a file changed between the copy and the application is skipped and listed; the others are applied", () => {
  const p = project();
  p.write("moving.txt", `m ${CPF}\n`);
  p.write("still.txt", `s ${CPF}\n`);
  p.writePii("touch-project", [path.join(p.dir, "moving.txt")]);
  const r = p.cli(["pii", "fix", "--yes", "--json"]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.deepEqual(r.doc.applied, ["still.txt"]);
  assert.deepEqual(r.doc.skipped, [{ path: "moving.txt", reason: "changed-since-copy" }]);
  assert.equal(p.read("moving.txt"), `m ${CPF}\nedited meanwhile\n`, "the file changed meanwhile is not overwritten");
  assert.equal(p.read("still.txt"), "s [CPF]\n");
  const text = p.cli(["pii", "check", "still.txt", "--json"]);
  assert.equal(text.code, 0);
});

test("a tool that touches a file outside the list, creates a file, fails or answers an inconsistent status applies nothing", () => {
  for (const behavior of ["outside", "create", "fail", "liar"]) {
    const p = project();
    p.write("clients.txt", `client: ${CPF}\n`);
    // base.txt is committed and outside the scope (the default scope is what changed).
    p.writePii(behavior === "outside" ? "touch-project" : behavior, behavior === "outside" ? [path.join(p.dir, "base.txt")] : []);
    const before = snapshot(p.dir);
    const r = p.cli(["pii", "fix", "--yes", "--json"]);
    assert.equal(r.code, 2, `${behavior}: ${r.out}${r.err}`);
    assert.equal(r.doc.mode, "failed", behavior);
    assert.deepEqual(r.doc.applied, [], behavior);
    assert.ok(r.doc.failure.code, behavior);
    if (behavior === "outside") assert.equal(r.doc.failure.code, "PROJECT_TOUCHED");
    else assert.equal(r.doc.failure.code, "MASKING_COMMAND_FAILED");
    const after = snapshot(p.dir);
    if (behavior === "outside") delete before["base.txt"], delete after["base.txt"];
    assert.deepEqual(after, before, `${behavior}: no file of the project changed`);
    assert.equal(p.read("clients.txt"), `client: ${CPF}\n`, behavior);
    assert.deepEqual(fixDirs(p.home), [], `${behavior}: no original kept`);
    noValue(r.out + r.err, behavior);
  }
});

test("--staged refuses a file with changes outside the index and puts back in the index only the accepted ones", () => {
  const p = project({ tool: "mask" });
  p.write("staged.txt", `s ${CPF}\n`);
  p.write("partial.txt", `p ${CPF}\n`);
  p.write("unstaged.txt", "u\n");
  p.git("add", "staged.txt", "partial.txt", "unstaged.txt");
  p.git("commit", "-qm", "more");
  p.write("staged.txt", `s2 ${CPF}\n`);
  p.write("partial.txt", `p2 ${CPF}\n`);
  p.write("unstaged.txt", `u2 ${CPF}\n`);
  p.git("add", "staged.txt", "partial.txt");
  p.write("partial.txt", `p3 ${CPF}\n`); // a change outside the index

  // check --staged reads the index: the content of partial.txt in the index has the value too.
  p.write("clean-in-tree.txt", "x\n");
  const check = p.cli(["pii", "check", "--staged", "--json"]);
  assert.equal(check.code, 1);
  assert.deepEqual(check.doc.files.map((f) => f.path), ["partial.txt", "staged.txt"]);

  const r = p.cli(["pii", "fix", "--staged", "--yes", "--json"]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.deepEqual(r.doc.refused, [{ path: "partial.txt", reason: "unstaged-changes" }]);
  assert.deepEqual(r.doc.applied, ["staged.txt"]);
  assert.equal(r.doc.staged, true);
  assert.equal(p.read("staged.txt"), "s2 [CPF]\n");
  assert.equal(p.git("show", ":staged.txt"), "s2 [CPF]\n", "the fixed file went back to the index");
  assert.equal(p.git("diff", "--name-only", "--", "staged.txt"), "", "no change of staged.txt left outside the index");
  assert.equal(p.read("partial.txt"), `p3 ${CPF}\n`, "the refused file is untouched");
  assert.equal(p.git("show", ":partial.txt"), `p2 ${CPF}\n`);
  assert.equal(p.read("unstaged.txt"), `u2 ${CPF}\n`, "a file outside the index is outside the scope");
  assert.deepEqual(p.git("diff", "--cached", "--name-only").trim().split("\n").sort(), ["partial.txt", "staged.txt"], "only the accepted file was added");
  noValue(r.out + r.err, "pii fix --staged");

  // The undo of a staged fix restores the file and its index entry.
  const undo = p.cli(["pii", "fix", "--undo", "--json"]);
  assert.equal(undo.code, 0, undo.out);
  assert.equal(p.git("show", ":staged.txt"), `s2 ${CPF}\n`);
});

test("without a configured tool pii fix changes nothing and explains; a bad configuration is a usage error", () => {
  const p = project();
  p.write("clients.txt", `client: ${CPF}\n`);
  const before = snapshot(p.dir);
  const r = p.cli(["pii", "fix", "--yes", "--json"]);
  assert.equal(r.code, 3, r.out);
  assert.equal(r.doc.code, "NO_FIX_TOOL");
  assert.match(r.doc.message, /fix\.tools/);
  const text = p.cli(["pii", "fix", "--yes", "--locale", "en"]);
  assert.equal(text.code, 3);
  assert.match(text.err, /only detects/);
  assert.deepEqual(snapshot(p.dir), before);
  assert.deepEqual(fixDirs(p.home), []);

  const bad = project({ extraPii: ["fix:", "  tools: [missing]"] });
  const invalid = bad.cli(["pii", "fix", "--yes", "--json"]);
  assert.equal(invalid.code, 3);
  assert.equal(invalid.doc.code, "CONFIG_INVALID");
  assert.match(invalid.doc.message, /fix\.tools\[0\]/);
  const typo = project({ extraPii: ["fix:", "  backupRetentionDay: 3"] });
  assert.equal(typo.cli(["pii", "check", "--json"]).doc.code, "CONFIG_INVALID");

  // Usage: one scope only, options of fix refused by check, unknown action, no Git for the default scope.
  assert.equal(p.cli(["pii", "check", "--staged", "--all", "--json"]).doc.code, "SCOPE_CONFLICT");
  assert.equal(p.cli(["pii", "check", "--yes", "--json"]).doc.code, "FIX_ONLY_OPTION");
  assert.equal(p.cli(["pii", "scan", "--json"]).doc.code, "UNKNOWN_ACTION");
  assert.equal(p.cli(["pii", "check", "../outside", "--json"]).doc.code, "PATH_OUTSIDE_PROJECT");
  const plain = tmp("jgates-pii-nogit-");
  fs.writeFileSync(path.join(plain, "a.txt"), `a ${CPF}\n`);
  const env = { ...process.env, JGATES_HOME: p.home, JGATES_PYTHON: PYTHON };
  const nogit = spawnSync(process.execPath, [MAIN, "pii", "check", "--cwd", plain, "--json"], { encoding: "utf8", env });
  assert.equal(nogit.status, 3);
  assert.equal(JSON.parse(nogit.stdout).code, "NOT_A_GIT_REPOSITORY");
  const all = spawnSync(process.execPath, [MAIN, "pii", "check", "--all", "--cwd", plain, "--json"], { encoding: "utf8", env });
  assert.equal(all.status, 1, all.stdout);
});

test("jgates gc deletes the expired originals of pii fix and keeps the others", () => {
  const p = project({ tool: "mask", retentionDays: 2 });
  p.write("a.txt", `a ${CPF}\n`);
  const first = p.cli(["pii", "fix", "--yes", "--json"]);
  assert.equal(first.code, 0, first.out);
  p.write("b.txt", `b ${CPF}\n`);
  const second = p.cli(["pii", "fix", "b.txt", "--yes", "--json"]);
  assert.equal(second.code, 0, second.out);
  const [oldDir] = fixDirs(p.home).filter((d) => path.basename(d) === first.doc.fixId);
  const manifestFile = path.join(oldDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  assert.equal(Math.round((Date.parse(manifest.expiresAt) - Date.parse(manifest.createdAt)) / 86_400_000), 2, "backupRetentionDays");
  manifest.expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));

  const gc = (args) => spawnSync(process.execPath, [MAIN, "gc", ...args, "--json"], { encoding: "utf8", env: { ...process.env, JGATES_HOME: p.home } });
  const dry = gc(["--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout).piiFix.expired.map((b) => b.fixId), [first.doc.fixId]);
  assert.ok(fs.existsSync(oldDir), "--dry-run deletes nothing");
  const real = gc(["--yes"]);
  assert.equal(real.status, 0, real.stderr);
  assert.deepEqual(JSON.parse(real.stdout).applied.piiFixRemoved.map((b) => b.fixId), [first.doc.fixId]);
  assert.ok(!fs.existsSync(oldDir), "the expired originals are deleted");
  assert.deepEqual(fixDirs(p.home).map((d) => path.basename(d)), [second.doc.fixId], "the others stay");
});
