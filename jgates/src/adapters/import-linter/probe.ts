// Whether Import Linter (lint-imports) is in the tools image, and its version, from image.json (nothing starts); in
// the image it lives in its own environment, whose Python imports grimp for the graph helper. Inside the image only,
// JGATES_IMPORT_LINTER names another executable: it is asked for its version, with the Python of its environment.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findOnPath, resolveProjectPython } from "../../core/bridge/index.js";
import { besideOverridePython, imageProbeUnlessOverridden, inImageOverride } from "../../core/tools-image/catalogue.js";
import { probeEnv } from "../../core/runner/probe-env.js";

/** The interpreter of Import Linter's environment in the tools image (it imports grimp). */
export const IMAGE_IMPORT_LINTER_PYTHON = "/opt/tools/python/import-linter/bin/python";

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
const pythonName = win ? "python.exe" : "python";

/** Inside the tools image only: the executable JGATES_IMPORT_LINTER names, else the one beside the JGATES_PYTHON override. */
export function findImportLinter(env: NodeJS.ProcessEnv): { executable: string | null; tried: string[] } {
  const override = inImageOverride(env, "JGATES_IMPORT_LINTER") ?? besideOverridePython(env, "lint-imports");
  return override ? { executable: findOnPath(override, env), tried: [override] } : { executable: null, tried: [] };
}

/** The interpreter next to the executable (not resolved through symlinks: a virtual environment is found by its path). */
export function pythonBeside(executable: string): string | null {
  const sibling = path.join(path.dirname(executable), pythonName);
  return fs.existsSync(sibling) ? sibling : null;
}

const grimpCache = new Map<string, boolean>();

/**
 * The interpreter of the graph helper: the one beside lint-imports (a virtual environment), otherwise the project's
 * Python when it imports grimp. The second case is a `pip install --user` install, where lint-imports lives in the
 * user's scripts folder (~/.local/bin, %APPDATA%\Python\PythonXY\Scripts) and no interpreter sits beside it.
 */
export function pythonFor(executable: string, env: NodeJS.ProcessEnv): string | null {
  const beside = pythonBeside(executable);
  if (beside) return beside;
  const { interpreter } = resolveProjectPython(env);
  if (!interpreter) return null;
  let ok = grimpCache.get(interpreter);
  if (ok === undefined) {
    const r = spawnSync(interpreter, ["-c", "import grimp"], { encoding: "utf8", timeout: 30_000, env: probeEnv(env, { PATH: toolPath(env.PATH), PYTHONDONTWRITEBYTECODE: "1" }), windowsHide: true });
    ok = r.status === 0;
    grimpCache.set(interpreter, ok);
  }
  return ok ? interpreter : null;
}

/** The scanner's PATH: the caller's, with the system folders the interpreter may need. */
export function toolPath(parent: string | undefined): string {
  if (win) return parent ?? "";
  const parts = (parent ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of ["/usr/bin", "/bin"]) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(path.delimiter);
}

export function probeImportLinter(env: NodeJS.ProcessEnv): ImportLinterProbe {
  const image = imageProbeUnlessOverridden("import-linter", env, "JGATES_IMPORT_LINTER");
  if (image) return { ...image, python: image.executable ? IMAGE_IMPORT_LINTER_PYTHON : null };
  const { executable, tried } = findImportLinter(env);
  if (!executable) return { executable: null, python: null, version: null, problem: "not_found", detail: tried.join(", ") };
  const python = pythonFor(executable, env);
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
  const r = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 60_000, env: probeEnv(env, { PATH: toolPath(env.PATH) }), windowsHide: true });
  // "lint-imports, version 2.15" (click) or "import-linter 2.15": the first x.y(.z) in the answer.
  const found = r.status === 0 ? (/(\d+\.\d+(?:\.\d+)?)/.exec(r.stdout)?.[1] ?? null) : null;
  // Import Linter says "2.15": semver wants three parts.
  const version = found === null ? null : found.split(".").length === 2 ? `${found}.0` : found;
  cache.set(executable, { mtimeMs, version });
  return version ? { executable, python, version, problem: null, detail: "" } : { executable, python, version: null, problem: "no_answer", detail: executable };
}
