#!/usr/bin/env node
// Full verification of the repository: the same checks verify-all.ps1 ran, in Node so that they run on Linux, macOS
// and Windows. verify-all.ps1 is only a shortcut that calls this file.
//
//   node scripts/verify-all.mjs          run every step
//   node scripts/verify-all.mjs --list   print the steps (one JSON document) without running anything
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Unit tests create isolated Git repositories and inject their own ranges where required. Ambient CI refs point at
// the outer checkout and would make those fixtures resolve an unrelated range, so verification stays deterministic.
export const CI_RANGE_VARIABLES = [
  "GITHUB_BASE_REF",
  "GITHUB_HEAD_REF",
  "GITHUB_SHA",
  "GITLAB_CI",
  "CI_MERGE_REQUEST_DIFF_BASE_SHA",
  "CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
  "CI_COMMIT_SHA",
];

/** The verification steps, in order. `cwd` is relative to the repository root. */
export function verifySteps() {
  // The tests call `python`; fall back to `python3` only on machines that have no `python` on PATH.
  const python = spawnSync("python", ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0 ? "python" : "python3";
  return [
    // Root end-to-end tests execute the bundled Python sidecar in quick mode; its sole runtime dependency must be
    // installed before them in a pristine environment (the quality workspace test repeats this idempotently).
    { cwd: ".", command: python, args: ["-m", "pip", "install", "--disable-pip-version-check", "--quiet", "defusedxml==0.7.1"] },
    // Root tests run the compiled semantic-gate CLI: bootstrap that workspace first so a pristine checkout is tested in
    // the same state as an installed one.
    { cwd: "semantic-gate", command: "npm", args: ["ci", "--workspaces=false"] },
    { cwd: "semantic-gate", command: "npm", args: ["run", "build", "--workspaces=false"] },
    { cwd: ".", command: "node", args: ["--check", "quality-gate/bin/quality-gate.js"] },
    { cwd: ".", command: "npm", args: ["run", "test:root"] },
    { cwd: ".", command: "npm", args: ["pack", "--dry-run"] },
    { cwd: "semantic-gate", command: "npm", args: ["run", "test:build", "--workspaces=false"] },
    { cwd: "semantic-gate", command: "npm", args: ["run", "pack:dry-run", "--workspaces=false"] },
    { cwd: "quality-gate", command: "npm", args: ["ci", "--workspaces=false"] },
    { cwd: "quality-gate", command: "npm", args: ["test", "--workspaces=false"] },
    { cwd: "quality-gate", command: "npm", args: ["pack", "--dry-run"] },
  ];
}

function gitStatus() {
  const r = spawnSync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("Unable to capture the Git worktree state.");
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

function runStep(step, env) {
  const shown = `${step.command} ${step.args.join(" ")}`;
  process.stdout.write(`\n> (${step.cwd}) ${shown}\n`);
  // npm and node are resolved through the shell on Windows (npm.cmd); the arguments are fixed strings above.
  const r = spawnSync(step.command === "node" ? process.execPath : step.command, step.args, {
    cwd: path.join(root, step.cwd),
    env,
    stdio: "inherit",
    shell: process.platform === "win32" && step.command !== "node",
  });
  if (r.error) throw new Error(`${shown} could not start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${shown} failed with exit code ${r.status}.`);
}

function main() {
  if (process.argv.includes("--list")) {
    process.stdout.write(`${JSON.stringify(verifySteps(), null, 2)}\n`);
    return 0;
  }
  const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-verify-"));
  const env = { ...process.env, NPM_CONFIG_CACHE: path.join(verifyDir, "npm-cache") };
  for (const name of CI_RANGE_VARIABLES) delete env[name];
  try {
    const initial = gitStatus();
    for (const step of verifySteps()) runStep(step, env);
    const final = gitStatus();
    const added = final.filter((line) => !initial.includes(line));
    const removed = initial.filter((line) => !final.includes(line));
    if (added.length > 0 || removed.length > 0) {
      const details = [...removed.map((l) => `< ${l}`), ...added.map((l) => `> ${l}`)].join("\n");
      throw new Error(`Verification changed the Git worktree:\n${details}`);
    }
    process.stdout.write("\nverify: all checks passed\n");
    return 0;
  } catch (error) {
    process.stderr.write(`verify failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    fs.rmSync(verifyDir, { recursive: true, force: true });
  }
}

process.exitCode = main();
