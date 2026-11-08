// Finds the oasdiff executable and asks it for its version, without installing or changing anything.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findOnPath } from "../../core/bridge/index.js";
import { resolveHome } from "../../core/home/index.js";
import { probeEnv } from "../../core/runner/probe-env.js";

export interface OasdiffProbe {
  executable: string | null;
  version: string | null;
  problem: "not_found" | "no_answer" | null;
  detail: string;
}

const cache = new Map<string, { mtimeMs: number; version: string | null }>();
const exeName = process.platform === "win32" ? "oasdiff.exe" : "oasdiff";

/** JGATES_OASDIFF, then <JGATES_HOME>/tools/bin (where the customer may put the release binary), then PATH. */
export function findOasdiff(env: NodeJS.ProcessEnv): { executable: string | null; tried: string[] } {
  const tried: string[] = [];
  if (env.JGATES_OASDIFF) {
    tried.push(env.JGATES_OASDIFF);
    return { executable: findOnPath(env.JGATES_OASDIFF, env), tried };
  }
  const own = path.join(resolveHome({ env }), "tools", "bin", exeName);
  tried.push(own);
  if (fs.existsSync(own)) return { executable: own, tried };
  tried.push("oasdiff on PATH");
  return { executable: findOnPath("oasdiff", env), tried };
}

export function probeOasdiff(env: NodeJS.ProcessEnv): OasdiffProbe {
  const { executable, tried } = findOasdiff(env);
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
  const r = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 30_000, env: probeEnv(env, { PATH: env.PATH ?? "", HOME: env.HOME ?? "", NO_COLOR: "1" }), windowsHide: true });
  const version = r.status === 0 ? (/(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? null) : null;
  cache.set(executable, { mtimeMs, version });
  return version ? { executable, version, problem: null, detail: "" } : { executable, version: null, problem: "no_answer", detail: executable };
}
