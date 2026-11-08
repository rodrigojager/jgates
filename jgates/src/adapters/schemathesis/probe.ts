// Finds the Schemathesis CLI (`st`) and asks it for its version, without installing or changing anything.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findOnPath } from "../../core/bridge/index.js";
import { pythonEnvExecutable } from "../../core/install/paths.js";
import { probeEnv } from "../../core/runner/probe-env.js";

export interface SchemathesisProbe {
  executable: string | null;
  version: string | null;
  problem: "not_found" | "no_answer" | null;
  detail: string;
}

const cache = new Map<string, { mtimeMs: number; version: string | null }>();
const exeName = process.platform === "win32" ? "st.exe" : "st";

/** JGATES_SCHEMATHESIS, then the folder of JGATES_PYTHON (same virtual environment), then the JGates environment
 * (<JGATES_HOME>/tools/python, from `jgates doctor --fix`), then `st` on PATH. */
export function findSchemathesis(env: NodeJS.ProcessEnv): { executable: string | null; tried: string[] } {
  const tried: string[] = [];
  if (env.JGATES_SCHEMATHESIS) {
    tried.push(env.JGATES_SCHEMATHESIS);
    return { executable: findOnPath(env.JGATES_SCHEMATHESIS, env), tried };
  }
  if (env.JGATES_PYTHON) {
    const sibling = path.join(path.dirname(env.JGATES_PYTHON), exeName);
    tried.push(sibling);
    if (fs.existsSync(sibling)) return { executable: path.resolve(sibling), tried };
  }
  const own = pythonEnvExecutable("st", env);
  if (own) return { executable: own, tried: [...tried, own] };
  tried.push("st on PATH");
  return { executable: findOnPath("st", env), tried };
}

export function probeSchemathesis(env: NodeJS.ProcessEnv): SchemathesisProbe {
  const { executable, tried } = findSchemathesis(env);
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
  const r = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 60_000, env: probeEnv(env, { PATH: env.PATH ?? "", HOME: env.HOME ?? "", NO_COLOR: "1", PYTHONIOENCODING: "utf-8" }), windowsHide: true });
  // "st, version 4.33.1"
  const version = r.status === 0 ? (/version\s+(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? /(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? null) : null;
  cache.set(executable, { mtimeMs, version });
  return version ? { executable, version, problem: null, detail: "" } : { executable, version: null, problem: "no_answer", detail: executable };
}
