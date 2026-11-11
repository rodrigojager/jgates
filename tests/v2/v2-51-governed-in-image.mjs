import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-51 (no engine): `jgates ci` inside the tools image (image.json present, no Docker anywhere).
//   1. The steps run natively: the clean copy of the commit is analyzed and the dependencies are installed there with the
//      frozen commands of the ecosystem (`go mod download` + `go mod verify` with GOFLAGS=-mod=readonly), recorded in the
//      run folder (deps-install.json). A unit without a lockfile is not installed at all: the check that needs it is blocked
//      with DEPENDENCIES_NOT_READY and the tool never starts.
//   2. execution.extensionImage: forbid refuses a commit that carries an extension image (exit 3, nothing runs);
//      pinned refuses it too (no fixed digest), refuses a tools image whose digest is not the pinned one, and accepts the
//      pinned digest.
//   3. Advisory data older than the policy's execution.dataMaxAgeDays (default 7) blocks the check that reads it
//      (DATA_STALE), data that was never fetched blocks it (DATA_MISSING), and a looser limit lets the same data through.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const DAY = 86_400_000;

const { writeImageJson } = await import(pathToFileURL(path.join(root, "jgates", "tests", "setup", "image-json.mjs")).href);
const { readPolicyBundle } = await import(pathToFileURL(path.join(root, "jgates", "dist", "core", "policy", "index.js")).href);
const { findOnPath } = await import(pathToFileURL(path.join(root, "jgates", "dist", "core", "bridge", "index.js")).href);
const PIN = JSON.parse(fs.readFileSync(path.join(root, "jgates", "release", "tools-image.json"), "utf8"));

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const write = (dir, files) => {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, ...name.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
};
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const CAPABILITIES = ["file-size", "lint", "secrets", "sast", "dependencies", "duplication", "iac", "unit", "coverage", "pii"];
const profiles = `schemaVersion: 1\nprofiles:\n  gate:\n    label: gate\n    extends: builtin:minimal\n    checks:\n${CAPABILITIES.map((c) => `      capability:${c}:\n        enabled: ${c === "file-size" || c === "dependencies"}\n`).join("")}`;
const GO_FILES = { "go.mod": "module example.com/app\n\ngo 1.22\n", "go.sum": "", "main.go": "package main\n\nfunc main() {}\n" };

const git = (dir, ...args) => {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
  assert.equal(r.status, 0, r.stderr);
};

/** A Go project committed to Git, a CI policy folder, a fake `go` that records its calls and an empty advisory data folder. */
function setup({ files = GO_FILES, policyExecution = "" } = {}) {
  const project = tmp("v2-51-project-");
  const policy = tmp("v2-51-policy-");
  const home = tmp("v2-51-home-");
  const bin = tmp("v2-51-bin-");
  const data = tmp("v2-51-data-");
  const calls = path.join(bin, "go-calls.jsonl");
  write(project, files);
  git(project, "init", "-q");
  git(project, "add", "-A");
  git(project, "commit", "-qm", "init");
  const policyFiles = {
    "jgates.yml": `schemaVersion: 1\nextends:\n  - .jgates/profiles.yml\nselection:\n  profile: gate\n${policyExecution}`,
    ".jgates/profiles.yml": profiles,
    ".jgates/tools.yml": "schemaVersion: 1\ntools:\n  govulncheck:\n    adapter: govulncheck\n    capabilities: [dependencies]\n",
    ".jgates/quality-policy.json": '{"schemaVersion":1}\n',
  };
  write(policy, policyFiles);
  // The fake Go toolchain: records the arguments, the folder and GOFLAGS of every call, and succeeds.
  const script = `const fs = require("fs");\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), hasLockfile: fs.existsSync("go.sum"), goflags: process.env.GOFLAGS ?? null }) + "\\n");\n`;
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "go.js"), script);
  else {
    fs.writeFileSync(path.join(bin, "go"), `#!/usr/bin/env node\n${script}`);
    fs.chmodSync(path.join(bin, "go"), 0o755);
  }
  const python = findOnPath("python") ?? findOnPath("python3");
  const gitBinary = findOnPath("git");
  assert.ok(python && gitBinary, "python and git are needed on the PATH of the test");
  const sha = () => readPolicyBundle(policy).bundle.sha256;
  const base = {
    ...process.env,
    JGATES_HOME: home,
    JGATES_PYTHON: python,
    JGATES_GIT: gitBinary,
    JGATES_DATA_DIR: data,
    JGATES_LOCALE: "en",
    NO_COLOR: "1",
    PATH: bin,
    PATHEXT: ".EXE;.CMD;.BAT;.JS",
    // No engine anywhere: a docker call would fail.
    DOCKER_CONTEXT: "",
    DOCKER_HOST: "tcp://127.0.0.1:1",
    JGATES_CONTAINER_RUNTIME: path.join(bin, "no-docker"),
    GITHUB_BASE_REF: "",
    GITHUB_HEAD_REF: "",
    GITHUB_SHA: "",
    GITLAB_CI: "",
  };
  delete base.JGATES_NO_CACHE;
  delete base.JGATES_TOOLS_IMAGE;
  delete base.JGATES_POLICY_DIR;
  const seedData = (fetchedAt) => {
    fs.rmSync(path.join(data, "jgates-data.json"), { force: true });
    if (fetchedAt) fs.writeFileSync(path.join(data, "jgates-data.json"), JSON.stringify({ schemaVersion: 1, databases: { govulndb: { fetchedAt, source: "fake://govulndb" } } }));
  };
  const ci = (imageJson, extraEnv = {}) => {
    const r = spawnSync(process.execPath, [MAIN, "ci", "--cwd", project, "--policy", policy, "--json"], {
      encoding: "utf8",
      env: { ...base, JGATES_IMAGE_JSON: imageJson, JGATES_POLICY_SHA256: sha(), ...extraEnv },
      timeout: 300_000,
    });
    let doc;
    try {
      doc = JSON.parse(r.stdout);
    } catch (error) {
      assert.fail(`stdout is not one JSON document (${error.message}):\n${r.stdout}\n${r.stderr}`);
    }
    return { code: r.status, doc, stderr: r.stderr };
  };
  const goCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const runs = () => {
    const ws = path.join(home, "workspaces");
    return fs.existsSync(ws) ? fs.readdirSync(ws).flatMap((id) => (fs.existsSync(path.join(ws, id, "runs")) ? fs.readdirSync(path.join(ws, id, "runs")) : [])) : [];
  };
  return { project, policy, home, data, seedData, ci, goCalls, runs, policyFiles, resetCalls: () => fs.rmSync(calls, { force: true }), sha, write: (files) => write(policy, files) };
}

const stageOf = (doc, id) => doc.stages.find((s) => s.id === id) ?? assert.fail(`${id} not in ${JSON.stringify(doc.stages.map((s) => s.id))}`);
const problemCodes = (stage) => (stage.execution?.notRun?.problems ?? []).map((p) => p.code);
const readJson = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));

test("V2-51: jgates ci inside the image runs natively with frozen installs, refuses extensions by policy, pins the image digest and blocks on old advisory data", () => {
  const imageJson = writeImageJson();

  // 1. Native run, frozen installs, in the clean copy of the commit.
  const fresh = setup();
  const dayOld = iso(Date.now() - DAY);
  fresh.seedData(dayOld);
  const ok = fresh.ci(imageJson);
  assert.notEqual(ok.code, 3, JSON.stringify(ok.doc).slice(0, 600));
  assert.equal(ok.doc.exitCode, ok.code);
  assert.equal(stageOf(ok.doc, "quality-bridge.file-size").state, "completed", "the bridge's file-size check ran natively");
  const installed = fresh.goCalls();
  assert.deepEqual(installed.map((c) => c.args), [["mod", "download"], ["mod", "verify"]], "the frozen install commands ran, nothing else");
  for (const call of installed) {
    assert.match(call.goflags ?? "", /-mod=readonly/, "go is told not to touch go.mod and go.sum");
    assert.notEqual(call.cwd.toLowerCase(), fs.realpathSync(fresh.project).toLowerCase(), "the install ran in the copy of the commit, never in the work tree");
    assert.ok(call.cwd.toLowerCase().includes(`${path.sep}snapshots${path.sep}`), `the install ran in the run's snapshot: ${call.cwd}`);
    assert.equal(call.hasLockfile, true, "the copy of the commit holds the lockfile");
  }
  const record = readJson(ok.doc.runDir, "deps-install.json");
  assert.equal(record.mode, "in-image");
  assert.equal(record.governed, true);
  assert.equal(record.units.length, 1);
  assert.equal(record.units[0].manager, "go");
  assert.equal(record.units[0].mode, "frozen");
  assert.equal(record.units[0].status, "installed");
  assert.deepEqual(record.units[0].commands, [["go", "mod", "download"], ["go", "mod", "verify"]]);
  assert.match(record.units[0].env.GOFLAGS, /-mod=readonly/);
  // The advisory data was read from where the job mounted it, 1 day old against the default limit of 7.
  const dataRecord = readJson(ok.doc.runDir, "data-status.json");
  assert.equal(dataRecord.maxAgeDays, 7);
  assert.equal(dataRecord.databases.govulndb.fetchedAt, dayOld);
  assert.ok(!problemCodes(stageOf(ok.doc, "govulncheck#dependencies")).some((c) => c.startsWith("DATA_")), "fresh data does not block");
  assert.ok(!problemCodes(stageOf(ok.doc, "govulncheck#dependencies")).some((c) => c.startsWith("DEPENDENCIES_")), "installed dependencies do not block");

  // Without a lockfile in the commit nothing is installed and the check that needs the dependencies does not start.
  const unlocked = setup({ files: { "go.mod": GO_FILES["go.mod"], "main.go": GO_FILES["main.go"] } });
  unlocked.seedData(iso(Date.now() - DAY));
  const noLock = unlocked.ci(imageJson);
  assert.equal(unlocked.goCalls().length, 0, "no install without a lockfile");
  const blocked = stageOf(noLock.doc, "govulncheck#dependencies");
  assert.equal(blocked.state, "blocked");
  assert.ok(problemCodes(blocked).includes("DEPENDENCIES_NOT_READY"), JSON.stringify(blocked));
  assert.notEqual(noLock.code, 0, "an incomplete run never exits 0");
  assert.equal(readJson(noLock.doc.runDir, "deps-install.json").units[0].status, "not-ready");

  // 3. Data older than the policy's age, never fetched, and a looser limit.
  const stale = setup();
  stale.seedData(iso(Date.now() - 9 * DAY));
  const old = stale.ci(imageJson);
  const staleStage = stageOf(old.doc, "govulncheck#dependencies");
  assert.equal(staleStage.state, "blocked");
  assert.ok(problemCodes(staleStage).includes("DATA_STALE"), JSON.stringify(staleStage));
  assert.match(staleStage.reason, /9 days old \(the limit is 7 days\)/);
  assert.notEqual(old.code, 0);
  assert.equal(readJson(old.doc.runDir, "data-status.json").maxAgeDays, 7);

  const loose = setup({ policyExecution: "execution:\n  dataMaxAgeDays: 10\n" });
  loose.seedData(iso(Date.now() - 9 * DAY));
  const allowed = loose.ci(imageJson);
  assert.ok(!problemCodes(stageOf(allowed.doc, "govulncheck#dependencies")).includes("DATA_STALE"), "the policy's looser limit lets the data through");
  assert.equal(readJson(allowed.doc.runDir, "data-status.json").maxAgeDays, 10);

  const missing = setup();
  missing.seedData(null);
  assert.ok(problemCodes(stageOf(missing.ci(imageJson).doc, "govulncheck#dependencies")).includes("DATA_MISSING"));

  // 2. The policy and the images.
  const extensionFiles = { ...GO_FILES, ".jgates/image/Dockerfile": "ARG JGATES_TOOLS\nFROM ${JGATES_TOOLS}\nRUN true\n" };
  const refused = (r, code) => {
    assert.equal(r.code, 3, JSON.stringify(r.doc));
    assert.equal(r.doc.code, code);
    assert.equal(r.doc.exitCode, 3);
    assert.equal(r.doc.executed, false);
    assert.ok(r.doc.message.length > 0 && r.doc.fix.length > 0);
  };

  const forbid = setup({ files: extensionFiles, policyExecution: "execution:\n  extensionImage: forbid\n" });
  forbid.seedData(iso(Date.now() - DAY));
  refused(forbid.ci(imageJson), "EXTENSION_IMAGE_FORBIDDEN");
  assert.deepEqual(forbid.runs(), [], "a refused run creates no run folder");
  assert.deepEqual(forbid.goCalls(), [], "nothing was installed");
  // The same policy accepts a commit without an extension.
  const noExtension = setup({ policyExecution: "execution:\n  extensionImage: forbid\n" });
  noExtension.seedData(iso(Date.now() - DAY));
  assert.notEqual(noExtension.ci(imageJson).code, 3);

  const pinned = "execution:\n  extensionImage: pinned\n";
  const pinnedImage = writeImageJson({}, { digest: PIN.digest });
  const other = `sha256:${"0".repeat(64)}`;
  const withExtension = setup({ files: extensionFiles, policyExecution: pinned });
  withExtension.seedData(iso(Date.now() - DAY));
  refused(withExtension.ci(pinnedImage), "EXTENSION_IMAGE_UNPINNED");

  const plain = setup({ policyExecution: pinned });
  plain.seedData(iso(Date.now() - DAY));
  const different = plain.ci(writeImageJson({}, { digest: other }));
  refused(different, "TOOLS_IMAGE_DIGEST_MISMATCH");
  assert.equal(different.doc.expected, PIN.digest);
  assert.equal(different.doc.actual, other);
  refused(plain.ci(imageJson), "TOOLS_IMAGE_DIGEST_UNKNOWN");
  assert.notEqual(plain.ci(pinnedImage).code, 3, "the pinned digest is accepted");
  // The digest can also come from the job's environment (the CI example sets it from the container reference).
  refused(plain.ci(imageJson, { JGATES_TOOLS_IMAGE_DIGEST: other }), "TOOLS_IMAGE_DIGEST_MISMATCH");
  assert.notEqual(plain.ci(imageJson, { JGATES_TOOLS_IMAGE_DIGEST: PIN.digest }).code, 3);
  assert.deepEqual(plain.runs().length, 2, "only the two accepted runs left a run folder");
});
