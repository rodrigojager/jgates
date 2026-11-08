// Source identity: repository + commit + dirty-content hash of the source a run judged. It is taken from the same
// analysis a run already records (run/analysis.ts prepareAnalysis: Git context, `git status` with untracked files and
// the input manifest with the sha256 of every input), never from a second hasher. Two identities are the same source
// only when both are traceable, neither is a legacy derivation and their ids are equal.
import fs from "node:fs";
import path from "node:path";
import { canonicalPath, contentHash } from "../ids/index.js";
import { prepareAnalysis, type AnalyzedState, type PreparedAnalysis } from "../run/analysis.js";
import { gitContext, resolveCommit, runGit, type GitContext } from "../snapshot/index.js";
import type { SourceIdentity, SourceRepository } from "./types.js";

const VERSION = 1;
const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40,64}$/;

type RepoContext = Extract<GitContext, { repository: true }>;

function safeCanonical(p: string): string {
  try {
    return canonicalPath(p);
  } catch {
    return path.resolve(p);
  }
}

/** The repository without remotes: its root commits when the history has any (the same in every clone), else its path. */
function repositoryOf(git: RepoContext, dir: string, env: NodeJS.ProcessEnv): SourceRepository {
  const root = path.resolve(git.toplevel);
  if (git.head) {
    const r = runGit(git.git, ["rev-list", "--max-parents=0", git.head], dir, env);
    const roots = r.status === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => COMMIT.test(l)).sort() : [];
    if (roots.length > 0) return { id: contentHash({ roots }), idBasis: "root-commits", root, prefix: git.prefix };
  }
  return { id: contentHash({ path: safeCanonical(root) }), idBasis: "path", root, prefix: git.prefix };
}

const gitId = (repository: SourceRepository, commit: string | null, dirtyContentHash: string | null, traceable: boolean): string =>
  contentHash({ v: VERSION, repository: repository.id, prefix: repository.prefix, commit, dirtyContentHash, traceable });

/**
 * Identity of the state an analysis prepared: the commit snapshot, the folder without Git, or the Git working tree with
 * its dirty contents (tracked changes, staged or not, deletions and untracked files that are not ignored).
 */
export function sourceIdentityOf(prep: PreparedAnalysis): SourceIdentity {
  const { git, status, snapshot, before } = prep;
  const env = prep.request.env;
  if (snapshot && git.repository) {
    const repository = repositoryOf(git, prep.request.workspacePath, env);
    const traceable = !before.truncated;
    return {
      schemaVersion: 1,
      id: gitId(repository, snapshot.commit, null, traceable),
      basis: "git-commit",
      repository,
      commit: snapshot.commit,
      dirty: false,
      dirtyContentHash: null,
      dirtyPaths: 0,
      inputsHash: before.hash,
      traceable,
    };
  }
  if (!git.repository) {
    const traceable = !before.truncated;
    return {
      schemaVersion: 1,
      id: contentHash({ v: VERSION, inputsHash: before.hash, traceable }),
      basis: "directory",
      repository: null,
      commit: null,
      dirty: null,
      dirtyContentHash: null,
      dirtyPaths: 0,
      inputsHash: before.hash,
      traceable,
    };
  }
  const repository = repositoryOf(git, prep.path, env);
  const byPath = new Map(before.entries.map((e) => [e.path, e.sha256]));
  let dirtyContentHash: string | null;
  let dirtyPaths: number;
  let traceable = !before.truncated;
  if (status) {
    // Each dirty path with its current content: absent from disk = removed; present but outside the inputs = excluded.
    const paths = [...new Set([...status.tracked.map((t) => t.path), ...status.untracked])].sort();
    const entries = paths.map((p) => [p, byPath.get(p) ?? (fs.existsSync(path.join(prep.path, p)) ? "excluded" : null)]);
    dirtyPaths = paths.length;
    dirtyContentHash = paths.length > 0 ? contentHash({ v: VERSION, dirty: entries }) : null;
    traceable = traceable && !status.truncated;
  } else {
    // git status failed: the contents are still pinned by the whole input manifest, but the identity is not traceable.
    dirtyPaths = before.files;
    dirtyContentHash = contentHash({ v: VERSION, unknownStatus: before.hash });
    traceable = false;
  }
  return {
    schemaVersion: 1,
    id: gitId(repository, git.head, dirtyContentHash, traceable),
    basis: "git-working-tree",
    repository,
    commit: git.head,
    dirty: dirtyContentHash !== null,
    dirtyContentHash,
    dirtyPaths,
    inputsHash: before.hash,
    traceable,
  };
}

export interface ComputeSourceOptions {
  env?: NodeJS.ProcessEnv;
  /** Workspace-relative paths the plan declares as outputs (never inputs), as for a run. */
  outputs?: string[];
}

/** Source identity of a folder as it is now (a Git checkout with its dirty and untracked files, or a plain folder). */
export function computeSourceIdentity(workspacePath: string, options: ComputeSourceOptions = {}): SourceIdentity {
  const env = options.env ?? process.env;
  // Without a head to snapshot, prepareAnalysis reads the folder in place and never uses the data folder or the run id.
  const prep = prepareAnalysis({ workspacePath, home: "", workspaceId: "", runId: "", env, outputs: options.outputs ?? [] });
  return sourceIdentityOf(prep);
}

/** Source identity of a commit alone (an incremental base or target without local changes). Throws when Git cannot resolve it. */
export function commitSourceIdentity(workspacePath: string, ref: string, env: NodeJS.ProcessEnv = process.env): SourceIdentity {
  const git = gitContext(workspacePath, env);
  if (!git.repository) throw new Error(`${workspacePath} is not a Git work tree`);
  const commit = resolveCommit(git, workspacePath, ref, env);
  if (!commit) throw new Error(`${ref} names no commit`);
  const repository = repositoryOf(git, workspacePath, env);
  return {
    schemaVersion: 1,
    id: gitId(repository, commit, null, true),
    basis: "git-commit",
    repository,
    commit,
    dirty: false,
    dirtyContentHash: null,
    dirtyPaths: 0,
    inputsHash: null,
    traceable: true,
  };
}

/**
 * Source identity derived from the `analyzed` block of a result written before V2. The dirty contents were never
 * recorded, so the identity is marked legacy and never matches a current one (see sourceMatch).
 */
export function sourceFromAnalyzed(analyzed: Partial<AnalyzedState> | null | undefined, workspacePath: string | null): SourceIdentity {
  const a = analyzed ?? {};
  const head = a.snapshot?.commit ?? a.git?.head ?? null;
  const commit = typeof head === "string" && COMMIT.test(head) ? head : null;
  const inputsHash = typeof a.inputs?.hash === "string" && HASH.test(a.inputs.hash) ? a.inputs.hash : null;
  const root = workspacePath ?? (typeof a.path === "string" ? a.path : null);
  const repository: SourceRepository | null =
    a.git?.repository === true && root ? { id: contentHash({ path: path.resolve(root) }), idBasis: "path", root: path.resolve(root), prefix: "" } : null;
  const changes = a.git?.changes ?? null;
  const dirty = typeof a.dirty === "boolean" ? a.dirty : null;
  const traceable = a.inputs?.truncated === false && changes?.truncated !== true && a.stale !== true;
  return {
    schemaVersion: 1,
    id: contentHash({ v: VERSION, legacy: true, repository: repository?.id ?? null, commit, dirty, inputsHash }),
    basis: "legacy-analyzed",
    repository,
    commit,
    dirty,
    dirtyContentHash: null,
    dirtyPaths: changes ? changes.tracked.length + changes.untracked.length : 0,
    inputsHash,
    traceable,
  };
}

export type SourceMatchCode = "SAME_SOURCE" | "DIFFERENT_SOURCE" | "SOURCE_UNTRACEABLE" | "SOURCE_LEGACY";

/** Whether two identities name the same source. Untraceable or legacy identities are never the same as anything. */
export function sourceMatch(a: SourceIdentity, b: SourceIdentity): { same: boolean; code: SourceMatchCode } {
  if (a.basis === "legacy-analyzed" || b.basis === "legacy-analyzed") return { same: false, code: "SOURCE_LEGACY" };
  if (!a.traceable || !b.traceable) return { same: false, code: "SOURCE_UNTRACEABLE" };
  return a.id === b.id ? { same: true, code: "SAME_SOURCE" } : { same: false, code: "DIFFERENT_SOURCE" };
}
