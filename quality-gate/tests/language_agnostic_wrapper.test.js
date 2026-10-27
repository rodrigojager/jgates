"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  parseArgs,
  resolveGitRange,
  resolveScopeFiles,
  normalizeInputFileArgs
} = require("../bin/quality-gate.js");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stderr}`);
}

function initRepository(root) {
  run("git", ["init"], root);
  run("git", ["config", "user.name", "Quality Test"], root);
  run("git", ["config", "user.email", "quality@example.invalid"], root);
}

test("parseArgs keeps explicit Git range out of sidecar passthrough", () => {
  const parsed = parseArgs([".", "--scope", "changed", "--base", "origin/main", "--head=feature"]);

  assert.equal(parsed.base, "origin/main");
  assert.equal(parsed.head, "feature");
  assert.equal(parsed.containerArgs.includes("--base"), false);
  assert.deepEqual(resolveGitRange(parsed), { base: "origin/main", head: "feature" });
});

test("changed scope records diff size, binaries, support files, and history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-metrics-"));
  try {
    initRepository(root);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture"}\n', "utf8");
    fs.writeFileSync(path.join(root, "src", "app.txt"), "first\n", "utf8");
    run("git", ["add", "."], root);
    run("git", ["commit", "-m", "initial"], root);

    fs.appendFileSync(path.join(root, "src", "app.txt"), "second\nthird\n", "utf8");
    fs.writeFileSync(path.join(root, "src", "new.txt"), "new\nlines\n", "utf8");
    fs.writeFileSync(path.join(root, "src", "asset.bin"), Buffer.from([0, 1, 2, 3]));

    const parsed = parseArgs([root, "--scope", "changed"]);
    const scope = resolveScopeFiles(root, parsed);

    assert.equal(scope.scope, "changed");
    assert.equal(scope.selectedFileCount, 3);
    assert.ok(scope.selectedFiles.includes("src/app.txt"));
    assert.ok(scope.supportFiles.includes("package.json"));
    assert.equal(scope.diff.status, "available");
    assert.ok(scope.diff.changedLines >= 4);
    assert.ok(scope.diff.patchBytes > 0);
    assert.equal(scope.diff.binaryFiles, 1);
    assert.equal(scope.history.status, "available");
    assert.equal(scope.history.files["src/app.txt"].commits, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit evidence is projected even when its directory is ignored", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-evidence-support-"));
  try {
    initRepository(root);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "reports"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "app.txt"), "before\n", "utf8");
    fs.writeFileSync(path.join(root, ".quality-gate.ignore"), "reports/\n", "utf8");
    run("git", ["add", "."], root);
    run("git", ["commit", "-m", "initial"], root);
    fs.appendFileSync(path.join(root, "src", "app.txt"), "after\n", "utf8");
    fs.writeFileSync(path.join(root, "reports", "evidence.json"), '{"schemaVersion":1}\n', "utf8");

    const absoluteEvidence = path.join(root, "reports", "evidence.json");
    const parsed = parseArgs([root, "--scope", "changed", "--evidence-report", absoluteEvidence]);
    parsed.containerArgs = normalizeInputFileArgs(parsed.containerArgs, root);
    const scope = resolveScopeFiles(root, parsed);

    assert.ok(scope.supportFiles.includes("reports/evidence.json"));
    assert.equal(scope.selectedFiles.includes("reports/evidence.json"), false);
    assert.deepEqual(parsed.containerArgs.slice(-2), ["--evidence-report", "reports/evidence.json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("evidence declared only in the policy is projected into changed scope", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-policy-support-"));
  try {
    initRepository(root);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "app.txt"), "before\n", "utf8");
    fs.writeFileSync(path.join(root, ".quality-gate-policy.json"), JSON.stringify({
      schemaVersion: 1,
      evidence: { reports: [".quality/evidence/quality.json"] }
    }), "utf8");
    run("git", ["add", "."], root);
    run("git", ["commit", "-m", "initial"], root);
    fs.appendFileSync(path.join(root, "src", "app.txt"), "after\n", "utf8");
    fs.mkdirSync(path.join(root, ".quality", "evidence"), { recursive: true });
    fs.writeFileSync(path.join(root, ".quality", "evidence", "quality.json"), '{"schemaVersion":1}\n', "utf8");

    const parsed = parseArgs([root, "--scope", "changed"]);
    const scope = resolveScopeFiles(root, parsed);

    assert.ok(scope.supportFiles.includes(".quality-gate-policy.json"));
    assert.ok(scope.supportFiles.includes(".quality/evidence/quality.json"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
