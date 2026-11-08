// Finds the govulncheck executable and asks it for its version, without installing or changing anything.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findOnPath } from "../../core/bridge/index.js";
import { resolveHome } from "../../core/home/index.js";
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
const exeName = process.platform === "win32" ? "govulncheck.exe" : "govulncheck";

/** JGATES_GOVULNCHECK, then <JGATES_HOME>/tools/bin, then where `go install` puts it ($GOBIN, $GOPATH/bin, ~/go/bin), then PATH. */
export function findGovulncheck(env: NodeJS.ProcessEnv): { executable: string | null; tried: string[] } {
  const tried: string[] = [];
  if (env.JGATES_GOVULNCHECK) {
    tried.push(env.JGATES_GOVULNCHECK);
    return { executable: findOnPath(env.JGATES_GOVULNCHECK, env), tried };
  }
  const homes = [path.join(resolveHome({ env }), "tools", "bin")];
  if (env.GOBIN) homes.push(env.GOBIN);
  if (env.GOPATH) for (const p of env.GOPATH.split(path.delimiter)) if (p) homes.push(path.join(p, "bin"));
  homes.push(path.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), "go", "bin"));
  for (const dir of homes) {
    const candidate = path.join(dir, exeName);
    tried.push(candidate);
    if (fs.existsSync(candidate)) return { executable: candidate, tried };
  }
  tried.push("govulncheck on PATH");
  return { executable: findOnPath("govulncheck", env), tried };
}

export function probeGovulncheck(env: NodeJS.ProcessEnv): GovulncheckProbe {
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
