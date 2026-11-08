// Finds the CodeQL CLI the customer supplied and asks it for its version, without installing or changing anything.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findOnPath } from "../../core/bridge/index.js";
import { resolveHome } from "../../core/home/index.js";
import { probeEnv } from "../../core/runner/probe-env.js";

export interface CodeqlProbe {
  executable: string | null;
  version: string | null;
  problem: "not_found" | "no_answer" | null;
  detail: string;
}

const cache = new Map<string, { mtimeMs: number; version: string | null }>();
const exeName = process.platform === "win32" ? "codeql.exe" : "codeql";

/** JGATES_CODEQL (the configured executable path), then <JGATES_HOME>/tools/bin, then PATH. */
export function findCodeql(env: NodeJS.ProcessEnv): { executable: string | null; tried: string[] } {
  const tried: string[] = [];
  if (env.JGATES_CODEQL) {
    tried.push(env.JGATES_CODEQL);
    return { executable: findOnPath(env.JGATES_CODEQL, env), tried };
  }
  const own = path.join(resolveHome({ env }), "tools", "bin", exeName);
  tried.push(own);
  if (fs.existsSync(own)) return { executable: own, tried };
  tried.push("codeql on PATH");
  return { executable: findOnPath("codeql", env), tried };
}

/** Readiness: `codeql version --format=terse` prints just the version (older CLIs print a banner; both are read). */
export function probeCodeql(env: NodeJS.ProcessEnv): CodeqlProbe {
  const { executable, tried } = findCodeql(env);
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
  const r = spawnSync(executable, ["version", "--format=terse"], { encoding: "utf8", timeout: 60_000, env: probeEnv(env, { PATH: env.PATH ?? "", HOME: env.HOME ?? "", NO_COLOR: "1" }), windowsHide: true });
  const version = r.status === 0 ? (/(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? null) : null;
  cache.set(executable, { mtimeMs, version });
  return version ? { executable, version, problem: null, detail: "" } : { executable, version: null, problem: "no_answer", detail: executable };
}
