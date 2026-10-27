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
