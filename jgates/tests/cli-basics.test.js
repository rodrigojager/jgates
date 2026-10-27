import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(here, "..", "dist", "cli", "main.js");
const rootVersion = JSON.parse(fs.readFileSync(path.resolve(here, "..", "..", "package.json"), "utf8")).version;

function jgates(args, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-home-"));
  try {
    return spawnSync(process.execPath, [MAIN, ...args], {
      encoding: "utf8",
      env: { ...process.env, JGATES_HOME: home, ...env },
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("--version prints the root package.json version", () => {
  const r = jgates(["--version"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), new RegExp(`${rootVersion.replace(/\./g, "\\.")}$`));
});

test("help --json prints one JSON document listing the commands found in the folder", () => {
  const r = jgates(["help", "--json"]);
  assert.equal(r.status, 0);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.status, "OK");
  assert.equal(doc.version, rootVersion);
  assert.ok(doc.commands.some((c) => c.name === "help"));
  assert.equal(r.stderr, "");
});

test("help without --json prints readable text", () => {
  const r = jgates(["help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /jgates/);
});

test("unknown command with --json yields the structured error and exit 3", () => {
  const r = jgates(["comando-inexistente", "--json"]);
  assert.equal(r.status, 3);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.status, "ERROR");
  assert.equal(doc.error.code, "UNKNOWN_COMMAND");
  assert.ok(doc.error.message);
  assert.ok(doc.error.fix);
  assert.doesNotMatch(r.stderr, /\u001b\[/);
  assert.equal(r.stderr, "");
});

test("unknown flag yields the structured error and exit 3", () => {
  const r = jgates(["help", "--nao-existe", "--json"]);
  assert.equal(r.status, 3);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.error.code, "UNKNOWN_FLAG");
});

test("a command module dropped into a commands folder shows up in help --json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-cmds-"));
  try {
    fs.writeFileSync(
      path.join(dir, "hello.js"),
      'export const command = { name: "hello", description: "Say hello", options: [{ name: "who", type: "string", description: "Who" }], run(ctx) { ctx.stdout("hello\\n"); return 0; } };\n',
    );
    const help = jgates(["help", "--json"], { JGATES_EXTRA_COMMANDS_DIR: dir });
    assert.equal(help.status, 0);
    const hello = JSON.parse(help.stdout).commands.find((c) => c.name === "hello");
    assert.ok(hello);
    assert.equal(hello.options[0].name, "--who");
    const run = jgates(["hello", "--who", "x"], { JGATES_EXTRA_COMMANDS_DIR: dir });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "hello\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
