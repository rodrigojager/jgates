import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// PATH refresh of the long-running server: pure merge plus an injectable registry reader. The real registry and the
// real PATH are never touched: every call gets its own env object.

const here = path.dirname(fileURLToPath(import.meta.url));
const { mergePath, expandVars, refreshPath, resetPathRefreshCache } = await import(
  pathToFileURL(path.resolve(here, "..", "dist", "core", "env-refresh", "index.js")).href
);

test("mergePath keeps existing entries and order, appends new ones", () => {
  assert.equal(mergePath("C:\\a;C:\\b", ["C:\\c;C:\\d"], true), "C:\\a;C:\\b;C:\\c;C:\\d");
});

test("mergePath de-duplicates case-insensitively on Windows, case-sensitively elsewhere", () => {
  assert.equal(mergePath("C:\\Tools;C:\\b", ["c:\\tools\\;C:\\B;C:\\new"], true), "C:\\Tools;C:\\b;C:\\new");
  assert.equal(mergePath("/a:/b", ["/A:/b:/c"], false), "/a:/b:/A:/c");
});

test("expandVars expands %VAR% case-insensitively and leaves unknown ones", () => {
  assert.equal(expandVars("%UserProfile%\\bin;%NOPE%", { USERPROFILE: "C:\\Users\\x" }), "C:\\Users\\x\\bin;%NOPE%");
});

test("refreshPath expands variables in registry values and merges", () => {
  resetPathRefreshCache();
  const env = { Path: "C:\\old", SystemRoot: "C:\\Windows" };
  const reader = (hive) => (hive === "machine" ? "%SystemRoot%\\system32;C:\\old" : "C:\\userbin");
  assert.equal(refreshPath({ platform: "win32", env, reader, now: () => 1 }), true);
  assert.equal(env.Path, "C:\\old;C:\\Windows\\system32;C:\\userbin");
  assert.equal(env.PATH, env.Path);
});

test("refreshPath is a no-op outside Windows", () => {
  resetPathRefreshCache();
  const env = { PATH: "/usr/bin" };
  let calls = 0;
  assert.equal(refreshPath({ platform: "linux", env, reader: () => (calls++, "/x") }), false);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(calls, 0);
});

test("refreshPath reads the registry once per cache window", () => {
  resetPathRefreshCache();
  const env = { PATH: "C:\\a" };
  let calls = 0;
  const reader = () => (calls++, "C:\\b");
  let t = 1000;
  assert.equal(refreshPath({ platform: "win32", env, reader, now: () => t }), true);
  assert.equal(calls, 2);
  t += 1000;
  assert.equal(refreshPath({ platform: "win32", env, reader, now: () => t }), false);
  assert.equal(calls, 2);
  t += 6000;
  assert.equal(refreshPath({ platform: "win32", env, reader, now: () => t }), true);
  assert.equal(calls, 4);
  assert.equal(refreshPath({ platform: "win32", env, reader, now: () => t, force: true }), true);
});

test("a stub tool in a folder added to the user PATH is found after the refresh", () => {
  resetPathRefreshCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jg-pathrefresh-"));
  try {
    fs.writeFileSync(path.join(dir, "stubtool.cmd"), "@echo off\n");
    const env = { PATH: "C:\\nowhere" };
    const find = () => env.PATH.split(";").some((d) => fs.existsSync(path.join(d, "stubtool.cmd")));
    assert.equal(find(), false);
    refreshPath({ platform: "win32", env, reader: (h) => (h === "user" ? dir : null), now: () => 1 });
    assert.equal(find(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing reader leaves PATH untouched", () => {
  resetPathRefreshCache();
  const env = { PATH: "C:\\a" };
  refreshPath({ platform: "win32", env, reader: () => null, now: () => 1 });
  assert.equal(env.PATH, "C:\\a");
});
