// Ruff in the container runner (tools.yml `runner: container`): which runtime and which image, both looked up
// without starting a container. The image comes only from .jgates/lock.json, where `jgates tools prepare` pinned it by
// digest (or image id) with the Ruff version of its label (org.jgates.tool.ruff.version or org.jgates.tool.version,
// jgates/docker/ruff/Dockerfile); the plan shows the image and that version.
import { probeLockedImage, runtimeClientEnv, SINGLE_TOOL_VERSION_LABEL, type LockedImageProbe } from "../../core/prepare/image.js";

export const IMAGE_VERSION_LABEL = SINGLE_TOOL_VERSION_LABEL;

export type RuffImageProbe = LockedImageProbe;

/** Environment of the runtime client: the basic variables and the Docker connection settings, nothing else. */
export const containerClientEnv = runtimeClientEnv;

/** The image the lock pins for the Ruff instance, checked against the runtime (JGATES_CONTAINER_RUNTIME, default docker). */
export function probeRuffImage(env: NodeJS.ProcessEnv, dir: string, instance: string): RuffImageProbe {
  return probeLockedImage({ env, dir, instance });
}
