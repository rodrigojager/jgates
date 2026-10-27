// Shared cache of a scanner's database (the vulnerability database of Trivy) in the data folder, between runs:
// <JGATES_HOME>/tools/cache/<name>/ holds the database files and jgates-cache.json, the record of where the copy came
// from and when (source, updatedAt, nextUpdate, downloadedAt, storedAt, lastUsedAt).
//
// Before a run, a copy that is still fresh (its nextUpdate is in the future) is linked into the run's output mount
// (a hard link: no copy of a gigabyte, the run folder stays the only writable mount) and the tool is told not to
// download (skip args). Otherwise the tool downloads into the output mount as before, and after the run the new copy
// is moved into the cache (a rename in the same file system), replacing the old one. Nothing here touches the network
// or the workspace; the decision is JGates', explicit and recorded.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface DatabaseCacheSpec {
  /** Folder name under <home>/tools/cache. */
  name: string;
  /** Folder, relative to the output mount, where the tool keeps the database. */
  dir: string;
  /** Files of the database inside `dir`, the metadata file included. */
  files: string[];
  /** The metadata file the tool writes next to the database (JSON). */
  metadata: string;
  /** Whether an invocation with these capabilities reads the database. */
  needed(capabilities: string[]): boolean;
  /** Arguments that make the tool use the copy as it is (no download), inserted before the scan target. */
  skipArgs: string[];
  /** The facts of a metadata document: when the data was updated, when the next update is due, when it was downloaded. */
  dates(metadata: unknown): { updatedAt: string | null; nextUpdate: string | null; downloadedAt: string | null };
}

export interface CacheRecord {
  schemaVersion: 1;
  name: string;
  source: string | null;
  updatedAt: string | null;
  nextUpdate: string | null;
  downloadedAt: string | null;
  /** When the copy entered the cache. */
  storedAt: string;
  /** Last run that used it. */
  lastUsedAt: string;
}

export const CACHE_RECORD = "jgates-cache.json";

export const cacheRoot = (home: string): string => path.join(home, "tools", "cache");
export const cacheDirOf = (home: string, spec: DatabaseCacheSpec): string => path.join(cacheRoot(home), spec.name);

export type CacheUse =
  /** The fresh copy was linked into the run; the tool did not download. */
  | { state: "reused"; record: CacheRecord }
  /** No usable copy: the tool downloads, and the copy is stored after the run. */
  | { state: "download"; reason: "none" | "stale" | "unreadable" | "link_failed"; record: CacheRecord | null };

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is CacheRecord {
  return typeof v === "object" && v !== null && (v as CacheRecord).schemaVersion === 1 && typeof (v as CacheRecord).storedAt === "string";
}

function writeRecord(dir: string, record: CacheRecord): void {
  const file = path.join(dir, CACHE_RECORD);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The record of the cached copy, or null when there is none (or it is incomplete). */
export function readCache(home: string, spec: DatabaseCacheSpec): CacheRecord | null {
  const dir = cacheDirOf(home, spec);
  const record = readJson(path.join(dir, CACHE_RECORD));
  if (!isRecord(record)) return null;
  for (const f of spec.files) if (!fs.existsSync(path.join(dir, f))) return null;
  return record;
}

/** A copy is fresh while its nextUpdate is in the future; a copy without that date is never fresh. */
export function isFresh(record: CacheRecord, now: Date): boolean {
  const next = record.nextUpdate ? Date.parse(record.nextUpdate) : NaN;
  return Number.isFinite(next) && next > now.getTime();
}

/** Before the run: links the fresh copy into <outputDir>/<spec.dir>, or says the tool must download. */
export function useCache(home: string, spec: DatabaseCacheSpec, outputDir: string, now: Date = new Date()): CacheUse {
  const record = readCache(home, spec);
  if (!record) return { state: "download", reason: "none", record: null };
  if (!isFresh(record, now)) return { state: "download", reason: "stale", record };
  const source = cacheDirOf(home, spec);
  const target = path.join(outputDir, ...spec.dir.split("/"));
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  try {
    for (const f of spec.files) {
      const to = path.join(target, f);
      fs.rmSync(to, { force: true });
      fs.linkSync(path.join(source, f), to);
    }
  } catch {
    // Another file system (no hard link): the tool downloads into the run as it did before the cache existed.
    for (const f of spec.files) fs.rmSync(path.join(target, f), { force: true });
    return { state: "download", reason: "link_failed", record };
  }
  const used = { ...record, lastUsedAt: now.toISOString() };
  try {
    writeRecord(source, used);
  } catch {
    // the record of the last use is informative only
  }
  return { state: "reused", record: used };
}

/**
 * After a run that downloaded: moves the new copy from the output mount into the cache, replacing the old one, and
 * records its dates. A copy without readable metadata or without every file is left alone (never cached half).
 */
export function storeCache(home: string, spec: DatabaseCacheSpec, outputDir: string, source: string | null, now: Date = new Date()): CacheRecord | null {
  const from = path.join(outputDir, ...spec.dir.split("/"));
  if (!spec.files.every((f) => fs.existsSync(path.join(from, f)))) return null;
  const meta = readJson(path.join(from, spec.metadata));
  if (meta === undefined) return null;
  const dates = spec.dates(meta);
  const root = cacheRoot(home);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(root, `.${spec.name}-`));
  const final = cacheDirOf(home, spec);
  try {
    for (const f of spec.files) {
      // The metadata stays in the run folder too (the facts of the run are read from it).
      if (f === spec.metadata) fs.copyFileSync(path.join(from, f), path.join(staging, f));
      else fs.renameSync(path.join(from, f), path.join(staging, f));
    }
    const record: CacheRecord = { schemaVersion: 1, name: spec.name, source, ...dates, storedAt: now.toISOString(), lastUsedAt: now.toISOString() };
    writeRecord(staging, record);
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(staging, final);
    return record;
  } catch {
    fs.rmSync(staging, { recursive: true, force: true });
    return null;
  }
}
