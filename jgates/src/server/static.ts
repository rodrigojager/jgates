// UI assets: the Vite build in dist/ui, served read-only by the local server (after the session check).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StaticAsset, StaticHandler } from "./types.js";

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function readFile(file: string): Buffer | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return null;
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

export const serveStatic: StaticHandler = (pathname): StaticAsset | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const target = path.resolve(UI_DIR, relative);
  const inside = path.relative(UI_DIR, target);
  if (inside.startsWith("..") || path.isAbsolute(inside)) return null;

  const direct = readFile(target);
  if (direct) {
    const ext = path.extname(target).toLowerCase();
    // Vite names assets by content hash, so they can be cached for good; the page itself is always revalidated.
    const hashed = relative.startsWith("assets/");
    return { contentType: TYPES[ext] ?? "application/octet-stream", body: direct, cacheControl: hashed ? "private, max-age=31536000, immutable" : "no-store" };
  }
  // The UI routes with the URL hash, so there is no history fallback: an unknown path is a 404.
  return null;
};
