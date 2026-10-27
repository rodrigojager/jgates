// The originals `jgates pii fix` replaced, kept for `jgates pii fix --undo`: <home>/workspaces/<id>/pii-fix/<fixId>/
// with manifest.json and originals/<path>. They hold the personal data the fix removed, so the folders are 0700, the
// files 0600, and they live only until the expiry written at fix time (fix.backupRetentionDays, 7 days by default);
// `jgates gc --yes` deletes the expired ones. Nothing here follows a link.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { piiFixDir } from "../home/index.js";

export const FIX_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/;
/** The temporary copies of running fixes, under pii-fix/; one older than this is left over from a crash. */
export const WORK_DIR = ".work";
const WORK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface FixFileRecord {
  path: string;
  /** Permission bits of the original file. */
  mode: number;
  originalSha256: string;
  fixedSha256: string;
}

export interface FixManifest {
  schemaVersion: 1;
  fixId: string;
  createdAt: string;
  expiresAt: string;
  workspacePath: string;
  scope: string;
  /** The fix ran with --staged: the files went back to the index, and so does the undo. */
  staged: boolean;
  tools: string[];
  counts: Record<string, number>;
  files: FixFileRecord[];
}

export const sha256 = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");

function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

export function newFixId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export function expiryOf(now: Date, retentionDays: number): string {
  return new Date(now.getTime() + retentionDays * DAY_MS).toISOString();
}

/** The folder the temporary copy of a fix goes in (created private). */
export function workRoot(home: string, workspaceId: string): string {
  const dir = path.join(piiFixDir(home, workspaceId), WORK_DIR);
  mkdirPrivate(dir);
  return dir;
}

export interface BackupWriter {
  dir: string;
  saveOriginal(file: string, bytes: Buffer): void;
  writeManifest(manifest: FixManifest): void;
  remove(): void;
}

export function createBackup(home: string, workspaceId: string, fixId: string): BackupWriter {
  if (!FIX_ID.test(fixId)) throw new Error(`invalid fix id: ${fixId}`);
  const dir = path.join(piiFixDir(home, workspaceId), fixId);
  mkdirPrivate(path.dirname(dir));
  fs.mkdirSync(dir, { mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  return {
    dir,
    saveOriginal(file, bytes) {
      const target = path.join(dir, "originals", ...file.split("/"));
      mkdirPrivate(path.dirname(target));
      fs.writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
    },
    writeManifest(manifest) {
      const target = path.join(dir, "manifest.json");
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, target);
    },
    remove() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function readOriginal(home: string, workspaceId: string, fixId: string, file: string): Buffer {
  return fs.readFileSync(path.join(piiFixDir(home, workspaceId), fixId, "originals", ...file.split("/")));
}

function readManifest(dir: string): FixManifest | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as FixManifest;
    return value && value.schemaVersion === 1 && FIX_ID.test(value.fixId) && Array.isArray(value.files) ? value : null;
  } catch {
    return null;
  }
}

/** The fixes kept for a workspace, newest first. */
export function listFixes(home: string, workspaceId: string): FixManifest[] {
  const root = piiFixDir(home, workspaceId);
  let names: string[];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && FIX_ID.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
  return names
    .map((name) => readManifest(path.join(root, name)))
    .filter((m): m is FixManifest => m !== null)
    .sort((a, b) => (a.fixId < b.fixId ? 1 : a.fixId > b.fixId ? -1 : 0));
}

export function readFix(home: string, workspaceId: string, fixId: string): FixManifest | null {
  if (!FIX_ID.test(fixId)) return null;
  return readManifest(path.join(piiFixDir(home, workspaceId), fixId));
}

export function writeFixManifest(home: string, workspaceId: string, manifest: FixManifest): void {
  const target = path.join(piiFixDir(home, workspaceId), manifest.fixId, "manifest.json");
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function removeFix(home: string, workspaceId: string, fixId: string): void {
  if (!FIX_ID.test(fixId)) return;
  fs.rmSync(path.join(piiFixDir(home, workspaceId), fixId), { recursive: true, force: true });
}

// ---- retention (jgates gc) ---------------------------------------------------------------------------------------------

export interface ExpiredBackup {
  workspaceId: string;
  /** The fix id, or ".work/<name>" for a temporary copy left over from a crash. */
  fixId: string;
  expiresAt: string | null;
  bytes: number;
  dir: string;
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Bytes under a folder, without following links. */
function sizeOf(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) total += sizeOf(child);
    else if (entry.isFile()) total += fs.lstatSync(child).size;
  }
  return total;
}

/**
 * The originals whose expiry passed (an unreadable manifest counts from the folder's time with the default retention)
 * and the temporary copies older than a day. `workspaceId` limits the search to one workspace.
 */
export function planPiiFixRetention(home: string, now: number = Date.now(), workspaceId?: string, defaultRetentionDays = 7): ExpiredBackup[] {
  const out: ExpiredBackup[] = [];
  const ids = workspaceId ? [workspaceId] : safeReaddir(path.join(home, "workspaces"));
  for (const id of ids) {
    const root = piiFixDir(home, id);
    let rootStat: fs.Stats;
    try {
      rootStat = fs.lstatSync(root);
    } catch {
      continue;
    }
    if (!rootStat.isDirectory()) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const dir = path.join(root, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === WORK_DIR) {
        for (const work of fs.readdirSync(dir, { withFileTypes: true })) {
          const workDir = path.join(dir, work.name);
          if (!work.isDirectory()) continue;
          if (now - fs.lstatSync(workDir).mtimeMs > WORK_MAX_AGE_MS) out.push({ workspaceId: id, fixId: `${WORK_DIR}/${work.name}`, expiresAt: null, bytes: sizeOf(workDir), dir: workDir });
        }
        continue;
      }
      if (!FIX_ID.test(entry.name)) continue;
      const manifest = readManifest(dir);
      const expires = manifest ? Date.parse(manifest.expiresAt) : fs.lstatSync(dir).mtimeMs + defaultRetentionDays * DAY_MS;
      if (!Number.isFinite(expires) || expires <= now) {
        out.push({ workspaceId: id, fixId: entry.name, expiresAt: manifest && Number.isFinite(expires) ? manifest.expiresAt : null, bytes: sizeOf(dir), dir });
      }
    }
  }
  return out.sort((a, b) => (a.workspaceId + a.fixId < b.workspaceId + b.fixId ? -1 : 1));
}

export function applyPiiFixRetention(home: string, expired: readonly ExpiredBackup[]): { removed: ExpiredBackup[]; freedBytes: number } {
  const removed: ExpiredBackup[] = [];
  const base = path.resolve(home, "workspaces") + path.sep;
  for (const item of expired) {
    // Only folders inside the data folder, never through a link.
    if (!path.resolve(item.dir).startsWith(base)) continue;
    try {
      if (fs.lstatSync(item.dir).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    fs.rmSync(item.dir, { recursive: true, force: true });
    removed.push(item);
  }
  return { removed, freedBytes: removed.reduce((n, r) => n + r.bytes, 0) };
}
