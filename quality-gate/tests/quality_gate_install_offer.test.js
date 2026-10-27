"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { pythonCommand, missingLocalTools, runDockerWrapper } = require("../bin/quality-gate.js");

// The local sidecar (no Docker) ended without a tool: on a terminal the wrapper offers to install it through
// `jgates doctor --fix` or to try Docker; anywhere else the exit code is the one of today, plus the hint. Everything is
// a fake runner: nothing is installed, no Docker, no network.

const temps = [];
test.after(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

function sample() {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "quality-gate-offer-")));
  temps.push(temp);
  const target = path.join(temp, "target");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "sample.js"), "const value = 1;\n", "utf8");
  const bin = path.join(temp, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "jgates"), "#!/bin/sh\n", { mode: 0o755 });
  return { temp, target, bin };
}

/** A runner: Docker is down; the sidecar misses gitleaks until jgates doctor ran. */
function fakeRunner(s, { doctorStatus = 0, dockerUp = false } = {}) {
  const calls = [];
  let fixed = false;
  const runner = (command, args) => {
    calls.push([command, args]);
    if (command === "docker" && args[0] === "version") return dockerUp ? { status: 0, stdout: "27.0.0\n" } : { status: 1, stdout: "", stderr: "down" };
    if (command === "docker") return { status: 0 };
    if (path.basename(command) === "jgates") {
      if (doctorStatus === 0) fixed = true;
      return { status: doctorStatus };
    }
    if (args[0] === "-m" && args[1] === "quality_sidecar") {
      const reports = path.join(s.target, ".quality", "reports");
      fs.mkdirSync(reports, { recursive: true });
      const tools = fixed ? [{ name: "gitleaks", status: "completed" }] : [{ name: "gitleaks", status: "missing" }];
      fs.writeFileSync(path.join(reports, "quality-report.json"), JSON.stringify({ tools }));
      return { status: fixed ? 0 : 2 };
    }
    return { status: 3 };
  };
  return { runner, calls };
}

const ARGS = (s) => [s.target, "--scope", "full", "--no-start-docker"];
const sidecarCalls = (calls) => calls.filter(([, args]) => args[0] === "-m" && args[1] === "quality_sidecar");

test("interactive: choosing to install runs jgates doctor --fix and the local sidecar again", () => {
  const s = sample();
  const { runner, calls } = fakeRunner(s);
  const questions = [];
  const env = { ...process.env, PATH: s.bin };
  const code = runDockerWrapper(ARGS(s), env, runner, undefined, { interactive: true, ask: (q) => (questions.push(q), "i") });
  assert.equal(code, 0);
  assert.equal(questions.length, 1);
  assert.match(questions[0], /doctor --fix/);
  assert.match(questions[0], /Docker/);
  const doctor = calls.find(([command]) => path.basename(command) === "jgates");
  assert.deepEqual(doctor[1].slice(0, 2), ["doctor", "--fix"]);
  assert.equal(sidecarCalls(calls).length, 2);
});

test("interactive: choosing Docker tries it; with the daemon still down the result stays as it was", () => {
  const s = sample();
  const { runner, calls } = fakeRunner(s);
  const code = runDockerWrapper([...ARGS(s), "--docker-start-timeout-ms", "1"], { ...process.env, PATH: s.bin }, runner, () => ({ ok: true }), { interactive: true, ask: () => "d" });
  assert.equal(code, 2);
  assert.equal(sidecarCalls(calls).length, 1);
  assert.equal(calls.some(([command]) => path.basename(command) === "jgates"), false);
});

test("interactive: a no leaves the exit code of today and installs nothing", () => {
  const s = sample();
  const { runner, calls } = fakeRunner(s);
  const code = runDockerWrapper(ARGS(s), { ...process.env, PATH: s.bin }, runner, undefined, { interactive: true, ask: () => "n" });
  assert.equal(code, 2);
  assert.equal(calls.some(([command]) => path.basename(command) === "jgates"), false);
});

test("not interactive (--ci, --no-interactive or no terminal): no question, the error of today and the hint", () => {
  for (const extra of [["--ci"], ["--no-interactive"], []]) {
    const s = sample();
    const { runner, calls } = fakeRunner(s);
    const messages = [];
    const original = console.error;
    console.error = (...a) => messages.push(a.join(" "));
    let code;
    try {
      code = runDockerWrapper([...ARGS(s), ...extra], { ...process.env, PATH: s.bin }, runner, undefined, {
        ...(extra.length === 0 ? { interactive: false } : {}),
        ask: () => assert.fail("must not ask"),
      });
    } finally {
      console.error = original;
    }
    assert.equal(code, 2, extra.join(" "));
    assert.ok(messages.some((m) => /jgates doctor --fix/.test(m)), extra.join(" "));
    assert.equal(calls.some(([command]) => path.basename(command) === "jgates"), false);
  }
});

test("the local Python is JGATES_PYTHON, then PYTHON, then the JGates environment, then the PATH", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "quality-gate-home-")));
  temps.push(home);
  const bin = path.join(home, "tools", "python", process.platform === "win32" ? "Scripts" : "bin");
  fs.mkdirSync(bin, { recursive: true });
  const own = path.join(bin, process.platform === "win32" ? "python.exe" : "python");
  fs.writeFileSync(own, "");
  const fallback = process.platform === "win32" ? "python" : "python3";
  assert.equal(pythonCommand({ JGATES_HOME: home }), own);
  assert.equal(pythonCommand({ JGATES_HOME: home, PYTHON: "/x/py" }), "/x/py");
  assert.equal(pythonCommand({ JGATES_HOME: home, PYTHON: "/x/py", JGATES_PYTHON: "/y/py" }), "/y/py");
  assert.equal(pythonCommand({ JGATES_HOME: path.join(home, "none") }), fallback);
});

test("missingLocalTools reads the tools with status missing from the report", () => {
  const s = sample();
  assert.deepEqual(missingLocalTools(path.join(s.temp, "nothing")), []);
  fs.writeFileSync(path.join(s.temp, "quality-report.json"), JSON.stringify({ tools: [{ name: "a", status: "missing" }, { name: "b", status: "completed" }] }));
  assert.deepEqual(missingLocalTools(s.temp), ["a"]);
});
