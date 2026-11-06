import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// What the first run on Windows exposed, kept true on every system: the environment a child gets (the user's
// site-packages through APPDATA), the reason a detector died, a repository Git refused, the project's tests that ran
// twice in the bridge, and the bridge's scanners in the sidecar image when the host does not have them. Every case
// here is a pure function: no Docker, no Git repository and no Windows machine are needed to run it.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (...p) => pathToFileURL(path.resolve(here, "..", "dist", ...p)).href;
const runner = await import(dist("core", "runner", "index.js"));
const { probeEnv } = await import(dist("core", "runner", "probe-env.js"));
const { gitProblem } = await import(dist("core", "snapshot", "git.js"));
const bridge = await import(dist("adapters", "quality-bridge", "index.js"));

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const t = (key, params = {}) => `${key}:${JSON.stringify(params)}`;

test("the runner's environment keeps APPDATA and LOCALAPPDATA (Windows), which are absent and skipped elsewhere", () => {
  assert.ok(runner.DEFAULT_ENV_ALLOWLIST.includes("APPDATA"));
  assert.ok(runner.DEFAULT_ENV_ALLOWLIST.includes("LOCALAPPDATA"));
  const env = runner.buildEnv({ env: {} }, { parentEnv: { PATH: "/usr/bin", HOME: "/home/u", SECRET_TOKEN: "x" } });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH"], "Linux keeps exactly the variables it had");
  const win = runner.buildEnv({ env: {} }, { parentEnv: { PATH: "C:\\bin", APPDATA: "C:\\Users\\u\\AppData\\Roaming", SECRET_TOKEN: "x" } });
  assert.equal(win.APPDATA, "C:\\Users\\u\\AppData\\Roaming");
  assert.equal(win.SECRET_TOKEN, undefined);
});

test("a probe environment is unchanged on Linux and macOS and gains the Windows essentials on Windows", () => {
  const parent = { PATH: "p", HOME: "h", SYSTEMROOT: "C:\\Windows", APPDATA: "C:\\A", SECRET_TOKEN: "x" };
  assert.deepEqual(probeEnv(parent, { PATH: "p" }, "linux"), { PATH: "p" });
  assert.deepEqual(probeEnv(parent, { PATH: "p" }, "darwin"), { PATH: "p" });
  const win = probeEnv(parent, { PATH: "p" }, "win32");
  assert.equal(win.SYSTEMROOT, "C:\\Windows");
  assert.equal(win.APPDATA, "C:\\A");
  assert.equal(win.PATH, "p");
  assert.equal(win.SECRET_TOKEN, undefined);
});

test("the reason a child died is its exception line only, never the rest of its stderr", () => {
  const traceback = 'Traceback (most recent call last):\n  File "x.py", line 1\n    import defusedxml\nModuleNotFoundError: No module named \'defusedxml\'\n';
  assert.equal(runner.exceptionLine(traceback), "ModuleNotFoundError: No module named 'defusedxml'");
  assert.equal(runner.exceptionLine("some output\nwith CPF 123.456.789-09\n"), null);
  assert.equal(runner.exceptionLine("Error: spawn failed\r\n"), "Error: spawn failed");
  assert.equal(runner.exceptionLine("x".repeat(10)), null);
});

test("a repository Git refused is told apart from a folder without a repository, in any language of Git", () => {
  const plain = tmp("jg-git-none-");
  assert.equal(gitProblem("fatal: not a git repository (or any of the parent directories): .git\n", plain), null);

  const repo = tmp("jg-git-repo-");
  fs.mkdirSync(path.join(repo, ".git"));
  const dubious = [
    "fatal: detected dubious ownership in repository at 'D:/p'",
    "'D:/p' is owned by:",
    "        BUILTIN/Administradores (S-1-5-32-544)",
    "To add an exception for this directory, call:",
    "",
    "        git config --global --add safe.directory D:/p",
  ].join("\n");
  const unsafe = gitProblem(dubious, repo);
  assert.equal(unsafe?.code, "UNSAFE_REPOSITORY");
  assert.equal(unsafe?.fix, "git config --global --add safe.directory D:/p");
  assert.match(unsafe?.message ?? "", /dubious ownership/);

  const other = gitProblem("fatal: index file corrupt\n", path.join(repo));
  assert.equal(other?.code, "GIT_ERROR");
  assert.equal(other?.fix, null);
});

test("a test adapter replaces the bridge's project tests and coverage, so the project's tests never run twice", () => {
  const bridgePairs = [
    { subcheck: "project-tests", capability: "unit" },
    { subcheck: "coverage", capability: "coverage" },
    { subcheck: "jscpd", capability: "duplication" },
  ];
  const active = [
    { tool: "pytest", adapter: "pytest", capability: "unit" },
    { tool: "pytest", adapter: "pytest", capability: "coverage" },
  ];
  const out = bridge.supersededPairs(bridgePairs, active);
  assert.deepEqual([...out.keys()].sort(), ["coverage#coverage", "project-tests#unit"]);
  assert.deepEqual(out.get("project-tests#unit").by, ["pytest#unit"]);
  // Without a test adapter, the bridge keeps them.
  assert.equal(bridge.supersededPairs(bridgePairs, []).size, 0);
  // A Vitest instance replaces them as well.
  assert.equal(bridge.supersededPairs(bridgePairs, [{ tool: "vitest-web", adapter: "vitest", capability: "unit" }]).size, 1);
});

const request = (extra = {}) => ({
  schemaVersion: 1,
  target: path.resolve("/work/project"),
  outputDir: path.resolve("/runs/r1/outputs/quality-bridge"),
  mode: "full",
  subchecks: ["file-size", "megalinter", "semgrep", "gitleaks", "project-tests"],
  ...extra,
});
const facts = (extra = {}) => ({ setting: "auto", missing: ["megalinter", "semgrep"], external: ["megalinter", "semgrep", "gitleaks"], runtime: "docker", daemon: true, imageId: "sha256:" + "ab".repeat(32), ...extra });

test("the bridge's scanners go to the sidecar image only when the host lacks one and the image is there", () => {
  assert.equal(bridge.decideRunner(request(), facts(), t, "qg").kind, "container");
  assert.deepEqual(bridge.decideRunner(request(), facts(), t, "qg").external, ["megalinter", "semgrep", "gitleaks"]);
  // Every scanner on the host: local, as before.
  assert.equal(bridge.decideRunner(request(), facts({ missing: [] }), t, "qg").kind, "local");
  // JGATES_BRIDGE_RUNNER=local, a governed request, or a reduced mode: always local.
  assert.equal(bridge.decideRunner(request(), facts({ setting: "local" }), t, "qg").kind, "local");
  assert.equal(bridge.decideRunner(request({ hardened: true }), facts(), t, "qg").kind, "local");
  assert.equal(bridge.decideRunner(request({ mode: "quick" }), facts(), t, "qg").kind, "local");
  // JGATES_BRIDGE_RUNNER=container: the image even when the host has every scanner.
  assert.equal(bridge.decideRunner(request(), facts({ setting: "container", missing: [] }), t, "qg").kind, "container");
  // No image, or no Docker: local, with the reason for the missing scanners.
  const noImage = bridge.decideRunner(request(), facts({ imageId: null }), t, "qg");
  assert.equal(noImage.kind, "local");
  assert.match(noImage.hint, /^bridge_image_missing:/);
  const noDocker = bridge.decideRunner(request(), facts({ daemon: false, imageId: null }), t, "qg");
  assert.match(noDocker.hint, /^bridge_docker_missing:/);
  assert.equal(bridge.runnerSetting({ JGATES_BRIDGE_RUNNER: "Container" }), "container");
  assert.equal(bridge.runnerSetting({}), "auto");
});

test("a split request: the host keeps the built-in subchecks, the container gets the scanners with its own paths", () => {
  const req = request({ toolConfigs: { gitleaks: path.resolve("/work/project/cfg/gitleaks.toml"), trivy: "trivy.yaml" }, projectTests: true, coverage: true });
  const ext = ["megalinter", "semgrep", "gitleaks"];
  assert.deepEqual(bridge.localPart(req, ext).subchecks, ["file-size", "project-tests"]);
  const box = bridge.containerPart(req, ext);
  assert.equal(box.target, "/workspace");
  assert.equal(box.outputDir, "/output");
  assert.deepEqual(box.subchecks, ext);
  assert.equal(box.projectTests, false);
  assert.equal(box.coverage, false);
  assert.equal(box.toolConfigs.gitleaks, "/workspace/cfg/gitleaks.toml");
  assert.equal(box.toolConfigs.trivy, "trivy.yaml");
});

test("the merged answer takes each subcheck from the part that ran it, counts a policy once and keeps the worst verdict", () => {
  const host = {
    schemaVersion: 1, ok: true, status: "APPROVED", exitCode: 0,
    subchecks: [{ id: "file-size", status: "findings", findings: 1 }, { id: "semgrep", status: "missing" }],
    report: {
      status: "APPROVED", score: { value: 94, threshold: 80, max: 100 },
      summary: { counts: { active: 1 }, reasons: [], toolErrors: [] },
      findings: [{ tool: "quality-budget", rule: "budget.file-lines", message: "long", severity: "medium" }],
      tools: [{ name: "semgrep", status: "missing" }],
    },
  };
  const box = {
    schemaVersion: 1, ok: true, status: "APPROVED", exitCode: 0,
    subchecks: [{ id: "file-size", status: "skipped" }, { id: "semgrep", status: "findings", findings: 1 }],
    report: {
      status: "APPROVED", score: { value: 80, threshold: 80, max: 100 },
      summary: { counts: { active: 2 }, reasons: ["x"], toolErrors: [] },
      findings: [
        { tool: "semgrep", rule: "subprocess-shell-true", message: "shell", severity: "high" },
        { tool: "quality-evidence", rule: "evidence.missing", message: "dup", severity: "high" },
      ],
      tools: [{ name: "semgrep", status: "findings" }, { name: "file-size", status: "skipped" }],
    },
  };
  const merged = bridge.mergeResponses(host, box, ["semgrep"]);
  assert.deepEqual(merged.subchecks.map((s) => `${s.id}:${s.status}`), ["file-size:findings", "semgrep:findings"]);
  assert.deepEqual(merged.report.findings.map((f) => f.tool), ["quality-budget", "semgrep"], "the container's policy finding is not counted twice");
  assert.deepEqual(merged.report.tools.map((x) => x.name), ["semgrep"]);
  assert.equal(merged.report.score.value, 74);
  assert.equal(merged.status, "REJECTED", "the merged score is below the threshold");
  assert.equal(merged.exitCode, 1);
  assert.equal(merged.report.summary.counts.active, 3);

  // A part that gave no answer: its subchecks are errors with the reason, the other part still counts.
  const failed = bridge.failedPart(["semgrep"], "sidecar container: spawn-failed: no docker");
  const partial = bridge.mergeResponses(host, failed, ["semgrep"]);
  assert.equal(partial.subchecks.find((s) => s.id === "semgrep").status, "error");
  assert.match(partial.subchecks.find((s) => s.id === "semgrep").error, /no docker/);
  assert.equal(partial.subchecks.find((s) => s.id === "file-size").status, "findings");
});

test("a missing scanner of a local answer carries the reason: no Docker, or the image to build", () => {
  const outcome = { kind: "response", interpreter: "python", exitCode: 2, stdout: "", stderr: "", durationMs: 1, response: { schemaVersion: 1, ok: true, status: "NEEDS_CHANGES", exitCode: 2, subchecks: [{ id: "semgrep", status: "missing", error: "Analyzer reported an operational error." }, { id: "file-size", status: "ok" }] } };
  const hinted = bridge.withMissingHint(outcome, ["semgrep"], "build the image");
  assert.equal(hinted.response.subchecks[0].error, "build the image");
  assert.equal(hinted.response.subchecks[1].error, undefined);
});

test("the container runner mounts a cache folder only when asked, writable and apart from the workspace", () => {
  const ws = tmp("jg-ws-");
  const cache = tmp("jg-cache-");
  const spec = { image: "sha256:" + "ab".repeat(32), command: ["bridge"], workspace: ws, user: "1000:1000" };
  assert.ok(!runner.buildContainerArgs(spec).args.some((a) => a.includes("dst=/cache")));
  const args = runner.buildContainerArgs({ ...spec, cacheDir: cache }).args;
  const mount = args.find((a) => a.includes("dst=/cache"));
  assert.ok(mount && !mount.includes("readonly"), mount);
  assert.ok(args.includes("--read-only"), "the root file system stays read-only");
});
