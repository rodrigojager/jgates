// The container runtime the user chose (wizard step 1, Preferências), kept in <JGATES_HOME>/preferences.json under
// `containerRuntime`: "docker", "podman" or the absolute path of another Docker-compatible executable. It belongs to
// the user, not to a project, so the UI server and every CLI command of the same data folder use the same engine.
// JGATES_CONTAINER_RUNTIME still wins over it (CI and tests set it).
import fs from "node:fs";
import path from "node:path";
import { resolveHome } from "../home/index.js";

export const PREFERENCES_FILE = "preferences.json";
export const NAMED_RUNTIMES = ["docker", "podman"] as const;

/** A stored value is accepted only when it is a known name or an absolute path (never a bare word from a damaged file). */
export function validRuntimeValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v === "" || v.length > 1024 || /[\0\r\n]/.test(v)) return false;
  return (NAMED_RUNTIMES as readonly string[]).includes(v) || path.isAbsolute(v) || path.win32.isAbsolute(v);
}

let cache: { file: string; mtimeMs: number; size: number; value: string | null } | null = null;

/** The runtime stored in the preferences of the data folder `home`; null when none was chosen (or the file is unreadable). */
export function readRuntimePreference(home: string): string | null {
  const file = path.join(home, PREFERENCES_FILE);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.value;
  let value: string | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { containerRuntime?: unknown };
    value = validRuntimeValue(parsed.containerRuntime) ? parsed.containerRuntime.trim() : null;
  } catch {
    value = null;
  }
  cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, value };
  return value;
}

export type RuntimeSource = "env" | "preference" | "default";

/** The engine executable and where it came from: JGATES_CONTAINER_RUNTIME, then the user's preference, then docker. */
export function resolveRuntime(env: NodeJS.ProcessEnv = process.env): { runtime: string; source: RuntimeSource } {
  const fromEnv = env.JGATES_CONTAINER_RUNTIME?.trim();
  if (fromEnv) return { runtime: fromEnv, source: "env" };
  let home: string;
  try {
    home = resolveHome({ env });
  } catch {
    return { runtime: "docker", source: "default" };
  }
  const preferred = readRuntimePreference(home);
  return preferred ? { runtime: preferred, source: "preference" } : { runtime: "docker", source: "default" };
}

/** Forgets the cached preference (after the file was written in the same millisecond with the same size). */
export function forgetRuntimePreference(): void {
  cache = null;
}
