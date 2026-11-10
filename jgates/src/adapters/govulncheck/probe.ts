// Whether govulncheck and the Go toolchain it needs are in the tools image, and their versions, from image.json
// (nothing starts). Inside the image only, JGATES_GOVULNCHECK names another executable, which is asked for its version.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { findOnPath } from "../../core/bridge/index.js";
import { imageProbeUnlessOverridden, inImageOverride, probeImageTool } from "../../core/tools-image/catalogue.js";
import { probeEnv } from "../../core/runner/probe-env.js";

export interface GovulncheckProbe {
  executable: string | null;
  version: string | null;
  /** The Go toolchain govulncheck needs to load the packages of the module (source mode). */
  go: string | null;
  problem: "not_found" | "no_go" | "no_answer" | null;
  detail: string;
}

const cache = new Map<string, { mtimeMs: number; version: string | null }>();
/** The executable JGATES_GOVULNCHECK names, inside the tools image only. */
export function findGovulncheck(env: NodeJS.ProcessEnv): { executable: string | null; tried: string[] } {
  const override = inImageOverride(env, "JGATES_GOVULNCHECK");
  return override ? { executable: findOnPath(override, env), tried: [override] } : { executable: null, tried: [] };
}

export function probeGovulncheck(env: NodeJS.ProcessEnv): GovulncheckProbe {
  const image = imageProbeUnlessOverridden("govulncheck", env, "JGATES_GOVULNCHECK");
  if (image) {
    if (image.problem !== null) return { ...image, go: null };
    const go = probeImageTool("go", env);
    return go.executable ? { ...image, go: go.executable } : { executable: image.executable, version: image.version, go: null, problem: "no_go", detail: go.detail };
  }
  const { executable, tried } = findGovulncheck(env);
  if (!executable) return { executable: null, version: null, go: null, problem: "not_found", detail: tried.join(", ") };
  const go = findOnPath("go", env);
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(executable).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  const hit = cache.get(executable);
  let version: string | null;
  if (hit && hit.mtimeMs === mtimeMs) version = hit.version;
  else {
    const r = spawnSync(executable, ["-version"], { encoding: "utf8", timeout: 30_000, env: probeEnv(env, { PATH: env.PATH ?? "", HOME: env.HOME ?? "", NO_COLOR: "1" }), windowsHide: true });
    version = r.status === 0 ? (/govulncheck@v?(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? null) : null;
    cache.set(executable, { mtimeMs, version });
  }
  if (!version) return { executable, version: null, go, problem: "no_answer", detail: executable };
  if (!go) return { executable, version, go: null, problem: "no_go", detail: "go on PATH" };
  return { executable, version, go, problem: null, detail: "" };
}
