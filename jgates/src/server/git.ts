// Branch and commit of the workspace read straight from the .git files. Running `git` in an untrusted repository can
// execute repository-configured programs (fsmonitor, filters), and discovery never executes code (threat A), so the
// dirty flag is not computed here.
import fs from "node:fs";
import path from "node:path";

export interface GitContext {
  root: string;
  branch: string | null;
  detached: boolean;
  commit: string | null;
  dirty: null;
  dirtyReason: "NOT_COMPUTED_WITHOUT_GIT";
}

const MAX_FILE = 64 * 1024;

function readSmall(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The .git directory of `dir` or of its nearest ancestor, following a worktree "gitdir:" file. */
function findGitDir(dir: string): { root: string; gitDir: string } | null {
  let cur = path.resolve(dir);
  for (;;) {
    const candidate = path.join(cur, ".git");
    try {
      const st = fs.statSync(candidate);
      if (st.isDirectory()) return { root: cur, gitDir: candidate };
      if (st.isFile()) {
        const text = readSmall(candidate);
        const m = text ? /^gitdir:\s*(.+?)\s*$/m.exec(text) : null;
        if (m && m[1]) return { root: cur, gitDir: path.resolve(cur, m[1]) };
        return null;
      }
    } catch {
      // Keep going up.
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function resolveRef(gitDir: string, commonDir: string, ref: string): string | null {
  for (const base of [gitDir, commonDir]) {
    const loose = readSmall(path.join(base, ...ref.split("/")));
    const sha = loose?.trim();
    if (sha && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
  }
  const packed = readSmall(path.join(commonDir, "packed-refs"));
  if (packed) {
    for (const line of packed.split(/\r?\n/)) {
      const [sha, name] = line.split(" ");
      if (name === ref && sha && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
    }
  }
  return null;
}

export function readGitContext(dir: string): GitContext | null {
  const found = findGitDir(dir);
  if (!found) return null;
  const { root, gitDir } = found;
  const common = readSmall(path.join(gitDir, "commondir"))?.trim();
  const commonDir = common ? path.resolve(gitDir, common) : gitDir;
  const head = readSmall(path.join(gitDir, "HEAD"))?.trim() ?? "";
  const symbolic = /^ref:\s*(refs\/\S+)$/.exec(head);
  if (symbolic && symbolic[1]) {
    const ref = symbolic[1];
    return {
      root,
      branch: ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref,
      detached: false,
      commit: resolveRef(gitDir, commonDir, ref),
      dirty: null,
      dirtyReason: "NOT_COMPUTED_WITHOUT_GIT",
    };
  }
  return { root, branch: null, detached: true, commit: /^[0-9a-f]{40,64}$/.test(head) ? head : null, dirty: null, dirtyReason: "NOT_COMPUTED_WITHOUT_GIT" };
}
