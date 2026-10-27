// Read-only Git queries about the workspace, to record what a run really analyzed. Nothing here
// writes in the user's repository: no checkout, no reset, no index refresh (GIT_OPTIONAL_LOCKS=0), and the snapshot
// of another commit is materialized through a private index file in the data folder (see materialize.ts).
import { spawnSync } from "node:child_process";
import { findOnPath } from "../bridge/index.js";

/** Variables that would point Git at another repository, index or work tree than the one asked for. */
const GIT_REDIRECTS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"];

const MAX_BUFFER = 512 * 1024 * 1024;

/** The git executable: JGATES_GIT (absolute path or name) or `git` on the PATH. */
export function resolveGit(env: NodeJS.ProcessEnv = process.env): string | null {
  return findOnPath(env.JGATES_GIT && env.JGATES_GIT.trim() !== "" ? env.JGATES_GIT : "git", env);
}

export interface GitCall {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs git without a shell, with the redirecting variables removed and optional locks off. */
export function runGit(git: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): GitCall {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const name of GIT_REDIRECTS) delete clean[name];
  const r = spawnSync(git, args, {
    cwd,
    env: { ...clean, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...extra },
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.error ? r.error.message : (r.stderr ?? "") };
}

export type GitContext =
  | { available: false; repository: false; git: null }
  | { available: true; repository: false; git: string }
  | {
      available: true;
      repository: true;
      git: string;
      /** Root of the work tree. */
      toplevel: string;
      /** The workspace inside the work tree ("" at the root, otherwise "sub/dir/"). */
      prefix: string;
      /** Commit checked out (null on an unborn branch). */
      head: string | null;
      /** Branch name (null when detached). */
      branch: string | null;
    };

/** What Git knows about the folder: whether it is in a work tree, its root, HEAD and branch. */
export function gitContext(dir: string, env: NodeJS.ProcessEnv = process.env): GitContext {
  const git = resolveGit(env);
  if (!git) return { available: false, repository: false, git: null };
  const top = runGit(git, ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--show-prefix"], dir, env);
  const lines = top.stdout.split(/\r?\n/);
  if (top.status !== 0 || lines[0] !== "true") return { available: true, repository: false, git };
  const head = runGit(git, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], dir, env);
  const branch = runGit(git, ["symbolic-ref", "--quiet", "--short", "HEAD"], dir, env);
  return {
    available: true,
    repository: true,
    git,
    toplevel: lines[1] ?? dir,
    prefix: lines[2] ?? "",
    head: head.status === 0 && head.stdout.trim() !== "" ? head.stdout.trim() : null,
    branch: branch.status === 0 && branch.stdout.trim() !== "" ? branch.stdout.trim() : null,
  };
}

/** Resolves a reference to a full commit id, or null when it names no commit. Never reads an option from the ref. */
export function resolveCommit(context: GitContext, dir: string, ref: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!context.repository || ref.trim() === "" || ref.startsWith("-")) return null;
  const r = runGit(context.git, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], dir, env);
  const sha = r.stdout.trim();
  return r.status === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

export interface TrackedChange {
  /** Relative to the workspace, forward slashes. */
  path: string;
  /** Porcelain XY code (index, work tree), for example " M", "A ", "D ". */
  status: string;
}

export interface WorkingTreeStatus {
  dirty: boolean;
  tracked: TrackedChange[];
  untracked: string[];
  truncated: boolean;
}

export const STATUS_LIMIT = 10_000;

const stripPrefix = (prefix: string, p: string): string | null => (prefix === "" ? p : p.startsWith(prefix) ? p.slice(prefix.length) : null);

/**
 * Changes of the work tree inside the workspace: tracked files changed (staged or not) and untracked files that are
 * not ignored (those are part of what the run reads). Ignored files are neither changes nor inputs.
 */
export function workingTreeStatus(context: GitContext, dir: string, env: NodeJS.ProcessEnv = process.env, limit: number = STATUS_LIMIT): WorkingTreeStatus | null {
  if (!context.repository) return null;
  const r = runGit(context.git, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", "."], dir, env);
  if (r.status !== 0) return null;
  const tracked: TrackedChange[] = [];
  const untracked: string[] = [];
  let truncated = false;
  for (const entry of r.stdout.split("\0")) {
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    // Porcelain paths are relative to the repository root.
    const rel = stripPrefix(context.prefix, entry.slice(3));
    if (rel === null || rel === "") continue;
    if (tracked.length + untracked.length >= limit) {
      truncated = true;
      break;
    }
    if (code === "??") untracked.push(rel);
    else if (code !== "!!") tracked.push({ path: rel, status: code });
  }
  tracked.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  untracked.sort();
  return { dirty: tracked.length > 0 || untracked.length > 0, tracked, untracked, truncated };
}

/** Files Git would put in the workspace: tracked plus untracked that are not ignored (relative to dir). */
export function gitFiles(context: GitContext, dir: string, env: NodeJS.ProcessEnv = process.env): string[] | null {
  if (!context.repository) return null;
  const r = runGit(context.git, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], dir, env);
  if (r.status !== 0) return null;
  return [...new Set(r.stdout.split("\0").filter((p) => p !== ""))].sort();
}
