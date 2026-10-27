import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(here, "..", "dist", "cli", "main.js");
const home = await import(pathToFileURL(path.resolve(here, "..", "dist", "core", "home", "index.js")).href);

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("two workspaces get distinct folders and workspaces list --json shows both", () => {
  const h = tmp("jg-home-");
  const a = tmp("jg-ws-a-");
  const b = tmp("jg-ws-b-");
  try {
    const env = { ...process.env, JGATES_HOME: h };
    for (const p of [a, b]) {
      const r = spawnSync(process.execPath, [MAIN, "workspaces", "add", p, "--json"], { encoding: "utf8", env });
      assert.equal(r.status, 0, r.stderr);
    }
    const r = spawnSync(process.execPath, [MAIN, "workspaces", "list", "--json"], { encoding: "utf8", env });
    assert.equal(r.status, 0);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.workspaces.length, 2);
    const ids = new Set(doc.workspaces.map((w) => w.id));
    assert.equal(ids.size, 2);
    for (const w of doc.workspaces) {
      assert.ok(w.path && w.name && w.lastAccess);
      for (const d of ["runs", "cache", "drafts", "snapshots", "locks"]) {
        assert.ok(fs.statSync(path.join(h, "workspaces", w.id, d)).isDirectory());
      }
    }
    assert.deepEqual(new Set(doc.workspaces.map((w) => w.name)), new Set([path.basename(fs.realpathSync(a)), path.basename(fs.realpathSync(b))]));
  } finally {
    for (const d of [h, a, b]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("registering the same workspace twice keeps one entry and refreshes last access", () => {
  const h = tmp("jg-home-");
  const a = tmp("jg-ws-");
  try {
    const first = home.registerWorkspace(a, { home: h, now: new Date("2026-01-01T00:00:00Z") });
    const second = home.touchWorkspace(a, { home: h, now: new Date("2026-02-01T00:00:00Z") });
    assert.equal(first.id, second.id);
    assert.equal(home.listWorkspaces(h).length, 1);
    assert.equal(home.listWorkspaces(h)[0].lastAccess, "2026-02-01T00:00:00.000Z");
    const run = home.createRunDir(h, first.id, "run_x");
    assert.equal(run, path.join(h, "workspaces", first.id, "runs", "run_x"));
    assert.ok(fs.statSync(run).isDirectory());
  } finally {
    for (const d of [h, a]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("without JGATES_HOME the Linux path follows XDG_STATE_HOME and defaults to ~/.local/state/jgates", () => {
  const fakeHome = tmp("jg-fakehome-");
  const xdg = tmp("jg-xdg-");
  try {
    assert.equal(home.resolveHome({ platform: "linux", env: { HOME: fakeHome, XDG_STATE_HOME: xdg } }), path.join(xdg, "jgates"));
    assert.equal(home.resolveHome({ platform: "linux", env: { HOME: fakeHome } }), path.join(fakeHome, ".local", "state", "jgates"));
    const env = { ...process.env, HOME: fakeHome, XDG_STATE_HOME: xdg };
    delete env.JGATES_HOME;
    const r = spawnSync(process.execPath, [MAIN, "workspaces", "list", "--json"], { encoding: "utf8", env });
    assert.equal(JSON.parse(r.stdout).home, process.platform === "win32" ? JSON.parse(r.stdout).home : path.join(xdg, "jgates"));
  } finally {
    for (const d of [fakeHome, xdg]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("macOS and JGATES_HOME resolution", () => {
  assert.equal(home.resolveHome({ platform: "darwin", env: {}, homedir: "/Users/u" }), "/Users/u/Library/Application Support/jgates");
  const h = tmp("jg-home-");
  try {
    assert.equal(home.resolveHome({ env: { JGATES_HOME: h } }), h);
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test("data folders are owner-only (0700) on POSIX", { skip: process.platform === "win32" ? "POSIX permission modes do not apply on Windows" : false }, () => {
  const parent = tmp("jg-parent-");
  const h = path.join(parent, "nested", "jgates");
  const a = tmp("jg-ws-");
  try {
    const e = home.registerWorkspace(a, { home: h });
    for (const d of [h, path.join(h, "workspaces"), path.join(h, "workspaces", e.id), path.join(h, "workspaces", e.id, "runs")]) {
      assert.equal(fs.statSync(d).mode & 0o777, 0o700, d);
    }
    assert.equal(fs.statSync(path.join(h, "workspaces.json")).mode & 0o077, 0);
  } finally {
    for (const d of [parent, a]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("Windows default path is %LOCALAPPDATA%\\jgates", { skip: process.platform !== "win32" ? "default Windows path is exercised only on Windows" : false }, () => {
  const r = home.resolveHome({ env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, platform: "win32" });
  assert.equal(r, "C:\\Users\\u\\AppData\\Local\\jgates");
});
