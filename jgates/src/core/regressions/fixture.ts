// Isolated fixtures: a folder holding a copy of the files a test needs (never the workspace itself) and, when the
// workspace has one, a link to its dependencies folder (node_modules), so a sandboxed test can import the project's
// packages without anything being installed. A fixture is removed after its runs; the link is removed first, so the
// dependencies it points to are never touched.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface FixtureFile {
  /** Relative to the fixture, forward slashes. */
  path: string;
  content: string | Buffer;
}

export interface Fixture {
  dir: string;
  files: number;
  /** The real dependencies folder behind the fixture's node_modules link (null: none). */
  dependencies: string | null;
}

const MAX_WORKSPACE_FILES = 5_000;
const MAX_WORKSPACE_BYTES = 64 * 1024 * 1024;
const SKIP = new Set(["node_modules", ".git"]);

/** A safe relative path (no absolute path, no "..", no drive letter), or null. */
export function safeRelative(p: string): string | null {
  const s = p.replace(/\\/g, "/").replace(/^\.\//, "");
  if (s === "" || s.startsWith("/") || /^[A-Za-z]:/.test(s) || s.split("/").some((x) => x === ".." || x === "")) return null;
  return s;
}

/** Writes a fixture (replacing an earlier one at the same place) and links the dependencies folder when given. */
export function writeFixture(dir: string, files: Iterable<FixtureFile>, options: { nodeModules?: string | null } = {}): Fixture {
  removeFixture(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let count = 0;
  for (const f of files) {
    const rel = safeRelative(f.path);
    if (!rel || rel === "node_modules" || rel.startsWith("node_modules/")) continue;
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
    count++;
  }
  let dependencies: string | null = null;
  if (options.nodeModules && fs.existsSync(options.nodeModules)) {
    try {
      dependencies = fs.realpathSync(options.nodeModules);
      fs.symlinkSync(dependencies, path.join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      dependencies = null;
    }
  }
  return { dir, files: count, dependencies };
}

/** Removes a fixture: its dependencies link first (never followed), then its own files. */
export function removeFixture(dir: string): void {
  const link = path.join(dir, "node_modules");
  try {
    if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
  } catch {
    // No link.
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/**
 * The files of a working tree for a fixture: Git's tracked and untracked-but-not-ignored files when it is a repository,
 * otherwise a walk that skips node_modules and .git; bounded in count and size (null with the reason when too large).
 */
export function workspaceFiles(workspacePath: string, env: NodeJS.ProcessEnv = process.env): { files: FixtureFile[] } | { problem: string } {
  let rels: string[] | null = null;
  const git = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: workspacePath, env, encoding: "utf8", timeout: 30_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (git.status === 0) rels = String(git.stdout).split("\0").filter((p) => p !== "");
  if (rels === null) {
    rels = [];
    const walk = (rel: string): void => {
      for (const e of fs.readdirSync(path.join(workspacePath, rel), { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const next = rel === "" ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) walk(next);
        else if (e.isFile()) (rels as string[]).push(next);
        if ((rels as string[]).length > MAX_WORKSPACE_FILES) return;
      }
    };
    walk("");
  }
  const files: FixtureFile[] = [];
  let bytes = 0;
  for (const rel of rels) {
    const safe = safeRelative(rel);
    if (!safe || safe.split("/").some((x) => SKIP.has(x))) continue;
    const abs = path.join(workspacePath, ...safe.split("/"));
    let content: Buffer;
    try {
      if (!fs.statSync(abs).isFile()) continue;
      content = fs.readFileSync(abs);
    } catch {
      continue; // Deleted in the working tree.
    }
    bytes += content.length;
    files.push({ path: safe, content });
    if (files.length > MAX_WORKSPACE_FILES || bytes > MAX_WORKSPACE_BYTES) return { problem: `the workspace is too large for an isolated copy (more than ${MAX_WORKSPACE_FILES} files or ${MAX_WORKSPACE_BYTES / 1024 / 1024} MB)` };
  }
  return { files };
}
