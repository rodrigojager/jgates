// Which configuration file pytest reads for an instance: the primary binding of tools.yml when it points to an
// existing file, otherwise pytest's own rootdir/inifile resolution (first match from the component root up). Nothing
// is created, written or executed: the files are only read to see whether they hold a pytest section.
import fs from "node:fs";
import path from "node:path";
import { resolveToolBindings } from "../../core/tools/index.js";
import { pytestManifest } from "./manifest.js";

export interface PytestConfigChoice {
  /** Workspace-relative path with forward slashes, or null when pytest would run without a configuration file. */
  file: string | null;
  source: "binding" | "native" | "none";
}

const slash = (p: string): string => p.split(path.sep).join("/");

function read(abs: string): string | null {
  try {
    return fs.statSync(abs).isFile() ? fs.readFileSync(abs, "utf8") : null;
  } catch {
    return null;
  }
}

/** Candidates in pytest's order; pytest.ini always wins (even empty), the others only with their section. */
const CANDIDATES: Array<{ name: string; holds: (text: string) => boolean }> = [
  { name: "pytest.ini", holds: () => true },
  { name: ".pytest.ini", holds: () => true },
  { name: "pyproject.toml", holds: (text) => /^\s*\[tool\.pytest\.ini_options\]/m.test(text) },
  { name: "tox.ini", holds: (text) => /^\s*\[pytest\]/m.test(text) },
  { name: "setup.cfg", holds: (text) => /^\s*\[tool:pytest\]/m.test(text) },
];

function nativeConfig(dir: string, componentRoot: string): string | null {
  const top = path.resolve(dir);
  let current = path.resolve(dir, componentRoot);
  for (;;) {
    for (const c of CANDIDATES) {
      const text = read(path.join(current, c.name));
      if (text !== null && c.holds(text)) return slash(path.relative(top, path.join(current, c.name)));
    }
    if (current === top) return null;
    const parent = path.dirname(current);
    if (parent === current || path.relative(top, parent).startsWith("..")) return null;
    current = parent;
  }
}

export function choosePytestConfig(dir: string, instanceId: string, componentRoot: string | null): PytestConfigChoice {
  try {
    const bound = resolveToolBindings(dir, { skipInventory: true, manifests: [pytestManifest] }).instances.find((i) => i.id === instanceId);
    const binding = bound?.bindings.find((b) => b.id === "config" && !b.refused && b.kind === "file" && b.relPath !== null && b.exists);
    if (binding?.relPath) return { file: binding.relPath, source: "binding" };
  } catch {
    // an unreadable tools.yml is reported by config validate; the native resolution still applies
  }
  const file = nativeConfig(dir, componentRoot ?? ".");
  return file ? { file, source: "native" } : { file: null, source: "none" };
}
