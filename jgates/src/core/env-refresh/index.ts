// Refreshes the PATH of a long-running process (the UI server) from the OS, so a tool whose installer added a folder
// to the PATH after start-up is found without restarting. Windows only (registry Environment, machine then user); a
// no-op elsewhere. The process's own entries keep their order and come first; new folders are appended.
import { spawn, spawnSync } from "node:child_process";

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

export type AsyncRegistryReader = (hive: "machine" | "user") => Promise<string | null>;

/** The Path value of one registry hive, read with `reg query` without blocking the event loop; null on any failure. */
export function defaultRegistryReaderAsync(hive: "machine" | "user"): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("reg", ["query", KEYS[hive], "/v", "Path"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => child.kill(), 3000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (out += chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      for (const line of out.split(/\r?\n/)) {
        const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line);
        if (m) return resolve(m[1]!.trim());
      }
      resolve(null);
    });
  });
}

let refreshing: Promise<boolean> | null = null;

/**
 * refreshPath for the local server's request handlers: the registry is read asynchronously (both hives at once), so a
 * request never blocks the others while `reg` runs. The same cache window; one read at a time.
 */
export function refreshPathAsync(options: Omit<RefreshOptions, "reader"> & { reader?: AsyncRegistryReader } = {}): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return Promise.resolve(false);
  const now = (options.now ?? Date.now)();
  if (!options.force && now - lastRefresh < (options.ttlMs ?? 5000)) return refreshing ?? Promise.resolve(false);
  if (refreshing) return refreshing;
  lastRefresh = now;
  const env = options.env ?? process.env;
  const reader = options.reader ?? defaultRegistryReaderAsync;
  refreshing = Promise.all([reader("machine"), reader("user")])
    .then((values) => {
      const extras = values.filter((v): v is string => typeof v === "string" && v.length > 0);
      if (extras.length === 0) return true;
      const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
      const merged = mergePath(env[key] ?? "", extras, true, env);
      env.PATH = merged;
      if (key !== "PATH") env[key] = merged;
      return true;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}
