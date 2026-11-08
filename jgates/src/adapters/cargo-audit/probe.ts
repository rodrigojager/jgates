// Finds the cargo-audit executable and asks it for its version, without installing or changing anything.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findOnPath } from "../../core/bridge/index.js";
import { resolveHome } from "../../core/home/index.js";
import { probeEnv } from "../../core/runner/probe-env.js";

export interface CargoAuditProbe {
  executable: string | null;
  version: string | null;
  problem: "not_found" | "no_answer" | null;
  detail: string;
}

const cache = new Map<string, { mtimeMs: number; version: string | null }>();
const exeName = process.platform === "win32" ? "cargo-audit.exe" : "cargo-audit";

/** JGATES_CARGO_AUDIT, then <JGATES_HOME>/tools/bin, then where `cargo install` puts it ($CARGO_HOME/bin, ~/.cargo/bin), then PATH. */
export function findCargoAudit(env: NodeJS.ProcessEnv): { executable: string | null; tried: string[] } {
  const tried: string[] = [];
  if (env.JGATES_CARGO_AUDIT) {
    tried.push(env.JGATES_CARGO_AUDIT);
    return { executable: findOnPath(env.JGATES_CARGO_AUDIT, env), tried };
  }
  const dirs = [path.join(resolveHome({ env }), "tools", "bin")];
  if (env.CARGO_HOME) dirs.push(path.join(env.CARGO_HOME, "bin"));
  dirs.push(path.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), ".cargo", "bin"));
  for (const dir of dirs) {
    const candidate = path.join(dir, exeName);
    tried.push(candidate);
    if (fs.existsSync(candidate)) return { executable: candidate, tried };
  }
  tried.push("cargo-audit on PATH");
  return { executable: findOnPath("cargo-audit", env), tried };
}

export function probeCargoAudit(env: NodeJS.ProcessEnv): CargoAuditProbe {
  const { executable, tried } = findCargoAudit(env);
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
  const version = r.status === 0 ? (/cargo-audit(?:\.exe)?\s+(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? /(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? null) : null;
  cache.set(executable, { mtimeMs, version });
  return version ? { executable, version, problem: null, detail: "" } : { executable, version: null, problem: "no_answer", detail: executable };
}
