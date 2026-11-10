import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-38: the sync is incremental and honours the exclusions. `jgates internal sync` (the code a run uses for its sync
// phase) copies a project into the workspace's source volume through the fake engine, which unpacks the archive the
// host streams into a folder per volume and records the modes. The second sync sends only what changed and deletes what
// the project removed, `.venv`, `node_modules`, `bin`, `__pycache__` and a virtual environment named `env` are never
// copied, `.git` is, the executable bit follows `git ls-files -s`, and the project folder is never mounted into any
// container. A 10 000-file project must sync again, with few changes, in under 10 s (the measured time is printed).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const project = tmp("v2-38-project-");
  const home = tmp("v2-38-home-");
  const bin = tmp("v2-38-engine-");
  const log = path.join(bin, "calls.jsonl");
  const runtime = path.join(bin, "docker.cjs");
  const labels = JSON.stringify({ "org.jgates.version": CLI_VERSION });
  fs.writeFileSync(runtime, `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(log)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(bin)};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(labels)};\nrequire(${JSON.stringify(FAKE)});\n`);
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  const sync = () => {
    const r = spawnSync(process.execPath, [MAIN, "internal", "sync", "--cwd", project, "--json"], { cwd: project, encoding: "utf8", env, input: "", timeout: 300_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return JSON.parse(r.stdout).sync;
  };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const volumeDir = (volume) => path.join(bin, "volumes", volume);
  const modes = (volume) => JSON.parse(fs.readFileSync(path.join(bin, "volumes", `${volume}.modes.json`), "utf8"));
  const put = (rel, content = "x\n") => {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), content);
  };
  const git = (...args) => spawnSync("git", args, { cwd: project, encoding: "utf8" });
  return { project, home, sync, calls, volumeDir, modes, put, git, runtime };
}

const tree = (dir) => {
  const out = [];
  const walk = (d, rel) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(d, entry.name), next);
      else out.push(next);
    }
  };
  walk(dir, "");
  return out.sort();
};
const syncRuns = (calls) => calls.filter((c) => c[0] === "run" && c.some((a) => typeof a === "string" && a.endsWith("dst=/dst")));

test("V2-38: the second sync reflects a changed and a deleted file, excluded folders are never copied and exec bits come from the Git index", () => {
  const w = setup();
  w.put("src/app.py", "print('one')\n");
  w.put("src/gone.py");
  w.put("src/keep.py", "keep\n");
  w.put("scripts/run.sh", "#!/bin/sh\n");
  w.put("README.md");
  w.put(".venv/lib/site.py");
  w.put("node_modules/dep/index.js");
  w.put("web/node_modules/dep/index.js");
  w.put("bin/tool.exe");
  w.put("src/__pycache__/app.pyc");
  w.put("env/pyvenv.cfg", "home = /usr\n");
  w.put("env/lib/python.py");
  assert.equal(w.git("init", "-q").status, 0, "git is needed for this case");
  w.git("add", "-A");
  assert.equal(w.git("update-index", "--chmod=+x", "scripts/run.sh").status, 0);
  // A tracked file the index marks executable and an untracked file (no mode in the index) on a host without exec bits.
  w.put("untracked.sh", "#!/bin/sh\n");

  // First sync: everything that is not excluded, nothing else.
  const first = w.sync();
  assert.equal(first.createdVolume, true);
  assert.match(first.volume, /^jgates-ws_[0-9a-f]{16}-src$/);
  const volume = w.volumeDir(first.volume);
  const copied = tree(volume);
  for (const wanted of ["src/app.py", "src/gone.py", "src/keep.py", "scripts/run.sh", "README.md", ".git/HEAD", "untracked.sh"]) assert.ok(copied.includes(wanted), `${wanted} is in the volume: ${copied.join(", ")}`);
  for (const p of copied) assert.ok(!/(^|\/)(\.venv|node_modules|bin|__pycache__|env)\//.test(p), `excluded path copied: ${p}`);
  assert.deepEqual([...first.excludedPaths].sort(), [".venv", "bin", "env", "node_modules", "src/__pycache__", "web/node_modules"].sort());
  for (const name of [".venv", "venv", "node_modules", "target", "bin", "obj", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"]) assert.ok(first.exclusions.includes(name), `${name} is in the exclusion list`);
  assert.equal(first.changedFiles, first.totalFiles, "the first sync sends every file");
  assert.equal(first.deletedFiles, 0);

  // Exec bits: the Git index says run.sh is executable; no other file is.
  const modes = w.modes(first.volume);
  assert.equal(modes["scripts/run.sh"], 0o755);
  assert.equal(modes["src/app.py"], 0o644);
  assert.equal(modes["README.md"], 0o644);
  if (process.platform === "win32") assert.equal(modes["untracked.sh"], 0o644, "Windows carries no exec bit, so an untracked file is 644");

  // The project folder is never mounted into any container: the helper sees only the stage folder and the volume.
  const helpers = syncRuns(w.calls());
  assert.equal(helpers.length, 1, "one helper container for the first sync");
  const mountArgs = w.calls().filter((c) => c[0] === "run").flatMap((c) => c.filter((a, i) => c[i - 1] === "--mount"));
  assert.ok(mountArgs.length > 0);
  assert.ok(!mountArgs.some((m) => m.includes(w.project)), `the project is not mounted: ${mountArgs.join(" | ")}`);
  assert.ok(mountArgs.some((m) => m.includes("dst=/stage") && m.endsWith("readonly")), "the stage folder is read-only");

  // Second sync with nothing changed: nothing is sent and no helper container starts.
  const idle = w.sync();
  assert.equal(idle.createdVolume, false);
  assert.equal(idle.changedFiles, 0);
  assert.equal(idle.deletedFiles, 0);
  assert.equal(idle.totalFiles, first.totalFiles);
  assert.equal(syncRuns(w.calls()).length, 1, "no helper container for an unchanged project");

  // A changed file, a deleted file, a new file, and a change inside an excluded folder: only the first three count.
  w.put("src/app.py", "print('two, longer')\n");
  fs.rmSync(path.join(w.project, "src", "gone.py"));
  w.put("src/new.py", "new\n");
  w.put(".venv/lib/more.py");
  w.put("node_modules/dep/other.js");
  const third = w.sync();
  assert.equal(third.changedFiles, 2, "app.py and new.py");
  assert.equal(third.deletedFiles, 1, "gone.py");
  assert.equal(syncRuns(w.calls()).length, 2);
  assert.equal(fs.readFileSync(path.join(volume, "src", "app.py"), "utf8"), "print('two, longer')\n");
  assert.ok(!fs.existsSync(path.join(volume, "src", "gone.py")), "the deleted file left the volume");
  assert.ok(fs.existsSync(path.join(volume, "src", "new.py")));
  assert.equal(fs.readFileSync(path.join(volume, "src", "keep.py"), "utf8"), "keep\n");
  assert.ok(!tree(volume).some((p) => p.startsWith(".venv/") || p.startsWith("node_modules/")), "excluded folders still absent");

  // A removed directory takes its files with it, and a mode flip alone is a change.
  fs.rmSync(path.join(w.project, "scripts"), { recursive: true });
  w.git("update-index", "--chmod=+x", "README.md");
  const fourth = w.sync();
  assert.ok(!fs.existsSync(path.join(volume, "scripts")), "the removed directory is gone from the volume");
  assert.equal(fourth.deletedFiles, 1);
  assert.equal(w.modes(first.volume)["README.md"], 0o755, "an index mode change is sent even when the content is the same");

  // The project was only read: nothing new appeared in it.
  assert.ok(!fs.existsSync(path.join(w.project, ".jgates-sync")));
  assert.deepEqual(tree(w.project).filter((p) => p.startsWith("src/")).sort(), ["src/__pycache__/app.pyc", "src/app.py", "src/keep.py", "src/new.py"]);
});

test("V2-38: a volume removed behind JGates's back is filled again, not trusted from the manifest", () => {
  const w = setup();
  w.put("a.py");
  w.put("b.py");
  const first = w.sync();
  // The volume is removed through the engine, as `docker volume rm` would.
  assert.equal(spawnSync(process.execPath, [w.runtime, "volume", "rm", first.volume]).status, 0);
  const again = w.sync();
  assert.equal(again.createdVolume, true);
  assert.equal(again.changedFiles, again.totalFiles);
  assert.deepEqual(tree(w.volumeDir(first.volume)), ["a.py", "b.py"]);
});

test("V2-38: a 10 000-file project syncs again in under 10 s with a few changes", (t) => {
  const w = setup();
  for (let d = 0; d < 100; d++) for (let f = 0; f < 100; f++) w.put(`pkg${d}/mod${f}.py`, `value = ${d * 100 + f}\n`);
  w.put(".venv/lib/skip.py");
  const cold = w.sync();
  assert.equal(cold.totalFiles, 10_000);
  assert.equal(tree(w.volumeDir(cold.volume)).length, 10_000);
  w.put("pkg1/mod1.py", "value = 'changed'\n");
  w.put("pkg2/added.py");
  fs.rmSync(path.join(w.project, "pkg3", "mod3.py"));
  const warm = w.sync();
  assert.equal(warm.changedFiles, 2);
  assert.equal(warm.deletedFiles, 1);
  const line = `V2-38 sync of ${cold.totalFiles} files (fake engine, host side): first ${cold.durationMs} ms (read ${cold.scanMs} ms, copy ${cold.copyMs} ms), with 2 changed and 1 deleted ${warm.durationMs} ms`;
  t.diagnostic(line);
  console.log(line);
  assert.ok(warm.durationMs < 10_000, line);
});
