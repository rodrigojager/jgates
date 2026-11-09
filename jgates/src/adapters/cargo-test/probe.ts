// Finds the cargo executable and asks it for its version, without installing or changing anything. The Rust toolchain
// is supplied by the customer: JGATES_CARGO, else cargo on the PATH (rustup's shim included).
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { findOnPath } from "../../core/bridge/index.js";
import { probeEnv } from "../../core/runner/probe-env.js";

export interface CargoProbe {
  executable: string | null;
  version: string | null;
  problem: "not_found" | "no_answer" | null;
  detail: string;
}

const cache = new Map<string, { mtimeMs: number; version: string | null }>();

export function findCargo(env: NodeJS.ProcessEnv): { executable: string | null; tried: string[] } {
  const name = env.JGATES_CARGO || "cargo";
  return { executable: findOnPath(name, env), tried: [env.JGATES_CARGO ? env.JGATES_CARGO : "cargo on PATH"] };
}

export function probeCargo(env: NodeJS.ProcessEnv): CargoProbe {
  const { executable, tried } = findCargo(env);
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
  const r = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 60_000, env: probeEnv(env, { PATH: env.PATH ?? "", HOME: env.HOME ?? "", NO_COLOR: "1" }), windowsHide: true });
  const version = r.status === 0 ? (/cargo\s+(\d+\.\d+\.\d+\S*)/i.exec(r.stdout)?.[1] ?? null) : null;
  cache.set(executable, { mtimeMs, version });
  return version ? { executable, version, problem: null, detail: "" } : { executable, version: null, problem: "no_answer", detail: executable };
}
