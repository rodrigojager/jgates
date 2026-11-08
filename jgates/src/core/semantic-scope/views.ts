// Read-only views of the files of one scope end: the working tree as it is (tracked plus untracked files that are not
// ignored), a commit (git ls-tree / cat-file, nothing checked out), a commit with selected dirty inputs laid over it,
// or a plain folder without Git. Paths are workspace-relative with forward slashes. Nothing here writes in the
// repository: Git runs with optional locks off and without the variables that would redirect it.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gitFiles, runGit, workingTreeStatus, type GitContext } from "../snapshot/index.js";

export type RepoContext = Extract<GitContext, { repository: true }>;

const GIT_REDIRECTS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"];
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__"]);
const MAX_DIRECTORY_FILES = 50_000;

export const posix = (p: string): string => p.split(path.sep).join("/").replace(/\\/g, "/");
export const sha256 = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");

export interface FileView {
  kind: "working-tree" | "commit" | "directory";
  commit: string | null;
  /** Sorted workspace-relative paths present at this end. */
  files: string[];
  /** true when the listing stopped at a limit. */
  truncated: boolean;
  has(p: string): boolean;
  size(p: string): number | null;
  /** Reads several files at once (one Git call for a commit); cached. */
  preload(paths: readonly string[]): void;
  read(p: string): Buffer | null;
  sha(p: string): string | null;
}

/** Same comparison as the file system: case-insensitive on Windows. */
export const pathKey = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);

abstract class BaseView implements FileView {
  abstract kind: FileView["kind"];
  abstract commit: string | null;
  files: string[] = [];
  truncated = false;
  protected index = new Map<string, string>();
  protected cache = new Map<string, Buffer | null>();
  protected shas = new Map<string, string | null>();
  protected setFiles(files: string[]): void {
    this.files = [...new Set(files)].sort();
    this.index = new Map(this.files.map((f) => [pathKey(f), f]));
  }
  has(p: string): boolean {
    return this.index.has(pathKey(p));
  }
  canonical(p: string): string | null {
    return this.index.get(pathKey(p)) ?? null;
  }
  abstract size(p: string): number | null;
  abstract preload(paths: readonly string[]): void;
  read(p: string): Buffer | null {
    const c = this.canonical(p);
    if (c === null) return null;
    if (!this.cache.has(c)) this.preload([c]);
    return this.cache.get(c) ?? null;
  }
  sha(p: string): string | null {
    const c = this.canonical(p);
    if (c === null) return null;
    if (!this.shas.has(c)) {
      const buf = this.read(c);
      this.shas.set(c, buf ? sha256(buf) : null);
    }
    return this.shas.get(c) ?? null;
  }
}

/** Files read from disk under a root. */
class DiskView extends BaseView {
  constructor(
    readonly kind: "working-tree" | "directory",
    readonly commit: string | null,
    private root: string,
    files: string[],
    truncated: boolean,
  ) {
    super();
    this.setFiles(files.filter((f) => isFile(path.join(root, f))));
    this.truncated = truncated;
  }
  size(p: string): number | null {
    const c = this.canonical(p);
    if (c === null) return null;
    try {
      return fs.statSync(path.join(this.root, c)).size;
    } catch {
      return null;
    }
  }
  preload(paths: readonly string[]): void {
    for (const p of paths) {
      const c = this.canonical(p);
      if (c === null || this.cache.has(c)) continue;
      try {
        this.cache.set(c, fs.readFileSync(path.join(this.root, c)));
      } catch {
        this.cache.set(c, null);
      }
    }
  }
}

function isFile(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  for (const name of GIT_REDIRECTS) delete clean[name];
  return clean;
}

/** A commit's tree, read through git cat-file in batches. */
class CommitView extends BaseView {
  readonly kind = "commit" as const;
  private sizes = new Map<string, number>();
  constructor(
    private git: RepoContext,
    private dir: string,
    readonly commit: string,
    private env: NodeJS.ProcessEnv,
  ) {
    super();
    const r = runGit(git.git, ["ls-tree", "-r", "-z", "--long", "--full-tree", commit], dir, env);
    const files: string[] = [];
    if (r.status === 0) {
      for (const entry of r.stdout.split("\0")) {
        // <mode> SP <type> SP <object> SP+ <size> TAB <path>
        const tab = entry.indexOf("\t");
        if (tab < 0) continue;
        const meta = entry.slice(0, tab).trim().split(/\s+/);
        if (meta[1] !== "blob") continue;
        const full = entry.slice(tab + 1);
        if (git.prefix !== "" && !full.startsWith(git.prefix)) continue;
        const rel = full.slice(git.prefix.length);
        if (rel === "") continue;
        files.push(rel);
        const size = Number(meta[3]);
        if (Number.isFinite(size)) this.sizes.set(rel, size);
      }
    }
    this.setFiles(files);
  }
  size(p: string): number | null {
    const c = this.canonical(p);
    return c === null ? null : (this.sizes.get(c) ?? null);
  }
  preload(paths: readonly string[]): void {
    const wanted = [...new Set(paths.map((p) => this.canonical(p)).filter((c): c is string => c !== null && !this.cache.has(c)))];
    // Batches keep the stdin and the output of one call bounded.
    for (let i = 0; i < wanted.length; i += 500) {
      const batch = wanted.slice(i, i + 500);
      const input = batch.map((p) => `${this.commit}:${this.git.prefix}${p}`).join("\n") + "\n";
      const r = spawnSync(this.git.git, ["cat-file", "--batch"], { cwd: this.dir, env: cleanEnv(this.env), input, maxBuffer: 1024 * 1024 * 1024, windowsHide: true });
      const out: Buffer = r.status === 0 && Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.alloc(0);
      let offset = 0;
      for (const p of batch) {
        const nl = out.indexOf(0x0a, offset);
        if (nl < 0) {
          this.cache.set(p, null);
          continue;
        }
        const header = out.subarray(offset, nl).toString("utf8").split(" ");
        offset = nl + 1;
        if (header[1] === "missing" || header.length < 3) {
          this.cache.set(p, null);
          continue;
        }
        const size = Number(header[2]);
        this.cache.set(p, Buffer.from(out.subarray(offset, offset + size)));
        offset += size + 1;
      }
    }
  }
}

/** A commit with dirty inputs laid over it: present paths read from disk, removed ones absent. */
class OverlayView extends BaseView {
  readonly kind = "commit" as const;
  readonly commit: string;
  constructor(
    private base: CommitView,
    private root: string,
    private overlay: Map<string, boolean>,
  ) {
    super();
    this.commit = base.commit;
    const files = new Set(base.files);
    for (const [p, present] of overlay) {
      if (present) files.add(p);
      else files.delete(p);
    }
    this.setFiles([...files]);
  }
  private onDisk(c: string): boolean {
    return this.overlay.get(c) === true;
  }
  size(p: string): number | null {
    const c = this.canonical(p);
    if (c === null) return null;
    if (!this.onDisk(c)) return this.base.size(c);
    try {
      return fs.statSync(path.join(this.root, c)).size;
    } catch {
      return null;
    }
  }
  preload(paths: readonly string[]): void {
    const fromBase: string[] = [];
    for (const p of paths) {
      const c = this.canonical(p);
      if (c === null || this.cache.has(c)) continue;
      if (this.onDisk(c)) {
        try {
          this.cache.set(c, fs.readFileSync(path.join(this.root, c)));
        } catch {
          this.cache.set(c, null);
        }
      } else fromBase.push(c);
    }
    this.base.preload(fromBase);
    for (const c of fromBase) this.cache.set(c, this.base.read(c));
  }
}

function walkDirectory(root: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const child = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(child);
      } else if (e.isFile()) {
        if (files.length >= MAX_DIRECTORY_FILES) return { files, truncated: true };
        files.push(child);
      }
    }
  }
  return { files, truncated: false };
}

/** The working tree as it is: tracked and untracked files that are not ignored (or every file without Git). */
export function workingTreeView(workspacePath: string, git: GitContext, env: NodeJS.ProcessEnv): FileView {
  if (git.repository) {
    const listed = gitFiles(git, workspacePath, env);
    if (listed) return new DiskView("working-tree", git.head, workspacePath, listed.map(posix), false);
  }
  const walked = walkDirectory(workspacePath);
  return new DiskView("directory", null, workspacePath, walked.files, walked.truncated);
}

export function commitView(workspacePath: string, git: RepoContext, commit: string, env: NodeJS.ProcessEnv): FileView {
  return new CommitView(git, workspacePath, commit, env);
}

/** A commit plus selected dirty paths (true: present on disk, false: removed in the working tree). */
export function overlayView(workspacePath: string, git: RepoContext, commit: string, overlay: Map<string, boolean>, env: NodeJS.ProcessEnv): FileView {
  return new OverlayView(new CommitView(git, workspacePath, commit, env), workspacePath, overlay);
}

export interface DirtyEntry {
  path: string;
  change: "modified" | "removed" | "untracked" | "added";
}

/** The dirty and untracked paths of the working tree (relative to the workspace), with what happened to each. */
export function dirtyEntries(workspacePath: string, git: RepoContext, env: NodeJS.ProcessEnv): { entries: DirtyEntry[]; truncated: boolean } | null {
  const status = workingTreeStatus(git, workspacePath, env);
  if (!status) return null;
  const entries: DirtyEntry[] = [];
  for (const t of status.tracked) {
    const removed = t.status.includes("D") && !fs.existsSync(path.join(workspacePath, t.path));
    entries.push({ path: posix(t.path), change: removed ? "removed" : t.status.startsWith("A") ? "added" : "modified" });
  }
  for (const u of status.untracked) entries.push({ path: posix(u), change: "untracked" });
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, truncated: status.truncated };
}

export interface DiffEntry {
  path: string;
  change: "added" | "modified" | "renamed" | "removed";
  previousPath?: string;
}

/** Changes between two commits inside the workspace, with renames detected. null when Git refuses. */
export function diffCommits(workspacePath: string, git: RepoContext, base: string, target: string, env: NodeJS.ProcessEnv): DiffEntry[] | null {
  const r = runGit(git.git, ["diff", "-z", "--name-status", "-M", "--no-ext-diff", "--relative", base, target, "--"], workspacePath, env);
  if (r.status !== 0) return null;
  const parts = r.stdout.split("\0");
  const out: DiffEntry[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i] ?? "";
    if (code === "") {
      i++;
      continue;
    }
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const from = posix(parts[i + 1] ?? "");
      const to = posix(parts[i + 2] ?? "");
      i += 3;
      if (letter === "R") out.push({ path: to, change: "renamed", previousPath: from });
      else out.push({ path: to, change: "added" });
      continue;
    }
    const p = posix(parts[i + 1] ?? "");
    i += 2;
    if (p === "") continue;
    out.push({ path: p, change: letter === "A" ? "added" : letter === "D" ? "removed" : "modified" });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
