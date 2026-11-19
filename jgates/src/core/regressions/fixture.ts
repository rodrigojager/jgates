// Isolated fixtures: a folder of the run (or of the data folder) holding a copy of the files a test needs, built by host
// code from the files the run may read (never the workspace itself). A test container sees it read-only at /workspace;
// the workspace's prepared dependency volumes are mounted over its empty mount points (`node_modules`), read-only too.
// The host dependencies folder is never used (ADR-0006). A fixture is removed after its runs.
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
  /** Empty folders created for the dependency volumes a container mounts there (relative, forward slashes). */
  mountPoints: string[];
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

const insideDependencies = (rel: string): boolean => rel.split("/").some((part) => SKIP.has(part));

/**
 * Writes a fixture (replacing an earlier one at the same place). `mountPoints` are folders a container mounts a
 * dependency volume on: they are created empty, so the read-only tree needs no change when the volume is mounted.
 */
export function writeFixture(dir: string, files: Iterable<FixtureFile>, options: { mountPoints?: readonly string[] } = {}): Fixture {
  removeFixture(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let count = 0;
  for (const f of files) {
    const rel = safeRelative(f.path);
    if (!rel || insideDependencies(rel)) continue;
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
    count++;
  }
  const mountPoints: string[] = [];
  for (const raw of options.mountPoints ?? []) {
    const rel = safeRelative(raw);
    if (!rel) continue;
    fs.mkdirSync(path.join(dir, ...rel.split("/")), { recursive: true });
    mountPoints.push(rel);
  }
  return { dir, files: count, mountPoints };
}

/** Removes a fixture and everything in it. */
export function removeFixture(dir: string): void {
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
