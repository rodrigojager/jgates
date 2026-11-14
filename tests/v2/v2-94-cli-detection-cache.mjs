import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importDist, MAIN } from "./fixtures/sequence/helpers.mjs";

// V2-94: the detection of the agent CLIs is cached in the local server. The provider step of the Semantic setup
// (GET /api/providers/cli-status, the route both screens use) answers its second visit without starting any CLI; the
// button "Detectar de novo" (refresh=1) asks for all of them again, and a CLI installed in between appears; `checkedAt`
// does not move between two cached reads; `jgates providers` in the terminal still detects live. Every CLI is a stub on
// a temporary PATH: no real CLI runs and no login happens.

const WIN = process.platform === "win32";
const VARS = ["PATH", "Path", "HOME", "USERPROFILE", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"];

/** A stub CLI `name` in `dir`: a node script that logs every start (one line per process) and answers by argument line. */
function stubCli(dir, name, answers, log) {
  const script = path.join(dir, "node_modules", name, "cli.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(
    script,
    [
      `const key = process.argv.slice(2).join(" ");`,
      `require("node:fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + " " + key + "\\n");`,
      `const table = ${JSON.stringify(answers)};`,
      `const b = table[key];`,
      `if (!b) { process.stderr.write("unknown command " + key + "\\n"); process.exit(2); }`,
      `if (b.stdout) process.stdout.write(b.stdout);`,
      `process.exitCode = b.code ?? 0;`,
      "",
    ].join("\n"),
  );
  if (WIN) {
    fs.writeFileSync(path.join(dir, `${name}.cmd`), `@ECHO off\r\nnode "%dp0%\\node_modules\\${name}\\cli.js" %*\r\n`);
  } else {
    const bin = path.join(dir, name);
    fs.writeFileSync(bin, `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`);
    fs.chmodSync(bin, 0o755);
  }
}

const runs = (log) => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("V2-94: the provider step opened twice starts no CLI the second time; Detectar de novo detects again; the terminal command stays live", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-v2-94-"));
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  try {
    const bin = path.join(root, "bin");
    const home = path.join(root, "home");
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const log = path.join(root, "starts.log");
    stubCli(bin, "claude", { "--version": { stdout: "2.1.321 (Claude Code)\n" }, "auth status": { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) } }, log);
    stubCli(bin, "codex", { "--version": { stdout: "codex-cli 0.167.0\n" }, "login status": { stdout: "Logged in using ChatGPT\n" }, "debug models": { stdout: JSON.stringify({ models: [{ slug: "gpt-listed", visibility: "list" }] }) } }, log);

    const env = { PATH: bin, Path: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD", HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"), XDG_CONFIG_HOME: path.join(home, ".config") };
    if (WIN) {
      for (const k of ["SYSTEMROOT", "SystemRoot", "ComSpec", "TEMP", "TMP", "WINDIR"]) if (process.env[k]) env[k] = process.env[k];
      env.PATH = env.Path = `${bin};${path.join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32")}`;
    }
    for (const k of VARS) process.env[k] = env[k];

    const { routes } = await importDist("server", "routes", "providers.js");
    const { clearCliStatusCache } = await importDist("core", "providers", "cli-status.js");
    const status = routes.find((r) => r.method === "GET" && r.path === "/api/providers/cli-status");
    clearCliStatusCache();
    // The provider step asks once per visit: ?models=1.
    const visit = async (query = { models: "1" }) => {
      const started = Date.now();
      const answer = await status.handler({ query });
      return { json: answer.json, ms: Date.now() - started };
    };
    const byId = (answer) => Object.fromEntries(answer.json.providers.map((p) => [p.id, p]));

    // First visit: cold, the CLIs run.
    const first = await visit();
    const afterFirst = runs(log).length;
    assert.ok(afterFirst >= 5, `the first visit detected the CLIs (${afterFirst} processes)`);
    assert.equal(byId(first)["gemini-cli"].installed, false);

    // Second visit: no CLI process at all, answered within the time of a cached read, the same checkedAt.
    const second = await visit();
    assert.equal(runs(log).length, afterFirst, "the second visit started no CLI process");
    assert.ok(second.ms < 250, `a cached read answers at once (${second.ms} ms)`);
    for (const id of Object.keys(byId(first))) assert.equal(byId(second)[id].checkedAt, byId(first)[id].checkedAt, `${id}: checkedAt does not change between two cached reads`);
    await sleep(20);
    const third = await visit();
    assert.deepEqual(third.json.providers, second.json.providers, "a third read is the same answer");

    // A CLI is installed in between: nothing shows until "Detectar de novo".
    stubCli(bin, "gemini", { "--version": { stdout: "0.9.1\n" } }, log);
    assert.equal(byId(await visit())["gemini-cli"].installed, false, "a visit does not detect again on its own");
    assert.equal(runs(log).length, afterFirst, "still no process");
    const detected = await visit({ models: "1", refresh: "1" });
    assert.ok(runs(log).length > afterFirst + 4, "Detectar de novo started the CLIs again");
    assert.equal(byId(detected)["gemini-cli"].installed, true, "the CLI installed in between appears");
    assert.equal(byId(detected)["gemini-cli"].version, "0.9.1");
    assert.notEqual(byId(detected)["codex-cli"].checkedAt, byId(first)["codex-cli"].checkedAt, "the detection has a new time");
    const afterDetect = runs(log).length;
    assert.equal(byId(await visit())["gemini-cli"].installed, true, "the next visit reads the new detection from the cache");
    assert.equal(runs(log).length, afterDetect);

    // jgates providers detects live: each invocation starts the CLIs, whatever a server cache holds.
    const cliRun = () => {
      const result = spawnSync(process.execPath, [MAIN, "providers", "list", "--json"], { encoding: "utf8", env: { ...env, JGATES_HOME: path.join(root, "jgates-home"), SEMANTIC_GATE_HOME: path.join(root, "sg-home") }, input: "", timeout: 120_000 });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      return JSON.parse(result.stdout);
    };
    const beforeCli = runs(log).length;
    const one = cliRun();
    const afterOne = runs(log).length;
    assert.ok(afterOne > beforeCli, "jgates providers started the CLIs although the server cache was warm");
    cliRun();
    assert.ok(runs(log).length > afterOne, "and again on the next invocation");
    assert.ok(one.cli.some((p) => p.id === "gemini-cli" && p.installed === true));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
