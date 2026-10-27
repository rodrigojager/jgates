// Which project files `jgates pii check` and `jgates pii fix` cover, and how their content is read. Read-only on the
// repository: Git is only queried (status, ls-files, cat-file), never asked to change the index here.
//   default   what goes into the next commit: changed tracked files (staged or not) and untracked files
//   staged    only what is in the index; for `fix`, a file with changes outside the index is refused (the part in the
//             index cannot be fixed alone without risk); `check` reads the content of the index
//   changed   changed tracked files only
//   all       every file Git would put in the project (tracked plus untracked, not ignored), or every file without Git
//   paths     the files named (a folder covers the files under it)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { matchesPathOrParent } from "../discovery/glob.js";
import { gitContext, gitFiles, runGit, workingTreeStatus, type GitContext } from "../snapshot/git.js";

export type ScopeKind = "default" | "staged" | "changed" | "all" | "paths";

export interface ScopeRequest {
  kind: ScopeKind;
  /** The paths named (kind "paths"), relative to the project or absolute inside it. */
  paths: string[];
  /** `fix` refuses partly staged files under --staged; `check` reads the index instead. */
  forFix: boolean;
  includes: string[];
  excludes: string[];
}

export interface ScopeEntry {
  /** Relative to the project, "/" separators. */
  path: string;
  /** Where the content is read from: the file on disk, or the index (check --staged). */
  source: "worktree" | "index";
}

export interface LeftOut {
  path: string;
  reason: string;
}

export type ScopeResult =
  | { ok: true; kind: ScopeKind; entries: ScopeEntry[]; refused: LeftOut[]; git: GitContext }
  | { ok: false; code: "NOT_A_GIT_REPOSITORY" | "GIT_FAILED" | "PATH_OUTSIDE_PROJECT" | "PATH_NOT_FOUND"; detail: string };

/** Folders never walked when the project has no Git (dependencies, environments, the repository itself). */
const WALK_SKIP = new Set([".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__"]);

const toPosix = (p: string): string => p.split(path.sep).join("/");

function walk(root: string, rel: string, out: string[]): void {
  const abs = rel === "" ? root : path.join(root, ...rel.split("/"));
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!WALK_SKIP.has(entry.name)) walk(root, child, out);
    } else out.push(child);
  }
}

function inScope(file: string, request: ScopeRequest): boolean {
  if (request.includes.length > 0 && !request.includes.some((g) => matchesPathOrParent(g, file))) return false;
  return !request.excludes.some((g) => matchesPathOrParent(g, file));
}

/** Unmerged entries of `git status --porcelain` (both sides changed the file). */
const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function resolveScope(projectDir: string, request: ScopeRequest, env: NodeJS.ProcessEnv = process.env): ScopeResult {
  const dir = path.resolve(projectDir);
  const git = gitContext(dir, env);
  const refused: LeftOut[] = [];
  let candidates: ScopeEntry[] = [];
  const needsGit = request.kind === "default" || request.kind === "staged" || request.kind === "changed";
  if (needsGit && !git.repository) return { ok: false, code: "NOT_A_GIT_REPOSITORY", detail: dir };

  if (needsGit) {
    const status = workingTreeStatus(git, dir, env);
    if (!status) return { ok: false, code: "GIT_FAILED", detail: "git status" };
    if (request.kind === "staged") {
      for (const change of status.tracked) {
        const [x, y] = [change.status[0] ?? " ", change.status[1] ?? " "];
        if (UNMERGED.has(change.status)) refused.push({ path: change.path, reason: "unmerged" });
        else if (x === " " || x === "D") continue;
        else if (request.forFix && y !== " ") refused.push({ path: change.path, reason: "unstaged-changes" });
        else candidates.push({ path: change.path, source: request.forFix ? "worktree" : "index" });
      }
    } else {
      candidates = status.tracked.map((c) => ({ path: c.path, source: "worktree" as const }));
      if (request.kind === "default") candidates.push(...status.untracked.map((p) => ({ path: p, source: "worktree" as const })));
    }
  } else if (request.kind === "all") {
    const files = git.repository ? gitFiles(git, dir, env) : null;
    if (git.repository && !files) return { ok: false, code: "GIT_FAILED", detail: "git ls-files" };
    const list = files ?? [];
    if (!files) walk(dir, "", list);
    candidates = list.map((p) => ({ path: p, source: "worktree" as const }));
  } else {
    for (const raw of request.paths) {
      const abs = path.resolve(dir, raw);
      const rel = path.relative(dir, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, code: "PATH_OUTSIDE_PROJECT", detail: raw };
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(abs);
      } catch {
        return { ok: false, code: "PATH_NOT_FOUND", detail: raw };
      }
      const relPosix = toPosix(rel);
      if (!stat.isDirectory()) {
        candidates.push({ path: relPosix, source: "worktree" });
        continue;
      }
      const list: string[] = [];
      if (git.repository) {
        const r = runGit(git.git, ["--literal-pathspecs", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", relPosix === "" ? "." : relPosix], dir, env);
        if (r.status !== 0) return { ok: false, code: "GIT_FAILED", detail: "git ls-files" };
        list.push(...r.stdout.split("\0").filter((p) => p !== ""));
      } else walk(dir, relPosix, list);
      candidates.push(...list.map((p) => ({ path: p, source: "worktree" as const })));
    }
  }

  const seen = new Set<string>();
  const entries: ScopeEntry[] = [];
  for (const entry of candidates) {
    if (seen.has(entry.path) || !inScope(entry.path, request)) continue;
    seen.add(entry.path);
    if (entry.source === "worktree") {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(path.join(dir, ...entry.path.split("/")));
      } catch {
        continue; // removed from the work tree: nothing to read or to fix
      }
      if (!stat.isFile()) {
        refused.push({ path: entry.path, reason: "not-a-regular-file" });
        continue;
      }
    }
    entries.push(entry);
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  refused.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, kind: request.kind, entries, refused, git };
}

const GIT_REDIRECTS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"];

/** The bytes of a scope entry: the file on disk, or its blob in the index. Null when it cannot be read. */
export function readEntry(projectDir: string, git: GitContext, entry: ScopeEntry, env: NodeJS.ProcessEnv = process.env): Buffer | null {
  if (entry.source === "worktree") {
    try {
      return fs.readFileSync(path.join(projectDir, ...entry.path.split("/")));
    } catch {
      return null;
    }
  }
  if (!git.repository) return null;
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const name of GIT_REDIRECTS) delete clean[name];
  // ":<path>" names the blob of stage 0 in the index; the path is relative to the root of the work tree.
  const r = spawnSync(git.git, ["cat-file", "blob", `:${git.prefix}${entry.path}`], {
    cwd: projectDir,
    env: { ...clean, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
  });
  return r.error || r.status !== 0 ? null : r.stdout;
}

/** `git add` of exactly these files (the ones `pii fix --staged` changed). */
export function stageFiles(projectDir: string, git: GitContext, files: readonly string[], env: NodeJS.ProcessEnv = process.env): string | null {
  if (!git.repository || files.length === 0) return null;
  const r = runGit(git.git, ["--literal-pathspecs", "add", "--", ...files], projectDir, env);
  return r.status === 0 ? null : r.stderr.trim().split("\n")[0] || `git add exited with ${r.status}`;
}
