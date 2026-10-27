// Finds the Semgrep executable and asks it for its version, without installing or changing anything.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findOnPath } from "../../core/bridge/index.js";
import { pythonEnvExecutable } from "../../core/install/paths.js";

export interface SemgrepProbe {
  executable: string | null;
  version: string | null;
  problem: "not_found" | "no_answer" | null;
  detail: string;
}

const cache = new Map<string, { mtimeMs: number; version: string | null }>();
const exeName = process.platform === "win32" ? "semgrep.exe" : "semgrep";

/** JGATES_SEMGREP, then the folder of JGATES_PYTHON (same virtual environment), then the JGates environment
 * (<JGATES_HOME>/tools/python, from `jgates doctor --fix`), then PATH. */
export function findSemgrep(env: NodeJS.ProcessEnv): { executable: string | null; tried: string[] } {
  const tried: string[] = [];
  if (env.JGATES_SEMGREP) {
    tried.push(env.JGATES_SEMGREP);
    return { executable: findOnPath(env.JGATES_SEMGREP, env), tried };
  }
  if (env.JGATES_PYTHON) {
    const sibling = path.join(path.dirname(env.JGATES_PYTHON), exeName);
    tried.push(sibling);
    if (fs.existsSync(sibling)) return { executable: path.resolve(sibling), tried };
  }
  const own = pythonEnvExecutable("semgrep", env);
  if (own) return { executable: own, tried: [...tried, own] };
  tried.push("semgrep on PATH");
  return { executable: findOnPath("semgrep", env), tried };
}

/** Semgrep's native core runs `uname`: the scanner's PATH always carries the system folders, even when the caller's is empty. */
export function scannerPath(parent: string | undefined): string {
  if (process.platform === "win32") return parent ?? "";
  const parts = (parent ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of ["/usr/bin", "/bin"]) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(path.delimiter);
}

export function probeSemgrep(env: NodeJS.ProcessEnv): SemgrepProbe {
  const { executable, tried } = findSemgrep(env);
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
  // Metrics and the version check stay off even for this probe; the home is a throwaway folder.
  const r = spawnSync(executable, ["--version", "--disable-version-check"], {
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: scannerPath(env.PATH), HOME: env.HOME ?? "", SEMGREP_SEND_METRICS: "off", SEMGREP_ENABLE_VERSION_CHECK: "0" },
    windowsHide: true,
  });
  const version = r.status === 0 ? (/(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? null) : null;
  cache.set(executable, { mtimeMs, version });
  return version ? { executable, version, problem: null, detail: "" } : { executable, version: null, problem: "no_answer", detail: executable };
}
