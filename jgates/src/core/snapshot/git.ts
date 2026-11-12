// Read-only Git queries about the workspace, to record what a run really analyzed. Nothing here
// writes in the user's repository: no checkout, no reset, no index refresh (GIT_OPTIONAL_LOCKS=0), and the snapshot
// of another commit is materialized through a private index file in the data folder (see materialize.ts).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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

function gitEnv(env: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const name of GIT_REDIRECTS) delete clean[name];
  return { ...clean, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...extra };
}

/**
 * Where the local server keeps the answers of read-only Git questions (core/engine/facts.ts, ADR-0010): inside one of its
 * scopes a read is answered from the cache, or throws the cache's pending marker while it is probed asynchronously.
 * Outside a scope it returns undefined and Git runs as it always did.
 */
export interface GitReadCache {
  readSync(key: string, probe: () => Promise<GitCall>): GitCall | undefined;
}

let readCache: GitReadCache | null = null;

/** Installs (or removes) the read cache; only core/engine/facts.ts calls it. */
export function setGitReadCache(cache: GitReadCache | null): void {
  readCache = cache;
}

/** The Git commands that only read and whose answer is small: the only ones a cached answer may stand for. */
const READ_VERBS = new Set(["rev-parse", "symbolic-ref", "status"]);

function verbOf(args: readonly string[]): string | undefined {
  let i = 0;
  while (args[i] === "-c" && i + 1 < args.length) i += 2;
  return args[i];
}

/** Runs git without a shell, with the redirecting variables removed and optional locks off. */
export function runGit(git: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): GitCall {
  if (readCache && Object.keys(extra).length === 0 && READ_VERBS.has(verbOf(args) ?? "")) {
    const served = readCache.readSync(JSON.stringify(["git", git, path.resolve(cwd), ...args]), () => runGitAsync(git, args, cwd, env));
    if (served) return served;
  }
  const r = spawnSync(git, args, {
    cwd,
    env: gitEnv(env, extra),
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.error ? r.error.message : (r.stderr ?? "") };
}

/** Largest answer runGitAsync keeps (its callers ask small questions). */
const ASYNC_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * runGit without blocking the event loop, for the local server: the same environment, plus a time limit after which
 * Git is stopped and the answer has no status (as when it could not start).
 */
export function runGitAsync(git: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, extra: Record<string, string> = {}, timeoutMs = 30_000): Promise<GitCall> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let size = 0;
    let settled = false;
    const done = (call: GitCall): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(call);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(git, args, { cwd, env: gitEnv(env, extra), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ status: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done({ status: null, stdout, stderr: `git ${verbOf(args) ?? ""} did not answer within ${timeoutMs} ms` });
    }, timeoutMs);
    const take = (chunk: string, into: "out" | "err"): void => {
      size += chunk.length;
      if (size > ASYNC_MAX_BUFFER) {
        child.kill();
        done({ status: null, stdout, stderr: "git printed more than the answer may hold" });
        return;
      }
      if (into === "out") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => take(chunk, "out"));
    child.stderr?.on("data", (chunk: string) => take(chunk, "err"));
    child.on("error", (error) => done({ status: null, stdout, stderr: error.message }));
    child.on("close", (code) => done({ status: code, stdout, stderr }));
  });
}

/**
 * Why Git refused a folder that holds a repository: an ownership it does not trust (safe.directory), or another error.
 * `fix` is the command Git itself suggests, when it suggests one.
 */
export interface GitProblem {
  code: "UNSAFE_REPOSITORY" | "GIT_ERROR";
  message: string;
  fix: string | null;
}

export type GitContext =
  | { available: false; repository: false; git: null }
  | { available: true; repository: false; git: string; problem?: GitProblem }
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
  if (top.status !== 0 || lines[0] !== "true") {
    const problem = top.status !== 0 ? gitProblem(top.stderr, dir) : null;
    return problem ? { available: true, repository: false, git, problem } : { available: true, repository: false, git };
  }
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

/** True when `dir` or one of its parents holds a `.git` entry (a folder, or the file of a worktree or submodule). */
function insideRepository(dir: string): boolean {
  let current = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

/**
 * Tells a folder without a repository from a repository Git refused, whatever the language of Git's messages: the
 * safe.directory hint is a command and is never translated, and a refused folder still has its `.git` entry.
 */
export function gitProblem(stderr: string, dir: string): GitProblem | null {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  const fix = lines.find((l) => /^git config .*safe\.directory\s/.test(l)) ?? null;
  const first = (lines[0] ?? "").replace(/^fatal:\s*/, "");
  if (fix) return { code: "UNSAFE_REPOSITORY", message: first, fix };
  if (!insideRepository(dir)) return null;
  return first ? { code: "GIT_ERROR", message: first, fix: null } : null;
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
