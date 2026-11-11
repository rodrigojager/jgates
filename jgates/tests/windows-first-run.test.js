import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// What the first run on Windows exposed, kept true on every system: the environment a child gets (the user's
// site-packages through APPDATA), the reason a detector died, a repository Git refused, the project's tests that ran
// twice in the bridge. Every case
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
