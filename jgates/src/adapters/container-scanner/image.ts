// Which container runtime and which image a security scanner runs in, looked up without starting anything. Every
// scanner runs in the JGates tools image (container-first, ADR-0004): its image.json says whether the scanner is
// there and which version (the package's mirror of it on the host, release/image-tools.json); the image reference is
// the one the release pins (or JGATES_TOOLS_IMAGE for a development image). There is no local runner and no image to
// prepare per instance.
import { findOnPath } from "../../core/bridge/index.js";
import { engineRuntime } from "../../core/engine/index.js";
import { DOCKER_CLIENT_ENV } from "../../core/runner/index.js";
import { probeImageTool } from "../../core/tools-image/catalogue.js";
import { toolsImageTarget } from "../../core/tools-image/index.js";

/** The engine itself (missing, stopped) is the plan's one preflight blocker, never a per-scanner problem. */
export type ImageProblem = "not_in_image";

/** The legacy sidecar image (quality-gate/Dockerfile) of the bridge's container mode and of `trivy image` scans. */
export const SIDECAR_IMAGE = "jgates/quality-sidecar:latest";

/** The engine's runtime (JGATES_CONTAINER_RUNTIME, the user's preference, else docker), looked up on the PATH. */
export function containerRuntime(env: NodeJS.ProcessEnv): { name: string; path: string | null } {
  const name = engineRuntime(env);
  return { name, path: findOnPath(name, env) };
}

export interface ScannerImageProbe {
  /** Absolute path of the container runtime client, or null when it was not found. */
  runtime: string | null;
  /** The runtime name or path that was looked up. */
  runtimeName: string;
  /** The tools image reference the runner starts. */
  image: string | null;
  /** The scanner's version in the image (image.json). */
  version: string | null;
  problem: ImageProblem | null;
  detail: string;
}

/** Environment of the runtime client: the basic variables and the Docker connection settings, nothing else. */
export function runtimeClientEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", ...DOCKER_CLIENT_ENV]) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** The tools image and the scanner's version in it, with the runtime client (see containerRuntime). */
export function probeScannerImage(env: NodeJS.ProcessEnv, toolName: string): ScannerImageProbe {
  const { name: runtimeName, path: runtime } = containerRuntime(env);
  let image: string | null;
  try {
    image = toolsImageTarget(env).reference;
  } catch {
    image = null;
  }
  const tool = probeImageTool(toolName, env);
  const base = { runtime, runtimeName, image, version: tool.version };
  if (tool.problem !== null) return { ...base, problem: "not_in_image", detail: tool.detail };
  return { ...base, problem: null, detail: "" };
}
