// Snapshot of another commit: the files of the commit are written to a folder of the data
// folder (JGATES_HOME/workspaces/<id>/snapshots/), never by checkout or reset in the user's work tree. The commit is
// read into a private index file next to the snapshot (GIT_INDEX_FILE) and checked out from it with
// `checkout-index --prefix`: the repository's own index, HEAD and work tree are not touched, and Git applies the
// same filters (end of line, LFS smudge when installed) it would apply to a checkout.
import fs from "node:fs";
import path from "node:path";
import { runGit, type GitContext } from "./git.js";

export interface NotMaterialized {
  path: string;
  /** submodule: a gitlink, its files are not part of the snapshot; lfs-pointer: the LFS object was not fetched. */
  kind: "submodule" | "lfs-pointer";
}

export interface CommitSnapshot {
  kind: "git-commit";
  path: string;
  commit: string;
  /** Tree of the workspace folder in that commit. */
  tree: string;
  notMaterialized: NotMaterialized[];
}

export class SnapshotError extends Error {
  constructor(
    readonly code: "NOT_A_GIT_REPOSITORY" | "GIT_UNAVAILABLE" | "SNAPSHOT_PATH_MISSING" | "SNAPSHOT_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "SnapshotError";
  }
}

/** Snapshots folder of a workspace in the data folder. */
export function snapshotsDir(home: string, workspaceId: string): string {
  return path.join(home, "workspaces", workspaceId, "snapshots");
}

/** Removes a snapshot folder (and its index file, if one was left behind). */
export function removeSnapshot(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  fs.rmSync(`${dir}.index`, { force: true });
}

/**
 * Writes the files of `commit` (the workspace folder of it, when the workspace is a subfolder of the repository) to
 * `dest`, which must not exist. Throws SnapshotError when Git cannot do it; nothing is left at `dest` then.
 */
export function materializeCommit(context: GitContext, commit: string, dest: string, env: NodeJS.ProcessEnv = process.env): CommitSnapshot {
  if (!context.available) throw new SnapshotError("GIT_UNAVAILABLE", "git was not found");
  if (!context.repository) throw new SnapshotError("NOT_A_GIT_REPOSITORY", "the workspace is not inside a Git work tree");
  const top = context.toplevel;
  const sub = context.prefix.replace(/\/+$/, "");
  const treeish = sub === "" ? `${commit}^{tree}` : `${commit}:${sub}`;
  const type = runGit(context.git, ["cat-file", "-t", treeish], top, env);
  if (type.status !== 0 || type.stdout.trim() !== "tree") throw new SnapshotError("SNAPSHOT_PATH_MISSING", `${sub || "."} does not exist in ${commit}`);
  const tree = runGit(context.git, ["rev-parse", "--verify", "--quiet", treeish], top, env).stdout.trim();

  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.mkdirSync(dest, { mode: 0o700 });
  const indexFile = `${dest}.index`;
  const withIndex = { GIT_INDEX_FILE: indexFile };
  try {
    const read = runGit(context.git, ["read-tree", tree], top, env, withIndex);
    if (read.status !== 0) throw new SnapshotError("SNAPSHOT_FAILED", `git read-tree failed: ${read.stderr.trim()}`);
    const prefix = dest.split(path.sep).join("/").replace(/\/?$/, "/");
    const out = runGit(context.git, ["checkout-index", "--all", "--force", `--prefix=${prefix}`], top, env, withIndex);
    if (out.status !== 0) throw new SnapshotError("SNAPSHOT_FAILED", `git checkout-index failed: ${out.stderr.trim()}`);
  } catch (error) {
    removeSnapshot(dest);
    throw error;
  } finally {
    fs.rmSync(indexFile, { force: true });
  }

  // Gitlinks (submodules) are not materialized: their content belongs to another repository.
  const notMaterialized: NotMaterialized[] = [];
  const listing = runGit(context.git, ["ls-tree", "-r", "-z", tree], top, env);
  for (const entry of listing.stdout.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    if (entry.startsWith("160000 ")) notMaterialized.push({ path: entry.slice(tab + 1), kind: "submodule" });
  }
  return { kind: "git-commit", path: dest, commit, tree, notMaterialized };
}
