"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  DEFAULT_IMAGE,
  parseArgs,
  buildDockerArgs,
  buildLocalSidecarArgs,
  commandLine,
  isDockerAvailable,
  ensureDockerAvailable,
  canBuildBundledImage,
  resolveGitRange,
  resolveScopeFiles,
  helpText,
  runDockerWrapper,
  writeEmptyQualityReport
} = require("../bin/quality-gate.js");

const createdTemps = [];

// Every sample target made below is removed when the file is done (the tests used to leave them in the temp folder).
test.after(() => {
  for (const temp of createdTemps) fs.rmSync(temp, { recursive: true, force: true });
});

function createSampleTarget(prefix = "quality-gate-wrapper-") {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTemps.push(temp);
  const target = path.join(temp, "target");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "sample.js"), "const value = 1;\n", "utf8");
  return target;
}

function dockerVersionResponse(attempt) {
  return attempt >= 2
    ? { status: 0, stdout: "28.1.1\n", stderr: "" }
    : { status: 1, stdout: "", stderr: "Docker unavailable" };
}

test("parseArgs keeps quality gate flags for the container", () => {
  const parsed = parseArgs([
    ".",
    "--threshold",
    "90",
    "--profile",
    "strict",
    "--allow-path",
    "samples/**",
    "--enable-secrets"
  ], {});

  assert.equal(parsed.target, ".");
  assert.equal(parsed.image, DEFAULT_IMAGE);
  assert.deepEqual(parsed.containerArgs, [
    "--threshold",
    "90",
    "--profile",
    "strict",
    "--allow-path",
    "samples/**",
    "--enable-secrets"
  ]);
});

test("parseArgs consumes wrapper-only flags", () => {
  const parsed = parseArgs([
    "src",
    "--scope",
    "paths",
    "--path",
    "src",
    "--exclude",
    "dist/**",
    "--image",
    "jgates/quality-sidecar:dev",
    "--pull",
    "--docker-arg",
    "--network=none",
    "--debug-docker",
    "--format",
    "json"
  ], {});

  assert.equal(parsed.target, "src");
  assert.equal(parsed.scope, "paths");
  assert.deepEqual(parsed.paths, ["src"]);
  assert.deepEqual(parsed.excludes, ["dist/**"]);
  assert.equal(parsed.image, "jgates/quality-sidecar:dev");
  assert.equal(parsed.pull, true);
  assert.equal(parsed.build, true);
  assert.equal(parsed.debugDocker, true);
  assert.deepEqual(parsed.dockerArgs, ["--network=none"]);
  assert.deepEqual(parsed.containerArgs, ["--format", "json"]);
});

test("parseArgs defaults to changed scope and supports json headless mode", () => {
  const parsed = parseArgs(["--json", "--no-interactive"], {});
  assert.equal(parsed.scope, "changed");
  assert.equal(parsed.json, true);
  assert.equal(parsed.noInteractive, true);
  assert.deepEqual(parsed.containerArgs, ["--format", "json"]);
});

test("parseArgs requires paths scope when --path is used", () => {
  assert.throws(() => parseArgs(["--scope", "changed", "--path", "src"], {}), /--path can only be used with --scope paths/);
  assert.throws(() => parseArgs(["--scope", "full", "--path", "src"], {}), /--path can only be used with --scope paths/);
});

test("resolveScopeFiles deduplicates ignore files and supports re-inclusion", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "quality-wrapper-ignore-"));
  try {
    fs.writeFileSync(path.join(temp, "kept.js"), "const kept = true;\n", "utf8");
    fs.writeFileSync(path.join(temp, "ignored.js"), "const ignored = true;\n", "utf8");
    fs.writeFileSync(path.join(temp, ".gitignore"), "ignored.js\n", "utf8");
    fs.writeFileSync(path.join(temp, ".quality-gate.ignore"), "ignored.js\n!ignored.js\n", "utf8");

    const result = resolveScopeFiles(temp, {
      scope: "full",
      paths: [],
      excludes: [],
      includes: [],
      ignoreFiles: [".quality-gate.ignore"]
    });

    assert.ok(result.ignoreFiles.includes(".gitignore"));
    assert.equal(result.ignoreFiles.filter((file) => file === ".quality-gate.ignore").length, 1);
    assert.ok(result.files.includes("ignored.js"));
    assert.ok(result.files.includes("kept.js"));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("resolveScopeFiles reads the shared .jgates.ignore file", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "quality-wrapper-shared-ignore-"));
  try {
    fs.writeFileSync(path.join(temp, "kept.js"), "const kept = true;\n", "utf8");
    fs.writeFileSync(path.join(temp, "generated.js"), "const generated = true;\n", "utf8");
    fs.writeFileSync(path.join(temp, ".jgates.ignore"), "generated.js\n", "utf8");

    const result = resolveScopeFiles(temp, { scope: "full", paths: [], excludes: [], includes: [], ignoreFiles: [] });

    assert.ok(result.ignoreFiles.includes(".jgates.ignore"));
    assert.ok(!result.files.includes("generated.js"));
    assert.ok(result.files.includes("kept.js"));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("resolveScopeFiles paths scope does not add support files outside selected paths", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "quality-wrapper-paths-"));
  try {
    fs.mkdirSync(path.join(temp, "docs"), { recursive: true });
    fs.writeFileSync(path.join(temp, "package.json"), "{\"name\":\"demo\"}\n", "utf8");
    fs.writeFileSync(path.join(temp, "docs", "a.md"), "# A\n", "utf8");

    const result = resolveScopeFiles(temp, {
      scope: "paths",
      paths: ["docs"],
      excludes: [],
      includes: [],
      ignoreFiles: []
    });

    assert.deepEqual(result.files, ["docs/a.md"]);
    assert.equal(result.files.includes("package.json"), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("help text documents ignore re-inclusion", () => {
  assert.match(helpText(), /supports !path re-inclusion/);
  assert.match(helpText(), /Add a path for scope=paths/);
  assert.match(helpText(), /Local fallback:/);
  assert.match(helpText(), /keeps full mode by default/);
  assert.match(helpText(), /explicitly to opt into a reduced-evidence scan/);
  assert.doesNotMatch(helpText(), /Limit changed\/full context/);
});

test("parseArgs normalizes PowerShell comma-expanded format values", () => {
  const parsed = parseArgs([".", "--format", "json md", "--threshold", "90"], {});
  assert.deepEqual(parsed.containerArgs, ["--format", "json,md", "--threshold", "90"]);

  const equalsParsed = parseArgs([".", "--format=json md"], {});
  assert.deepEqual(equalsParsed.containerArgs, ["--format=json,md"]);
});

test("parseArgs supports explicit build controls", () => {
  assert.equal(parseArgs(["--no-build"], {}).build, false);
  assert.equal(parseArgs(["--build"], { QUALITY_GATE_NO_BUILD: "1" }).build, true);
  assert.equal(parseArgs([], { QUALITY_GATE_AUTO_BUILD: "0" }).build, false);
  assert.equal(parseArgs(["--no-start-docker"], {}).startDocker, false);
  assert.equal(parseArgs(["--start-docker"], { QUALITY_GATE_NO_START_DOCKER: "1" }).startDocker, true);
  assert.equal(parseArgs(["--docker-start-timeout-ms", "5000"], {}).dockerStartTimeoutMs, 5000);
  assert.throws(() => parseArgs(["--docker-start-timeout-ms", "nope"], {}), /non-negative number/);
});

test("parseArgs rejects missing wrapper values except docker-arg dash values", () => {
  assert.throws(() => parseArgs(["--image", "--pull"], {}), /Missing value/);
  const parsed = parseArgs(["--docker-arg", "--network=none"], {});
  assert.deepEqual(parsed.dockerArgs, ["--network=none"]);
});

test("buildDockerArgs creates the expected sidecar invocation", () => {
  const targetPath = path.resolve("sample-project");
  const parsed = parseArgs(["sample-project", "--threshold", "90"], {});
  const dockerArgs = buildDockerArgs(parsed, targetPath);

  assert.deepEqual(dockerArgs.slice(0, 4), ["run", "--rm", "--user", "0"]);
  assert.ok(dockerArgs.includes("QUALITY_GATE_SCOPE=changed"));
  assert.ok(dockerArgs.includes(`${targetPath}:/workspace`));
  assert.ok(dockerArgs.includes(`${path.join(targetPath, ".quality", "reports")}:/workspace/.quality/reports`));
  assert.ok(dockerArgs.includes("--output"));
  assert.ok(dockerArgs.includes(".quality/reports"));
  assert.ok(dockerArgs.includes("--scope-manifest"));
  assert.ok(dockerArgs.includes(".quality/reports/quality-scope.json"));
  assert.deepEqual(dockerArgs.slice(-2), ["--threshold", "90"]);
});

test("buildLocalSidecarArgs creates the bundled Python sidecar invocation", () => {
  const targetPath = path.resolve("sample-project");
  const reportsPath = path.join(targetPath, ".quality", "reports");
  const parsed = parseArgs(["sample-project", "--threshold", "90"], {});
  const args = buildLocalSidecarArgs(parsed, targetPath, reportsPath);

  assert.deepEqual(args.slice(0, 4), ["-m", "quality_sidecar", "check", targetPath]);
  assert.ok(args.includes("--output"));
  assert.ok(args.includes(reportsPath));
  assert.ok(args.includes("--scope-manifest"));
  assert.ok(args.includes(path.join(reportsPath, "quality-scope.json")));
  assert.ok(args.includes("--mode"));
  assert.ok(args.includes("full"));
  assert.deepEqual(args.slice(-4), ["--threshold", "90", "--mode", "full"]);

  const explicitMode = buildLocalSidecarArgs(
    parseArgs(["sample-project", "--mode", "quick"], {}),
    targetPath,
    reportsPath
  );
  assert.equal(explicitMode.filter((arg) => arg === "--mode").length, 1);
  assert.ok(explicitMode.includes("quick"));

  const explicitOffline = buildLocalSidecarArgs(
    parseArgs(["sample-project", "--mode", "offline"], {}),
    targetPath,
    reportsPath
  );
  assert.equal(explicitOffline.filter((arg) => arg === "--mode").length, 1);
  assert.ok(explicitOffline.includes("offline"));
});

test("resolveGitRange prefers GitLab's exact merge request diff base SHA", () => {
  const parsed = parseArgs([], {
    GITLAB_CI: "true",
    CI_MERGE_REQUEST_DIFF_BASE_SHA: "abc123",
    CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main",
    CI_COMMIT_SHA: "def456"
  });
  assert.deepEqual(resolveGitRange(parsed), { base: "abc123", head: "def456" });
});

test("resolveGitRange uses explicit GitHub pull request refs", () => {
  const parsed = parseArgs([".", "--scope", "changed"], {
    GITHUB_BASE_REF: "main",
    GITHUB_SHA: "0123456789abcdef"
  });

  assert.deepEqual(resolveGitRange(parsed), {
    base: "origin/main",
    head: "0123456789abcdef"
  });
});

test("resolveGitRange rejects option-like, empty, and control-character refs before Git runs", () => {
  for (const args of [["--base=-c"], ["--base="], ["--head=bad\nref"]]) {
    assert.throws(
      () => resolveGitRange(parseArgs(args, {})),
      (error) => error.code === "INVALID_GIT_REF" && error.exitCode === 3 && error.details.commands.length === 0
    );
  }
  assert.throws(() => parseArgs(["--base", "--output=/tmp/report"], {}), /Missing value for --base/);
});

test("commandLine quotes paths with spaces for debug output", () => {
  const line = commandLine("docker", ["run", "-v", "C:\\Project Files:/workspace"]);
  assert.match(line, /^docker run -v "/);
  assert.match(line, /Project Files/);
});

test("isDockerAvailable validates server output", () => {
  assert.equal(
    isDockerAvailable({}, () => ({ status: 0, stdout: "28.1.1\n", stderr: "" })),
    true
  );
  assert.equal(
    isDockerAvailable({}, () => ({ status: 0, stdout: "", stderr: "Internal Server Error" })),
    false
  );
});

test("ensureDockerAvailable starts Docker and waits for readiness", () => {
  const parsed = parseArgs(["--docker-start-timeout-ms", "1"], {});
  let versionChecks = 0;
  const starts = [];
  const runner = (command, args) => {
    if (command === "docker" && args[0] === "version") {
      versionChecks += 1;
      return dockerVersionResponse(versionChecks);
    }
    return { status: 3 };
  };
  const starter = (command, args) => {
    starts.push([command, args]);
    return { status: 0 };
  };

  assert.equal(ensureDockerAvailable(parsed, {}, runner, starter), true);
  assert.equal(starts.length, 1);
  assert.equal(versionChecks >= 2, true);
});

test("runDockerWrapper propagates docker run exit code", () => {
  const target = createSampleTarget();
  const calls = [];
  const runner = (command, args, options) => {
    calls.push([command, args, options]);
    if (args[0] === "version") {
      return { status: 0, stdout: "28.1.1\n", stderr: "" };
    }
    if (args[0] === "image") {
      return { status: 0 };
    }
    if (args[0] === "run") {
      return { status: 7 };
    }
    return { status: 3 };
  };

  const exitCode = runDockerWrapper([target, "--scope", "full", "--image", "example/sidecar:test", "--threshold", "90"], process.env, runner);
  assert.equal(exitCode, 7);
  const runCall = calls.find(([, args]) => args[0] === "run");
  assert.ok(runCall);
  const dockerArgs = runCall[1];
  assert.deepEqual(dockerArgs.slice(0, 2), ["run", "--rm"]);
  assert.ok(dockerArgs.includes("example/sidecar:test"));
  assert.ok(dockerArgs.includes("--output"));
  assert.ok(dockerArgs.includes(".quality/reports"));
  assert.ok(dockerArgs.includes("--scope-manifest"));
  assert.ok(dockerArgs.includes(".quality/reports/quality-scope.json"));
  assert.deepEqual(dockerArgs.slice(-2), ["--threshold", "90"]);
  assert.ok(fs.existsSync(path.join(target, ".quality", "reports")));
});

test("runDockerWrapper builds bundled image when default image is missing", () => {
  const target = createSampleTarget();
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "version") {
      return { status: 0, stdout: "28.1.1\n", stderr: "" };
    }
    if (args[0] === "image") {
      return { status: 1 };
    }
    if (args[0] === "build") {
      return { status: 0 };
    }
    if (args[0] === "run") {
      return { status: 0 };
    }
    return { status: 3 };
  };

  const exitCode = runDockerWrapper([target, "--scope", "full", "--image", "example/sidecar:test"], process.env, runner);
  assert.equal(exitCode, 0);
  assert.ok(calls.some(([, args]) => args[0] === "build" && args.includes("example/sidecar:test")));
  assert.ok(calls.some(([, args]) => args[0] === "run"));
});

test("runDockerWrapper keeps full mode when Docker is unavailable", () => {
  const target = createSampleTarget("quality-gate-wrapper-local-");
  const calls = [];
  const runner = (command, args, options) => {
    calls.push([command, args, options]);
    if (command === "docker" && args[0] === "version") {
      return { status: 1, stdout: "", stderr: "Docker unavailable" };
    }
    if (args[0] === "-m" && args[1] === "quality_sidecar") {
      return { status: 0 };
    }
    return { status: 3 };
  };

  const exitCode = runDockerWrapper([target, "--scope", "full", "--threshold", "90", "--no-start-docker"], process.env, runner);
  assert.equal(exitCode, 0);
  assert.ok(calls.some(([command]) => command === "docker"));
  const localCall = calls.find(([, args]) => args[0] === "-m" && args[1] === "quality_sidecar");
  assert.ok(localCall);
  assert.ok(localCall[1].includes("--mode"));
  assert.ok(localCall[1].includes("full"));
  assert.equal(localCall[1].includes("offline"), false);
  assert.equal(localCall[2].env.QUALITY_GATE_SCOPE, "full");
});

test("runDockerWrapper reports an invalid Git range as an operational error", () => {
  const target = createSampleTarget("quality-gate-invalid-range-");
  const git = (...args) => spawnSync("git", args, { cwd: target, encoding: "utf8" });
  assert.equal(git("init").status, 0);
  assert.equal(git("config", "user.name", "Quality Test").status, 0);
  assert.equal(git("config", "user.email", "quality@example.invalid").status, 0);
  assert.equal(git("add", ".").status, 0);
  assert.equal(git("commit", "-m", "initial").status, 0);
  let runtimeCalled = false;
  const runner = () => {
    runtimeCalled = true;
    return { status: 0 };
  };

  try {
    const exitCode = runDockerWrapper([
      target,
      "--scope", "changed",
      "--base", "missing-base-ref",
      "--head", "HEAD",
      "--no-start-docker"
    ], {}, runner);
    assert.equal(exitCode, 3);
    assert.equal(runtimeCalled, false);
    const reports = path.join(target, ".quality", "reports");
    const scope = JSON.parse(fs.readFileSync(path.join(reports, "quality-scope.json"), "utf8"));
    const report = JSON.parse(fs.readFileSync(path.join(reports, "quality-report.json"), "utf8"));
    assert.equal(scope.schemaVersion, 1);
    assert.equal(scope.resolution.status, "error");
    assert.equal(scope.resolution.code, "GIT_SCOPE_RESOLUTION_FAILED");
    assert.equal(scope.diff.status, "error");
    assert.equal(report.status, "ERROR");
    assert.equal(report.exitCode, 3);
    assert.equal(report.error.code, "GIT_SCOPE_RESOLUTION_FAILED");
    assert.equal(report.score.value, null);
  } finally {
    fs.rmSync(path.dirname(target), { recursive: true, force: true });
  }
});

test("runDockerWrapper approves a genuinely empty valid Git range", () => {
  const target = createSampleTarget("quality-gate-empty-range-");
  const git = (...args) => spawnSync("git", args, { cwd: target, encoding: "utf8" });
  assert.equal(git("init").status, 0);
  assert.equal(git("config", "user.name", "Quality Test").status, 0);
  assert.equal(git("config", "user.email", "quality@example.invalid").status, 0);
  assert.equal(git("add", ".").status, 0);
  assert.equal(git("commit", "-m", "initial").status, 0);

  try {
    const exitCode = runDockerWrapper([
      target,
      "--scope", "changed",
      "--base", "HEAD",
      "--head", "HEAD",
      "--no-start-docker"
    ], {}, () => {
      throw new Error("Runtime must not run for an empty valid scope");
    });
    assert.equal(exitCode, 0);
    const reports = path.join(target, ".quality", "reports");
    const scope = JSON.parse(fs.readFileSync(path.join(reports, "quality-scope.json"), "utf8"));
    const report = JSON.parse(fs.readFileSync(path.join(reports, "quality-report.json"), "utf8"));
    assert.equal(scope.schemaVersion, 1);
    assert.equal(scope.resolution.status, "available");
    assert.equal(scope.diff.status, "available");
    assert.equal(report.status, "APPROVED");
    assert.equal(report.exitCode, 0);
  } finally {
    fs.rmSync(path.dirname(target), { recursive: true, force: true });
  }
});

test("runDockerWrapper starts Docker automatically before running the container", () => {
  const target = createSampleTarget("quality-gate-wrapper-start-docker-");
  let versionChecks = 0;
  const starts = [];
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, args]);
    if (command === "docker" && args[0] === "version") {
      versionChecks += 1;
      return dockerVersionResponse(versionChecks);
    }
    if (args[0] === "image") {
      return { status: 0 };
    }
    if (args[0] === "run") {
      return { status: 0 };
    }
    return { status: 3 };
  };
  const starter = (command, args) => {
    starts.push([command, args]);
    return { status: 0 };
  };

  const exitCode = runDockerWrapper([target, "--scope", "full", "--docker-start-timeout-ms", "1"], {}, runner, starter);
  assert.equal(exitCode, 0);
  assert.equal(starts.length, 1);
  assert.ok(calls.some(([, args]) => args[0] === "run"));
});

test("canBuildBundledImage validates packaged build context", () => {
  assert.equal(canBuildBundledImage(path.resolve(__dirname, "..")), true);
});

test("writeEmptyQualityReport creates scoped approved report", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "quality-empty-report-"));
  try {
    writeEmptyQualityReport(temp, {
      scope: "changed",
      files: [],
      fileCount: 0,
      ignoredCount: 0,
      ignoreFiles: [],
      commands: []
    }, { target: "." });
    const report = JSON.parse(fs.readFileSync(path.join(temp, "quality-report.json"), "utf8"));
    assert.equal(report.status, "APPROVED");
    assert.equal(report.scope.scope, "changed");
    assert.equal(report.scoreAppliesTo, "changed-files");
    assert.equal(report.findings.length, 0);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
