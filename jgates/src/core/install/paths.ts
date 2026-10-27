// Where JGates keeps the Python environment it installs into: <JGATES_HOME>/tools/python, a virtual environment of
// its own, never the system Python. The adapters (Ruff, Semgrep) and the bridge look there after their explicit
// variables and before the PATH. This module only computes paths and checks files: it never creates anything.
import fs from "node:fs";
import path from "node:path";
import { resolveHome } from "../home/index.js";

/** <JGATES_HOME>/tools/python. */
export function pythonEnvDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveHome({ env }), "tools", "python");
}

/** The folder of the environment's executables: bin (POSIX) or Scripts (Windows). */
export function pythonEnvBinDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return path.join(pythonEnvDir(env), platform === "win32" ? "Scripts" : "bin");
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The absolute path of an executable of the environment (`ruff`, `semgrep`, `python`), or null when it is not there. */
export function pythonEnvExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const bin = pythonEnvBinDir(env);
  const candidates = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  for (const file of candidates) {
    const abs = path.join(bin, file);
    if (isFile(abs)) return abs;
  }
  return null;
}

/** The interpreter of the environment, or null when JGates has not created it. */
export function pythonEnvInterpreter(env: NodeJS.ProcessEnv = process.env): string | null {
  return pythonEnvExecutable("python", env);
}
