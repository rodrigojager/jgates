// Container runner: translates an ExecutionSpec into one `docker run`.
// The image is pinned by digest, the workspace is a read-only mount, the output folder is a separate writable mount,
// the root filesystem is read-only, the network is off unless the spec asks for it, the limits are always set, and the
// container never gets --privileged, extra capabilities or the Docker socket. Cancelling or timing out removes the
// container by name (not only the client process). Nothing from the parent environment reaches the container.
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ENV_ALLOWLIST, runSpec, type ExecutionResult, type RunnerOptions } from "./process.js";
import { currentScope } from "./scope.js";

export const CONTAINER_WORKSPACE = "/workspace";
export const CONTAINER_OUTPUT = "/output";
export const DEFAULT_CONTAINER_LIMITS = { memoryMb: 1024, cpus: 2, pids: 256, tmpfsMb: 64 } as const;
/** Connection settings of the Docker client; they stay on the host side and are never passed into the container. */
export const DOCKER_CLIENT_ENV: readonly string[] = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "XDG_RUNTIME_DIR"];

const DIGEST_IMAGE = /^(?:[A-Za-z0-9][A-Za-z0-9._\-/:]*@)?sha256:[0-9a-f]{64}$/;

export interface ContainerSpec {
  /** Runtime executable; defaults to `docker`. */
  runtime?: string;
  /** Image by digest: `name@sha256:<64 hex>` or an image id `sha256:<64 hex>`. A tag is refused. */
  image: string;
  /** Command and arguments run in the container (the image entrypoint receives them). */
  command: string[];
  /** Host folder mounted read-only at /workspace. */
  workspace: string;
  /** Host folder mounted writable at /output, kept apart from the workspace. */
  outputDir?: string;
  /** Working directory relative to the workspace ("." = the root). */
  cwd?: string;
  /** `uid:gid`; defaults to the host user (never root). "root" is a declared exception, reported in the result. */
  user?: string;
  /** Extra environment given to the tool (the only variables the container sees). */
  env?: Record<string, string>;
  limits?: { memoryMb?: number; cpus?: number; pids?: number; tmpfsMb?: number };
  /** `none` (default) or `bridge`; the second one is a declared need of the tool (rule updates, online lookups). */
  network?: "none" | "bridge";
  timeoutMs?: number;
  /** Labels put on the container (for example org.jgates.dev=true in the development smoke). */
  labels?: Record<string, string>;
  /** Container name; generated when absent. */
  name?: string;
  signal?: AbortSignal;
  stdin?: string | null;
  stdoutFile?: string;
  stderrFile?: string;
}

export interface ContainerFacts {
  runtime: string;
  name: string;
  image: string;
  user: string;
  rootException: boolean;
  network: "none" | "bridge";
  /** The `docker run` arguments, exactly as started. */
  args: string[];
  /** The container was asked to be removed after a cancellation, a timeout or a client that died. */
  removalRequested: boolean;
  /** The runtime answered that exit code 125-127 (the runtime itself failed, not the tool). */
  runtimeFailure: boolean;
}

export type ContainerResult = ExecutionResult & { container: ContainerFacts };

export class ContainerSpecError extends Error {
  constructor(
    readonly code: "IMAGE_NOT_PINNED" | "BAD_MOUNT" | "BAD_LIMIT" | "BAD_NAME" | "BAD_CWD" | "BAD_ENV" | "BAD_USER",
    message: string,
  ) {
    super(message);
    this.name = "ContainerSpecError";
  }
}

function mountPath(p: string, what: string): string {
  if (!path.isAbsolute(p)) throw new ContainerSpecError("BAD_MOUNT", `${what} must be an absolute path: ${p}`);
  if (/[,\n\r\0]/.test(p)) throw new ContainerSpecError("BAD_MOUNT", `${what} has a character a mount cannot carry: ${JSON.stringify(p)}`);
  const resolved = path.resolve(p);
  if (/docker\.sock/.test(resolved)) throw new ContainerSpecError("BAD_MOUNT", `${what} must not be the Docker socket`);
  return resolved;
}

function limit(value: number | undefined, fallback: number, name: string, integer: boolean): number {
  const v = value ?? fallback;
  if (!Number.isFinite(v) || v <= 0 || (integer && !Number.isInteger(v))) throw new ContainerSpecError("BAD_LIMIT", `${name} must be a positive ${integer ? "integer" : "number"}: ${String(v)}`);
  return v;
}

/** Host user as `uid:gid`; 65534 (nobody) where there is no uid or the host user is root. */
export function defaultContainerUser(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  return uid > 0 && gid >= 0 ? `${uid}:${gid}` : "65534:65534";
}

export function containerName(): string {
  return `jgates-${randomBytes(6).toString("hex")}`;
}

/** The path a workspace-relative file has inside the container (forward slashes, no way out of /workspace). */
export function toContainerPath(relative: string, root: string = CONTAINER_WORKSPACE): string {
  const clean = path.posix.normalize(relative.split(path.sep).join("/") || ".");
  if (clean === ".." || clean.startsWith("../") || path.posix.isAbsolute(clean)) throw new ContainerSpecError("BAD_CWD", `path leaves the workspace: ${relative}`);
  return clean === "." ? root : `${root}/${clean}`;
}

/** The `docker run` arguments of a spec (validated); a pure function, so a fake runtime can record them. */
export function buildContainerArgs(spec: ContainerSpec): { args: string[]; name: string; user: string; rootException: boolean; network: "none" | "bridge" } {
  if (!DIGEST_IMAGE.test(spec.image)) throw new ContainerSpecError("IMAGE_NOT_PINNED", `the image must be pinned by digest (name@sha256:... or sha256:...), got ${spec.image}`);
  const name = spec.name ?? containerName();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) throw new ContainerSpecError("BAD_NAME", `invalid container name: ${name}`);
  const workspace = mountPath(spec.workspace, "workspace");
  const user = spec.user ?? defaultContainerUser();
  if (!/^(?:root|0|0:0|[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?)$/.test(user)) throw new ContainerSpecError("BAD_USER", `invalid user: ${user}`);
  const rootException = user === "root" || user === "0" || user.startsWith("0:") || user.startsWith("root:");
  const network = spec.network ?? "none";
  const memoryMb = limit(spec.limits?.memoryMb, DEFAULT_CONTAINER_LIMITS.memoryMb, "memoryMb", true);
  const cpus = limit(spec.limits?.cpus, DEFAULT_CONTAINER_LIMITS.cpus, "cpus", false);
  const pids = limit(spec.limits?.pids, DEFAULT_CONTAINER_LIMITS.pids, "pids", true);
  const tmpfsMb = limit(spec.limits?.tmpfsMb, DEFAULT_CONTAINER_LIMITS.tmpfsMb, "tmpfsMb", true);

  const args = [
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    "--read-only",
    "--network",
    network,
    "--memory",
    `${memoryMb}m`,
    "--memory-swap",
    `${memoryMb}m`,
    "--cpus",
    String(cpus),
    "--pids-limit",
    String(pids),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,size=${tmpfsMb}m`,
    "--user",
    user,
    "--mount",
    `type=bind,src=${workspace},dst=${CONTAINER_WORKSPACE},readonly`,
  ];
  if (spec.outputDir !== undefined) args.push("--mount", `type=bind,src=${mountPath(spec.outputDir, "outputDir")},dst=${CONTAINER_OUTPUT}`);
  args.push("--workdir", toContainerPath(spec.cwd ?? "."));
  for (const [k, v] of Object.entries(spec.labels ?? {})) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(k) || /[\n\r\0]/.test(v)) throw new ContainerSpecError("BAD_ENV", `invalid label: ${k}`);
    args.push("--label", `${k}=${v}`);
  }
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || /[\n\r\0]/.test(v)) throw new ContainerSpecError("BAD_ENV", `invalid environment variable: ${k}`);
    args.push("--env", `${k}=${v}`);
  }
  if (spec.stdin !== undefined && spec.stdin !== null) args.push("--interactive");
  args.push(spec.image, ...spec.command);
  return { args, name, user, rootException, network };
}

/** Never-aborting signal: the removal of a container must run even when the run itself was cancelled. */
const NEVER = new AbortController().signal;

async function removeContainer(runtime: string, name: string, options: RunnerOptions): Promise<void> {
  await runSpec({ executable: runtime, args: ["rm", "--force", name], cwd: os.tmpdir(), timeoutMs: 30_000, signal: NEVER }, options);
}

export async function runContainer(spec: ContainerSpec, options: RunnerOptions = {}): Promise<ContainerResult> {
  const runtime = spec.runtime ?? "docker";
  const built = buildContainerArgs(spec);
  const runnerOptions: RunnerOptions = { ...options, envAllowlist: [...(options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST),...DOCKER_CLIENT_ENV] };
  const abort = spec.signal ?? currentScope()?.signal;
  let removal: Promise<void> | null = null;
  let removalRequested = false;
  const requestRemoval = (): Promise<void> => {
    removalRequested = true;
    removal ??= removeContainer(runtime, built.name, runnerOptions).catch(() => undefined);
    return removal;
  };
  // The client process is stopped by runSpec; the container belongs to the daemon, so it is removed by name as well.
  const onAbort = (): void => void requestRemoval();
  abort?.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await runSpec(
      {
        executable: runtime,
        args: built.args,
        cwd: os.tmpdir(),
        stdin: spec.stdin ?? null,
        ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
        ...(spec.signal ? { signal: spec.signal } : {}),
        ...(spec.stdoutFile ? { stdoutFile: spec.stdoutFile } : {}),
        ...(spec.stderrFile ? { stderrFile: spec.stderrFile } : {}),
      },
      runnerOptions,
    );
    // Cancelled, timed out or a client that died without an exit code: make sure no container is left behind.
    if (result.cancelled || result.timedOut || (result.exitCode === null && !result.spawnError)) await requestRemoval();
    else if (removal) await removal;
    return {
      ...result,
      container: {
        runtime,
        name: built.name,
        image: spec.image,
        user: built.user,
        rootException: built.rootException,
        network: built.network,
        args: built.args,
        removalRequested,
        runtimeFailure: result.exitCode !== null && result.exitCode >= 125 && result.exitCode <= 127,
      },
    };
  } finally {
    abort?.removeEventListener("abort", onAbort);
  }
}
