import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// `jgates skill`: the shortcut an agent uses to read the JGates skill, find it, or install it into its skills folder.

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(here, "..", "dist", "cli", "main.js");
const SKILL = fs.readFileSync(path.resolve(here, "..", "skill", "SKILL.md"), "utf8");
const jgates = (args) => spawnSync(process.execPath, [MAIN, ...args, "--locale", "en"], { encoding: "utf8" });

test("jgates skill prints the shipped skill, and --path where it is", () => {
  const r = jgates(["skill"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, SKILL.endsWith("\n") ? SKILL : `${SKILL}\n`);
  const p = jgates(["skill", "--path"]);
  assert.equal(p.status, 0);
  assert.equal(fs.readFileSync(p.stdout.trim(), "utf8"), SKILL);
  const j = JSON.parse(jgates(["skill", "--json"]).stdout);
  assert.equal(j.text, SKILL);
});

test("--install copies it to <folder>/SKILL.md, is idempotent, and never overwrites a different file without --force", () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jg-skill-")), "skills", "jgates");
  const target = path.join(dir, "SKILL.md");
  const first = JSON.parse(jgates(["skill", "--install", dir, "--json"]).stdout);
  assert.equal(first.changed, true);
  assert.equal(fs.readFileSync(target, "utf8"), SKILL);
  assert.equal(JSON.parse(jgates(["skill", "--install", dir, "--json"]).stdout).changed, false);
  fs.writeFileSync(target, "my own notes\n");
  const refused = jgates(["skill", "--install", dir, "--json"]);
  assert.equal(refused.status, 3);
  assert.equal(JSON.parse(refused.stdout).code, "SKILL_EXISTS");
  assert.equal(fs.readFileSync(target, "utf8"), "my own notes\n");
  assert.equal(jgates(["skill", "--install", dir, "--force"]).status, 0);
  assert.equal(fs.readFileSync(target, "utf8"), SKILL);
});
