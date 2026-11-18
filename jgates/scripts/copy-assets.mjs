// Copies the non-TypeScript assets of src/ (message catalogs) next to the compiled code in dist/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const dist = path.join(root, "dist");

function copyJson(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const from = path.join(dir, entry.name);
    if (entry.isDirectory()) copyJson(from);
    else if (entry.name.endsWith(".json")) {
      const to = path.join(dist, path.relative(src, from));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

copyJson(src);

// The linter descriptors' folders are copied whole: a tool's default configuration may be YAML, TOML or an ini file.
// The copy mirrors the source, so a descriptor removed from src/ does not linger in dist/.
const linters = path.join(src, "builtin", "linters");
const lintersOut = path.join(dist, "builtin", "linters");
fs.rmSync(lintersOut, { recursive: true, force: true });
if (fs.existsSync(linters)) fs.cpSync(linters, lintersOut, { recursive: true });
