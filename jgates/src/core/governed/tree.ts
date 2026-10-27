// What jgates ci refuses in the analyzed commit before anything runs: a gitlink (submodule), whose files belong to
// another repository and would not be analyzed, and a symbolic link that resolves outside the checkout, through which
// a tool would read (and report) files of the CI machine. Both are read from the commit's tree, never from the work
// tree; the links are resolved component by component, the way the file system would follow them.
import { gitContext, runGit } from "../snapshot/index.js";

export type TreeProblemCode = "CI_SUBMODULE_REFUSED" | "CI_SYMLINK_ESCAPE" | "CI_TREE_UNREADABLE";

export interface TreeProblem {
  code: TreeProblemCode;
  /** Path in the analyzed folder (forward slashes). */
  path: string;
  /** English detail for logs. */
  detail: string;
}

interface Entry {
  mode: string;
  sha: string;
}

const MAX_HOPS = 40;

/** Reads the tree of `commit` (the workspace folder of it) as path -> entry. */
function readTree(projectDir: string, commit: string, env: NodeJS.ProcessEnv): { entries: Map<string, Entry>; git: string; top: string } | TreeProblem {
  const context = gitContext(projectDir, env);
  if (!context.repository) return { code: "CI_TREE_UNREADABLE", path: ".", detail: "the checkout is not a Git work tree" };
  const sub = context.prefix.replace(/\/+$/, "");
  const treeish = sub === "" ? `${commit}^{tree}` : `${commit}:${sub}`;
  const listing = runGit(context.git, ["ls-tree", "-r", "-z", "--full-tree", treeish], context.toplevel, env);
  if (listing.status !== 0) return { code: "CI_TREE_UNREADABLE", path: ".", detail: `git ls-tree failed: ${listing.stderr.trim()}` };
  const entries = new Map<string, Entry>();
  for (const raw of listing.stdout.split("\0")) {
    const tab = raw.indexOf("\t");
    if (tab < 0) continue;
    const [mode = "", , sha = ""] = raw.slice(0, tab).split(" ");
    entries.set(raw.slice(tab + 1), { mode, sha });
  }
  return { entries, git: context.git, top: context.toplevel };
}

/**
 * Follows `rel` through the links of the tree the way the file system would (`linkTarget` gives the raw target of a
 * link, relative to the link's own folder). Returns the resolved path inside the root, or null when it leaves the
 * root (an absolute target, too many "..", a loop).
 */
export function resolveInTree(rel: string, linkTarget: (p: string) => string | null): string | null {
  let pending = rel.split("/").filter((c) => c !== "" && c !== ".");
  const done: string[] = [];
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.shift() as string;
    if (part === "..") {
      if (done.length === 0) return null;
      done.pop();
      continue;
    }
    const candidate = [...done, part].join("/");
    const target = linkTarget(candidate);
    if (target === null) {
      done.push(part);
      continue;
    }
    if (++hops > MAX_HOPS) return null;
    if (target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith("\\")) return null;
    pending = [...target.split(/[\\/]/).filter((c) => c !== "" && c !== "."), ...pending];
  }
  return done.join("/");
}

/** The first gitlink or escaping symlink of the commit, or null when the tree is acceptable. */
export function checkCommitTree(projectDir: string, commit: string, env: NodeJS.ProcessEnv = process.env): TreeProblem | null {
  const read = readTree(projectDir, commit, env);
  if ("code" in read) return read;
  const { entries, git, top } = read;
  const links: string[] = [];
  for (const [p, e] of entries) {
    if (e.mode === "160000") return { code: "CI_SUBMODULE_REFUSED", path: p, detail: `${p} is a gitlink (submodule): its files are not part of the commit` };
    if (e.mode === "120000") links.push(p);
  }
  // The blob of a symlink is its target text.
  const targets = new Map<string, string>();
  for (const p of links) {
    const blob = runGit(git, ["cat-file", "blob", entries.get(p)?.sha ?? ""], top, env);
    if (blob.status !== 0) return { code: "CI_TREE_UNREADABLE", path: p, detail: `git cat-file failed: ${blob.stderr.trim()}` };
    targets.set(p, blob.stdout);
  }
  const linkTarget = (p: string): string | null => targets.get(p) ?? null;
  for (const p of links) {
    // The link itself is the last component: following it resolves its target from its own folder.
    if (resolveInTree(p, linkTarget) === null) return { code: "CI_SYMLINK_ESCAPE", path: p, detail: `${p} points to ${targets.get(p)}, outside the checkout` };
  }
  return null;
}
