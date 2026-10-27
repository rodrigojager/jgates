import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadEffectiveConfig } from "../dist/config.js";
import { collectGitReviewContext } from "../dist/context.js";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stderr}`);
}

test("context ignore files are deduplicated and support re-inclusion", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-context-ignore-"));
  try {
    run("git", ["init"], temp);
    run("git", ["config", "user.email", "test@example.invalid"], temp);
    run("git", ["config", "user.name", "Test User"], temp);
    fs.writeFileSync(path.join(temp, "kept.js"), "const kept = true;\n", "utf8");
    fs.writeFileSync(path.join(temp, "ignored.js"), "const ignored = true;\n", "utf8");
    fs.writeFileSync(path.join(temp, ".gitignore"), "ignored.js\n", "utf8");
    fs.writeFileSync(path.join(temp, ".semantic-gate.ignore"), "ignored.js\n!ignored.js\n", "utf8");
    run("git", ["add", "kept.js", ".gitignore", ".semantic-gate.ignore"], temp);
    run("git", ["add", "-f", "ignored.js"], temp);
    run("git", ["commit", "-m", "initial"], temp);
    fs.appendFileSync(path.join(temp, "ignored.js"), "const changed = true;\n", "utf8");

    const config = loadEffectiveConfig(temp, {
      scope: "changed",
      ignoreFiles: [".semantic-gate.ignore"],
      includeUntracked: true
    });
    const context = await collectGitReviewContext(temp, config);

    assert.ok(context.ignoreFiles.includes(".gitignore"));
    assert.equal(context.ignoreFiles.filter((file) => file === ".semantic-gate.ignore").length, 1);
    assert.ok(context.changedFiles.some((file) => file.path === "ignored.js" && !file.skippedReason));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("semantic config requires paths scope when --path is used", () => {
  assert.throws(
    () => loadEffectiveConfig(process.cwd(), { scope: "changed", paths: ["docs"] }),
    /--path can only be used with scope=paths/
  );
  assert.throws(
    () => loadEffectiveConfig(process.cwd(), { scope: "full", paths: ["docs"] }),
    /--path can only be used with scope=paths/
  );
});

test("semantic config ignores configured paths outside paths scope", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-config-paths-"));
  try {
    fs.writeFileSync(path.join(temp, ".semantic-gate.json"), JSON.stringify({
      scope: "changed",
      paths: ["docs"]
    }), "utf8");

    const config = loadEffectiveConfig(temp, { scope: "changed" });

    assert.equal(config.scope, "changed");
    assert.deepEqual(config.paths, []);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("paths scope filters git status to selected paths", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-path-status-"));
  try {
    run("git", ["init"], temp);
    run("git", ["config", "user.email", "test@example.invalid"], temp);
    run("git", ["config", "user.name", "Test User"], temp);
    fs.writeFileSync(path.join(temp, "selected.js"), "const selected = 1;\n", "utf8");
    fs.writeFileSync(path.join(temp, "other.js"), "const other = 1;\n", "utf8");
    run("git", ["add", "selected.js", "other.js"], temp);
    run("git", ["commit", "-m", "initial"], temp);
    fs.appendFileSync(path.join(temp, "selected.js"), "const changed = true;\n", "utf8");
    fs.appendFileSync(path.join(temp, "other.js"), "const leaked = true;\n", "utf8");

    const config = loadEffectiveConfig(temp, {
      scope: "paths",
      paths: ["selected.js"],
      includeUntracked: true
    });
    const context = await collectGitReviewContext(temp, config);

    assert.match(context.statusShort, /selected\.js/);
    assert.doesNotMatch(context.statusShort, /other\.js/);
    assert.deepEqual(context.changedFiles.map((file) => file.path), ["selected.js"]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("context reads the shared .jgates.ignore file", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-context-shared-ignore-"));
  try {
    run("git", ["init"], temp);
    run("git", ["config", "user.email", "test@example.invalid"], temp);
    run("git", ["config", "user.name", "Test User"], temp);
    fs.writeFileSync(path.join(temp, "kept.js"), "const kept = true;\n", "utf8");
    fs.writeFileSync(path.join(temp, "generated.js"), "const generated = true;\n", "utf8");
    fs.writeFileSync(path.join(temp, ".jgates.ignore"), "generated.js\n", "utf8");

    const config = loadEffectiveConfig(temp, { scope: "changed", includeUntracked: true });
    const context = await collectGitReviewContext(temp, config);

    assert.ok(context.ignoreFiles.includes(".jgates.ignore"));
    assert.ok(context.changedFiles.some((file) => file.path === "kept.js" && !file.skippedReason));
    assert.ok(!context.changedFiles.some((file) => file.path === "generated.js" && !file.skippedReason));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
