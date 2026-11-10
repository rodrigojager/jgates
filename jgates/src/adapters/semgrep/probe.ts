// Whether Semgrep is in the tools image, and its version, from image.json (nothing starts). Inside the image only,
// JGATES_SEMGREP names another executable, which is asked for its version.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findOnPath } from "../../core/bridge/index.js";
import { besideOverridePython, imageProbeUnlessOverridden, inImageOverride } from "../../core/tools-image/catalogue.js";
import { probeEnv } from "../../core/runner/probe-env.js";

export interface SemgrepProbe {
  executable: string | null;
  version: string | null;
  problem: "not_found" | "no_answer" | null;
  detail: string;
}

const cache = new Map<string, { mtimeMs: number; version: string | null }>();

/** Inside the tools image only: the executable JGATES_SEMGREP names, else the one beside the JGATES_PYTHON override. */
export function findSemgrep(env: NodeJS.ProcessEnv): { executable: string | null; tried: string[] } {
  const override = inImageOverride(env, "JGATES_SEMGREP") ?? besideOverridePython(env, "semgrep");
  return override ? { executable: findOnPath(override, env), tried: [override] } : { executable: null, tried: [] };
}

/** Semgrep's native core runs `uname`: the scanner's PATH always carries the system folders, even when the caller's is empty. */
export function scannerPath(parent: string | undefined): string {
  if (process.platform === "win32") return parent ?? "";
  const parts = (parent ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of ["/usr/bin", "/bin"]) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(path.delimiter);
}

export function probeSemgrep(env: NodeJS.ProcessEnv): SemgrepProbe {
  const image = imageProbeUnlessOverridden("semgrep", env, "JGATES_SEMGREP");
  if (image) return image;
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
  // A Node script named for Semgrep (a wrapper or a test double) runs through the Node that runs JGates.
  const script = /\.(?:mjs|cjs|js)$/i.test(executable);
  const r = spawnSync(script ? process.execPath : executable, script ? [executable, "--version", "--disable-version-check"] : ["--version", "--disable-version-check"], {
    encoding: "utf8",
    timeout: 60_000,
    env: probeEnv(env, { PATH: scannerPath(env.PATH), HOME: env.HOME ?? "", SEMGREP_SEND_METRICS: "off", SEMGREP_ENABLE_VERSION_CHECK: "0" }),
    windowsHide: true,
  });
  const version = r.status === 0 ? (/(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? null) : null;
  cache.set(executable, { mtimeMs, version });
  return version ? { executable, version, problem: null, detail: "" } : { executable, version: null, problem: "no_answer", detail: executable };
}
