// Refreshes the PATH of a long-running process (the UI server) from the OS, so a tool whose installer added a folder
// to the PATH after start-up is found without restarting. Windows only (registry Environment, machine then user); a
// no-op elsewhere. The process's own entries keep their order and come first; new folders are appended.
import { spawnSync } from "node:child_process";

export type RegistryReader = (hive: "machine" | "user") => string | null;

export interface RefreshOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  reader?: RegistryReader;
  /** Clock in ms, injectable for tests. */
  now?: () => number;
  /** Cache window in ms (default 5000). */
  ttlMs?: number;
  /** Ignore the cache window. */
  force?: boolean;
}

const KEYS = {
  machine: "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  user: "HKCU\\Environment",
} as const;

/** Reads the Path value of one registry hive with `reg query`; null when absent or on any failure. */
export function defaultRegistryReader(hive: "machine" | "user"): string | null {
  try {
    const r = spawnSync("reg", ["query", KEYS[hive], "/v", "Path"], { encoding: "utf8", windowsHide: true, timeout: 3000 });
    if (r.status !== 0 || typeof r.stdout !== "string") return null;
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line);
      if (m) return m[1]!.trim();
    }
  } catch {
    // fall through
  }
  return null;
}

/** Expands %VAR% references from `env` (case-insensitive); unknown variables are left as they are. */
export function expandVars(value: string, env: NodeJS.ProcessEnv): string {
  const lookup = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) if (v !== undefined) lookup.set(k.toLowerCase(), v);
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => lookup.get(name.toLowerCase()) ?? whole);
}

function normalize(entry: string, windows: boolean): string {
  let e = entry.trim().replace(/^"(.*)"$/, "$1");
  if (windows) e = e.replace(/[\\/]+$/, "").toLowerCase();
  return e;
}

/** Merges PATH strings: `current` entries first and in order, then new entries of `extra`, without duplicates. */
export function mergePath(current: string, extras: string[], windows: boolean, env: NodeJS.ProcessEnv = {}): string {
  const sep = windows ? ";" : ":";
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string, expand: boolean): void => {
    for (const part of raw.split(sep)) {
      const value = (expand ? expandVars(part, env) : part).trim();
      if (!value) continue;
      const key = normalize(value, windows);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
  };
  add(current, false);
  for (const extra of extras) add(extra, true);
  return out.join(sep);
}

let lastRefresh = Number.NEGATIVE_INFINITY;

/** Resets the cache window (tests). */
export function resetPathRefreshCache(): void {
  lastRefresh = Number.NEGATIVE_INFINITY;
}

/**
 * Updates env.PATH (and env.Path on Windows) with the folders the OS now lists. Returns true when it read the
 * registry, false when skipped (not Windows, or inside the cache window).
 */
export function refreshPath(options: RefreshOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return false;
  const now = (options.now ?? Date.now)();
  if (!options.force && now - lastRefresh < (options.ttlMs ?? 5000)) return false;
  lastRefresh = now;
  const env = options.env ?? process.env;
  const reader = options.reader ?? defaultRegistryReader;
  const extras = [reader("machine"), reader("user")].filter((v): v is string => typeof v === "string" && v.length > 0);
  if (extras.length === 0) return true;
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const merged = mergePath(env[key] ?? "", extras, true, env);
  env.PATH = merged;
  if (key !== "PATH") env[key] = merged;
  return true;
}
