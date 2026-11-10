// Whether zizmor is in the tools image, and its version, from image.json (nothing starts). Inside the image only,
// JGATES_ZIZMOR names another executable, which is asked for its version.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { findOnPath } from "../../core/bridge/index.js";
import { besideOverridePython, imageProbeUnlessOverridden, inImageOverride } from "../../core/tools-image/catalogue.js";
import { probeEnv } from "../../core/runner/probe-env.js";

export interface ZizmorProbe {
  executable: string | null;
  version: string | null;
  problem: "not_found" | "no_answer" | null;
  detail: string;
}

const cache = new Map<string, { mtimeMs: number; version: string | null }>();
/** Inside the tools image only: the executable JGATES_ZIZMOR names, else the one beside the JGATES_PYTHON override. */
export function findZizmor(env: NodeJS.ProcessEnv): { executable: string | null; tried: string[] } {
  const override = inImageOverride(env, "JGATES_ZIZMOR") ?? besideOverridePython(env, "zizmor");
  return override ? { executable: findOnPath(override, env), tried: [override] } : { executable: null, tried: [] };
}

export function probeZizmor(env: NodeJS.ProcessEnv): ZizmorProbe {
  const image = imageProbeUnlessOverridden("zizmor", env, "JGATES_ZIZMOR");
  if (image) return image;
  const { executable, tried } = findZizmor(env);
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
