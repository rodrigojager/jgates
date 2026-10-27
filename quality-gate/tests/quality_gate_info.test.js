"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { runDockerWrapper, packageVersion } = require("../bin/quality-gate.js");

const BIN = path.resolve(__dirname, "..", "bin", "quality-gate.js");
const POSIX = process.platform !== "win32";

// A runtime that fails the test the moment anything calls it: info commands must never reach the container runtime.
function forbiddenRunner(calls) {
  return (command, args) => {
    calls.push([command, ...args]);
    throw new Error(`the container runtime must not be called: ${command} ${args.join(" ")}`);
  };
}

function captureConsole(fn) {
  const logs = [];
  const original = console.log;
  console.log = (...parts) => logs.push(parts.join(" "));
  try {
    return { code: fn(), logs };
  } finally {
    console.log = original;
  }
}

for (const argv of [["--version"], ["--help"], ["-h"], ["--version", "--build"], ["--help", "--pull"]]) {
  test(`quality-gate ${argv.join(" ")} does not call Docker or build an image (in process)`, () => {
    const calls = [];
    const starts = [];
    const { code, logs } = captureConsole(() =>
      runDockerWrapper(argv, {}, forbiddenRunner(calls), (...args) => {
        starts.push(args);
        throw new Error("the Docker daemon must not be started");
      })
    );
    assert.equal(code, 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(starts, []);
    assert.ok(logs.join("\n").length > 0);
  });
}

test("quality-gate --version prints the package version", () => {
  const { logs } = captureConsole(() => runDockerWrapper(["--version"], {}, forbiddenRunner([])));
  assert.deepEqual(logs, [packageVersion()]);
  assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
});

test("quality-gate --version and --help run the real binary with a fake docker that fails if called", { skip: POSIX ? false : "the fake runtime is a shell script (POSIX only)" }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "quality-gate-info-"));
  try {
    const marker = path.join(temp, "docker-called");
    const bin = path.join(temp, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "docker"), `#!/bin/sh\necho "$@" >> '${marker}'\nexit 1\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    delete env.QUALITY_GATE_NO_START_DOCKER;
    delete env.QUALITY_GATE_NO_BUILD;
    for (const flag of ["--version", "--help"]) {
      const result = spawnSync(process.execPath, [BIN, flag], { env, encoding: "utf8", cwd: temp });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.trim().length > 0, flag);
      assert.equal(fs.existsSync(marker), false, `${flag} called docker`);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
