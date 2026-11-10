// Finds the container runtime and the ZAP image the instance names, without pulling or changing anything.
import { spawnSync } from "node:child_process";
import { containerRuntime, runtimeClientEnv } from "../container-scanner/image.js";

export const DEFAULT_ZAP_IMAGE = "ghcr.io/zaproxy/zaproxy:stable";

export interface ZapProbe {
  /** The container runtime executable (docker or JGATES_CONTAINER_RUNTIME). */
  runtime: string | null;
  /** The local image id (sha256:...) the run will use, so what runs is what the plan recorded. */
  imageId: string | null;
  image: string;
  problem: "no_runtime" | "no_daemon" | "no_image" | null;
  detail: string;
}

const cache = new Map<string, { at: number; probe: ZapProbe }>();

export function probeZap(env: NodeJS.ProcessEnv, image: string = DEFAULT_ZAP_IMAGE): ZapProbe {
  const rt = containerRuntime(env);
  if (!rt.path) return { runtime: null, imageId: null, image, problem: "no_runtime", detail: rt.name };
  const key = `${rt.path}\n${image}`;
  const hit = cache.get(key);
  // A short cache: planning asks several times within one command.
  if (hit && Date.now() - hit.at < 10_000) return hit.probe;
  const r = spawnSync(rt.path, ["image", "inspect", "--format", "{{.Id}}", image], { encoding: "utf8", timeout: 30_000, env: runtimeClientEnv(env), windowsHide: true });
  let probe: ZapProbe;
  if (r.error) probe = { runtime: rt.path, imageId: null, image, problem: "no_daemon", detail: r.error.message };
  else if (r.status !== 0) {
    const text = `${r.stderr ?? ""}`.trim();
    // "No such image" is a missing image; anything else (daemon not running) is a runtime that does not answer.
    probe = /no such image|not found/i.test(text) ? { runtime: rt.path, imageId: null, image, problem: "no_image", detail: image } : { runtime: rt.path, imageId: null, image, problem: "no_daemon", detail: text.split(/\r?\n/).slice(-1)[0] ?? "" };
  } else {
    const id = r.stdout.trim().split(/\r?\n/)[0] ?? "";
    probe = /^sha256:[0-9a-f]{64}$/.test(id) ? { runtime: rt.path, imageId: id, image, problem: null, detail: "" } : { runtime: rt.path, imageId: null, image, problem: "no_image", detail: image };
  }
  cache.set(key, { at: Date.now(), probe });
  return probe;
}
