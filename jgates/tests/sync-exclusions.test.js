import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The two exclusions of the sync that depend on the project: `dist` and `build` are left out only where the
// project's ignore files list them, and the `exclude` patterns of .jgates/workspace.yml are honoured (never `.git`).

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const FAKE = path.join(here, "docker", "fake-docker.cjs");
const sync = await import(pathToFileURL(path.join(dist, "core", "sync", "index.js")).href);
const phase = await import(pathToFileURL(path.join(dist, "core", "sync", "phase.js")).href);

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
const files = (scan) => [...scan.entries.entries()].filter(([, e]) => e[0] === "f").map(([p]) => p).sort();

test("dist and build are copied unless the project's ignore files list them", () => {
  const plain = tmp("jgates-sync-plain-");
  write(plain, "src/app.py");
  write(plain, "dist/bundle.js");
  write(plain, "build/tool.py");
  write(plain, "pkg/dist/x.js");
  assert.deepEqual(files(sync.scanProject(plain)), ["build/tool.py", "dist/bundle.js", "pkg/dist/x.js", "src/app.py"], "no ignore file: nothing is left out");

  const ignored = tmp("jgates-sync-ignored-");
  write(ignored, ".gitignore", "# outputs\nnode_modules/\n/dist\nbuild/\n");
  write(ignored, "src/app.py");
  write(ignored, "dist/bundle.js");
  write(ignored, "build/tool.py");
  write(ignored, "pkg/build/y.js", "y\n");
  write(ignored, "pkg/dist/x.js", "x\n");
  const scan = sync.scanProject(ignored);
  assert.deepEqual(files(scan), [".gitignore", "pkg/dist/x.js", "src/app.py"], "/dist is the root one only; build/ is any depth");
  assert.deepEqual(scan.excludedFound, ["build", "dist", "pkg/build"]);
});

test("ignore patterns in the other spellings, a nested ignore file, a negation and the Docker ignore file", () => {
  const dir = tmp("jgates-sync-spell-");
  write(dir, ".gitignore", "**/dist/\nbuild/**\n!build\n");
  write(dir, ".dockerignore", "build\n");
  write(dir, "a/dist/x.js");
  write(dir, "a/build/y.js");
  write(dir, "b/.gitignore", "/build\n");
  write(dir, "b/build/z.js");
  write(dir, "b/c/build/w.js");
  write(dir, "keep.py");
  const found = files(sync.scanProject(dir));
  assert.ok(!found.includes("a/dist/x.js"), "**/dist/");
  assert.ok(!found.includes("a/build/y.js"), ".dockerignore at the root names build (the negation of .gitignore is its own file's)");
  assert.ok(!found.includes("b/build/z.js"), "/build of a nested ignore file");
  assert.ok(found.includes("b/c/build/w.js") === false, "the root .dockerignore still covers build below b/c");
  assert.ok(found.includes("keep.py"));

  const only = tmp("jgates-sync-nested-");
  write(only, "b/.gitignore", "/build\n");
  write(only, "b/build/z.js");
  write(only, "b/c/build/w.js");
  write(only, "build/root.py");
  assert.deepEqual(files(sync.scanProject(only)), ["b/.gitignore", "b/c/build/w.js", "build/root.py"], "an anchored pattern covers its own folder only");

  const negated = tmp("jgates-sync-negated-");
  write(negated, ".gitignore", "dist\n!dist\n");
  write(negated, "dist/a.js");
  assert.deepEqual(files(sync.scanProject(negated)), [".gitignore", "dist/a.js"]);
  assert.deepEqual(sync.ignoredBuildOutputs("src/dist\ntmp\ndist-old\n").anywhere.size, 0, "only the exact names count");
});

test("honorIgnoreFiles false copies dist and build even when ignored", () => {
  const dir = tmp("jgates-sync-off-");
  write(dir, ".gitignore", "dist\n");
  write(dir, "dist/a.js");
  assert.ok(files(sync.scanProject(dir, sync.SYNC_EXCLUDED_DIRECTORIES, { honorIgnoreFiles: false })).includes("dist/a.js"));
});

test("exclude patterns of workspace.yml leave out folders and files, a bare name at any depth, and never .git", () => {
  const dir = tmp("jgates-sync-patterns-");
  for (const rel of ["src/app.py", "vendor/lib.py", "src/vendor/inner.py", "docs/api/a.md", "docs/guide.md", "gen/out.py", "gen/keep.txt", "notes.tmp", "sub/notes.tmp", ".git/config", ".git/HEAD"]) write(dir, rel);
  const scan = sync.scanProject(dir, sync.SYNC_EXCLUDED_DIRECTORIES, { excludePatterns: ["vendor", "docs/api", "gen/*.py", "*.tmp", ".git", ".git/**", "./src/other"] });
  assert.deepEqual(files(scan), [".git/HEAD", ".git/config", "docs/guide.md", "gen/keep.txt", "src/app.py"]);
  assert.ok(scan.excludedFound.includes("vendor") && scan.excludedFound.includes("src/vendor") && scan.excludedFound.includes("docs/api"));
  assert.ok(scan.excludedFound.includes("gen/out.py") && scan.excludedFound.includes("notes.tmp") && scan.excludedFound.includes("sub/notes.tmp"));
});

test("the sync phase reads the exclusions of .jgates/workspace.yml and reports them with the build outputs", async () => {
  const project = tmp("jgates-sync-phase-");
  const home = tmp("jgates-sync-home-");
  const engine = tmp("jgates-sync-engine-");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(runtime, [`process.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};`, `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(path.join(engine, "calls.jsonl"))};`, `require(${JSON.stringify(FAKE)});`, ""].join("\n"));
  write(project, "src/app.py");
  write(project, "legacy/old.py");
  write(project, "dist/out.js");
  write(project, ".gitignore", "dist\n");
  write(project, ".jgates/workspace.yml", "schemaVersion: 1\nexclude:\n  - legacy\n");
  const runDir = tmp("jgates-sync-run-");
  const env = { ...process.env, JGATES_CONTAINER_RUNTIME: runtime, JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_LOCALE: "en" };
  const outcome = await phase.createSyncPhase({ projectDir: project, workspace: "ws_0123456789abcdef", runId: "run_x", runDir, version: "test", home, env }).run();
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.deepEqual(outcome.details.excludePatterns, ["legacy"]);
  assert.deepEqual(outcome.details.buildOutputs, ["dist", "build"]);
  assert.deepEqual(outcome.details.excludedPaths, ["dist", "legacy"]);
  const volume = path.join(engine, "volumes", outcome.details.volume);
  assert.ok(fs.existsSync(path.join(volume, "src", "app.py")));
  assert.ok(!fs.existsSync(path.join(volume, "legacy")), "the workspace.yml exclusion was not copied");
  assert.ok(!fs.existsSync(path.join(volume, "dist")), "the ignored build output was not copied");
  const log = fs.readFileSync(path.join(runDir, "logs", "sync.log"), "utf8");
  assert.match(log, /workspace\.yml: legacy\n/);
  assert.match(log, /: dist, build\n/);
});
