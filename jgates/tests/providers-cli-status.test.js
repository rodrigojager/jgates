import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The agent CLIs (claude-code, codex-cli, opencode, gemini-cli): installed, logged in, models, the login terminal and
// the project's provider saved in jgates.yml. Every CLI here is a stub on a temporary PATH: no real CLI runs, no login
// happens, and no terminal is opened (the spawner is replaced). The real homes are never read: HOME, USERPROFILE,
// CODEX_HOME, CLAUDE_CONFIG_DIR and XDG_CONFIG_HOME point at temporary folders.

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, "..", "dist");
const mod = (p) => import(pathToFileURL(path.join(DIST, p)).href);
const WIN = process.platform === "win32";

const cleanups = [];
test.after(() => {
  for (const fn of cleanups.reverse()) fn();
});
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/**
 * A stub CLI named `name` in `dir`: a node script whose behaviour per argument line is `behaviour` ({ "auth status":
 * { stdout, stderr, code } | "hang" }). On Windows it is an npm-style .cmd shim (so the shim path is exercised), on
 * POSIX an executable script with node in the shebang.
 */
function stubCli(dir, name, behaviour, logFile) {
  const script = path.join(dir, "node_modules", name, "cli.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(
    script,
    [
      `const table = ${JSON.stringify(behaviour)};`,
      `const key = process.argv.slice(2).join(" ");`,
      // Every start of the stub is recorded (one line per process), so a test can count the processes.
      logFile ? `require("node:fs").appendFileSync(${JSON.stringify(logFile)}, ${JSON.stringify(name)} + " " + key + "\\n");` : "",
      `const b = table[key];`,
      `if (b === "hang") { setInterval(() => {}, 1000); }`,
      `else if (!b) { process.stderr.write("unknown command " + key + "\\n"); process.exit(2); }`,
      `else { if (b.stdout) process.stdout.write(b.stdout); if (b.stderr) process.stderr.write(b.stderr); process.exitCode = b.code ?? 0; }`,
      "",
    ].join("\n"),
  );
  if (WIN) {
    fs.writeFileSync(path.join(dir, `${name}.cmd`), `@ECHO off\r\nnode "%dp0%\\node_modules\\${name}\\cli.js" %*\r\n`);
    // The extensionless sh script and the .ps1 of an npm shim are present too and must be skipped.
    fs.writeFileSync(path.join(dir, name), "#!/bin/sh\nexit 99\n");
    fs.writeFileSync(path.join(dir, `${name}.ps1`), "exit 99\n");
  } else {
    const bin = path.join(dir, name);
    fs.writeFileSync(bin, `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`);
    fs.chmodSync(bin, 0o755);
  }
}

/** An environment with only the stub folder on PATH and temporary homes. */
function stubEnv(bin) {
  const home = tmp("jgates-cli-home-");
  const env = { PATH: bin, Path: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD", HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"), XDG_CONFIG_HOME: path.join(home, ".config") };
  if (WIN) {
    for (const k of ["SYSTEMROOT", "SystemRoot", "ComSpec", "TEMP", "TMP", "WINDIR"]) if (process.env[k]) env[k] = process.env[k];
    // taskkill lives in System32.
    env.PATH = env.Path = `${bin};${path.join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32")}`;
  }
  return { env, home };
}

const CLAUDE_OK = { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "someone@example.com", orgId: "x" }, null, 2), code: 0 };

test("installed, missing and hanging CLIs: path, version, login state, all bounded in time", async () => {
  const { cliProvidersStatus, clearCliStatusCache } = await mod("core/providers/cli-status.js");
  clearCliStatusCache();
  const bin = tmp("jgates-cli-bin-");
  stubCli(bin, "claude", { "--version": { stdout: "2.1.321 (Claude Code)\n" }, "auth status": CLAUDE_OK });
  stubCli(bin, "codex", { "--version": { stdout: "codex-cli 0.167.0\n" }, "login status": { stderr: "Not logged in\n", code: 1 }, "debug models": { stdout: JSON.stringify({ models: [{ slug: "gpt-listed", visibility: "list" }, { slug: "gpt-hidden", visibility: "hide" }] }) } });
  stubCli(bin, "opencode", { "--version": { stdout: "v2.2.5\n" }, "auth list": "hang", models: { stdout: "openai/gpt-x\nopenrouter/~anthropic/claude-latest\n" } });
  const { env, home } = stubEnv(bin);
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), '# my config\nmodel = "gpt-configured"\n\n[profiles.other]\nmodel = "not-this"\n');

  const started = Date.now();
  const report = await cliProvidersStatus({ env, timeoutMs: 2_500, modelsTimeoutMs: 5_000 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 12_000, `bounded in time even with a hanging CLI (${elapsed} ms)`);
  const by = Object.fromEntries(report.providers.map((p) => [p.id, p]));
  assert.deepEqual(Object.keys(by).sort(), ["claude-code", "codex-cli", "gemini-cli", "opencode"]);

  // claude: installed with its path and version, logged in (method only; the email never comes back).
  assert.equal(by["claude-code"].installed, true);
  assert.ok(by["claude-code"].path.startsWith(bin), by["claude-code"].path);
  if (WIN) assert.match(by["claude-code"].path, /claude\.cmd$/i, "the .cmd shim, not the extensionless script nor the .ps1");
  assert.equal(by["claude-code"].version, "2.1.321");
  assert.deepEqual(by["claude-code"].login, { state: "logged-in", reason: "STATUS_COMMAND", method: "claude.ai", checkedWith: "claude auth status" });
  assert.doesNotMatch(JSON.stringify(report), /someone@example\.com/);
  assert.deepEqual(by["claude-code"].models.list.slice(0, 3), ["sonnet", "opus", "haiku"]);
  assert.equal(by["claude-code"].models.source, "suggested");

  // codex: not logged in (stderr, exit 1); models from `codex debug models` plus the model of its config.toml, first.
  assert.equal(by["codex-cli"].version, "0.167.0");
  assert.equal(by["codex-cli"].login.state, "not-logged-in");
  assert.deepEqual(by["codex-cli"].loginCommand, { command: "codex", args: ["login"], display: "codex login" });
  assert.deepEqual(by["codex-cli"].models.list, ["gpt-configured", "gpt-listed"]);
  assert.equal(by["codex-cli"].models.configured, "gpt-configured");
  assert.equal(by["codex-cli"].models.configuredIn, path.join(home, ".codex", "config.toml"));
  assert.equal(by["codex-cli"].models.suggestedDefault, "gpt-configured");

  // opencode: its status command hangs: unknown with TIMEOUT; its models come from `opencode models`.
  assert.deepEqual([by.opencode.login.state, by.opencode.login.reason], ["unknown", "TIMEOUT"]);
  assert.deepEqual(by.opencode.models.list, ["openai/gpt-x", "openrouter/~anthropic/claude-latest"]);
  assert.equal(by.opencode.models.source, "cli");
  assert.equal(by.opencode.models.suggestedDefault, null);

  // gemini: missing.
  assert.deepEqual([by["gemini-cli"].installed, by["gemini-cli"].path, by["gemini-cli"].login.reason], [false, null, "NOT_INSTALLED"]);
  assert.equal(by["gemini-cli"].install, "npm install -g @google/gemini-cli");
});

test("login parsing: claude JSON and text, codex text, opencode lists, gemini by credential presence only", async () => {
  const m = await mod("core/providers/cli-status.js");
  const r = (stdout, extra = {}) => ({ code: 0, stdout, stderr: "", timedOut: false, error: null, ...extra });
  assert.equal(m.parseClaudeStatus(r('{"loggedIn": false}', { code: 1 })).state, "not-logged-in");
  assert.deepEqual(m.parseClaudeStatus(r(CLAUDE_OK.stdout)), { state: "logged-in", reason: "STATUS_COMMAND", method: "claude.ai" });
  assert.equal(m.parseClaudeStatus(r("Not logged in. Run claude auth login.", { code: 1 })).state, "not-logged-in");
  assert.equal(m.parseClaudeStatus(r("", { timedOut: true, code: null })).reason, "TIMEOUT");
  assert.deepEqual(m.parseCodexStatus(r("", { stderr: "Logged in using ChatGPT\n" })), { state: "logged-in", reason: "STATUS_COMMAND", method: "ChatGPT" });
  assert.equal(m.parseCodexStatus(r("Logged in using an API key - sk-proj-***abc")).method, null, "a label with odd characters is dropped");
  assert.equal(m.parseCodexStatus(r("\u001b[31mNot logged in\u001b[0m", { code: 1 })).state, "not-logged-in");
  assert.deepEqual(m.parseCodexStatus(r("something else")), { state: "unknown", reason: "UNRECOGNIZED_OUTPUT", method: null });
  assert.equal(m.parseCodexStatus(r("", { error: "spawn ENOENT", code: null })).reason, "COMMAND_FAILED");
  const listed = "\u250c  Credentials ~/.local/share/opencode/auth.json\n\u2502\n\u25cf  Anthropic oauth\n\u2502\n\u2514  1 credentials\n";
  assert.equal(m.parseOpencodeStatus(r(listed)).state, "logged-in");
  assert.equal(m.parseOpencodeStatus(r("OpenAI            OpenAI                      stored\n")).state, "logged-in");
  assert.equal(m.parseOpencodeStatus(r("\u250c  Credentials ~/x/auth.json\n\u2502\n\u2514  0 credentials\n")).state, "not-logged-in");
  assert.equal(m.parseVersion("opencode v2.2.5"), "2.2.5");
  assert.equal(m.codexConfigModel('model_provider = "x"\nmodel = \'gpt-a\' # mine\n'), "gpt-a");
  assert.equal(m.codexConfigModel('[profiles.x]\nmodel = "gpt-b"\n'), null, "only the top-level model");
  assert.deepEqual(m.parseCodexModels("not json"), null);

  // gemini: no status command. A key variable or the OAuth credential file present means logged in; never its content.
  const home = tmp("jgates-gemini-home-");
  const env = { HOME: home, USERPROFILE: home };
  assert.deepEqual([m.geminiLogin(env).state, m.geminiLogin(env).reason], ["unknown", "NO_CREDENTIAL_FOUND"]);
  fs.mkdirSync(path.join(home, ".gemini"));
  const creds = path.join(home, ".gemini", "oauth_creds.json");
  fs.writeFileSync(creds, "SECRET-TOKEN-NEVER-READ");
  const g = m.geminiLogin(env);
  assert.deepEqual([g.state, g.reason], ["logged-in", "CREDENTIAL_FILE"]);
  assert.doesNotMatch(JSON.stringify(g), /SECRET-TOKEN/);
  assert.equal(m.geminiLogin({ ...env, GEMINI_API_KEY: "value-not-shown" }).reason, "KEY_VARIABLE");
  assert.doesNotMatch(JSON.stringify(m.geminiLogin({ ...env, GEMINI_API_KEY: "value-not-shown" })), /value-not-shown/);
  fs.writeFileSync(path.join(home, ".gemini", "settings.json"), JSON.stringify({ model: { name: "gemini-pro-x" } }));
  assert.equal(m.configuredModel("gemini-cli", env).model, "gemini-pro-x");
});

test("a status command never gets a user string: arguments are constants and an odd one is refused", async () => {
  const { spawnPlan } = await mod("core/providers/cli-status.js");
  assert.throws(() => spawnPlan("/usr/bin/codex", ["login", "status & calc"], "linux"));
  assert.throws(() => spawnPlan("C:\\x%PATH%\\codex.bat", ["login"], "win32"), /refused path/, "a .bat that is no npm shim goes through cmd.exe, and a path cmd.exe would expand is refused");
  const plain = spawnPlan("C:\\Tools\\codex.bat", ["login", "status"], "win32", { ComSpec: "C:\\Windows\\system32\\cmd.exe" });
  assert.deepEqual(plain, { program: "C:\\Windows\\system32\\cmd.exe", args: ["/d", "/s", "/c", '""C:\\Tools\\codex.bat" login status"'], verbatim: true });
});

test("the login terminal: one plan per platform, the CLI's own login command, a stubbed spawner", async () => {
  const { openLoginTerminal, terminalPlan, cliSpec } = await mod("core/providers/cli-status.js");
  const calls = [];
  const spawner = async (program, args, options) => {
    calls.push({ program, args, verbatim: options.verbatim });
  };
  const win = await openLoginTerminal("codex-cli", { platform: "win32", env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" }, spawner });
  assert.deepEqual([win.opened, win.method, win.command.display], [true, "windows-start", "codex login"]);
  assert.deepEqual(calls[0], { program: "C:\\Windows\\system32\\cmd.exe", args: ["/d", "/c", "start", '"JGates - Codex CLI login"', "cmd.exe", "/k", "codex login"], verbatim: true });

  const mac = await openLoginTerminal("claude-code", { platform: "darwin", env: {}, spawner });
  assert.equal(mac.method, "macos-terminal");
  assert.equal(calls[1].program, "osascript");
  assert.match(calls[1].args[1], /do script "claude auth login"/);

  // Linux: the first terminal found on PATH; none: nothing is spawned and the command is returned to copy.
  const bin = tmp("jgates-term-bin-");
  const term = path.join(bin, "gnome-terminal");
  fs.writeFileSync(term, "#!/bin/sh\n");
  if (!WIN) fs.chmodSync(term, 0o755);
  if (!WIN) {
    const linux = await openLoginTerminal("opencode", { platform: "linux", env: { PATH: bin }, spawner });
    assert.deepEqual([linux.method, calls[2].program, calls[2].args], ["gnome-terminal", "gnome-terminal", ["--", "opencode", "auth", "login"]]);
  }
  const before = calls.length;
  const none = await openLoginTerminal("gemini-cli", { platform: "linux", env: { PATH: tmp("jgates-empty-") }, spawner });
  assert.deepEqual([none.opened, none.reason, none.command.display], [false, "NO_TERMINAL", "gemini"]);
  assert.equal(calls.length, before);
  assert.equal(terminalPlan(cliSpec("gemini-cli"), "linux", { PATH: "" }), null);

  const failing = await openLoginTerminal("codex-cli", { platform: "win32", env: {}, spawner: async () => { throw new Error("ENOENT"); } });
  assert.deepEqual([failing.opened, failing.reason], [false, "SPAWN_FAILED"]);
});

test("the routes: GET /api/providers/cli-status and POST /api/providers/:name/login (stubbed CLIs and spawner)", async () => {
  const { routes } = await mod("server/routes/providers.js");
  const { setTerminalSpawner, clearCliStatusCache } = await mod("core/providers/cli-status.js");
  const status = routes.find((r) => r.method === "GET" && r.path === "/api/providers/cli-status");
  const login = routes.find((r) => r.method === "POST" && r.path === "/api/providers/:name/login");
  assert.ok(status.timeoutMs >= 20_000, "the handler limit covers a model listing");
  const bin = tmp("jgates-cli-route-");
  stubCli(bin, "codex", { "--version": { stdout: "codex-cli 0.167.0\n" }, "login status": { stdout: "Logged in using ChatGPT\n" }, "debug models": { stdout: '{"models":[]}' } });
  const { env } = stubEnv(bin);
  const saved = { PATH: process.env.PATH, Path: process.env.Path, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    setTerminalSpawner(null);
  };
  try {
    for (const k of Object.keys(saved)) process.env[k] = env[k];
    clearCliStatusCache();
    const answer = await status.handler({ query: { only: "codex-cli" } });
    assert.equal(answer.status, 200);
    assert.equal(answer.json.providers.length, 1);
    const codex = answer.json.providers[0];
    assert.deepEqual([codex.id, codex.installed, codex.version, codex.login.state, codex.login.method], ["codex-cli", true, "0.167.0", "logged-in", "ChatGPT"]);
    assert.equal(codex.models.problem, "UNRECOGNIZED_OUTPUT", "an empty listing is reported, not hidden");
    const fast = await status.handler({ query: { models: "0" } });
    assert.ok(fast.json.providers.every((p) => p.models === null));

    const calls = [];
    setTerminalSpawner(async (program, args) => {
      calls.push([program, ...args].join(" "));
    });
    const server = { policyMode: false, log() {} };
    const opened = await login.handler({ params: { name: "codex-cli" }, server });
    assert.deepEqual([opened.status, opened.json.opened, opened.json.command.display], [200, true, "codex login"]);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /codex login/);
    await assert.rejects(login.handler({ params: { name: "claude-code" }, server }), (e) => e.code === "CLI_NOT_INSTALLED" && e.status === 409);
    await assert.rejects(login.handler({ params: { name: "openai" }, server }), (e) => e.code === "NOT_A_CLI_PROVIDER" && e.status === 404);
    process.env.JGATES_POLICY_DIR = tmp("jgates-policy-");
    await assert.rejects(login.handler({ params: { name: "codex-cli" }, server }), (e) => e.code === "GOVERNED_LOCKED");
    assert.equal(calls.length, 1, "nothing spawned when refused");
  } finally {
    delete process.env.JGATES_POLICY_DIR;
    restore();
  }
});

test("saving the project's provider patches jgates.yml > extensions.semantic-gate, keeps comments, honors the revision and the governed lock", async () => {
  const { routes } = await mod("server/routes/semantic.js");
  const { buildSemanticPlan } = await mod("core/semantic/plan.js");
  const view = routes.find((r) => r.method === "GET" && r.path === "/api/semantic");
  const save = routes.find((r) => r.method === "PUT" && r.path === "/api/config/semantic/provider");
  const dir = tmp("jgates-semantic-provider-");
  const file = path.join(dir, "jgates.yml");
  const original = "# Configuração do projeto: não apague este comentário.\nschemaVersion: 1\nselection:\n  profile: minimal # inline comment\n";
  fs.writeFileSync(file, original);
  const server = { projectDir: dir, log() {} };
  const home = tmp("jgates-semantic-home-");
  const env = { ...process.env, JGATES_HOME: home };

  const before = buildSemanticPlan({ workspacePath: dir, env, home });
  assert.ok(before.blockers.some((b) => b.code === "SEMANTIC_NOT_CONFIGURED"));

  const revision = (await view.handler({ server })).json.form.revision;
  await assert.rejects(async () => save.handler({ server, body: { expectedRevision: "0".repeat(64), provider: "codex-cli", model: "gpt-6.1-terra" } }), (e) => e.code === "REVISION_CONFLICT");
  await assert.rejects(async () => save.handler({ server, body: { expectedRevision: revision, provider: "no-such-provider", model: null } }), (e) => e.code === "UNKNOWN_PROVIDER");
  assert.equal(fs.readFileSync(file, "utf8"), original, "nothing written by a refused save");

  const saved = await save.handler({ server, body: { expectedRevision: revision, provider: "codex-cli", model: "gpt-6.1-terra" } });
  assert.equal(saved.json.save.status, "saved");
  assert.deepEqual(saved.json.save.changes.sort(), ["model", "provider"]);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.startsWith("# Configuração do projeto: não apague este comentário.\n"), text);
  assert.match(text, /profile: minimal # inline comment/);
  assert.match(text, /extensions:\n\s+semantic-gate:\n\s+provider: codex-cli\n\s+model: gpt-6.1-terra/);
  assert.equal(saved.json.semantic.state, "configured");
  assert.equal(saved.json.semantic.provider, "codex-cli");
  const after = buildSemanticPlan({ workspacePath: dir, env, home });
  assert.ok(!after.blockers.some((b) => b.code === "SEMANTIC_NOT_CONFIGURED"), JSON.stringify(after.blockers));

  // An alias becomes the provider id; model null removes the project's model; enabled: false is turned on.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("    provider: codex-cli\n", "    enabled: false\n    provider: codex-cli\n"));
  const rev2 = (await view.handler({ server })).json.form.revision;
  const second = await save.handler({ server, body: { expectedRevision: rev2, provider: "claude", model: null } });
  const text2 = fs.readFileSync(file, "utf8");
  assert.match(text2, /provider: anthropic/);
  assert.doesNotMatch(text2, /model:/);
  assert.match(text2, /enabled: true/);
  assert.equal(second.json.semantic.provider, "anthropic");

  // The governed mode refuses the write.
  process.env.JGATES_POLICY_DIR = tmp("jgates-policy-");
  try {
    const rev3 = (await view.handler({ server })).json.form.revision;
    await assert.rejects(async () => save.handler({ server, body: { expectedRevision: rev3, provider: "opencode", model: null } }), (e) => e.code === "GOVERNED_LOCKED");
  } finally {
    delete process.env.JGATES_POLICY_DIR;
  }
});

// ---- the detection cache (DC1) ----------------------------------------------------------------------------------------

const STUB_VARS = ["PATH", "Path", "HOME", "USERPROFILE", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** How many stub processes of `name` ran (every line of the log is one start), optionally only for one argument line. */
const starts = (log, name, args) => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n") : []).filter((l) => (args === undefined ? l.startsWith(`${name} `) : l === `${name} ${args}`)).length;

test("the route answers from the detection cache: one start of the CLIs for two requests, refresh and only=<id> replace entries, the login drops one", async () => {
  const { routes } = await mod("server/routes/providers.js");
  const { setTerminalSpawner, clearCliStatusCache } = await mod("core/providers/cli-status.js");
  const status = routes.find((r) => r.method === "GET" && r.path === "/api/providers/cli-status");
  const login = routes.find((r) => r.method === "POST" && r.path === "/api/providers/:name/login");
  const bin = tmp("jgates-cli-cache-");
  const log = path.join(bin, "starts.log");
  stubCli(bin, "claude", { "--version": { stdout: "2.1.321 (Claude Code)\n" }, "auth status": CLAUDE_OK }, log);
  stubCli(bin, "codex", { "--version": { stdout: "codex-cli 0.167.0\n" }, "login status": { stdout: "Logged in using ChatGPT\n" }, "debug models": { stdout: JSON.stringify({ models: [{ slug: "gpt-listed", visibility: "list" }] }) } }, log);
  const { env } = stubEnv(bin);
  const saved = Object.fromEntries(STUB_VARS.map((k) => [k, process.env[k]]));
  try {
    for (const k of STUB_VARS) process.env[k] = env[k];
    clearCliStatusCache();
    const by = (answer) => Object.fromEntries(answer.json.providers.map((p) => [p.id, p]));

    const first = await status.handler({ query: {} });
    const afterFirst = starts(log, "claude") + starts(log, "codex");
    assert.ok(afterFirst >= 5, "the first request started the stubs: version and status of both, the model listing of codex");
    assert.equal(starts(log, "codex", "debug models"), 1, "the model listing is part of the same detection");
    const firstBy = by(first);
    for (const id of ["claude-code", "codex-cli", "opencode", "gemini-cli"]) assert.match(firstBy[id].checkedAt, /^\d{4}-\d\d-\d\dT/, `${id} carries its checkedAt`);
    assert.deepEqual(firstBy["codex-cli"].models.list, ["gpt-listed"]);

    // A second request, whole or with the models: no process at all, the same checkedAt, the same models.
    const second = await status.handler({ query: {} });
    assert.equal(starts(log, "claude") + starts(log, "codex"), afterFirst, "the second request starts no CLI");
    assert.deepEqual(second.json.providers, first.json.providers);
    const fast = await status.handler({ query: { models: "0" } });
    assert.ok(fast.json.providers.every((p) => p.models === null), "models=0 leaves the listings out of a cached answer");
    assert.equal(fast.json.providers.find((p) => p.id === "codex-cli").checkedAt, firstBy["codex-cli"].checkedAt);
    assert.equal(starts(log, "codex", "debug models"), 1, "the model list did not run again (no 60-second cache of its own)");

    // refresh=1 detects all of them again and replaces the entries.
    await sleep(15);
    const refreshed = await status.handler({ query: { refresh: "1" } });
    assert.equal(starts(log, "claude") + starts(log, "codex"), afterFirst * 2, "refresh=1 starts every CLI again");
    assert.notEqual(by(refreshed)["codex-cli"].checkedAt, firstBy["codex-cli"].checkedAt);
    const again = await status.handler({ query: {} });
    assert.deepEqual(again.json.providers, refreshed.json.providers, "the refreshed entries are what the cache holds now");

    // only=<id>&refresh=1 replaces one entry and leaves the others.
    await sleep(15);
    const total = starts(log, "claude") + starts(log, "codex");
    const claudeRuns = starts(log, "claude");
    const one = await status.handler({ query: { only: "codex-cli", refresh: "1" } });
    assert.equal(one.json.providers.length, 1);
    assert.equal(starts(log, "claude"), claudeRuns, "claude is untouched");
    assert.equal(starts(log, "claude") + starts(log, "codex"), total + 3, "only codex ran again: version, status, model listing");
    const all = by(await status.handler({ query: {} }));
    assert.equal(all["claude-code"].checkedAt, by(refreshed)["claude-code"].checkedAt, "the other entries were left alone");
    assert.equal(all["codex-cli"].checkedAt, one.json.providers[0].checkedAt);
    assert.notEqual(all["codex-cli"].checkedAt, by(refreshed)["codex-cli"].checkedAt);

    // The login route drops that CLI's entry: the next request detects only that CLI again.
    setTerminalSpawner(async () => {});
    const claudeBefore = starts(log, "claude");
    const codexBefore = starts(log, "codex");
    const loginAnswer = await login.handler({ params: { name: "codex-cli" }, server: { policyMode: false, log() {} } });
    assert.equal(loginAnswer.json.opened, true);
    await sleep(15);
    const afterLogin = by(await status.handler({ query: {} }));
    assert.equal(starts(log, "claude"), claudeBefore, "claude's entry stayed");
    assert.equal(starts(log, "codex"), codexBefore + 3, "codex was detected again after its login terminal opened");
    assert.notEqual(afterLogin["codex-cli"].checkedAt, all["codex-cli"].checkedAt);
    assert.equal(afterLogin["claude-code"].checkedAt, all["claude-code"].checkedAt);
  } finally {
    setTerminalSpawner(null);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("a detection that hangs or fails is never cached, and two requests at once start the CLIs once", async () => {
  const { cachedCliProvidersStatus, clearCliStatusCache } = await mod("core/providers/cli-status.js");
  clearCliStatusCache();
  const bin = tmp("jgates-cli-nocache-");
  const log = path.join(bin, "starts.log");
  // claude: its status command hangs (TIMEOUT). codex: its model listing fails (COMMAND_FAILED). opencode: answers fully.
  stubCli(bin, "claude", { "--version": { stdout: "2.1.321 (Claude Code)\n" }, "auth status": "hang" }, log);
  stubCli(bin, "codex", { "--version": { stdout: "codex-cli 0.167.0\n" }, "login status": { stdout: "Logged in using ChatGPT\n" }, "debug models": { stderr: "boom\n", code: 3 } }, log);
  stubCli(bin, "opencode", { "--version": { stdout: "v2.2.5\n" }, "auth list": { stdout: "1 credentials\n" }, models: { stdout: "openai/gpt-x\n" } }, log);
  const { env } = stubEnv(bin);
  const options = { env, timeoutMs: 1_500, modelsTimeoutMs: 5_000 };

  const first = await cachedCliProvidersStatus(options);
  const by = Object.fromEntries(first.providers.map((p) => [p.id, p]));
  assert.equal(by["claude-code"].login.reason, "TIMEOUT");
  assert.equal(by["codex-cli"].models.problem, "COMMAND_FAILED");
  const claudeRuns = starts(log, "claude");
  const codexRuns = starts(log, "codex");
  const opencodeRuns = starts(log, "opencode");
  await cachedCliProvidersStatus(options);
  assert.equal(starts(log, "claude"), claudeRuns * 2, "a CLI whose status hung is detected again");
  assert.equal(starts(log, "codex"), codexRuns * 2, "a CLI whose model listing failed is detected again");
  assert.equal(starts(log, "opencode"), opencodeRuns, "a CLI that answered stays cached");

  // Two requests at once on a cold cache share one detection.
  clearCliStatusCache();
  const before = starts(log, "opencode");
  const [a, b] = await Promise.all([cachedCliProvidersStatus({ ...options, only: ["opencode"] }), cachedCliProvidersStatus({ ...options, only: ["opencode"] })]);
  assert.equal(starts(log, "opencode"), before + opencodeRuns, "one detection, not two");
  assert.equal(a.providers[0].checkedAt, b.providers[0].checkedAt);
});

test("jgates providers detects live: cliProvidersStatus ignores the cache", async () => {
  const { cachedCliProvidersStatus, cliProvidersStatus, clearCliStatusCache } = await mod("core/providers/cli-status.js");
  clearCliStatusCache();
  const bin = tmp("jgates-cli-live-");
  const log = path.join(bin, "starts.log");
  stubCli(bin, "opencode", { "--version": { stdout: "v2.2.5\n" }, "auth list": { stdout: "1 credentials\n" }, models: { stdout: "openai/gpt-x\n" } }, log);
  const { env } = stubEnv(bin);
  await cachedCliProvidersStatus({ env, only: ["opencode"] });
  const warm = starts(log, "opencode");
  await cliProvidersStatus({ env, only: ["opencode"], models: false });
  assert.ok(starts(log, "opencode") > warm, "the live detection started the CLI although the cache is warm");
});
