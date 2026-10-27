import fs from "node:fs";
import path from "node:path";
import { gitContext, workingTreeStatus } from "../snapshot/git.js";
import type { GitStatusRecord, WorkspaceChangeEntry, WorkspaceChanges, WorkspaceGitStatus } from "./types.js";

// State of the workspace before and after a run: the Git status (tracked changes and
// untracked files that are not ignored) and the manifest of every file outside .git and node_modules, with size and
// modification time. The manifest works for Git and non-Git folders, ignored files included.

/** `git status` of the workspace, or null when it is not a Git work tree (or Git is not installed). */
export function takeGitStatus(root: string, env: NodeJS.ProcessEnv = process.env): GitStatusRecord | null {
  const context = gitContext(root, env);
  const status = workingTreeStatus(context, root, env);
  return status ? { tracked: status.tracked, untracked: status.untracked, truncated: status.truncated } : null;
}

/** Both Git records of a run, and whether the run changed what Git reports. */
export function compareGitStatus(before: GitStatusRecord | null, after: GitStatusRecord | null): WorkspaceGitStatus {
  return {
    repository: before !== null || after !== null,
    before,
    after,
    changed: JSON.stringify(before) !== JSON.stringify(after),
  };
}

const SKIP_DIRS = new Set([".git", "node_modules"]);
export const MANIFEST_LIMIT = 50_000;

export interface Manifest {
  files: Map<string, string>;
  truncated: boolean;
}

export function takeManifest(root: string, limit: number = MANIFEST_LIMIT): Manifest {
  const files = new Map<string, string>();
  let truncated = false;
  const walk = (dir: string): void => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.size >= limit) {
        truncated = true;
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      let stamp = "?";
      try {
        const st = fs.lstatSync(full);
        stamp = `${st.size}:${st.mtimeMs}`;
      } catch {
        // vanished while walking: keep it with an unknown stamp
      }
      files.set(path.relative(root, full).split(path.sep).join("/"), stamp);
    }
  };
  walk(root);
  return { files, truncated };
}

export function diffManifests(before: Manifest, after: Manifest): WorkspaceChanges {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [file, stamp] of after.files) {
    const old = before.files.get(file);
    if (old === undefined) added.push(file);
    else if (old !== stamp) modified.push(file);
  }
  for (const file of before.files.keys()) if (!after.files.has(file)) removed.push(file);
  const out: WorkspaceChanges = { checked: true, added: added.sort(), modified: modified.sort(), removed: removed.sort() };
  if (before.truncated || after.truncated) out.truncated = true;
  return out;
}

/** Remembers, for every path that differs from the starting manifest, the first step after which it differed. */
export class ChangeAttribution {
  private readonly first = new Map<string, string>();
  constructor(
    private readonly start: Manifest,
    private readonly root: string,
  ) {}

  /** Call after each step finishes. */
  afterStep(stepId: string, limit: number = MANIFEST_LIMIT): void {
    const now = takeManifest(this.root, limit);
    const d = diffManifests(this.start, now);
    for (const file of [...d.added, ...d.modified, ...d.removed]) if (!this.first.has(file)) this.first.set(file, stepId);
  }

  entries(final: WorkspaceChanges): WorkspaceChangeEntry[] {
    const out: WorkspaceChangeEntry[] = [];
    for (const [change, files] of [["added", final.added], ["modified", final.modified], ["removed", final.removed]] as const) {
      for (const file of files) out.push({ path: file, change, stage: this.first.get(file) ?? null });
    }
    return out;
  }
}
