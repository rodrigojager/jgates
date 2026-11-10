// The file-size analysis: text files of the workspace whose line count is over the limit. Pure and offline: it reads
// the files, runs nothing and writes nothing. Binary files (a NUL byte in the first block) are not counted, and the
// folders that hold generated or third-party code are not entered.
import fs from "node:fs";
import path from "node:path";

/** Same default as the standard budget profile of the quality sidecar, which this check replaces. */
export const DEFAULT_MAX_LINES = 5000;
/** The walk stops here (the result says so); a bigger tree is not a project this check can judge whole. */
export const MAX_FILES = 50_000;

/** Folders that are not the project's own code. */
export const SKIPPED_FOLDERS: ReadonlySet<string> = new Set([".git", ".hg", ".svn", ".jgates", "node_modules", ".venv", "venv", "__pycache__", "target", "vendor", "dist", "build", "obj", ".next", ".tox", ".mypy_cache", ".ruff_cache", ".pytest_cache", ".gradle"]);

export interface OversizedFile {
  /** Workspace-relative POSIX path. */
  file: string;
  lines: number;
}

export interface FileSizeResult {
  limit: number;
  /** Text files measured. */
  checked: number;
  /** Files not measured, with the reason (binary, unreadable): reported, never counted as small. */
  skipped: Array<{ file: string; reason: "binary" | "unreadable" }>;
  oversized: OversizedFile[];
  /** true: the walk stopped at MAX_FILES, so files may be missing from the answer. */
  truncated: boolean;
}

/** Lines of a file (a last line without a newline counts), or "binary" when it holds a NUL byte. */
function countLines(abs: string): number | "binary" {
  const fd = fs.openSync(abs, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let lines = 0;
    let lastByte = 0x0a;
    let first = true;
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      if (first && buffer.subarray(0, Math.min(read, 8000)).includes(0)) return "binary";
      first = false;
      for (let i = 0; i < read; i += 1) if (buffer[i] === 0x0a) lines += 1;
      lastByte = buffer[read - 1] as number;
    }
    return lastByte === 0x0a ? lines : lines + 1;
  } finally {
    fs.closeSync(fd);
  }
}

export function analyzeFileSize(workspace: string, opts: { maxLines?: number; maxFiles?: number } = {}): FileSizeResult {
  const limit = opts.maxLines ?? DEFAULT_MAX_LINES;
  const maxFiles = opts.maxFiles ?? MAX_FILES;
  const result: FileSizeResult = { limit, checked: 0, skipped: [], oversized: [], truncated: false };
  let seen = 0;
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (result.truncated) return;
      const next = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) walk(path.join(dir, entry.name), next);
        continue;
      }
      // Symbolic links and special files are not the project's own text.
      if (!entry.isFile()) continue;
      if (seen >= maxFiles) {
        result.truncated = true;
        return;
      }
      seen += 1;
      try {
        const lines = countLines(path.join(dir, entry.name));
        if (lines === "binary") {
          result.skipped.push({ file: next, reason: "binary" });
          continue;
        }
        result.checked += 1;
        if (lines > limit) result.oversized.push({ file: next, lines });
      } catch {
        result.skipped.push({ file: next, reason: "unreadable" });
      }
    }
  };
  walk(path.resolve(workspace), "");
  return result;
}
