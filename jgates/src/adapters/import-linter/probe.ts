// Finds the Import Linter executable (lint-imports) and the Python of the same environment (the graph helper needs
// grimp, which comes with Import Linter), and asks for the version, without installing or changing anything.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findOnPath } from "../../core/bridge/index.js";

export interface ImportLinterProbe {
  executable: string | null;
  /** The interpreter of the environment that holds lint-imports (it can import grimp). */
  python: string | null;
  version: string | null;
  problem: "not_found" | "no_answer" | null;
  detail: string;
}

const cache = new Map<string, { mtimeMs: number; version: string | null }>();
const win = process.platform === "win32";
const exeName = win ? "lint-imports.exe" : "lint-imports";
const pythonName = win ? "python.exe" : "python";

/** JGATES_IMPORT_LINTER, then the folder of JGATES_PYTHON (same virtual environment), then PATH. */
export function findImportLinter(env: NodeJS.ProcessEnv): { executable: string | null; tried: string[] } {
  const tried: string[] = [];
  if (env.JGATES_IMPORT_LINTER) {
    tried.push(env.JGATES_IMPORT_LINTER);
    return { executable: findOnPath(env.JGATES_IMPORT_LINTER, env), tried };
  }
  if (env.JGATES_PYTHON) {
    const sibling = path.join(path.dirname(env.JGATES_PYTHON), exeName);
    tried.push(sibling);
    if (fs.existsSync(sibling)) return { executable: path.resolve(sibling), tried };
  }
  tried.push("lint-imports on PATH");
  return { executable: findOnPath("lint-imports", env), tried };
}

/** The interpreter next to the executable (not resolved through symlinks: a virtual environment is found by its path). */
export function pythonBeside(executable: string): string | null {
  const sibling = path.join(path.dirname(executable), pythonName);
  return fs.existsSync(sibling) ? sibling : null;
}

/** The scanner's PATH: the caller's, with the system folders the interpreter may need. */
export function toolPath(parent: string | undefined): string {
  if (win) return parent ?? "";
  const parts = (parent ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of ["/usr/bin", "/bin"]) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(path.delimiter);
}

export function probeImportLinter(env: NodeJS.ProcessEnv): ImportLinterProbe {
  const { executable, tried } = findImportLinter(env);
  if (!executable) return { executable: null, python: null, version: null, problem: "not_found", detail: tried.join(", ") };
  const python = pythonBeside(executable);
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(executable).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  const hit = cache.get(executable);
  if (hit && hit.mtimeMs === mtimeMs) {
    return hit.version ? { executable, python, version: hit.version, problem: null, detail: "" } : { executable, python, version: null, problem: "no_answer", detail: executable };
  }
  const r = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 60_000, env: { PATH: toolPath(env.PATH) }, windowsHide: true });
  // "lint-imports, version 2.15" (click) or "import-linter 2.15": the first x.y(.z) in the answer.
  const found = r.status === 0 ? (/(\d+\.\d+(?:\.\d+)?)/.exec(r.stdout)?.[1] ?? null) : null;
  // Import Linter says "2.15": semver wants three parts.
  const version = found === null ? null : found.split(".").length === 2 ? `${found}.0` : found;
  cache.set(executable, { mtimeMs, version });
  return version ? { executable, python, version, problem: null, detail: "" } : { executable, python, version: null, problem: "no_answer", detail: executable };
}
