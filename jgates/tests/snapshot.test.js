import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// What a run analyzed: another commit is analyzed
// in a snapshot of the data folder, never by checkout in the user's tree; a dirty tree never approves the clean
// commit; an analyzed file that changes during the run makes the result stale; outputs and caches never enter the
// input hash; the result carries the snapshot identity and the hashes of configuration, policy, templates and tools;
// and a project without jgates.yml also runs a plan.
//
// The bridge is a fake sidecar (a Python package written by the test) that records what it was asked to read and
// answers like the real one: the tests do not depend on the scanners of the machine.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const { findOnPath } = await import(pathToFileURL(path.join(dist, "core", "bridge", "index.js")).href);
const { EXIT_CODES } = await import(pathToFileURL(path.join(dist, "core", "contract", "index.js")).href);
const snapshotApi = await import(pathToFileURL(path.join(dist, "core", "snapshot", "index.js")).href);
const provenanceApi = await import(pathToFileURL(path.join(dist, "core", "provenance", "index.js")).href);
const planApi = await import(pathToFileURL(path.join(dist, "core", "plan", "index.js")).href);

const PYTHON = findOnPath("python") ?? findOnPath("python3");
const GIT = findOnPath("git");
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validateResult = ajv.compile(JSON.parse(fs.readFileSync(path.resolve(here, "..", "schemas", "result", "result.schema.json"), "utf8")));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const NO_DOCKER = { DOCKER_CONTEXT: "", DOCKER_HOST: "tcp://127.0.0.1:1", GITHUB_BASE_REF: "", GITHUB_HEAD_REF: "", GITHUB_SHA: "", GITLAB_CI: "" };

/**
 * A fake quality_sidecar: writes seen.json in the output folder (the target it was given and the files it found
 * there with their text), does what FAKE_ACTION asks to the target (modify an analyzed file, or write caches), then
 * answers APPROVED with every requested subcheck ok.
 */
const SIDECAR = String.raw`
import json, os, sys
req = json.loads(sys.stdin.read())
target, out = req["target"], req["outputDir"]
os.makedirs(out, exist_ok=True)
seen = {}
for root, dirs, files in os.walk(target):
    for name in files:
        full = os.path.join(root, name)
        rel = os.path.relpath(full, target).replace(os.sep, "/")
        try:
            seen[rel] = open(full, encoding="utf-8", errors="replace").read()[:200]
        except OSError:
            seen[rel] = None
json.dump({"target": target, "files": seen, "request": req}, open(os.path.join(out, "seen.json"), "w"))
action = os.environ.get("FAKE_ACTION", "")
if action == "modify":
    with open(os.path.join(target, "app.txt"), "a") as fh:
        fh.write("changed during the run\n")
if action == "cache":
    for rel in ["__pycache__/app.cpython-311.pyc", ".ruff_cache/0.1/cache", ".quality/reports/r.json", "lib/x.pyc", ".coverage", "node_modules/m/index.js"]:
        full = os.path.join(target, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        open(full, "w").write("cache")
ids = ["file-size", "megalinter", "semgrep", "gitleaks", "trivy", "checkov", "osv-scanner", "jscpd", "project-tests", "coverage"]
asked = req.get("subchecks")
mode = req.get("mode", "full")
def status(i):
    if asked is not None:
        return "ok" if i in asked else "skipped"
    if i == "file-size":
        return "ok"
    return "ok" if mode == "full" and i in ["megalinter", "semgrep", "trivy", "checkov", "osv-scanner", "jscpd"] else "skipped"
report = {"schemaVersion": "1.0.0", "status": "APPROVED", "exitCode": 0, "mode": mode, "tools": [], "findings": [], "score": {"value": 100, "threshold": 80}, "summary": {"reasons": []}}
report_path = os.path.join(out, "quality-report.json")
json.dump(report, open(report_path, "w"))
print(json.dumps({"schemaVersion": 1, "ok": True, "status": "APPROVED", "exitCode": 0, "outputDir": out, "reportPath": report_path, "subchecks": [{"id": i, "status": status(i)} for i in ids], "report": report}))
`;

function fakeSidecar() {
  const dir = tmp("jgates-snap-sidecar-");
  fs.mkdirSync(path.join(dir, "quality_sidecar"));
  fs.writeFileSync(path.join(dir, "quality_sidecar", "__init__.py"), "");
  fs.writeFileSync(path.join(dir, "quality_sidecar", "__main__.py"), SIDECAR);
  return dir;
}

function git(dir, ...args) {
  const r = spawnSync(GIT, ["-c", "user.name=JGates Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A workspace with its own data folder, an empty PATH (no scanner of the machine), git by JGATES_GIT. */
function workspace({ repo = true } = {}) {
  assert.ok(PYTHON, "python not found on PATH: put the repository .venv/bin first on PATH");
  assert.ok(GIT, "git not found on PATH");
  const dir = tmp("jgates-snap-ws-");
  const home = tmp("jgates-snap-home-");
  const emptyBin = tmp("jgates-snap-bin-");
  const sidecar = fakeSidecar();
  const env = { ...process.env, ...NO_DOCKER, JGATES_HOME: home, JGATES_PYTHON: PYTHON, JGATES_GIT: GIT, JGATES_SIDECAR_DIR: sidecar, PATH: emptyBin };
  delete env.FAKE_ACTION;
  delete env.JGATES_KEEP_SNAPSHOTS;
  if (repo) git(dir, "init", "-q");
  const cli = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: { ...env, ...extra }, timeout: 300_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const commit = (message) => {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", message);
    return git(dir, "rev-parse", "HEAD").trim();
  };
  const cleanup = () => {
    for (const d of [dir, home, emptyBin, sidecar]) fs.rmSync(d, { recursive: true, force: true });
  };
  return { dir, home, env, cli, write, commit, cleanup };
}

function one(r) {
  try {
    return JSON.parse(r.out);
  } catch (error) {
    throw new Error(`stdout is not one JSON document (${error.message}):\n${r.out}\n${r.err}`);
  }
}

function result(r) {
  const doc = one(r);
  assert.ok(validateResult(doc), JSON.stringify(validateResult.errors, null, 2));
  assert.equal(doc.exitCode, EXIT_CODES[doc.decision]);
  assert.equal(r.code, doc.exitCode, r.err);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(doc.runDir, "result.json"), "utf8")), doc);
  return doc;
}

const seenOf = (doc) => JSON.parse(fs.readFileSync(path.join(doc.runDir, "outputs", "quality-bridge", "seen.json"), "utf8"));
const status = (dir) => git(dir, "status", "--porcelain=v1", "--untracked-files=all", "--ignored");
const initMinimal = (w) => {
  const init = w.cli(["init", "--cwd", w.dir, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
};

test("run --scope full --head <older commit> analyzes a snapshot in the data folder; HEAD and git status of the user's tree stay the same", () => {
  const w = workspace();
  try {
    w.write("app.txt", "version one\n");
    w.write("old.txt", "only in the first commit\n");
    initMinimal(w);
    const first = w.commit("first");
    w.write("app.txt", "version two\n");
    fs.rmSync(path.join(w.dir, "old.txt"));
    w.write("new.txt", "only in the second commit\n");
    const second = w.commit("second");
    // Local changes on top of the second commit: they must not leak into the snapshot of the first one.
    w.write("app.txt", "local edit\n");
    w.write("scratch.txt", "untracked\n");
    const statusBefore = status(w.dir);
    const worktreesBefore = git(w.dir, "worktree", "list", "--porcelain");

    const doc = result(w.cli(["run", "--cwd", w.dir, "--scope", "full", "--head", "HEAD~1", "--json"]));
    const wsId = doc.workspace.id;
    const snapshots = path.join(w.home, "workspaces", wsId, "snapshots");
    assert.equal(doc.analyzed.target, "commit");
    assert.equal(doc.analyzed.snapshot.kind, "git-commit");
    assert.equal(doc.analyzed.snapshot.commit, first);
    assert.match(doc.analyzed.snapshot.tree, /^[0-9a-f]{40}$/);
    assert.equal(path.dirname(doc.analyzed.path), snapshots);
    assert.equal(doc.analyzed.dirty, false);
    assert.equal(doc.analyzed.git.head, second);
    assert.equal(doc.provenance.sourceCommit, first);

    // The bridge read the snapshot: the files of the first commit, nothing of the second one or of the local edits.
    const seen = seenOf(doc);
    assert.equal(seen.target, doc.analyzed.path);
    assert.equal(seen.files["app.txt"], "version one\n");
    assert.equal(seen.files["old.txt"], "only in the first commit\n");
    assert.ok(!("new.txt" in seen.files));
    assert.ok(!("scratch.txt" in seen.files));
    assert.ok(!Object.keys(seen.files).some((f) => f.startsWith(".git/")));
    assert.ok("jgates.yml" in seen.files);

    // The snapshot lives only during the run; the plan records the commit the reference named.
    assert.equal(doc.analyzed.snapshot.removed, true);
    assert.ok(!fs.existsSync(doc.analyzed.path));
    assert.deepEqual(fs.readdirSync(snapshots), []);
    const plan = JSON.parse(fs.readFileSync(path.join(doc.runDir, "plan.json"), "utf8"));
    assert.equal(plan.scope.head, first);
    assert.equal(plan.selection.request.head, "HEAD~1");
    // The plan belongs to the user's workspace, not to the snapshot it was read from.
    assert.equal(fs.realpathSync(plan.workspace.path), fs.realpathSync(w.dir));
    assert.equal(plan.workspace.id, wsId);

    // The user's tree: same HEAD, same branch, same status, no worktree added.
    assert.equal(git(w.dir, "rev-parse", "HEAD").trim(), second);
    assert.equal(git(w.dir, "symbolic-ref", "--short", "HEAD").trim(), "main");
    assert.equal(status(w.dir), statusBefore);
    assert.equal(git(w.dir, "worktree", "list", "--porcelain"), worktreesBefore);
    assert.equal(fs.readFileSync(path.join(w.dir, "app.txt"), "utf8"), "local edit\n");
    assert.deepEqual(doc.workspaceChanges, { checked: true, added: [], modified: [], removed: [] });

    // A plan of that commit saved with `plan --out` is the same plan when run later (the snapshot path is not in it).
    const planFile = path.join(w.home, "plan-of-first.json");
    const planned = w.cli(["plan", "--cwd", w.dir, "--scope", "full", "--head", first, "--out", planFile, "--json"]);
    assert.equal(planned.code, 0, planned.out + planned.err);
    const replay = result(w.cli(["run", "--cwd", w.dir, "--plan", planFile, "--json"]));
    assert.equal(replay.analyzed.snapshot.commit, first);
    assert.equal(seenOf(replay).files["app.txt"], "version one\n");
    assert.equal(status(w.dir), statusBefore);

    // A reference that names no commit is refused before any run starts.
    const runsBefore = fs.readdirSync(path.join(w.home, "workspaces", wsId, "runs")).length;
    const bad = w.cli(["run", "--cwd", w.dir, "--scope", "full", "--head", "no-such-ref", "--json"]);
    assert.equal(bad.code, 3);
    assert.equal(one(bad).error.code, "REF_UNKNOWN");
    assert.equal(fs.readdirSync(path.join(w.home, "workspaces", wsId, "runs")).length, runsBefore);
  } finally {
    w.cleanup();
  }
});

test("a run on a dirty work tree records dirty true and says it does not approve the clean commit", () => {
  const w = workspace();
  try {
    w.write("app.txt", "committed\n");
    const head = w.commit("first");

    // Clean tree: the passed result approves HEAD.
    const clean = result(w.cli(["run", "--cwd", w.dir, "--bridge-mode", "quick", "--json"]));
    assert.equal(clean.decision, "passed");
    assert.equal(clean.analyzed.target, "working-tree");
    assert.equal(clean.analyzed.dirty, false);
    assert.deepEqual(clean.analyzed.approval, { commit: head, approved: true, code: "COMMIT_APPROVED", message: clean.analyzed.approval.message });

    // Tracked change and an untracked file: recorded, included in the analysis, and the clean commit is not approved.
    w.write("app.txt", "edited locally\n");
    w.write("notes.txt", "untracked\n");
    const dirty = result(w.cli(["run", "--cwd", w.dir, "--bridge-mode", "quick", "--json"]));
    assert.equal(dirty.decision, "passed");
    assert.equal(dirty.analyzed.dirty, true);
    assert.deepEqual(dirty.analyzed.git.changes.tracked, [{ path: "app.txt", status: " M" }]);
    assert.deepEqual(dirty.analyzed.git.changes.untracked, ["notes.txt"]);
    assert.equal(dirty.analyzed.approval.approved, false);
    assert.equal(dirty.analyzed.approval.code, "DIRTY_WORKING_TREE");
    assert.equal(dirty.analyzed.approval.commit, head);
    assert.match(dirty.analyzed.approval.message, /não aprova o commit limpo/);
    assert.match(dirty.analyzed.approval.message, new RegExp(head));
    assert.match(dirty.summary, /não aprova o commit limpo/);
    assert.equal(seenOf(dirty).files["notes.txt"], "untracked\n");
    assert.notEqual(dirty.analyzed.snapshot.id, clean.analyzed.snapshot.id);
    assert.notEqual(dirty.analyzed.identity, clean.analyzed.identity);

    // The text output says it too.
    const text = w.cli(["run", "--cwd", w.dir, "--bridge-mode", "quick"]);
    assert.equal(text.code, 0, text.err);
    assert.match(text.out, /mudanças locais/);
    assert.match(text.out, /não aprova o commit limpo/);
  } finally {
    w.cleanup();
  }
});

test("an analyzed file changed during the run (by the test sidecar) makes the result stale, never passed", () => {
  const w = workspace({ repo: false });
  try {
    w.write("app.txt", "before\n");
    const steady = result(w.cli(["run", "--cwd", w.dir, "--bridge-mode", "quick", "--json"]));
    assert.equal(steady.decision, "passed");
    assert.equal(steady.analyzed.target, "directory");
    assert.equal(steady.analyzed.stale, false);
    assert.equal(steady.analyzed.inputs.verified, true);
    assert.equal(steady.analyzed.inputs.after, steady.analyzed.inputs.hash);
    assert.equal(steady.analyzed.approval.code, "NO_COMMIT");

    const changed = result(w.cli(["run", "--cwd", w.dir, "--bridge-mode", "quick", "--json"], { FAKE_ACTION: "modify" }));
    assert.equal(changed.analyzed.stale, true);
    assert.notEqual(changed.decision, "passed");
    assert.equal(changed.decision, "incomplete");
    assert.equal(changed.exitCode, 2);
    assert.deepEqual(changed.analyzed.inputs.changes, { added: [], modified: ["app.txt"], removed: [] });
    assert.notEqual(changed.analyzed.inputs.after, changed.analyzed.inputs.hash);
    assert.equal(changed.analyzed.approval.approved, false);
    assert.equal(changed.analyzed.approval.code, "INPUTS_CHANGED");
    assert.match(changed.analyzed.approval.message, /desatualizado/);
    // The identity is of the state the run started from, not of the new one.
    assert.equal(changed.analyzed.inputs.hash, steady.analyzed.inputs.hash);
    // The file is reported, never reverted.
    assert.equal(fs.readFileSync(path.join(w.dir, "app.txt"), "utf8"), "before\nchanged during the run\n");
    assert.deepEqual(changed.workspaceChanges.modified, ["app.txt"]);
  } finally {
    w.cleanup();
  }
});

test("output and cache files never change the input hash; a source file does", () => {
  // Through the run: a sidecar that writes caches in the workspace leaves the result fresh.
  const w = workspace();
  try {
    w.write("app.txt", "source\n");
    w.commit("first");
    const doc = result(w.cli(["run", "--cwd", w.dir, "--bridge-mode", "quick", "--json"], { FAKE_ACTION: "cache" }));
    assert.equal(doc.analyzed.stale, false);
    assert.equal(doc.decision, "passed");
    assert.equal(doc.analyzed.inputs.after, doc.analyzed.inputs.hash);
    assert.ok(doc.workspaceChanges.added.includes("__pycache__/app.cpython-311.pyc"));
  } finally {
    w.cleanup();
  }

  // Directly on the manifest, with and without Git.
  const dir = tmp("jgates-snap-manifest-");
  try {
    fs.writeFileSync(path.join(dir, "main.py"), "print('hi')\n");
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "lib.ts"), "export const x = 1;\n");
    const first = snapshotApi.takeInputManifest(dir, { exclude: ["build/out"] });
    assert.equal(first.files, 2);
    for (const [rel, text] of [
      ["__pycache__/main.cpython-311.pyc", "x"],
      ["src/__pycache__/lib.pyc", "x"],
      [".ruff_cache/0.17/abc", "x"],
      [".pytest_cache/v/cache/lastfailed", "{}"],
      [".mypy_cache/3.11/x.json", "{}"],
      [".quality/reports/quality-report.json", "{}"],
      ["node_modules/pkg/index.js", "x"],
      ["helper.pyc", "x"],
      [".coverage", "x"],
      [".eslintcache", "x"],
      ["build/out/report.xml", "x"],
    ]) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    const second = snapshotApi.takeInputManifest(dir, { exclude: ["build/out"] });
    assert.equal(second.hash, first.hash);
    assert.equal(second.files, 2);
    assert.equal(snapshotApi.diffInputs(first, second).changed, false);

    fs.writeFileSync(path.join(dir, "src", "lib.ts"), "export const x = 2;\n");
    const third = snapshotApi.takeInputManifest(dir, { exclude: ["build/out"] });
    assert.notEqual(third.hash, first.hash);
    assert.deepEqual(snapshotApi.diffInputs(first, third), { changed: true, added: [], modified: ["src/lib.ts"], removed: [] });

    // With Git: ignored files are not inputs either, tracked and untracked ones are.
    git(dir, "init", "-q");
    fs.writeFileSync(path.join(dir, ".gitignore"), "dist/\n");
    const context = snapshotApi.gitContext(dir, { ...process.env, JGATES_GIT: GIT });
    assert.equal(context.repository, true);
    const files = () => snapshotApi.gitFiles(context, dir, process.env);
    const withGit = snapshotApi.takeInputManifest(dir, { files: files(), exclude: ["build/out"] });
    fs.mkdirSync(path.join(dir, "dist"));
    fs.writeFileSync(path.join(dir, "dist", "bundle.js"), "generated");
    assert.equal(snapshotApi.takeInputManifest(dir, { files: files(), exclude: ["build/out"] }).hash, withGit.hash);
    assert.deepEqual(withGit.entries.map((e) => e.path), [".gitignore", "main.py", "src/lib.ts"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("result.json carries the snapshot identity and the hashes of configuration, policy, templates and tools; changing any of them changes the identity", () => {
  const w = workspace();
  try {
    w.write("app.txt", "source\n");
    initMinimal(w);
    w.commit("first");
    const run = (extra) => result(w.cli(["run", "--cwd", w.dir, "--json"], extra));

    const base = run();
    const { analyzed, provenance } = base;
    for (const key of ["plan", "config", "policy", "templates", "tools", "nativeFiles", "inventory"]) assert.match(analyzed.hashes[key], /^sha256:[0-9a-f]{64}$/, key);
    assert.match(analyzed.identity, /^sha256:[0-9a-f]{64}$/);
    assert.match(analyzed.snapshot.id, /^sha256:[0-9a-f]{64}$/);
    assert.equal(analyzed.hashes.plan, base.selection.planHash);
    // The current provenance fields, plus hashes, the producing process and the plan.
    assert.equal(provenance.producer, "jgates");
    assert.equal(provenance.producerVersion, base.version);
    assert.equal(provenance.sourceCommit, analyzed.snapshot.commit);
    assert.ok(provenance.generatedAt);
    assert.equal(provenance.evidence, "runner");
    assert.equal(provenance.identity, analyzed.identity);
    assert.equal(provenance.snapshot, analyzed.snapshot.id);
    assert.deepEqual(provenance.hashes, analyzed.hashes);
    assert.deepEqual(provenance.plan, { hash: base.selection.planHash, source: "built", file: "plan.json" });
    assert.equal(typeof provenance.process.pid, "number");

    // The same state and configuration give the same identity.
    const again = run();
    assert.equal(again.analyzed.identity, analyzed.identity);

    const identities = new Set([analyzed.identity]);
    const changed = (doc, key) => {
      assert.notEqual(doc.analyzed.hashes[key], analyzed.hashes[key], key);
      assert.ok(!identities.has(doc.analyzed.identity), `identity unchanged after a change of ${key}`);
      identities.add(doc.analyzed.identity);
    };

    // Configuration: the run timeout.
    const yml = fs.readFileSync(path.join(w.dir, "jgates.yml"), "utf8");
    w.write("jgates.yml", `${yml}execution:\n  timeoutSeconds: 900\n`);
    changed(run(), "config");
    w.write("jgates.yml", yml);
    assert.equal(run().analyzed.identity, analyzed.identity);

    // Policy: a policy document appears.
    w.write(".jgates/policy.yml", "schemaVersion: 1\nexceptions: []\n");
    changed(run(), "policy");
    fs.rmSync(path.join(w.dir, ".jgates", "policy.yml"));

    // Templates: one more template entry (manual, so nothing else is selected).
    w.write("jgates.yml", yml.replace(/templates:\n/, "templates:\n  - id: python\n    source: builtin:python\n    activation: manual\n"));
    changed(run(), "templates");
    w.write("jgates.yml", yml);

    // Tools: the bridge runs with another interpreter path.
    const otherBin = tmp("jgates-snap-python-");
    try {
      fs.symlinkSync(PYTHON, path.join(otherBin, "python3"));
      changed(run({ JGATES_PYTHON: path.join(otherBin, "python3") }), "tools");
    } finally {
      fs.rmSync(otherBin, { recursive: true, force: true });
    }

    // The code: a different input gives a different snapshot and identity, with the same hashes.
    w.write("app.txt", "other source\n");
    const code = run();
    assert.deepEqual(code.analyzed.hashes, analyzed.hashes);
    assert.notEqual(code.analyzed.snapshot.id, analyzed.snapshot.id);
    assert.ok(!identities.has(code.analyzed.identity));

    // Each hash on its own moves the identity (the parts no run above isolates).
    const plan = JSON.parse(fs.readFileSync(path.join(base.runDir, "plan.json"), "utf8"));
    const hashes = provenanceApi.hashesOfPlan(plan);
    assert.deepEqual(hashes, analyzed.hashes);
    const id = (h) => provenanceApi.analysisIdentity(analyzed.snapshot.id, h, plan.scope);
    assert.equal(id(hashes), analyzed.identity);
    const seenIds = new Set([id(hashes)]);
    for (const key of Object.keys(hashes)) {
      const other = id({ ...hashes, [key]: `sha256:${"0".repeat(64)}` });
      assert.ok(!seenIds.has(other), key);
      seenIds.add(other);
    }
    const mutate = (fn) => {
      const copy = structuredClone(plan);
      fn(copy);
      return provenanceApi.hashesOfPlan(copy);
    };
    assert.notEqual(mutate((p) => (p.versions.tools["quality-gate"] = "9.9.9")).tools, hashes.tools);
    assert.notEqual(mutate((p) => (p.versions.jgates = "9.9.9")).tools, hashes.tools);
    assert.notEqual(mutate((p) => p.inputs.configFiles.push({ file: ".jgates/policy.yml", sha256: `sha256:${"1".repeat(64)}` })).policy, hashes.policy);
    assert.notEqual(mutate((p) => p.inputs.configFiles.push({ file: ".jgates/lock.json", sha256: `sha256:${"2".repeat(64)}` })).tools, hashes.tools);
    assert.notEqual(mutate((p) => p.inputs.configFiles.push({ file: "ruff.toml", sha256: `sha256:${"3".repeat(64)}` })).nativeFiles, hashes.nativeFiles);
    assert.notEqual(mutate((p) => (p.inputs.configHash = `sha256:${"4".repeat(64)}`)).config, hashes.config);
    assert.notEqual(mutate((p) => p.templates.inactive.push({ id: "x", source: "builtin:x", reason: "MANUAL" })).templates, hashes.templates);
  } finally {
    w.cleanup();
  }
});

test("a project without jgates.yml also builds, writes and executes a plan equivalent to the option flags", () => {
  const w = workspace();
  try {
    w.write("app.txt", "source\n");
    w.commit("first");
    const doc = result(w.cli(["run", "--cwd", w.dir, "--bridge-mode", "quick", "--enable-pii", "--json"]));
    assert.equal(doc.selection.planSource, "options");
    assert.equal(doc.selection.options.bridgeMode, "quick");
    assert.equal(doc.selection.options.pii, true);
    assert.equal(doc.artifacts.plan, "plan.json");

    const plan = JSON.parse(fs.readFileSync(path.join(doc.runDir, "plan.json"), "utf8"));
    assert.deepEqual(planApi.validatePlanDocument(plan), []);
    assert.equal(plan.planHash, doc.selection.planHash);
    assert.equal(planApi.computePlanHash(plan), plan.planHash);
    assert.equal(doc.provenance.plan.source, "options");
    assert.ok(plan.warnings.some((x) => x.code === "PLAN_FROM_OPTIONS"));
    assert.equal(fs.realpathSync(plan.workspace.path), fs.realpathSync(w.dir));

    // The plan says what runs and what the options left off, with the origin; the run follows it.
    const willRun = plan.groups.willRun.map((i) => i.id);
    assert.ok(willRun.includes("quality-bridge.file-size#file-size"));
    const semgrep = plan.groups.notApplicableOrDisabled.find((i) => i.id === "quality-bridge.semgrep#sast");
    assert.ok(semgrep);
    assert.equal(semgrep.state.runOnly, true);
    assert.equal(doc.stages.find((s) => s.id === "quality-bridge.semgrep").state, "disabled");
    assert.equal(doc.stages.find((s) => s.id === "quality-bridge.file-size").state, "completed");
    assert.equal(doc.reduced, plan.selection.reduced);

    // The bridge received exactly the request of the plan (the run folder in place of its token, the analyzed folder as target).
    const invocation = plan.invocations.find((i) => i.adapter === "quality-bridge");
    assert.equal(invocation.command.stdin.mode, "quick");
    assert.equal(invocation.command.stdin.pii, true);
    const sent = seenOf(doc).request;
    const expected = JSON.parse(JSON.stringify(invocation.command.stdin).split("{runDir}").join(doc.runDir));
    expected.target = doc.analyzed.path;
    assert.deepEqual(sent, expected);
  } finally {
    w.cleanup();
  }
});

test("Git queries are read-only: the snapshot of a commit comes from a private index and never touches the user's index", () => {
  const w = workspace();
  try {
    w.write("sub/app.txt", "one\n");
    w.write("root.txt", "root\n");
    const first = w.commit("first");
    w.write("sub/app.txt", "two\n");
    git(w.dir, "add", "sub/app.txt"); // staged change
    const index = path.join(w.dir, ".git", "index");
    const before = fs.readFileSync(index);
    const env = { ...process.env, JGATES_GIT: GIT };
    // The workspace is a subfolder of the repository: the snapshot holds that folder of the commit.
    const sub = path.join(w.dir, "sub");
    const context = snapshotApi.gitContext(sub, env);
    assert.equal(context.prefix, "sub/");
    assert.equal(snapshotApi.resolveCommit(context, sub, "HEAD", env), first);
    assert.equal(snapshotApi.resolveCommit(context, sub, "--output=/tmp/x", env), null);
    const status = snapshotApi.workingTreeStatus(context, sub, env);
    assert.deepEqual(status.tracked, [{ path: "app.txt", status: "M " }]);
    const dest = path.join(w.home, "snap");
    const snap = snapshotApi.materializeCommit(context, first, dest, env);
    assert.deepEqual(fs.readdirSync(dest), ["app.txt"]);
    assert.equal(fs.readFileSync(path.join(dest, "app.txt"), "utf8"), "one\n");
    assert.ok(!fs.existsSync(`${dest}.index`));
    assert.match(snap.tree, /^[0-9a-f]{40}$/);
    assert.deepEqual(fs.readFileSync(index), before);
    snapshotApi.removeSnapshot(dest);
    assert.ok(!fs.existsSync(dest));
  } finally {
    w.cleanup();
  }
});
