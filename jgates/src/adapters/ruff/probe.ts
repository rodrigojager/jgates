// Finds the Ruff executable and asks it for its version, without installing or changing anything.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findOnPath } from "../../core/bridge/index.js";
import { pythonEnvExecutable } from "../../core/install/paths.js";

export interface RuffProbe {
  /** Absolute executable path, or null when none was found. */
  executable: string | null;
  version: string | null;
  /** Why it is not usable (not found, did not answer). */
  problem: "not_found" | "no_answer" | null;
  detail: string;
}

const cache = new Map<string, { mtimeMs: number; version: string | null }>();
const exeName = process.platform === "win32" ? "ruff.exe" : "ruff";

/** JGATES_RUFF, then the folder of JGATES_PYTHON (same virtual environment), then the JGates environment
 * (<JGATES_HOME>/tools/python, from `jgates doctor --fix`), then PATH. */
export function findRuff(env: NodeJS.ProcessEnv): { executable: string | null; tried: string[] } {
  const tried: string[] = [];
  if (env.JGATES_RUFF) {
    tried.push(env.JGATES_RUFF);
    const found = findOnPath(env.JGATES_RUFF, env);
    return { executable: found, tried };
  }
  if (env.JGATES_PYTHON) {
    const sibling = path.join(path.dirname(env.JGATES_PYTHON), exeName);
    tried.push(sibling);
    if (fs.existsSync(sibling)) return { executable: path.resolve(sibling), tried };
  }
  const own = pythonEnvExecutable("ruff", env);
  if (own) return { executable: own, tried: [...tried, own] };
  tried.push("ruff on PATH");
  return { executable: findOnPath("ruff", env), tried };
}

export function probeRuff(env: NodeJS.ProcessEnv): RuffProbe {
  const { executable, tried } = findRuff(env);
  if (!executable) return { executable: null, version: null, problem: "not_found", detail: tried.join(", ") };
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(executable).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  const hit = cache.get(executable);
  if (hit && hit.mtimeMs === mtimeMs) {
    return hit.version ? { executable, version: hit.version, problem: null, detail: "" } : { executable, version: null, problem: "no_answer", detail: executable };
  }
  const r = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 15_000, env: { PATH: env.PATH ?? "", HOME: env.HOME ?? "" }, windowsHide: true });
  const version = r.status === 0 ? (/(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? null) : null;
  cache.set(executable, { mtimeMs, version });
  return version ? { executable, version, problem: null, detail: "" } : { executable, version: null, problem: "no_answer", detail: executable };
}
