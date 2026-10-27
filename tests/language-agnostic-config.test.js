"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CLI = path.resolve(__dirname, "..", "quality-gate", "bin", "quality-gate.js");
const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(...parts), "utf8"));
const LOCAL_SIDECAR_ENV = {
  ...process.env,
  // These tests verify the bundled local sidecar. A CI host may already have
  // Docker, which would otherwise build/run the image and make the fixtures
  // depend on daemon availability and container-created file ownership.
  DOCKER_CONTEXT: "",
  DOCKER_HOST: "tcp://127.0.0.1:1",
  GITHUB_BASE_REF: "",
  GITHUB_HEAD_REF: "",
  GITHUB_SHA: "",
  GITLAB_CI: "",
  CI_MERGE_REQUEST_DIFF_BASE_SHA: "",
  CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "",
  CI_COMMIT_SHA: ""
};

test("quality-gate treats a quality rejection as a gate decision, not an operational error", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-decision-"));
  try {
    const init = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    fs.writeFileSync(path.join(root, "large.txt"), "one\ntwo\nthree\n", "utf8");

    const result = spawnSync(process.execPath, [
      CLI,
      ".",
      "--scope", "changed",
      "--max-file-lines", "2",
      "--mode", "quick",
      "--no-start-docker",
      "--output", ".quality/reports/rejected",
      "--json",
      "--no-interactive"
    ], { cwd: root, encoding: "utf8", env: LOCAL_SIDECAR_ENV });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^REJECTED score=/);
    const report = readJson(root, ".quality", "reports", "rejected", "quality-report.json");
    assert.equal(report.status, "REJECTED");
    assert.equal(report.metrics.budgets.maxFileLines, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("GitLab merge request range preserves diff budgets and report artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-gitlab-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    git("init");
    git("config", "user.name", "GitLab Test");
    git("config", "user.email", "gitlab@example.invalid");
    fs.writeFileSync(path.join(root, "app.txt"), "one\n", "utf8");
    git("add", ".");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    fs.writeFileSync(path.join(root, "app.txt"), "one\ntwo\nthree\n", "utf8");
    git("add", ".");
    git("commit", "-m", "feature");
    const head = git("rev-parse", "HEAD");

    const result = spawnSync(process.execPath, [
      CLI,
      ".",
      "--scope", "changed",
      "--max-changed-lines", "1",
      "--mode", "quick",
      "--no-start-docker",
      "--output", "quality-report-dir",
      "--json",
      "--no-interactive"
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...LOCAL_SIDECAR_ENV,
        CI: "true",
        GITLAB_CI: "true",
        CI_MERGE_REQUEST_DIFF_BASE_SHA: base,
        CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main",
        CI_COMMIT_SHA: head
      }
    });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^REJECTED score=/);
    const scope = JSON.parse(fs.readFileSync(path.join(root, "quality-report-dir", "quality-scope.json"), "utf8"));
    assert.equal(scope.diff.base, base);
    assert.equal(scope.diff.head, head);
    assert.equal(scope.diff.fileCount, 1);
    assert.ok(scope.diff.changedLines > 1);
    assert.ok(fs.existsSync(path.join(root, "quality-report-dir", "quality-report.json")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("policy-declared neutral evidence works end to end in an ignored directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-policy-e2e-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
  };
  try {
    git("init");
    git("config", "user.name", "Policy Test");
    git("config", "user.email", "policy@example.invalid");
    fs.writeFileSync(path.join(root, "app.txt"), "before\n", "utf8");
    fs.writeFileSync(path.join(root, ".quality-gate-policy.json"), JSON.stringify({
      schemaVersion: 1,
      evidence: {
        reports: [".quality/evidence/quality.json"],
        requiredMetrics: { "mutation.score": { min: 80 } }
      }
    }), "utf8");
    git("add", ".");
    git("commit", "-m", "base");
    fs.writeFileSync(path.join(root, "app.txt"), "before\nafter\n", "utf8");
    fs.mkdirSync(path.join(root, ".quality", "evidence"), { recursive: true });
    fs.writeFileSync(path.join(root, ".quality", "evidence", "quality.json"), JSON.stringify({
      schemaVersion: 1,
      metrics: { "mutation.score": 70 },
      checks: []
    }), "utf8");

    const result = spawnSync(process.execPath, [
      CLI,
      ".",
      "--scope", "changed",
      "--mode", "quick",
      "--no-start-docker",
      "--output", ".quality/reports/policy-e2e",
      "--json",
      "--no-interactive"
    ], { cwd: root, encoding: "utf8", env: LOCAL_SIDECAR_ENV });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^REJECTED score=/);
    const report = readJson(root, ".quality", "reports", "policy-e2e", "quality-report.json");
    assert.ok(report.findings.some((finding) => finding.rule === "evidence.metric.mutation.score"));
    const evidence = report.tools.find((tool) => tool.name === "quality-evidence");
    assert.equal(evidence.status, "findings");
    assert.equal(evidence.output_path.endsWith(".quality\\evidence\\quality.json") || evidence.output_path.endsWith(".quality/evidence/quality.json"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deletion-only changes still run diff budgets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-deletion-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
  };
  try {
    git("init");
    git("config", "user.name", "Deletion Test");
    git("config", "user.email", "deletion@example.invalid");
    fs.writeFileSync(path.join(root, "removed.txt"), "one\ntwo\nthree\n", "utf8");
    git("add", ".");
    git("commit", "-m", "base");
    fs.rmSync(path.join(root, "removed.txt"));

    const result = spawnSync(process.execPath, [
      CLI,
      ".",
      "--scope", "changed",
      "--max-changed-lines", "1",
      "--mode", "quick",
      "--no-start-docker",
      "--output", ".quality/reports/deletion",
      "--json",
      "--no-interactive"
    ], { cwd: root, encoding: "utf8", env: LOCAL_SIDECAR_ENV });

    assert.equal(result.status, 1, result.stderr);
    const scope = readJson(root, ".quality", "reports", "deletion", "quality-scope.json");
    assert.ok(scope.selectedFiles.includes("removed.txt"));
    const report = readJson(root, ".quality", "reports", "deletion", "quality-report.json");
    assert.equal(report.metrics.change.deletions, 3);
    assert.ok(report.findings.some((finding) => finding.rule === "budget.changed-lines"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
