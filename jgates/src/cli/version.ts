import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Reads the version of the root package.json (name jgates), walking up from this module. */
export function readVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  let fallback = "0.0.0";
  for (let i = 0; i < 8; i++) {
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file)) {
      const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "jgates" && pkg.version) return pkg.version;
      if (pkg.version) fallback = pkg.version;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback;
}

/**
 * Which build runs: the installation folder (dist/) and a hash of its built UI page, computed as the UI server's lock
 * does (server/index.ts, buildIdentity), so `jgates --version` and a running server can be compared. Two installations
 * of the same version number (a local build, an installed package) differ here.
 */
export function readBuild(): { dir: string; hash: string } {
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let page = "";
  try {
    page = fs.readFileSync(path.join(dist, "ui", "index.html"), "utf8");
  } catch {
    page = "";
  }
  return { dir: dist, hash: crypto.createHash("sha256").update(dist).update("\0").update(page).digest("hex").slice(0, 16) };
}
