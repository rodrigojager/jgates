"use strict";

// B3: on Linux the container runs as root and leaves quality-report.* read-only for the
// caller. These tests use a fake runtime (no Docker) that does the same.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { runDockerWrapper } = require("../bin/quality-gate.js");

const ROOT = path.resolve(__dirname, "..", "..");
const QUALITY_BIN = path.join(ROOT, "quality-gate", "bin", "quality-gate.js");
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const SKIP = process.platform === "win32" ? "POSIX permissions only" : IS_ROOT ? "root ignores file modes" : false;

const created = [];

// The tests leave read-only files in read-only directories: make them writable again, then remove everything.
test.after(() => {
  for (const temp of created) {
    const walk = (dir) => {
      try {
        fs.chmodSync(dir, 0o755);
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(path.join(dir, entry.name));
        }
      } catch {
        // Already gone.
      }
    };
    walk(temp);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

function sampleTarget() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "quality-gate-perm-"));
  created.push(temp);
  const target = path.join(temp, "target");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "sample.js"), "const value = 1;\n", "utf8");
  return { temp, target };
}

function approvedReport() {
  return {
    schemaVersion: 1,
    tool: "quality-gate",
    status: "APPROVED",
    score: { value: 100, threshold: 90 },
    findings: [],
    tools: []
  };
}

// What the root container leaves behind: reports the current user cannot write to.
function writeReadOnlyReports(reportsDir, lockDirectory) {
  fs.mkdirSync(reportsDir, { recursive: true });
  const json = path.join(reportsDir, "quality-report.json");
  const md = path.join(reportsDir, "quality-report.md");
  fs.writeFileSync(json, `${JSON.stringify(approvedReport(), null, 2)}\n`);
  fs.writeFileSync(md, "# Quality Gate Report\n\nStatus: APPROVED\n");
  fs.chmodSync(json, 0o444);
  fs.chmodSync(md, 0o444);
  if (lockDirectory) fs.chmodSync(reportsDir, 0o555);
}

function unlock(reportsDir) {
  try {
    fs.chmodSync(reportsDir, 0o755);
  } catch {
    // Already gone.
  }
}

function fakeRunner(lockDirectory, exitCode = 0) {
  return (command, args) => {
    if (args[0] === "version") return { status: 0, stdout: "28.1.1\n", stderr: "" };
    if (args[0] === "image") return { status: 0 };
    if (args[0] === "run") {
      const mount = args.find((arg) => arg.endsWith(":/workspace/.quality/reports"));
      writeReadOnlyReports(mount.slice(0, -":/workspace/.quality/reports".length), lockDirectory);
      return { status: exitCode };
    }
    return { status: 3 };
  };
}

function captureStderr(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...parts) => lines.push(parts.join(" "));
  try {
    return { result: fn(), lines };
  } finally {
    console.error = original;
  }
}

test("B3: read-only reports still receive the scope and the container exit code is kept", { skip: SKIP }, () => {
  const { target } = sampleTarget();
  const reportsDir = path.join(target, ".quality", "reports");
  const { result, lines } = captureStderr(() =>
    runDockerWrapper([target, "--scope", "full", "--mode", "quick", "--image", "example/sidecar:test", "--no-pull"], process.env, fakeRunner(false))
  );
  assert.equal(result, 0);
  assert.deepEqual(lines, []);
  const report = JSON.parse(fs.readFileSync(path.join(reportsDir, "quality-report.json"), "utf8"));
  assert.equal(report.scope.scope, "full");
  assert.equal(report.status, "APPROVED");
  assert.match(fs.readFileSync(path.join(reportsDir, "quality-report.md"), "utf8"), /## Scope\n\nScope: full/);
});

test("B3: reports that cannot be replaced become an explicit warning, not an exception", { skip: SKIP }, () => {
  const { target } = sampleTarget();
  const reportsDir = path.join(target, ".quality", "reports");
  try {
    const { result, lines } = captureStderr(() =>
      runDockerWrapper([target, "--scope", "full", "--mode", "quick", "--image", "example/sidecar:test", "--no-pull"], process.env, fakeRunner(true))
    );
    assert.equal(result, 0);
    assert.equal(lines.filter((line) => line.startsWith("Aviso:")).length, 2);
    assert.ok(lines.every((line) => /quality-report\.(json|md)/.test(line)));
  } finally {
    unlock(reportsDir);
  }
});

test("B3: a failing container keeps its own exit code even with read-only reports", { skip: SKIP }, () => {
  const { target } = sampleTarget();
  const reportsDir = path.join(target, ".quality", "reports");
  try {
    const { result } = captureStderr(() =>
      runDockerWrapper([target, "--scope", "full", "--mode", "quick", "--image", "example/sidecar:test", "--no-pull"], process.env, fakeRunner(true, 2))
    );
    assert.equal(result, 2);
  } finally {
    unlock(reportsDir);
  }
});

function writeFakeDocker(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "version") { console.log("28.1.1"); process.exit(0); }
if (args[0] === "image") process.exit(0);
if (args[0] === "run") {
  const suffix = ":/workspace/.quality/reports";
  const mount = args.find((arg) => arg.endsWith(suffix));
  const dir = mount.slice(0, -suffix.length);
  fs.mkdirSync(dir, { recursive: true });
  const json = path.join(dir, "quality-report.json");
  const md = path.join(dir, "quality-report.md");
  fs.writeFileSync(json, ${JSON.stringify(JSON.stringify(approvedReport()))});
  fs.writeFileSync(md, "# Quality Gate Report\\n\\nStatus: APPROVED\\n");
  fs.chmodSync(json, 0o444);
  fs.chmodSync(md, 0o444);
  process.exit(0);
}
process.exit(3);
`;
  const file = path.join(binDir, "docker");
  fs.writeFileSync(file, script, { mode: 0o755 });
}

test("B3: quality-gate exits 0 with APPROVED over read-only container reports", { skip: SKIP }, () => {
  const { temp, target } = sampleTarget();
  const binDir = path.join(temp, "bin");
  writeFakeDocker(binDir);
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
  const direct = spawnSync(process.execPath, [QUALITY_BIN, target, "--scope", "full", "--mode", "quick", "--image", "example/sidecar:test", "--no-pull", "--no-start-docker"], { env, encoding: "utf8" });
  assert.equal(direct.status, 0, direct.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(target, ".quality", "reports", "quality-report.json"), "utf8"));
  assert.equal(report.status, "APPROVED");
  assert.equal(report.score.value, 100);
});
