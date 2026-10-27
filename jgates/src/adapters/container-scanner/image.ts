// Which container runtime and which image a security scanner runs in, looked up without starting a container.
// The image comes only from .jgates/lock.json, where `jgates tools prepare` pinned it (repository digest or image id)
// with the version of the tool read from the label org.jgates.tool.<tool>.version: the sidecar image
// (quality-gate/Dockerfile) carries several tools, so one label per tool; jgates/docker/security/Dockerfile carries the
// same labels.
import { probeLockedImage, runtimeClientEnv, SIDECAR_IMAGE, toolVersionLabel, type LockedImageProbe, type LockedImageProblem } from "../../core/prepare/image.js";

export { runtimeClientEnv, SIDECAR_IMAGE, toolVersionLabel };

export type ImageProblem = LockedImageProblem;

export type ScannerImageProbe = LockedImageProbe;

/** The image the lock pins for one scanner instance, checked against the runtime (JGATES_CONTAINER_RUNTIME, default docker). */
export function probeScannerImage(env: NodeJS.ProcessEnv, dir: string, instance: string): ScannerImageProbe {
  return probeLockedImage({ env, dir, instance });
}
