#!/usr/bin/env node
// Builds the package when npm installs it from the repository (git+https://..., git+file://..., a folder): npm runs
// `prepare` in a fresh clone. It installs the build dependencies, then builds the semantic gate and jgates.
//
// The inner npm commands run with a clean npm environment. npm passes the options of the outer install to the scripts
// as npm_config_* variables. A global install (`npm install --global git+...`) would then make the inner installs global
// too, and the build tools (tsc, vite) would never land in the clone. `--allow-scripts` also leaks, and npm refuses it in
// a project-scoped install.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The environment of this process without the npm options of the outer install. */
function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^npm_config_/i.test(key)) env[key] = value;
  }
  return env;
}

const env = cleanEnv();
const steps = [
  ["install", "--ignore-scripts", "--include=dev", "--no-audit", "--no-fund"],
  ["--prefix", "semantic-gate", "install", "--ignore-scripts", "--workspaces=false", "--no-audit", "--no-fund"],
  ["--prefix", "semantic-gate", "run", "build", "--workspaces=false"],
  ["--prefix", "jgates", "run", "build", "--workspaces=false"],
];

for (const args of steps) {
  const result = spawnSync("npm", args, { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    console.error(`prepare: npm ${args.join(" ")} failed`);
    process.exit(result.status ?? 1);
  }
}

// The commit this build comes from, for `jgates update` to compare with the repository. Absent when there is no git.
const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
const head = git(["rev-parse", "HEAD"]);
if (head.status === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim())) {
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]).stdout.trim() !== "";
  fs.writeFileSync(path.join(root, "jgates", "dist", "build-info.json"), `${JSON.stringify({ commit: head.stdout.trim(), dirty }, null, 2)}\n`);
}
