"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  MIN_API_COVERAGE,
  createMainFixture,
  fixMainFixture,
  measureApiCoverage,
  findDomainInfraImports,
  listTree,
  removeFixture
} = require("./fixtures/jgates/main-fixture.js");

const ROOT = path.resolve(__dirname, "..");

function git(dir, ...args) {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" });
}

test("fixture teardown requests bounded native retries without changing its target or recursive/force semantics", (t) => {
  const calls = [];
  t.mock.method(fs, "rmSync", (...args) => calls.push(args));
  removeFixture("exact-fixture-path");
  assert.deepEqual(calls, [["exact-fixture-path", { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }]]);
});

for (const code of ["EPERM", "EIO"]) {
  test(`fixture teardown propagates ${code === "EPERM" ? "exhausted transient" : "unrelated"} errors unchanged`, (t) => {
    const error = Object.assign(new Error("fixture removal failed"), { code });
    let calls = 0;
    t.mock.method(fs, "rmSync", () => { calls++; throw error; });
    assert.throws(() => removeFixture("exact-fixture-path"), (thrown) => thrown === error);
    assert.equal(calls, 1, "the fixture delegates bounded retries to Node; it never swallows or restarts failed removal");
  });
}

test("main fixture has the three components, each with its stack manifest", () => {
  const { dir } = createMainFixture();
  try {
    assert.ok(fs.existsSync(path.join(dir, "web", "package.json")));
    assert.ok(fs.existsSync(path.join(dir, "web", "tsconfig.json")));
    assert.ok(fs.existsSync(path.join(dir, "api", "pyproject.toml")));
    assert.ok(fs.existsSync(path.join(dir, "libs", "shared", "package.json")));
    for (const layer of ["domain", "application", "infrastructure"]) {
      assert.ok(fs.existsSync(path.join(dir, "api", "src", "shop_api", layer)), layer);
    }
    assert.equal(git(dir, "status", "--porcelain").stdout, "");
  } finally {
    removeFixture(dir);
  }
});

test("broken fixture shows both violations, the fix removes them, and the commits differ", () => {
  const { dir, brokenCommit } = createMainFixture();
  try {
    assert.equal(findDomainInfraImports(dir).length, 1);
    const before = measureApiCoverage(dir);
    assert.equal(before.tests_ok, true);
    assert.ok(before.percent < MIN_API_COVERAGE, `coverage ${before.percent}`);

    const fixedCommit = fixMainFixture(dir);
    assert.notEqual(fixedCommit, brokenCommit);
    assert.equal(git(dir, "rev-parse", "HEAD").stdout.trim(), fixedCommit);
    assert.equal(git(dir, "status", "--porcelain").stdout, "");

    assert.deepEqual(findDomainInfraImports(dir), []);
    const after = measureApiCoverage(dir);
    assert.equal(after.tests_ok, true);
    assert.ok(after.percent >= MIN_API_COVERAGE, `coverage ${after.percent}`);
  } finally {
    removeFixture(dir);
  }
});

test("two builds are byte-identical outside .git and leave nothing in the repository", () => {
  const before = git(ROOT, "status", "--porcelain", "--ignored", "--", "tests/fixtures/jgates").stdout;
  const a = createMainFixture();
  const b = createMainFixture();
  try {
    assert.deepEqual(listTree(a.dir), listTree(b.dir));
    assert.equal(a.brokenCommit, b.brokenCommit);
    assert.equal(git(ROOT, "status", "--porcelain", "--ignored", "--", "tests/fixtures/jgates").stdout, before);
  } finally {
    removeFixture(a.dir);
    removeFixture(b.dir);
  }
});
