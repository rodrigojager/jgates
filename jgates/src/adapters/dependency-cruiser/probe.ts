// Finds dependency-cruiser without installing or downloading anything. Container-first, it is the tools image's copy,
// from image.json (nothing starts). Inside the image only: JGATES_DEPCRUISE, then the project's own
// node_modules/.bin, then the image's copy; a copy on disk is asked for its version. Never `npx`.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findOnPath } from "../../core/bridge/index.js";
import { inImageOverride, probeImageTool } from "../../core/tools-image/catalogue.js";
import { stepMode } from "../../core/runner/in-image.js";

export interface DepcruiseProbe {
  /** What the plan runs: Node when the tool is a script, the tool itself otherwise. */
  executable: string | null;
  /** Leading arguments (the script path when it runs under Node). */
  prefix: string[];
  /** The resolved tool: the script or the binary. */
  tool: string | null;
  source: "env" | "project" | "image" | null;
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

/** In the image only: JGATES_DEPCRUISE, then the project's node_modules/.bin. Null tool: use the image's copy. */
export function findDepcruise(workspace: string, env: NodeJS.ProcessEnv): { tool: string | null; source: DepcruiseProbe["source"]; tried: string[] } {
  const named = inImageOverride(env, "JGATES_DEPCRUISE");
  if (named) {
    const found = isFile(named) ? path.resolve(named) : findOnPath(named, env);
    return { tool: found ? real(found) : null, source: found ? "env" : null, tried: [named] };
  }
  if (stepMode(env) !== "in-image") return { tool: null, source: null, tried: [] };
  const bin = path.join(workspace, "node_modules", ".bin", process.platform === "win32" ? "depcruise.cmd" : "depcruise");
  // The .bin entry is a link to the script; on Windows it is a shim, which is run as it is.
  return isFile(bin) ? { tool: real(bin), source: "project", tried: [bin] } : { tool: null, source: null, tried: [bin] };
}

export function probeDepcruise(workspace: string, env: NodeJS.ProcessEnv): DepcruiseProbe {
  const { tool, source, tried } = findDepcruise(workspace, env);
  if (!tool && inImageOverride(env, "JGATES_DEPCRUISE")) return { executable: null, prefix: [], tool: null, source: null, version: null, problem: "not_found", detail: tried.join(", ") };
  if (!tool) {
    const image = probeImageTool("dependency-cruiser", env);
    return image.problem === null
      ? { executable: image.executable, prefix: [], tool: image.executable, source: "image", version: image.version, problem: null, detail: "" }
      : { executable: null, prefix: [], tool: null, source: null, version: null, problem: "not_found", detail: image.detail };
  }
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
