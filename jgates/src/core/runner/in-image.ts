// Where a step runs: in a container the host launches (`container`, the default), or natively because JGates itself is
// running inside the tools image (`in-image`, detected from /etc/jgates/image.json). Outside the image a native step is
// refused: container-first means no tool ever runs as a host process (ADR-0004).
import fs from "node:fs";

export const IMAGE_JSON_PATH = "/etc/jgates/image.json";
export const HOST_EXECUTION_REFUSED = "HOST_EXECUTION_REFUSED";

export type StepMode = "container" | "in-image";

/** The facts the image records about itself (written at build time). */
export interface ImageJson {
  jgatesVersion?: string;
  imageVersion?: string;
  tools?: Record<string, string>;
  runtimeDefaults?: Record<string, unknown>;
  sourceRevision?: string;
  [key: string]: unknown;
}

/** JGATES_IMAGE_JSON overrides the path (tests, and images that mount the file elsewhere). */
export function imageJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.JGATES_IMAGE_JSON?.trim() || IMAGE_JSON_PATH;
}

/** The parsed image.json, or null when this process is not inside the tools image (absent or unreadable file). */
export function readImageJson(env: NodeJS.ProcessEnv = process.env): ImageJson | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(imageJsonPath(env), "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ImageJson) : null;
  } catch {
    return null;
  }
}

export function stepMode(env: NodeJS.ProcessEnv = process.env): StepMode {
  return readImageJson(env) ? "in-image" : "container";
}

/** A native launch outside the image and without an engine to launch it in. */
export class HostExecutionRefused extends Error {
  readonly code = HOST_EXECUTION_REFUSED;
  constructor(detail: string) {
    super(`${HOST_EXECUTION_REFUSED}: ${detail}`);
    this.name = "HostExecutionRefused";
  }
}

/** Throws HostExecutionRefused unless this process runs inside the tools image. */
export function assertNativeAllowed(env: NodeJS.ProcessEnv = process.env, executable = "a tool"): void {
  if (stepMode(env) !== "in-image") throw new HostExecutionRefused(`${executable} would run as a host process; tools run in the JGates tools image only`);
}
