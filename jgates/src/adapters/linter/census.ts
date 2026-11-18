// The file census: one walk of the synchronized workspace, giving per extension and per name the files found, and,
// for the descriptors that ask for it, the files whose first line (or first 4 KiB) fits a pattern. Templates and
// descriptors match against it. There is no depth or count cap (a long list runs in batches); the walk skips the same
// dependency, build and cache folders as the lint adapters' walk, and the folders of version control and tool state.
//
// A plan is built synchronously, so one census serves every descriptor and template of the plan: the census of a folder
// is kept until the current task of the event loop ends, then dropped (the next plan sees the files as they are then).
// Content matches are kept across plans by path, size and modification time.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LinterDescriptor } from "./descriptor.js";

/** Folders no lint pass enters: dependencies, build output, caches and tool state (lint-common's walk uses the same). */
export const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(["node_modules", "vendor", "target", "bin", "obj", "dist", "build", "out", "venv", "__pycache__", "third_party"]);

/** Dot folders the census does not enter: version control, JGates' own state, environments and caches. Other dot folders (.github, .gitlab, .circleci) are walked. */
export const SKIPPED_DOT_FOLDERS: ReadonlySet<string> = new Set([".git", ".hg", ".svn", ".jgates", ".venv", ".tox", ".nox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".cache", ".gradle", ".next", ".nuxt", ".terraform", ".terragrunt-cache", ".dart_tool", ".pub-cache", ".yarn", ".pnpm-store", ".idea", ".m2", ".bundle", ".stack-work"]);

export interface FileCensus {
  /** The folder walked (absolute). */
  root: string;
  /** Workspace-relative POSIX paths of every file, sorted. */
  files: readonly string[];
  /** sha256 of the listing (the sorted paths): a plan records it. */
  listingHash: string;
  /** Lowercase extension (with the dot, the last one) -> files. */
  byExtension: ReadonlyMap<string, readonly string[]>;
}

const skipped = (name: string): boolean => (name.startsWith(".") ? SKIPPED_DOT_FOLDERS.has(name) : SKIPPED_FOLDERS.has(name));

function walk(root: string): string[] {
  const files: string[] = [];
  const visit = (abs: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const next = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!skipped(e.name)) visit(path.join(abs, e.name), next);
      } else if (e.isFile()) files.push(next);
    }
  };
  visit(root, "");
  return files.sort();
}

const extensionOf = (rel: string): string => {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
};

const tick = new Map<string, FileCensus>();

/** The census of a folder (absolute); one walk per synchronous task, whatever the number of callers. */
export function fileCensus(dir: string): FileCensus {
  const root = path.resolve(dir);
  const hit = tick.get(root);
  if (hit) return hit;
  const files = walk(root);
  const byExtension = new Map<string, string[]>();
  for (const f of files) {
    const ext = extensionOf(f);
    if (ext === "") continue;
    const list = byExtension.get(ext);
    if (list) list.push(f);
    else byExtension.set(ext, [f]);
  }
  const census: FileCensus = { root, files, listingHash: "sha256:" + crypto.createHash("sha256").update(files.join("\n")).digest("hex"), byExtension };
  tick.set(root, census);
  setImmediate(() => tick.delete(root)).unref();
  return census;
}

/** A name pattern (* is any text inside one name) as a regular expression; matched on the base name, or on the relative path when the pattern has a folder. */
export function namePattern(pattern: string): { regex: RegExp; onPath: boolean } {
  const clean = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  const body = clean
    .split("*")
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return { regex: new RegExp(`^${body}$`, "i"), onPath: clean.includes("/") };
}

const baseName = (rel: string): string => rel.slice(rel.lastIndexOf("/") + 1);

export function matchesName(rel: string, pattern: string): boolean {
  const { regex, onPath } = namePattern(pattern);
  return regex.test(onPath ? rel : baseName(rel));
}

const HEAD_BYTES = 4096;
const contentMemo = new Map<string, boolean>();
const MAX_MEMO = 50_000;

/** Whether the file's first line (or first 4 KiB) fits the pattern; memoized by path, size and modification time. */
function contentFits(root: string, rel: string, pattern: string, firstLine: boolean): boolean {
  const abs = path.join(root, ...rel.split("/"));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return false;
  }
  const key = `${abs}\u0000${stat.size}\u0000${stat.mtimeMs}\u0000${pattern}\u0000${firstLine}`;
  const memo = contentMemo.get(key);
  if (memo !== undefined) return memo;
  let head = "";
  try {
    const fd = fs.openSync(abs, "r");
    try {
      const buffer = Buffer.alloc(Math.min(HEAD_BYTES, stat.size));
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  const text = firstLine ? (head.split(/\r?\n/, 1)[0] ?? "") : head;
  const fits = new RegExp(pattern, "m").test(text);
  if (contentMemo.size >= MAX_MEMO) contentMemo.clear();
  contentMemo.set(key, fits);
  return fits;
}

/** The files of the census a descriptor's activation picks (sorted, unique); empty for a whole-project tool without file rules. */
export function activatedFiles(census: FileCensus, activation: LinterDescriptor["activation"]): string[] {
  const picked = new Set<string>();
  for (const ext of activation.extensions ?? []) for (const f of census.byExtension.get(ext.toLowerCase()) ?? []) picked.add(f);
  const names = (activation.names ?? []).map(namePattern);
  if (names.length > 0) for (const f of census.files) if (names.some(({ regex, onPath }) => regex.test(onPath ? f : baseName(f)))) picked.add(f);
  const content = activation.content;
  if (content) {
    const candidates = content.names && content.names.length > 0 ? census.files.filter((f) => (content.names ?? []).some((n) => matchesName(f, n))) : census.files.filter((f) => extensionOf(f) === "");
    for (const f of candidates) if (!picked.has(f) && contentFits(census.root, f, content.pattern, content.firstLine !== false)) picked.add(f);
  }
  return [...picked].sort();
}

/** The first file of `requires` present at the workspace root (a * in the name is allowed), or null. */
export function requiredFilePresent(census: FileCensus, requires: readonly string[]): string | null {
  for (const want of requires) {
    const { regex } = namePattern(want);
    const hit = census.files.find((f) => (want.includes("/") ? regex.test(f) : !f.includes("/") && regex.test(f)));
    if (hit) return hit;
  }
  return null;
}

/**
 * Template evidence anywhere in a folder: `<folder>/**\/<name pattern>` (folder optional) holds when a file under the
 * folder fits the name and, when `contains` is given, has a line that starts with it. Used by template activation for
 * the derived templates, whose evidence is a file anywhere in the workspace.
 */
export function censusHasEvidence(dir: string, rel: string, contains: string | null): boolean {
  const at = rel.indexOf("**/");
  if (at < 0) return false;
  const prefix = rel.slice(0, at).replace(/\/+$/, "");
  const leaf = rel.slice(at + 3);
  const census = fileCensus(dir);
  const { regex, onPath } = namePattern(leaf);
  for (const f of census.files) {
    if (prefix !== "" && !f.startsWith(`${prefix}/`)) continue;
    const inner = prefix === "" ? f : f.slice(prefix.length + 1);
    if (!(onPath ? regex.test(inner) || regex.test(inner.split("/").slice(-leaf.split("/").length).join("/")) : regex.test(baseName(f)))) continue;
    if (contains === null) return true;
    try {
      const text = fs.readFileSync(path.join(census.root, ...f.split("/")), "utf8");
      if (text.split(/\r?\n/).some((line) => line.trimStart().startsWith(contains))) return true;
    } catch {
      // unreadable: not evidence
    }
  }
  return false;
}

/** Template evidence patterns of an activation (what a derived template matches): **\/*.ext and **\/<name>. */
export function evidencePatterns(activation: LinterDescriptor["activation"]): string[] {
  const out: string[] = [];
  for (const ext of activation.extensions ?? []) out.push(`**/*${ext}`);
  for (const name of activation.names ?? []) out.push(`**/${name.replace(/^\.\//, "")}`);
  for (const name of activation.content?.names ?? []) out.push(`**/${name.replace(/^\.\//, "")}`);
  return [...new Set(out)];
}
