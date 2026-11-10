// Whether the Schemathesis CLI (`st`) is in the tools image, and its version, from image.json (nothing starts). Inside
// the image only, JGATES_SCHEMATHESIS names another executable, which is asked for its version.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { findOnPath } from "../../core/bridge/index.js";
import { besideOverridePython, imageProbeUnlessOverridden, inImageOverride } from "../../core/tools-image/catalogue.js";
import { probeEnv } from "../../core/runner/probe-env.js";

export interface SchemathesisProbe {
  executable: string | null;
  version: string | null;
  problem: "not_found" | "no_answer" | null;
  detail: string;
}

const cache = new Map<string, { mtimeMs: number; version: string | null }>();
/** Inside the tools image only: the executable JGATES_SCHEMATHESIS names, else the one beside the JGATES_PYTHON override. */
export function findSchemathesis(env: NodeJS.ProcessEnv): { executable: string | null; tried: string[] } {
  const override = inImageOverride(env, "JGATES_SCHEMATHESIS") ?? besideOverridePython(env, "st");
  return override ? { executable: findOnPath(override, env), tried: [override] } : { executable: null, tried: [] };
}

export function probeSchemathesis(env: NodeJS.ProcessEnv): SchemathesisProbe {
  const image = imageProbeUnlessOverridden("schemathesis", env, "JGATES_SCHEMATHESIS");
  if (image) return image;
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
