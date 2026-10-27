// Input manifest of a run (to detect changes during the run): the content hash of every file
// the run reads, taken before and checked after the run. Outputs, caches and reports never enter it, so a tool that
// writes its cache in the workspace does not change the hash of the input (no invalidation loop).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { contentHash } from "../ids/index.js";

/** Folders that hold dependencies, outputs or caches, skipped wherever they are. */
export const OUTPUT_DIRS: readonly string[] = [
  ".git",
  "node_modules",
  ".quality",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  ".tox",
  ".nox",
  ".venv",
  ".nyc_output",
  "htmlcov",
  ".cache",
];

/** Files that are outputs or caches by name. */
export const OUTPUT_FILES: readonly RegExp[] = [/\.py[co]$/, /^\.coverage(\..+)?$/, /^\.eslintcache$/];

export const INPUT_LIMIT = 50_000;
const LFS_SIGNATURE = "version https://git-lfs.github.com/spec/";

export interface InputEntry {
  /** Relative to the analyzed folder, forward slashes. */
  path: string;
  kind: "file" | "symlink";
  size: number;
  /** sha256 of the content (of the link text for a symlink, which is never followed). */
  sha256: string;
}

export interface InputManifest {
  /** Content hash of the entries: equal inputs always give an equal hash. */
  hash: string;
  entries: InputEntry[];
  files: number;
  bytes: number;
  /** More files than the limit: the hash covers only the first ones and the inputs are not fully traceable. */
  truncated: boolean;
  /** Patterns that never enter the hash (the fixed list plus what the plan declares as workspace writes). */
  excluded: string[];
  /** Files that are Git LFS pointers (the object was not fetched). */
  lfsPointers: string[];
}

export interface InputOptions {
  /** The list of files to read (from Git: tracked plus untracked not ignored); otherwise the folder is walked. */
  files?: string[] | null;
  /** Workspace-relative paths (files or folders) declared as outputs. */
  exclude?: string[];
  limit?: number;
}

function hashFile(file: string): { sha256: string; lfs: boolean } {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let first: Buffer | null = null;
  try {
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      if (first === null) first = Buffer.from(buffer.subarray(0, Math.min(n, LFS_SIGNATURE.length)));
      hash.update(buffer.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: "sha256:" + hash.digest("hex"), lfs: first !== null && first.toString("utf8") === LFS_SIGNATURE };
}

const normalize = (p: string): string => p.split(path.sep).join("/").replace(/^\.\//, "").replace(/\/+$/, "");

/** True when the relative path is an output or a cache (by folder, by file name or declared by the plan). */
export function isOutputPath(rel: string, declared: readonly string[] = []): boolean {
  const parts = rel.split("/");
  if (parts.slice(0, -1).some((p) => OUTPUT_DIRS.includes(p))) return true;
  const name = parts[parts.length - 1] ?? "";
  if (OUTPUT_DIRS.includes(name) || OUTPUT_FILES.some((re) => re.test(name))) return true;
  return declared.some((d) => d !== "" && (rel === d || rel.startsWith(`${d}/`)));
}

function walk(root: string, declared: readonly string[], limit: number): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const visit = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (truncated) return;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!OUTPUT_DIRS.includes(entry.name) && !isOutputPath(childRel, declared)) visit(path.join(dir, entry.name), childRel);
        continue;
      }
      if (isOutputPath(childRel, declared)) continue;
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      files.push(childRel);
    }
  };
  visit(root, "");
  return { files, truncated };
}

/** Takes the input manifest of a folder. Never throws for a file that vanished or cannot be read (it is left out). */
export function takeInputManifest(root: string, options: InputOptions = {}): InputManifest {
  const limit = options.limit ?? INPUT_LIMIT;
  const declared = (options.exclude ?? []).map(normalize).filter((d) => d !== "" && d !== ".");
  let list: string[];
  let truncated = false;
  if (options.files) {
    list = options.files.map(normalize).filter((p) => p !== "" && !isOutputPath(p, declared));
    if (list.length > limit) {
      list = list.slice(0, limit);
      truncated = true;
    }
  } else {
    ({ files: list, truncated } = walk(root, declared, limit));
  }
  const entries: InputEntry[] = [];
  const lfsPointers: string[] = [];
  let bytes = 0;
  for (const rel of list) {
    const abs = path.join(root, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue; // listed by Git but deleted in the work tree: a tracked change, not an input
    }
    try {
      if (st.isSymbolicLink()) {
        const target = fs.readlinkSync(abs);
        entries.push({ path: rel, kind: "symlink", size: Buffer.byteLength(target), sha256: "sha256:" + crypto.createHash("sha256").update(target).digest("hex") });
      } else if (st.isFile()) {
        const { sha256, lfs } = hashFile(abs);
        if (lfs) lfsPointers.push(rel);
        entries.push({ path: rel, kind: "file", size: st.size, sha256 });
        bytes += st.size;
      }
    } catch {
      // unreadable now: left out, the after-check reports it if it comes back different
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const excluded = [...OUTPUT_DIRS.map((d) => `${d}/`), ...OUTPUT_FILES.map((re) => re.source), ...declared];
  return {
    hash: contentHash(entries.map((e) => [e.path, e.kind, e.sha256])),
    entries,
    files: entries.length,
    bytes,
    truncated,
    excluded,
    lfsPointers,
  };
}

export interface InputChanges {
  changed: boolean;
  added: string[];
  modified: string[];
  removed: string[];
}

/** What differs between the manifest taken before the run and the one taken after it. */
export function diffInputs(before: InputManifest, after: InputManifest): InputChanges {
  const old = new Map(before.entries.map((e) => [e.path, e.sha256]));
  const now = new Map(after.entries.map((e) => [e.path, e.sha256]));
  const added = [...now.keys()].filter((p) => !old.has(p));
  const removed = [...old.keys()].filter((p) => !now.has(p));
  const modified = [...now.entries()].filter(([p, h]) => old.has(p) && old.get(p) !== h).map(([p]) => p);
  return { changed: before.hash !== after.hash, added, modified, removed };
}
