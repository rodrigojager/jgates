import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalPath, workspaceId } from "../ids/index.js";

export interface WorkspaceEntry {
  id: string;
  path: string;
  name: string;
  /** ISO timestamp of the last access. */
  lastAccess: string;
  /** Ids of earlier workspaces (the same project at an older path) whose history belongs to this one. */
  linkedFrom?: string[];
  /** Set on an old entry that was relinked: its history now belongs to this workspace. */
  relinkedTo?: string;
}

export interface WorkspaceRegistry {
  schemaVersion: 1;
  workspaces: WorkspaceEntry[];
}

export interface HomeEnv {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Home directory of the user; defaults to os.homedir(). */
  homedir?: string;
}

/**
 * Resolves the JGates data folder (does not create it): JGATES_HOME when set; otherwise
 * %LOCALAPPDATA%\jgates (Windows), ~/Library/Application Support/jgates (macOS) or
 * $XDG_STATE_HOME/jgates with default ~/.local/state/jgates (others).
 */
export function resolveHome(opts: HomeEnv = {}): string {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const homedir = opts.homedir ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
  if (env.JGATES_HOME) return path.resolve(env.JGATES_HOME);
  if (platform === "win32") {
    const base = env.LOCALAPPDATA ?? path.win32.join(homedir, "AppData", "Local");
    return path.win32.join(base, "jgates");
  }
  if (platform === "darwin") return path.join(homedir, "Library", "Application Support", "jgates");
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(homedir, ".local", "state");
  return path.join(state, "jgates");
}

const WORKSPACE_DIRS = ["runs", "cache", "drafts", "snapshots", "locks"] as const;

function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

/** Creates the data folder with owner-only permission (0700 on POSIX) and returns its path. */
export function ensureHome(home: string = resolveHome()): string {
  mkdirPrivate(home);
  mkdirPrivate(path.join(home, "workspaces"));
  return home;
}

export function workspaceDir(home: string, id: string): string {
  return path.join(home, "workspaces", id);
}

/**
 * The originals kept by `jgates pii fix` (workspaces/<id>/pii-fix/<fixId>/): they hold the personal data the fix
 * removed, so the folder is private and short-lived (`jgates gc` deletes them when they expire).
 */
export function piiFixDir(home: string, id: string): string {
  return path.join(workspaceDir(home, id), "pii-fix");
}

/** Creates workspaces/<id> with runs, cache, drafts, snapshots and locks. */
export function ensureWorkspaceDirs(home: string, id: string): string {
  const dir = workspaceDir(home, id);
  mkdirPrivate(dir);
  for (const d of WORKSPACE_DIRS) mkdirPrivate(path.join(dir, d));
  return dir;
}

function registryFile(home: string): string {
  return path.join(home, "workspaces.json");
}

export function readRegistry(home: string = resolveHome()): WorkspaceRegistry {
  const file = registryFile(home);
  if (!fs.existsSync(file)) return { schemaVersion: 1, workspaces: [] };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<WorkspaceRegistry>;
  return { schemaVersion: 1, workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [] };
}

function writeRegistry(home: string, registry: WorkspaceRegistry): void {
  const file = registryFile(home);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export interface RegisterOptions {
  home?: string;
  /** Visible name; defaults to the folder name (or keeps the existing one). */
  name?: string;
  now?: Date;
}

/**
 * Registers a workspace (or refreshes its last access when already registered), creates its folders
 * and returns the entry. The id comes from the canonical real path.
 */
export function registerWorkspace(workspacePath: string, opts: RegisterOptions = {}): WorkspaceEntry {
  const home = ensureHome(opts.home ?? resolveHome());
  const real = canonicalPath(workspacePath);
  const id = workspaceId(workspacePath);
  const registry = readRegistry(home);
  const now = (opts.now ?? new Date()).toISOString();
  let entry = registry.workspaces.find((w) => w.id === id);
  if (entry) {
    entry.lastAccess = now;
    if (opts.name) entry.name = opts.name;
  } else {
    entry = { id, path: real, name: opts.name ?? path.basename(real) ?? real, lastAccess: now };
    registry.workspaces.push(entry);
  }
  ensureWorkspaceDirs(home, id);
  writeRegistry(home, registry);
  return entry;
}

/** Updates the last access of a registered workspace (registers it when unknown). */
export function touchWorkspace(workspacePath: string, opts: RegisterOptions = {}): WorkspaceEntry {
  return registerWorkspace(workspacePath, opts);
}

export function listWorkspaces(home: string = resolveHome()): WorkspaceEntry[] {
  return readRegistry(home).workspaces;
}

/** Creates and returns the folder of a new run: <home>/workspaces/<id>/runs/<runId>. */
export function createRunDir(home: string, id: string, runId: string): string {
  ensureWorkspaceDirs(home, id);
  const dir = path.join(workspaceDir(home, id), "runs", runId);
  mkdirPrivate(dir);
  return dir;
}

export class RelinkError extends Error {
  constructor(
    readonly code: "WORKSPACE_NOT_FOUND" | "RELINK_SAME_WORKSPACE" | "RELINK_CYCLE",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Links the history of an old workspace id to the workspace at `newPath` (registered when unknown): the new
 * workspace then lists the runs of the old one. Nothing is copied or moved.
 */
export function relinkWorkspace(oldId: string, newPath: string, opts: RegisterOptions = {}): WorkspaceEntry {
  const home = opts.home ?? resolveHome();
  if (!readRegistry(home).workspaces.some((w) => w.id === oldId)) throw new RelinkError("WORKSPACE_NOT_FOUND", oldId);
  const target = registerWorkspace(newPath, opts);
  if (target.id === oldId) throw new RelinkError("RELINK_SAME_WORKSPACE", oldId);
  const registry = readRegistry(home);
  const fresh = registry.workspaces.find((w) => w.id === target.id) as WorkspaceEntry;
  const old = registry.workspaces.find((w) => w.id === oldId) as WorkspaceEntry;
  // The old id must not already descend from the new one.
  if (lineageOf(registry, oldId).includes(target.id)) throw new RelinkError("RELINK_CYCLE", oldId);
  if (!fresh.linkedFrom?.includes(oldId)) fresh.linkedFrom = [...(fresh.linkedFrom ?? []), oldId];
  old.relinkedTo = fresh.id;
  writeRegistry(home, registry);
  return fresh;
}

function lineageOf(registry: WorkspaceRegistry, id: string): string[] {
  const seen = new Set<string>();
  const walk = (current: string): void => {
    if (seen.has(current)) return;
    seen.add(current);
    for (const from of registry.workspaces.find((w) => w.id === current)?.linkedFrom ?? []) walk(from);
  };
  walk(id);
  return [...seen];
}

/** The id itself followed by the ids relinked into it (directly or not): the folders its history lives in. */
export function workspaceLineage(home: string, id: string): string[] {
  return lineageOf(readRegistry(home), id);
}

/** Drops entries from the registry (their folders are the caller's business). */
export function removeRegistryEntries(home: string, ids: string[]): void {
  const registry = readRegistry(home);
  const drop = new Set(ids);
  registry.workspaces = registry.workspaces.filter((w) => !drop.has(w.id));
  for (const w of registry.workspaces) {
    if (w.linkedFrom) w.linkedFrom = w.linkedFrom.filter((i) => !drop.has(i));
    if (w.relinkedTo && drop.has(w.relinkedTo)) delete w.relinkedTo;
  }
  writeRegistry(home, registry);
}
