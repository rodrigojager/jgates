// Whether the CodeQL CLI is available, without installing or changing anything. CodeQL is customer supplied and never
// in the tools image (ADR-0005): image.json does not list it, so on the host it is missing until it is prepared into
// its own volume. Inside the image only, JGATES_CODEQL names the executable, which is asked for its version.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { findOnPath } from "../../core/bridge/index.js";
import { imageProbeUnlessOverridden, inImageOverride } from "../../core/tools-image/catalogue.js";
import { probeEnv } from "../../core/runner/probe-env.js";

export interface CodeqlProbe {
  executable: string | null;
  version: string | null;
  problem: "not_found" | "no_answer" | null;
  detail: string;
}

const cache = new Map<string, { mtimeMs: number; version: string | null }>();
/** The executable JGATES_CODEQL names, inside the tools image only. */
export function findCodeql(env: NodeJS.ProcessEnv): { executable: string | null; tried: string[] } {
  const override = inImageOverride(env, "JGATES_CODEQL");
  return override ? { executable: findOnPath(override, env), tried: [override] } : { executable: null, tried: [] };
}

/** Readiness: `codeql version --format=terse` prints just the version (older CLIs print a banner; both are read). */
export function probeCodeql(env: NodeJS.ProcessEnv): CodeqlProbe {
  const image = imageProbeUnlessOverridden("codeql", env, "JGATES_CODEQL");
  if (image) return image;
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
