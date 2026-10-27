import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** JSON with object keys sorted recursively, so equal content always gives equal text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Content hash ("sha256:<hex>") of any JSON value (plan, configuration, inputs), independent of key order. */
export function contentHash(value: unknown): string {
  return "sha256:" + crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** Canonical real path: symlinks resolved; compared case-insensitively on Windows. */
export function canonicalPath(p: string): string {
  const real = fs.realpathSync.native(path.resolve(p));
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/** Workspace id derived from the canonical real path: the same folder (or a symlink to it) gives the same id. */
export function workspaceId(workspacePath: string): string {
  const digest = crypto.createHash("sha256").update(canonicalPath(workspacePath), "utf8").digest("hex");
  return "ws_" + digest.slice(0, 16);
}

/** New run id: UTC timestamp plus a random suffix, sortable by creation time. */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `run_${stamp}_${crypto.randomBytes(4).toString("hex")}`;
}
