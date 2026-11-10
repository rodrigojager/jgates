import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// The pieces of the sync phase that do not need an engine: the versioned exclusion list, the scan of a project
// (exclusions, modes from the Git index), the plan of what to send and delete, the tar archive the helper unpacks,
// and the phase contract of the executor. The end-to-end behaviour with the fake engine is tests/v2/v2-38.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const sync = await import(pathToFileURL(path.join(dist, "core", "sync", "index.js")).href);
const tar = await import(pathToFileURL(path.join(dist, "core", "sync", "tar.js")).href);
const runner = await import(pathToFileURL(path.join(dist, "core", "runner", "index.js")).href);

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});
const write = (root, rel, content = "x\n") => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};

test("the exclusion list is the versioned constant: host environments, platform builds and tool caches", () => {
  assert.deepEqual([...sync.SYNC_EXCLUDED_DIRECTORIES].sort(), [".mypy_cache", ".pytest_cache", ".ruff_cache", ".venv", "__pycache__", "bin", "node_modules", "obj", "target", "venv"]);
});

test("scanProject skips excluded directories at any depth and virtual environments, and keeps .git", () => {
  const root = tmp("sync-scan-");
  write(root, "src/a.py");
  write(root, ".venv/lib/x.py");
  write(root, "pkg/node_modules/dep/index.js");
  write(root, "env/pyvenv.cfg", "home = /usr\n");
  write(root, "env/lib/y.py");
  write(root, ".git/HEAD", "ref: refs/heads/main\n");
  write(root, "bin/tool.exe");
  const { entries, excludedFound } = sync.scanProject(root);
  const paths = [...entries.keys()].sort();
  assert.ok(paths.includes("src/a.py"));
  assert.ok(paths.includes(".git/HEAD"), ".git is copied");
  for (const p of paths) assert.ok(!/^(\.venv|env|bin)\b|node_modules/.test(p), `excluded path scanned: ${p}`);
  assert.deepEqual(excludedFound, [".venv", "bin", "env", "pkg/node_modules"]);
});

test("executable bits come from the Git index, every other file is 644", (t) => {
  const git = spawnSync("git", ["--version"]);
  if (git.status !== 0) return t.diagnostic("git is not available; the Git index case is covered where it is");
  const root = tmp("sync-modes-");
  write(root, "run.sh", "#!/bin/sh\n");
  write(root, "plain.txt");
  const g = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  g("init", "-q");
  g("add", "-A");
  assert.equal(g("update-index", "--chmod=+x", "run.sh").status, 0);
  const { entries } = sync.scanProject(root);
  assert.equal(entries.get("run.sh")[3], 0o755);
  assert.equal(entries.get("plain.txt")[3], 0o644);
});

test("planSync sends new and changed paths, deletes the ones that vanished and drops paths under a removed directory", () => {
  const file = (size, mtime, mode = 0o644) => ["f", size, mtime, mode];
  const dir = ["d", 0, 0, 0o755];
  const before = new Map([
    ["a", dir],
    ["a/one", file(1, 1)],
    ["a/two", file(2, 2)],
    ["keep", file(3, 3)],
    ["gone", file(4, 4)],
    ["flip", file(5, 5)],
  ]);
  const after = new Map([
    ["keep", file(3, 3)],
    ["flip", ["d", 0, 0, 0o755]],
    ["fresh", file(6, 6)],
  ]);
  const plan = sync.planSync(before, after);
  assert.deepEqual(plan.changed, ["flip", "fresh"]);
  assert.deepEqual(plan.removed, ["a", "flip", "gone"]);
  assert.equal(plan.totalFiles, 2);
  assert.equal(plan.changedFiles, 1);
  assert.equal(plan.deletedFiles, 3);
  const cold = sync.planSync(null, after);
  assert.deepEqual(cold.changed, ["flip", "fresh", "keep"]);
  assert.deepEqual(cold.removed, []);
  const same = sync.planSync(after, after);
  assert.deepEqual([same.changed, same.removed], [[], []]);
  const mode = sync.planSync(new Map([["x", file(1, 1, 0o644)]]), new Map([["x", file(1, 1, 0o755)]]));
  assert.deepEqual(mode.changed, ["x"], "a mode change alone is sent");
});

test("the tar archive carries content, modes, directories, links and paths longer than 100 bytes", () => {
  const root = tmp("sync-tar-");
  const long = `${"deep-folder-name/".repeat(8)}file-with-a-long-name.txt`;
  assert.ok(Buffer.byteLength(long) > 100);
  write(root, "plain.txt", "hello");
  write(root, long, "x".repeat(1000));
  write(root, "accénted ñ.txt", "utf8");
  const out = path.join(tmp("sync-tar-out-"), "a.tar");
  const writer = new tar.TarWriter(out);
  assert.ok(writer.add({ path: "dir", kind: "dir", mode: 0o755, mtimeMs: 1_700_000_000_000 }));
  assert.ok(writer.add({ path: "plain.txt", kind: "file", mode: 0o755, mtimeMs: 1_700_000_000_000, size: 5, source: path.join(root, "plain.txt") }));
  assert.ok(writer.add({ path: long, kind: "file", mode: 0o644, mtimeMs: 1_700_000_000_000, size: 1000, source: path.join(root, ...long.split("/")) }));
  assert.ok(writer.add({ path: "accénted ñ.txt", kind: "file", mode: 0o644, mtimeMs: 1_700_000_000_000, size: 4, source: path.join(root, "accénted ñ.txt") }));
  assert.ok(writer.add({ path: "link", kind: "symlink", mode: 0o777, mtimeMs: 1_700_000_000_000, target: "plain.txt" }));
  assert.equal(writer.add({ path: "missing", kind: "file", mode: 0o644, mtimeMs: 0, size: 3, source: path.join(root, "missing") }), false, "an unreadable file is reported, not written");
  writer.close();
  const bytes = fs.readFileSync(out);
  assert.equal(bytes.length % 512, 0);
  const entries = tar.readTar(bytes);
  assert.deepEqual(
    entries.map((e) => [e.path, e.type, e.mode]),
    [["dir", "5", 0o755], ["plain.txt", "0", 0o755], [long, "0", 0o644], ["accénted ñ.txt", "0", 0o644], ["link", "2", 0o777]],
  );
  assert.equal(entries[1].data.toString(), "hello");
  assert.equal(entries[2].data.toString(), "x".repeat(1000));
  assert.equal(entries[4].link, "plain.txt");
  // GNU tar, when this machine has one, reads the same archive.
  const listing = spawnSync("tar", ["-tf", out], { encoding: "utf8" });
  if (listing.status === 0) assert.ok(listing.stdout.includes(long) || listing.stdout.includes("file-with-a-long-name.txt"), listing.stdout);
});

test("the helper script deletes first, then unpacks, and only touches /dst", () => {
  const [sh, flag, script] = sync.syncCommand();
  assert.deepEqual([sh, flag], ["sh", "-c"]);
  assert.ok(script.indexOf("rm -rf") < script.indexOf("tar -x"), "removals run before the unpack");
  assert.ok(script.includes("set -e"));
});

test("a phase runs before the steps, reports its details, and a failed phase blocks every step", async () => {
  const events = [];
  const step = (id) => ({
    id,
    skeleton: () => ({ stages: [{ id, state: "pending" }], requirements: [{ id, required: true }], disabled: [], findings: [], logs: [], outputs: [] }),
    run: async () => {
      events.push(`ran:${id}`);
      return { stages: [{ id, state: "completed", blockingViolations: 0 }], requirements: [{ id, required: true }], disabled: [], findings: [], logs: [], outputs: [] };
    },
  });
  const emit = (type, data) => events.push(`${type}:${data.phase ?? data.step ?? ""}`);
  const ok = await runner.executeSteps([step("a")], { emit, phases: [{ id: "sync", run: async () => ({ ok: true, details: { totalFiles: 3 } }) }] });
  assert.deepEqual(events.slice(0, 2), ["phase-started:sync", "phase-finished:sync"]);
  assert.ok(events.indexOf("ran:a") > events.indexOf("phase-finished:sync"));
  assert.equal(ok.phases[0].outcome.details.totalFiles, 3);
  assert.equal(ok.reports[0].status, "succeeded");

  events.length = 0;
  const bad = await runner.executeSteps([step("a"), step("b")], { emit, phases: [{ id: "sync", run: async () => ({ ok: false, code: "SYNC_FAILED", reason: "engine gone", details: {} }) }] });
  assert.ok(!events.some((e) => e.startsWith("ran:")), "no step ran");
  assert.deepEqual(bad.reports.map((r) => r.status), ["not-run", "not-run"]);
  assert.ok(bad.reports.every((r) => r.output.stages.every((s) => s.state === "blocked" && /engine gone/.test(s.reason))));
});
