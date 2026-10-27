import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import YAML from "yaml";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(here, "..", "dist", "cli", "main.js");
const require = createRequire(import.meta.url);
const mainFixture = require("../../tests/fixtures/jgates/main-fixture.js");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-init-home-"));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function jgates(args) {
  const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: { ...process.env, JGATES_HOME: home } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const git = (dir, args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout;

function withFixture(fn) {
  const { dir } = mainFixture.createMainFixture();
  try {
    return fn(dir);
  } finally {
    mainFixture.removeFixture(dir);
  }
}

function snapshot(dir, files) {
  return Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(dir, f))]));
}

test("init --no-interactive --json creates a valid minimal configuration (fixture)", () => {
  withFixture((dir) => {
    const r = jgates(["init", "--cwd", dir, "--profile", "standard", "--no-interactive", "--json"]);
    assert.equal(r.code, 0, r.err + r.out);
    const out = JSON.parse(r.out);
    assert.equal(out.status, "OK");
    assert.deepEqual(out.created, ["jgates.yml", ".jgates/profiles.yml"]);
    assert.deepEqual([...out.templates].sort(), ["base", "python", "python-import-linter", "python-pytest", "typescript", "typescript-dependency-cruiser", "typescript-eslint", "typescript-vitest"]);

    const root = fs.readFileSync(path.join(dir, "jgates.yml"), "utf8");
    assert.match(root, /^# .+/);
    assert.match(root, /profile: standard/);
    assert.ok(fs.readFileSync(path.join(dir, ".jgates/profiles.yml"), "utf8").startsWith("# "));

    const validate = jgates(["config", "validate", "--cwd", dir, "--json"]);
    assert.equal(validate.code, 0, validate.out);
    assert.equal(JSON.parse(validate.out).valid, true);
    const resolve = jgates(["config", "resolve", "--cwd", dir, "--json"]);
    assert.equal(resolve.code, 0, resolve.out + resolve.err);
    for (const profile of ["minimal", "standard", "strict"]) {
      const r2 = jgates(["config", "resolve", "--cwd", dir, "--profile", profile, "--json"]);
      assert.equal(r2.code, 0, `${profile}: ${r2.out}${r2.err}`);
    }
  });
});

test("profiles.yml has minimal, standard and strict, each extending its starter profile", () => {
  withFixture((dir) => {
    assert.equal(jgates(["init", "--cwd", dir, "--no-interactive", "--json"]).code, 0);
    const doc = YAML.parse(fs.readFileSync(path.join(dir, ".jgates/profiles.yml"), "utf8"));
    assert.deepEqual(Object.keys(doc.profiles), ["minimal", "standard", "strict"]);
    for (const id of Object.keys(doc.profiles)) {
      assert.equal(doc.profiles[id].extends, `builtin:${id}`);
      assert.ok(doc.profiles[id].label);
    }
  });
});

test("init touches nothing but the configuration, no .gitignore, no provider", () => {
  withFixture((dir) => {
    const ignoreBefore = fs.existsSync(path.join(dir, ".gitignore")) ? fs.readFileSync(path.join(dir, ".gitignore")) : null;
    const statusBefore = git(dir, ["status", "--porcelain"]);
    assert.equal(jgates(["init", "--cwd", dir, "--no-interactive", "--json"]).code, 0);
    const added = git(dir, ["status", "--porcelain", "--untracked-files=all"])
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3))
      .sort();
    const before = statusBefore.split("\n").filter(Boolean).map((l) => l.slice(3));
    assert.deepEqual(
      added.filter((f) => !before.includes(f)),
      [".jgates/profiles.yml", "jgates.yml"],
    );
    const ignoreAfter = fs.existsSync(path.join(dir, ".gitignore")) ? fs.readFileSync(path.join(dir, ".gitignore")) : null;
    assert.deepEqual(ignoreAfter, ignoreBefore);
    const text = fs.readFileSync(path.join(dir, "jgates.yml"), "utf8") + fs.readFileSync(path.join(dir, ".jgates/profiles.yml"), "utf8");
    assert.doesNotMatch(text, /semantic|provider/i);
    assert.deepEqual(fs.readdirSync(path.join(dir, ".jgates")), ["profiles.yml"]);
  });
});

test("running init again exits 3 with error.fix and changes no byte", () => {
  withFixture((dir) => {
    assert.equal(jgates(["init", "--cwd", dir, "--no-interactive", "--json"]).code, 0);
    const files = ["jgates.yml", ".jgates/profiles.yml"];
    const before = snapshot(dir, files);
    const r = jgates(["init", "--cwd", dir, "--no-interactive", "--json"]);
    assert.equal(r.code, 3);
    const out = JSON.parse(r.out);
    assert.equal(out.error.code, "CONFIG_EXISTS");
    assert.ok(out.error.fix);
    assert.deepEqual(snapshot(dir, files), before);
  });
});

test("an existing fragment alone also blocks init and is left intact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-init-frag-"));
  try {
    fs.mkdirSync(path.join(dir, ".jgates"));
    fs.writeFileSync(path.join(dir, ".jgates", "policy.yml"), "schemaVersion: 1\n");
    const r = jgates(["init", "--cwd", dir, "--no-interactive", "--json"]);
    assert.equal(r.code, 3);
    assert.ok(JSON.parse(r.out).error.fix);
    assert.equal(fs.existsSync(path.join(dir, "jgates.yml")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without --profile init does not wait for input and uses standard; unknown profile is a structured error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-init-empty-"));
  try {
    const bad = jgates(["init", "--cwd", dir, "--profile", "nope", "--no-interactive", "--json"]);
    assert.equal(bad.code, 3);
    assert.equal(JSON.parse(bad.out).error.code, "BAD_PROFILE");
    assert.equal(fs.existsSync(path.join(dir, "jgates.yml")), false);

    const r = jgates(["init", "--cwd", dir, "--no-interactive", "--json"]);
    assert.equal(r.code, 0, r.err + r.out);
    const out = JSON.parse(r.out);
    assert.equal(out.profile, "standard");
    assert.deepEqual(out.templates, ["base"]);
    assert.equal(jgates(["config", "validate", "--cwd", dir, "--json"]).code, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
