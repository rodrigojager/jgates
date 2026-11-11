// The non-engine part of `jgates uninstall`: the data folder, the key store and the command that removes the CLI itself.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRegistry } from "../home/index.js";
import { vaultDir, vaultPath } from "../secrets/index.js";
import { describeInstallation, findPackageDir } from "../update/index.js";
import { folderBytes } from "./plan.js";

/** Entries that mark a folder as a JGates data folder. */
const HOME_MARKERS = ["workspaces", "workspaces.json", "preferences.json", "tools", "cache", "toolchains.json", "data-status.json", "codeql-terms.json"];
/** What `--keep-config-notes` leaves in the data folder: the preferences and the registry of known projects. */
export const KEPT_CONFIG = ["preferences.json", "workspaces.json"];

export interface HomeVerdict {
  ok: boolean;
  /** Why the folder is refused (a fixed code; the command words it). */
  code: "OK" | "MISSING" | "NOT_A_JGATES_FOLDER" | "TOO_BROAD" | "HOLDS_A_PROJECT" | "IS_A_LINK";
  detail: string;
}

const inside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Whether `home` is safe to remove: a real JGates data folder, not a root, not the user's home, holding no registered project. */
export function checkHome(home: string): HomeVerdict {
  const dir = path.resolve(home);
  if (!fs.existsSync(dir)) return { ok: false, code: "MISSING", detail: dir };
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return { ok: false, code: "IS_A_LINK", detail: dir };
  } catch {
    return { ok: false, code: "MISSING", detail: dir };
  }
  const real = fs.realpathSync(dir);
  const broad = [path.parse(real).root, os.homedir(), process.cwd()].map((p) => path.resolve(p));
  if (broad.some((b) => inside(real, b))) return { ok: false, code: "TOO_BROAD", detail: dir };
  const names = fs.readdirSync(real);
  if (names.length > 0 && !names.some((n) => HOME_MARKERS.includes(n))) return { ok: false, code: "NOT_A_JGATES_FOLDER", detail: dir };
  try {
    for (const w of readRegistry(real).workspaces) {
      if (w.path && inside(real, path.resolve(w.path))) return { ok: false, code: "HOLDS_A_PROJECT", detail: w.path };
    }
  } catch {
    // an unreadable registry does not make the folder unsafe by itself
  }
  return { ok: true, code: "OK", detail: dir };
}

export interface HomeRemoval {
  removed: boolean;
  /** Entries left on purpose (--keep-config-notes). */
  kept: string[];
  details?: string;
}

/** Removes the data folder (runs, history, drafts, preferences...), or everything but the kept entries. */
export function removeHome(home: string, keep: readonly string[] = []): HomeRemoval {
  const verdict = checkHome(home);
  if (!verdict.ok) return { removed: false, kept: [], details: `${verdict.code}: ${verdict.detail}` };
  const dir = fs.realpathSync(path.resolve(home));
  try {
    if (keep.length === 0) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { removed: true, kept: [] };
    }
    const kept: string[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (keep.includes(name)) {
        kept.push(name);
        continue;
      }
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
    return { removed: true, kept };
  } catch (error) {
    return { removed: false, kept: [], details: error instanceof Error ? error.message : String(error) };
  }
}

export const homeBytes = (home: string): number => (fs.existsSync(home) ? folderBytes(home) : 0);

export interface KeyStoreFacts {
  path: string;
  exists: boolean;
}

/** The user's key store (outside the data folder: the semantic-gate configuration folder). */
export function keyStoreFacts(env: NodeJS.ProcessEnv = process.env): KeyStoreFacts {
  const file = vaultPath(env);
  return { path: file, exists: fs.existsSync(file) };
}

/** Deletes the key store file (and its folder when that leaves it empty). Only after the separate confirmation. */
export function removeKeyStore(env: NodeJS.ProcessEnv = process.env): { removed: boolean; details?: string } {
  const file = vaultPath(env);
  try {
    fs.rmSync(file, { force: true });
    const dir = vaultDir(env);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    return { removed: true };
  } catch (error) {
    return { removed: false, details: error instanceof Error ? error.message : String(error) };
  }
}

export interface CliRemoval {
  kind: "global" | "dependency" | "clone" | "unknown";
  /** The command that removes the CLI, or null when it is a folder to delete by hand. */
  command: string | null;
  /** Clone: the folder to delete. */
  folder: string | null;
}

/** The package-manager command that removes this CLI (JGates never removes itself). */
export function cliRemoval(): CliRemoval {
  const dir = findPackageDir();
  if (!dir) return { kind: "unknown", command: "npm uninstall -g jgates", folder: null };
  const installed = describeInstallation(dir);
  if (installed.kind === "global") return { kind: "global", command: "npm uninstall -g jgates", folder: null };
  if (installed.kind === "dependency") return { kind: "dependency", command: "npm uninstall jgates", folder: null };
  return { kind: "clone", command: null, folder: installed.packageDir };
}
