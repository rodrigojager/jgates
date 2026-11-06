// What the application shell shows: version, mode, branch and commit (with the dirty mark), the run counter, the run in
// progress and the workspaces known to this user. Opening another workspace starts (or reuses) the server of that
// workspace and hands back a one-time link: a session serves exactly one workspace.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT_FILE } from "../../core/config/load/index.js";
import { readRegistry, workspaceDir, workspaceLineage, type WorkspaceEntry } from "../../core/home/index.js";
import { resolveGit, runGit } from "../../core/snapshot/git.js";
import { translator } from "../../i18n/index.js";
import { HttpError } from "../http.js";
import { modeOf, policyEditingDir } from "../policy-mode.js";
import { readGitContext } from "../git.js";
import { UiError, launchUi, type LaunchOutcome } from "../index.js";
import type { RouteDefinition, ServerContext } from "../types.js";

const t = translator("shell");

export { modeOf };

/**
 * Uncommitted change in the work tree (tracked changes or untracked files that are not ignored). Read-only Git, with
 * the repository-configured file system monitor off so reading the status never runs a program of the repository.
 */
export function isDirty(dir: string, env: NodeJS.ProcessEnv = process.env): boolean | null {
  const git = resolveGit(env);
  if (!git) return null;
  const r = runGit(git, ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=dirty", "--", "."], dir, env);
  if (r.status !== 0) return null;
  return r.stdout.trim() !== "";
}

function countRuns(server: ServerContext): number {
  let count = 0;
  for (const id of workspaceLineage(server.home, server.workspace.id)) {
    try {
      for (const entry of fs.readdirSync(path.join(workspaceDir(server.home, id), "runs"), { withFileTypes: true })) if (entry.isDirectory()) count++;
    } catch {
      // No runs folder yet.
    }
  }
  return count;
}

function knownWorkspaces(server: ServerContext): Array<Record<string, unknown>> {
  return readRegistry(server.home)
    .workspaces.filter((w) => !w.relinkedTo)
    .sort((a, b) => (a.lastAccess < b.lastAccess ? 1 : -1))
    .map((w) => {
      const exists = isDirectory(w.path);
      const git = exists ? readGitContext(w.path) : null;
      return { id: w.id, name: w.name, path: w.path, lastAccess: w.lastAccess, current: w.id === server.workspace.id, exists, branch: git?.branch ?? null };
    });
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The one-time bootstrap link inside a launcher file (the secret never travels any other way). */
function bootstrapUrl(launcher: string): string | null {
  try {
    const html = fs.readFileSync(launcher, "utf8");
    const match = html.match(/https?:\/\/[^"'<>\s]*\/session\/bootstrap\?token=[A-Za-z0-9_\-%.~]+/);
    return match ? match[0].replace(/&amp;/g, "&") : null;
  } catch {
    return null;
  }
}

// Servers started here for other workspaces live as long as this process; they stop with it.
const opened: Array<Extract<LaunchOutcome, { kind: "started" }>> = [];
let stopHooked = false;
function hookStop(): void {
  if (stopHooked) return;
  stopHooked = true;
  const stopAll = () => void Promise.all(opened.splice(0).map((o) => o.stop().catch(() => undefined)));
  process.once("SIGINT", stopAll);
  process.once("SIGTERM", stopAll);
  if (process.platform === "win32") process.once("SIGBREAK", stopAll);
}

const MAX_BROWSE = 500;

/** Where browsing starts: the drives on Windows, the root elsewhere, and the user's home folder. */
function browseRoots(): string[] {
  if (process.platform !== "win32") return ["/"];
  const drives: string[] = [];
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    const root = `${letter}:\\`;
    if (isDirectory(root)) drives.push(root);
  }
  return drives;
}

/**
 * The folders inside one folder, for the folder picker of the workspace dialog: names only (never a file or its
 * contents), hidden and system folders left out, the ones already set up for JGates or Git marked. A browser cannot
 * hand a page the absolute path of a folder it picks, so the local server lists them; a session can already open any
 * folder by its path, so this shows nothing it could not reach.
 */
function browse(dir: string): Record<string, unknown> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new HttpError(403, "FOLDER_UNREADABLE", t("shell_browse_unreadable", { path: dir }), t("shell_browse_unreadable_fix"));
  }
  const folders = entries
    .filter((e) => !e.name.startsWith(".") && !e.name.startsWith("$") && e.name !== "System Volume Information")
    .filter((e) => e.isDirectory() || (e.isSymbolicLink() && isDirectory(path.join(dir, e.name))))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  const shown = folders.slice(0, MAX_BROWSE).map((name) => {
    const full = path.join(dir, name);
    return { name, path: full, configured: fs.existsSync(path.join(full, ROOT_FILE)), repository: fs.existsSync(path.join(full, ".git")) };
  });
  const parent = path.dirname(dir);
  return {
    schemaVersion: 1,
    status: "OK",
    path: dir,
    parent: parent === dir ? null : parent,
    roots: browseRoots(),
    home: os.homedir(),
    separator: path.sep,
    configured: fs.existsSync(path.join(dir, ROOT_FILE)),
    entries: shown,
    truncated: folders.length > MAX_BROWSE,
  };
}

function target(server: ServerContext, body: { id?: string; path?: string }): WorkspaceEntry | string {
  if (body.id !== undefined) {
    const entry = readRegistry(server.home).workspaces.find((w) => w.id === body.id && !w.relinkedTo);
    if (!entry) throw new HttpError(404, "WORKSPACE_NOT_FOUND", t("shell_workspace_not_found"), t("shell_workspace_not_found_fix"));
    if (!isDirectory(entry.path)) throw new HttpError(404, "WORKSPACE_MISSING", t("shell_workspace_missing", { path: entry.path }), t("shell_workspace_missing_fix"));
    return entry;
  }
  const dir = path.resolve(body.path as string);
  if (!isDirectory(dir)) throw new HttpError(400, "WORKSPACE_NOT_DIRECTORY", t("shell_workspace_not_directory", { path: dir }), t("shell_workspace_not_directory_fix"));
  return dir;
}

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/shell",
    handler({ server }) {
      const git = readGitContext(server.projectDir);
      const active = server.runs.active;
      const { mode, governed } = modeOf();
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          version: server.version,
          mode,
          governed,
          policyMode: policyEditingDir() !== null,
          workspace: { ...server.workspace, configured: fs.existsSync(path.join(server.projectDir, ROOT_FILE)) },
          git: git ? { branch: git.branch, detached: git.detached, commit: git.commit, dirty: isDirty(server.projectDir) } : null,
          runs: { count: countRuns(server), active: active ? { id: active.id, startedAt: active.startedAt } : null },
          workspaces: knownWorkspaces(server),
        },
      };
    },
  },
  {
    method: "GET",
    path: "/api/workspaces",
    handler({ server }) {
      return { status: 200, json: { schemaVersion: 1, status: "OK", workspaces: knownWorkspaces(server) } };
    },
  },
  {
    // The folder picker: the subfolders of `path` (the parent of the current workspace when absent).
    method: "GET",
    path: "/api/workspaces/browse",
    query: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 4096 } }, additionalProperties: false },
    handler({ query, server }) {
      if (policyEditingDir() !== null) throw new HttpError(403, "POLICY_MODE", t("shell_browse_policy"), t("shell_browse_policy_fix"));
      const asked = query.path !== undefined ? path.resolve(query.path) : path.dirname(server.projectDir);
      if (!isDirectory(asked)) throw new HttpError(400, "WORKSPACE_NOT_DIRECTORY", t("shell_workspace_not_directory", { path: asked }), t("shell_workspace_not_directory_fix"));
      // The path as the disk spells it (on Windows the registry may keep it in lower case).
      let dir = asked;
      try {
        dir = fs.realpathSync.native(asked);
      } catch {
        dir = asked;
      }
      return { status: 200, json: browse(dir) };
    },
  },
  {
    method: "POST",
    path: "/api/workspaces/open",
    body: {
      type: "object",
      properties: { id: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,128}$" }, path: { type: "string", minLength: 1, maxLength: 4096 } },
      // Exactly one of the two: a registered id, or a folder path.
      minProperties: 1,
      maxProperties: 1,
      additionalProperties: false,
    },
    timeoutMs: 20_000,
    async handler({ body, server }) {
      const picked = target(server, body as { id?: string; path?: string });
      const projectDir = typeof picked === "string" ? picked : picked.path;
      let outcome: LaunchOutcome;
      try {
        outcome = await launchUi({ projectDir, version: server.version, home: server.home });
      } catch (error) {
        if (error instanceof UiError) throw new HttpError(409, "WORKSPACE_OPEN_FAILED", t("shell_open_failed", { code: error.code }), t("shell_open_failed_fix"));
        throw error;
      }
      if (outcome.kind === "started") {
        opened.push(outcome);
        hookStop();
      }
      const url = bootstrapUrl(outcome.launcher);
      if (!url) throw new HttpError(500, "LAUNCHER_UNREADABLE", t("shell_open_failed", { code: "LAUNCHER" }), t("shell_open_failed_fix"));
      server.log(`workspace opened ${outcome.workspace.id}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", url, reused: outcome.kind === "reused", workspace: outcome.workspace } };
    },
  },
];
