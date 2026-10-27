// Finds the dependency-cruiser executable and asks it for its version, without installing or downloading anything.
// Order: JGATES_DEPCRUISE, the project's own node_modules/.bin, the copy that ships with JGates, PATH. Never `npx`.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findOnPath } from "../../core/bridge/index.js";

export interface DepcruiseProbe {
  /** What the plan runs: Node when the tool is a script, the tool itself otherwise. */
  executable: string | null;
  /** Leading arguments (the script path when it runs under Node). */
  prefix: string[];
  /** The resolved tool: the script or the binary. */
  tool: string | null;
  source: "env" | "project" | "bundled" | "path" | null;
  version: string | null;
  problem: "not_found" | "no_answer" | null;
  detail: string;
}

const SCRIPT = /\.(mjs|cjs|js)$/i;
const cache = new Map<string, { mtimeMs: number; version: string | null }>();
const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

/** The copy of dependency-cruiser that is a dependency of JGates (found by walking up from this module). */
function bundledScript(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, "node_modules", "dependency-cruiser", "bin", "dependency-cruiser.mjs");
    if (isFile(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function findDepcruise(workspace: string, env: NodeJS.ProcessEnv): { tool: string | null; source: DepcruiseProbe["source"]; tried: string[] } {
  const tried: string[] = [];
  if (env.JGATES_DEPCRUISE) {
    tried.push(env.JGATES_DEPCRUISE);
    const found = isFile(env.JGATES_DEPCRUISE) ? path.resolve(env.JGATES_DEPCRUISE) : findOnPath(env.JGATES_DEPCRUISE, env);
    return { tool: found ? real(found) : null, source: found ? "env" : null, tried };
  }
  const bin = path.join(workspace, "node_modules", ".bin", process.platform === "win32" ? "depcruise.cmd" : "depcruise");
  tried.push(bin);
  if (isFile(bin)) {
    // The .bin entry is a link to the script; on Windows it is a shim, which is run as it is.
    return { tool: real(bin), source: "project", tried };
  }
  const bundled = bundledScript();
  tried.push("dependency-cruiser of JGates");
  if (bundled) return { tool: real(bundled), source: "bundled", tried };
  tried.push("depcruise on PATH");
  const onPath = findOnPath("depcruise", env);
  return { tool: onPath ? real(onPath) : null, source: onPath ? "path" : null, tried };
}

export function probeDepcruise(workspace: string, env: NodeJS.ProcessEnv): DepcruiseProbe {
  const { tool, source, tried } = findDepcruise(workspace, env);
  if (!tool) return { executable: null, prefix: [], tool: null, source: null, version: null, problem: "not_found", detail: tried.join(", ") };
  const underNode = SCRIPT.test(tool);
  const executable = underNode ? process.execPath : tool;
  const prefix = underNode ? [tool] : [];
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(tool).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  const hit = cache.get(tool);
  let version: string | null;
  if (hit && hit.mtimeMs === mtimeMs) version = hit.version;
  else {
    const r = spawnSync(executable, [...prefix, "--version"], {
      encoding: "utf8",
      timeout: 60_000,
      env: { PATH: path.dirname(process.execPath), HOME: env.HOME ?? "" },
      windowsHide: true,
    });
    version = r.status === 0 ? (/(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? null) : null;
    cache.set(tool, { mtimeMs, version });
  }
  return version
    ? { executable, prefix, tool, source, version, problem: null, detail: "" }
    : { executable, prefix, tool, source, version: null, problem: "no_answer", detail: tool };
}
