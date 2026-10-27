import fs from "node:fs";
import path from "node:path";
import type { DirEntry, DiscoveryLimits } from "./types.js";

/** Stable string order (UTF-16 code units), the same on every platform. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Directories never indexed: dependencies, VCS data, caches and generated output. */
export const TECHNICAL_EXCLUDES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".nox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".cache",
  ".gradle",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  ".pnpm-store",
  ".yarn",
  "dist",
  "coverage",
  "obj",
]);

/** Third-party code kept in the tree: reported as ignored, never descended into. */
export const VENDOR_DIRS: ReadonlySet<string> = new Set(["vendor", "third_party", "third-party", "Pods", "bower_components", "site-packages"]);

export interface Tree {
  /** Project-relative file paths, sorted. */
  files: string[];
  /** Project-relative vendor directories found, sorted. */
  vendorDirs: string[];
  entries: number;
  truncated: boolean;
}

export function defaultReadDir(absDir: string): DirEntry[] {
  return fs.readdirSync(absDir, { withFileTypes: true }).map((d) => ({
    name: d.name,
    kind: d.isDirectory() ? "dir" : d.isFile() ? "file" : "other",
  }));
}

/**
 * Lists the files of a project in a fixed order. Directories are visited in sorted order whatever the order the
 * file system returns them, symbolic links are not followed, and the walk stops at the limits.
 */
export function walkProject(root: string, readDir: (abs: string) => DirEntry[], limits: DiscoveryLimits): Tree {
  const files: string[] = [];
  const vendorDirs: string[] = [];
  let entries = 0;
  let truncated = false;

  const visit = (rel: string, depth: number): void => {
    let listing: DirEntry[];
    try {
      listing = readDir(rel === "" ? root : path.join(root, ...rel.split("/")));
    } catch {
      return;
    }
    const sorted = [...listing].sort((a, b) => compareStrings(a.name, b.name));
    for (const entry of sorted) {
      if (truncated) return;
      if (entry.kind === "other") continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.kind === "dir") {
        if (TECHNICAL_EXCLUDES.has(entry.name)) continue;
        if (VENDOR_DIRS.has(entry.name)) {
          vendorDirs.push(childRel);
          continue;
        }
        if (depth + 1 > limits.maxDepth) {
          truncated = true;
          return;
        }
        visit(childRel, depth + 1);
      } else {
        if (entries >= limits.maxEntries) {
          truncated = true;
          return;
        }
        entries += 1;
        files.push(childRel);
      }
    }
  };

  visit("", 0);
  files.sort(compareStrings);
  vendorDirs.sort(compareStrings);
  return { files, vendorDirs, entries, truncated };
}
