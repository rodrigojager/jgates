// Cache of the local server's project computations (PLAN-performance.md P2, ADR-0010): the inventory (discovery), the
// resolved configuration and the views built from them are computed once and served again while the files they read
// stay the same.
//
// How validity is known. A computation runs synchronously while the cache records every file and folder of the project
// it touches through `fs` (read, listed, stat'ed, looked up): each one is stamped (modification time and size, or
// "missing") just before it is used. An entry is served again only when every stamp still matches, so a file edited by
// hand, a folder that gained or lost an entry, or a configuration file written by the server shows at the next request.
// Files the computation never touched (a source file discovery does not read) never invalidate anything. The server's
// own writes also clear the cache explicitly (invalidateProjectCache), so a write within the clock tick of a read is
// never missed. Nothing outside the given roots is stamped: the built-in catalogue, schemas and templates are part of
// the installed version.
//
// A computation that uses another cached one depends on everything that one read. Values are frozen: whoever reads
// them never changes them. Only the server uses this cache; the CLI computes everything once per command anyway.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverFor, onlyFileProblems, resolveConfig, type ResolveOptions, type ResolveResult } from "../config/resolve/index.js";
import type { Inventory } from "../discovery/types.js";
import { getLocale } from "../../i18n/index.js";

const MAX_ENTRIES = 64;
const caseless = process.platform === "win32";

interface Entry {
  value: unknown;
  /** Path (as recorded) -> signature it had when the computation used it. */
  stamps: Map<string, string>;
}

interface Trace {
  roots: string[];
  stamps: Map<string, string>;
}

const entries = new Map<string, Entry>();
const traces: Trace[] = [];
const counters = { hits: 0, misses: 0, computed: {} as Record<string, number>, invalidations: 0 };

// The unpatched functions, for the stamps (taken while a computation runs, when `fs` is patched).
const realStat = fs.statSync;

/** What a path is now: "-" missing, d:<mtime> a folder, f:<mtime>:<size> a file. */
function signature(abs: string): string {
  let st: fs.Stats | undefined;
  try {
    st = realStat(abs, { throwIfNoEntry: false });
  } catch {
    return "?";
  }
  if (!st) return "-";
  if (st.isDirectory()) return `d:${st.mtimeMs}`;
  if (st.isFile()) return `f:${st.mtimeMs}:${st.size}`;
  return `o:${st.mtimeMs}`;
}

const norm = (p: string): string => {
  const abs = path.resolve(p);
  return caseless ? abs.toLowerCase() : abs;
};

function inside(normalized: string, root: string): boolean {
  return normalized === root || normalized.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function pathArg(arg: unknown): string | null {
  if (typeof arg === "string") return arg;
  if (arg instanceof URL) return arg.protocol === "file:" ? fileURLToPath(arg) : null;
  if (Buffer.isBuffer(arg)) return arg.toString("utf8");
  return null;
}

/** Records `p` (before it is used) in every computation running now whose roots contain it. */
function touch(arg: unknown): void {
  const p = pathArg(arg);
  if (p === null || p === "") return;
  const key = norm(p);
  let sig: string | undefined;
  for (const trace of traces) {
    if (trace.stamps.has(key) || !trace.roots.some((r) => inside(key, r))) continue;
    sig ??= signature(path.resolve(p));
    trace.stamps.set(key, sig);
  }
}

type FsFunction = (...args: unknown[]) => unknown;
const TRACKED = ["readFileSync", "readdirSync", "statSync", "lstatSync", "existsSync", "realpathSync", "openSync", "accessSync", "opendirSync"] as const;
let saved: Map<string, FsFunction> | null = null;

function patch(): void {
  const target = fs as unknown as Record<string, FsFunction>;
  saved = new Map();
  for (const name of TRACKED) {
    const original = target[name];
    if (typeof original !== "function") continue;
    saved.set(name, original);
    const wrapped = function (this: unknown, ...args: unknown[]) {
      touch(args[0]);
      return original.apply(this, args);
    } as FsFunction & { native?: unknown };
    const native = (original as FsFunction & { native?: FsFunction }).native;
    if (typeof native === "function") {
      wrapped.native = function (this: unknown, ...args: unknown[]) {
        touch(args[0]);
        return native.apply(this, args);
      };
    }
    target[name] = wrapped;
  }
}

function unpatch(): void {
  if (!saved) return;
  const target = fs as unknown as Record<string, FsFunction>;
  for (const [name, original] of saved) target[name] = original;
  saved = null;
}

function stillValid(entry: Entry): boolean {
  for (const [key, sig] of entry.stamps) if (signature(key) !== sig) return false;
  return true;
}

function freeze<T>(value: T, seen = new Set<unknown>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child, seen);
  if (value instanceof Map) for (const [k, v] of value) (freeze(k, seen), freeze(v, seen));
  if (value instanceof Set) for (const v of value) freeze(v, seen);
  return Object.freeze(value);
}

/**
 * The value of `key`: from the cache while every file and folder under `roots` that its computation used is unchanged,
 * otherwise computed now by `compute` (synchronous, reads only) and kept. The key names everything else the value
 * depends on (profile, language, mode); the part before the first ":" names the kind of value in the statistics.
 */
export function cachedProject<T>(key: string, roots: readonly string[], compute: () => T): T {
  const id = `${key}\u0000${roots.map(norm).join("\u0000")}`;
  const known = entries.get(id);
  if (known && stillValid(known)) {
    counters.hits++;
    // The computations running now depend on what this one read.
    for (const trace of traces) for (const [k, sig] of known.stamps) if (!trace.stamps.has(k)) trace.stamps.set(k, sig);
    entries.delete(id);
    entries.set(id, known);
    return known.value as T;
  }
  counters.misses++;
  const kind = key.split(":")[0] ?? key;
  counters.computed[kind] = (counters.computed[kind] ?? 0) + 1;
  const trace: Trace = { roots: roots.map(norm), stamps: new Map() };
  if (traces.length === 0) patch();
  traces.push(trace);
  let value: T;
  try {
    value = compute();
  } finally {
    traces.pop();
    if (traces.length === 0) unpatch();
  }
  if (value instanceof Promise) throw new Error(`cachedProject(${kind}): the computation must be synchronous`);
  freeze(value);
  entries.delete(id);
  entries.set(id, { value, stamps: trace.stamps });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  return value;
}

/** After the server wrote into a project: nothing computed before is served again. */
export function invalidateProjectCache(): void {
  entries.clear();
  counters.invalidations++;
}

/** Changes at every invalidation: a caller can tell whether the cache was cleared since it looked. */
export function projectCacheGeneration(): number {
  return counters.invalidations;
}

export interface ProjectCacheStats {
  hits: number;
  misses: number;
  /** Computations by kind (the key's prefix): inventory, resolve, config-view... */
  computed: Record<string, number>;
  invalidations: number;
  entries: number;
}

export function projectCacheStats(): ProjectCacheStats {
  return { hits: counters.hits, misses: counters.misses, computed: { ...counters.computed }, invalidations: counters.invalidations, entries: entries.size };
}

/** The roots a project computation reads: the project and, when it is elsewhere, the configuration folder. */
function rootsOf(projectDir: string, configDir?: string): string[] {
  const dir = path.resolve(projectDir);
  return configDir === undefined || path.resolve(configDir) === dir ? [dir] : [dir, path.resolve(configDir)];
}

/** The inventory (discovery) of a project, computed once while the files discovery read stay the same. */
export function projectInventory(projectDir: string, configDir?: string): Inventory {
  return cachedProject(`inventory:${configDir ?? ""}`, rootsOf(projectDir, configDir), () => discoverFor(projectDir, configDir));
}

export type ProjectResolveOptions = Pick<ResolveOptions, "profile" | "configDir" | "templates">;

/** The resolved configuration of a project (with its cached inventory), computed once while its inputs stay the same. */
export function projectResolve(projectDir: string, options: ProjectResolveOptions = {}): ResolveResult {
  // The messages of the issues are in the process language.
  const key = `resolve:${JSON.stringify([options.profile ?? null, options.configDir ?? null, options.templates ?? [], getLocale()])}`;
  return cachedProject(key, rootsOf(projectDir, options.configDir), () =>
    resolveConfig(projectDir, {
      ...options,
      inventory: projectInventory(projectDir, options.configDir),
    }),
  );
}

export { onlyFileProblems };

/**
 * The resolved configuration a screen shows (ADR-0009: the screens show what the files hold): the strict one or, when
 * the only problem is a file the schema refuses (a key it does not know, a value out of its set), the lenient one. That
 * one keeps `ok: false` and CONFIG_INVALID, and its `diagnostics` say file, key and line; a run still refuses it.
 */
export function projectResolveReadable(projectDir: string, options: ProjectResolveOptions = {}): ResolveResult {
  const strict = projectResolve(projectDir, options);
  if (!onlyFileProblems(strict)) return strict;
  const key = `resolve-lenient:${JSON.stringify([options.profile ?? null, options.configDir ?? null, options.templates ?? [], getLocale()])}`;
  return cachedProject(key, rootsOf(projectDir, options.configDir), () =>
    resolveConfig(projectDir, {
      ...options,
      lenient: true,
      inventory: projectInventory(projectDir, options.configDir),
    }),
  );
}

/** The problems of the files (file, key, line) a view built from a lenient resolution carries; empty when valid. */
export function fileDiagnostics(result: ResolveResult): Array<{ code: string; file: string; path: string; message: string; suggestion?: string; line?: number; column?: number }> {
  if (result.ok) return [];
  return result.diagnostics.map((d) => ({ code: d.code, file: d.file, path: d.path, message: d.message, ...(d.suggestion ? { suggestion: d.suggestion } : {}), ...(d.line ? { line: d.line } : {}), ...(d.column ? { column: d.column } : {}) }));
}
