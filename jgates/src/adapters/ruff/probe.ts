// Whether Ruff is in the tools image, and its version, from image.json (nothing starts). Inside the image only,
// JGATES_RUFF names another executable, which is asked for its version.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { findOnPath } from "../../core/bridge/index.js";
import { besideOverridePython, imageProbeUnlessOverridden, inImageOverride } from "../../core/tools-image/catalogue.js";
import { probeEnv } from "../../core/runner/probe-env.js";

export interface RuffProbe {
  /** Absolute executable path, or null when none was found. */
  executable: string | null;
  version: string | null;
  /** Why it is not usable (not found, did not answer). */
  problem: "not_found" | "no_answer" | null;
  detail: string;
}

/** Whether the executable named for Ruff is a Node script (a test double or a wrapper), which Node has to run. */
export function isNodeScript(executable: string): boolean {
  return /\.(?:mjs|cjs|js)$/i.test(executable);
}

const cache = new Map<string, { mtimeMs: number; version: string | null }>();

/** Inside the tools image only: the executable JGATES_RUFF names, else the one beside the JGATES_PYTHON override. */
export function findRuff(env: NodeJS.ProcessEnv): { executable: string | null; tried: string[] } {
  const override = inImageOverride(env, "JGATES_RUFF") ?? besideOverridePython(env, "ruff");
  return override ? { executable: findOnPath(override, env), tried: [override] } : { executable: null, tried: [] };
}

export function probeRuff(env: NodeJS.ProcessEnv): RuffProbe {
  const image = imageProbeUnlessOverridden("ruff", env, "JGATES_RUFF");
  if (image) return image;
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
  const script = isNodeScript(executable);
  const r = spawnSync(script ? process.execPath : executable, script ? [executable, "--version"] : ["--version"], { encoding: "utf8", timeout: 15_000, env: probeEnv(env, { PATH: env.PATH ?? "", HOME: env.HOME ?? "" }), windowsHide: true });
  const version = r.status === 0 ? (/(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? null) : null;
  cache.set(executable, { mtimeMs, version });
  return version ? { executable, version, problem: null, detail: "" } : { executable, version: null, problem: "no_answer", detail: executable };
}
