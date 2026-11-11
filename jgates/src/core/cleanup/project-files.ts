// Files JGates left inside projects (jgates.yml, .jgates/, the pre-commit hook). Uninstall lists them and how to remove
// each one; it never touches them: a project is the person's, not JGates's.
import fs from "node:fs";
import path from "node:path";
import { readRegistry } from "../home/index.js";

/** The mark `jgates hooks install pre-commit` writes in the hook (hooks.ts HOOK_MARK). */
const HOOK_MARK = "# jgates-hook: pre-commit";

export interface ProjectFile {
  path: string;
  kind: "config" | "folder" | "hook";
  /** The command that removes it (a hook), or null: delete it by hand if you no longer want it. */
  removeCommand: string | null;
}

export interface ProjectFiles {
  workspace: string | null;
  path: string;
  files: ProjectFile[];
}

function quoted(p: string): string {
  return /[\s"']/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p;
}

/** The project files JGates wrote in the registered projects of this data folder and in `extra` (the current folder). */
export function listProjectFiles(home: string, extra: string[] = []): ProjectFiles[] {
  const entries = readRegistry(home).workspaces.filter((w) => !w.relinkedTo);
  const seen = new Set<string>();
  const projects: Array<{ workspace: string | null; dir: string }> = [];
  // The same folder can be spelled two ways (a short Windows name, a link): compare real paths.
  const keyOf = (dir: string): string => {
    try {
      return fs.realpathSync.native(dir);
    } catch {
      return dir;
    }
  };
  for (const w of entries) {
    const dir = path.resolve(w.path);
    if (!seen.has(keyOf(dir))) {
      seen.add(keyOf(dir));
      projects.push({ workspace: w.id, dir });
    }
  }
  for (const e of extra) {
    const dir = path.resolve(e);
    if (!seen.has(keyOf(dir))) {
      seen.add(keyOf(dir));
      projects.push({ workspace: null, dir });
    }
  }
  const out: ProjectFiles[] = [];
  for (const p of projects) {
    const files: ProjectFile[] = [];
    const yml = path.join(p.dir, "jgates.yml");
    if (fs.existsSync(yml)) files.push({ path: yml, kind: "config", removeCommand: null });
    const folder = path.join(p.dir, ".jgates");
    if (fs.existsSync(folder)) files.push({ path: folder, kind: "folder", removeCommand: null });
    const hook = path.join(p.dir, ".git", "hooks", "pre-commit");
    try {
      if (fs.existsSync(hook) && fs.readFileSync(hook, "utf8").includes(HOOK_MARK)) files.push({ path: hook, kind: "hook", removeCommand: `jgates hooks uninstall pre-commit --cwd ${quoted(p.dir)}` });
    } catch {
      // unreadable hook: not listed
    }
    if (files.length > 0) out.push({ workspace: p.workspace, path: p.dir, files });
  }
  return out;
}
