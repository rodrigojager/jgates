// Container runner: translates an ExecutionSpec into one `docker run`.
// The image is pinned by digest, the workspace is a read-only mount, the output folder is a separate writable mount,
// the root filesystem is read-only, the network is off unless the spec asks for it, the limits are always set, and the
// container never gets --privileged, extra capabilities or the Docker socket. Cancelling or timing out removes the
// container by name (not only the client process). Nothing from the parent environment reaches the container.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_RESOURCES,
  engineLabels,
  engineReachable,
  engineRuntime,
  IMAGE_USER,
  inspectImageSync,
  runInEngine,
  sourceVolumeName,
  type EngineContext,
  type EngineMount,
} from "../engine/index.js";
import { toolsImageTarget } from "../tools-image/index.js";
import { HOST_EXECUTION_REFUSED, stepMode } from "./in-image.js";
import { CONTAINER_HEADER_MARK, containerHeader } from "./log-sink.js";
import { DEFAULT_ENV_ALLOWLIST, runSpec, type ExecutionResult, type ExecutionSpec, type RunnerOptions } from "./process.js";
import { currentScope, type StepLauncherHook } from "./scope.js";

export const CONTAINER_WORKSPACE = "/workspace";
export const CONTAINER_OUTPUT = "/output";
export const CONTAINER_CACHE = "/cache";
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
  /**
   * Host folder mounted writable at /cache and kept between runs (the scanners' databases and rule caches), in the
   * JGates data folder, never in the workspace.
   */
  cacheDir?: string;
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
  if (spec.cacheDir !== undefined) args.push("--mount", `type=bind,src=${mountPath(spec.cacheDir, "cacheDir")},dst=${CONTAINER_CACHE}`);
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

// ---------------------------------------------------------------------------------------------------------------------
// The step launcher (container-first): every process of a plan step is one `docker run --pull never` of the tools image
// under the step container contract. The adapters keep building the commands they build today; the launcher maps the
// host paths of the workspace and the run folder to /workspace and /output, so nothing from the host is mounted but the
// run folder, and the project itself is never mounted (the steps work on the synchronized volume).
// ---------------------------------------------------------------------------------------------------------------------

export interface StepLauncherInput {
  env: NodeJS.ProcessEnv;
  /** Workspace id (ws_<16 hex>): selects the source volume `jgates-<ws>-src`. */
  workspaceId: string;
  runId: string;
  /** The run folder on the host; mounted at /output, the only host folder a step sees. */
  runDir: string;
  /** The folder the adapters believe is the workspace (host path); its prefix is mapped to /workspace. */
  projectDir: string;
  version: string;
  engine?: EngineContext;
  /** Image id or reference; resolved with the engine when absent. */
  image?: string;
  /**
   * What a step gets besides the source volume and the run folder: the dependency volumes of the units it needs, the
   * package cache and their variables (core/deps). Asked when each process starts; null or absent: nothing more.
   */
  stepEnvironment?: (stepId: string) => { mounts: EngineMount[]; env: Record<string, string> } | null;
}

/** The user a step runs as: the host uid:gid on Linux, the image user on Windows and macOS. */
export function stepUser(): string {
  if (process.platform === "linux" && typeof process.getuid === "function" && typeof process.getgid === "function") {
    const uid = process.getuid();
    const gid = process.getgid();
    if (uid > 0) return `${uid}:${gid}`;
  }
  return IMAGE_USER;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces host path prefixes in a text by their container paths (the rest of the path gets forward slashes). */
export function mapHostPaths(text: string, pairs: Array<{ host: string; target: string }>): string {
  let out = text;
  for (const { host, target } of [...pairs].sort((a, b) => b.host.length - a.host.length)) {
    const variants = [...new Set([host, host.split("\\").join("/")])].filter(Boolean);
    for (const variant of variants) {
      const re = new RegExp(`${escapeRegExp(variant)}(?=$|[\\\\/\\s"'<>|,;:)\\]}])((?:[\\\\/][^\\s"'<>|,;]*)?)`, process.platform === "win32" ? "gi" : "g");
      out = out.replace(re, (_m, rest: string) => `${target}${rest.split("\\").join("/")}`);
    }
  }
  return out;
}

const ENGINE_CLIENT = /^(?:docker|podman)(?:\.exe)?$/i;

function refusal(spec: ExecutionSpec, message: string): ExecutionResult {
  const now = new Date().toISOString();
  return {
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    cancelled: false,
    truncated: false,
    spawnError: { code: HOST_EXECUTION_REFUSED, message: `${spec.executable}: ${message}` },
    pid: null,
    startedAt: now,
    finishedAt: now,
    stdoutBytes: 0,
    stderrBytes: 0,
    logTruncated: false,
  };
}

export const ENGINE_LOST = "ENGINE_LOST";

function lostResult(spec: ExecutionSpec, message: string): ExecutionResult {
  return { ...refusal(spec, message), spawnError: { code: ENGINE_LOST, message } };
}

function containerStepName(run: string, step: string, ordinal: number): string {
  const clean = `${run}-${step}`.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  const suffix = ordinal > 1 ? `-${ordinal}` : "";
  return `jgates-${clean.slice(0, 100)}${suffix}`.replace(/[-.]+$/, "") || containerName();
}

/**
 * The launcher of a run, or null when JGates itself runs inside the tools image (the same commands then run natively).
 * Without an engine or without the image no step starts: the launch is refused with HOST_EXECUTION_REFUSED, never
 * handed to the host.
 */
export function createStepLauncher(input: StepLauncherInput): StepLauncherHook | null {
  if (stepMode(input.env) === "in-image") return null;
  const runtime = input.engine?.runtime ?? engineRuntime(input.env);
  const context: EngineContext = { ...(input.engine ?? {}), runtime, runnerOptions: { parentEnv: input.env, ...(input.engine?.runnerOptions ?? {}) } };
  let image: string | null | undefined = input.image;
  const resolveImage = (): string | null => {
    if (image !== undefined) return image;
    const reference = input.env.JGATES_TOOLS_IMAGE?.trim() || toolsImageTarget(input.env).reference;
    image = inspectImageSync(reference, context)?.id ?? null;
    return image;
  };
  const pairs = [
    { host: path.resolve(input.runDir), target: CONTAINER_OUTPUT },
    { host: path.resolve(input.projectDir), target: CONTAINER_WORKSPACE },
  ];
  const ordinals = new Map<string, number>();
  const user = stepUser();
  // Set once the engine stopped answering while a container of the run was running; nothing else is started after it.
  let lost: string | null = null;
  // The header of every process, per step: written by runSpec when the caller asked for a stderr file, otherwise added to the
  // adapter's own stderr log after the step (annotate).
  const headers = new Map<string, Array<{ text: string; written: boolean }>>();

  return {
    handles(spec) {
      return spec.executable !== runtime && !ENGINE_CLIENT.test(path.basename(spec.executable));
    },
    engineLost() {
      return lost;
    },
    annotateLogs(stepId, logs) {
      const pending = (headers.get(stepId) ?? []).filter((h) => !h.written && h.text !== "");
      const stderrLogs = logs.filter((l) => l.endsWith(".stderr.log"));
      if (pending.length === 0 || stderrLogs.length === 0) return;
      stderrLogs.forEach((log, index) => {
        // One log per process, in order; otherwise every log gets the headers of all the step's processes.
        const mine = pending.length === stderrLogs.length ? [pending[index] as { text: string }] : pending;
        try {
          const file = path.join(input.runDir, ...log.split("/"));
          const current = fs.readFileSync(file, "utf8");
          if (current.includes(CONTAINER_HEADER_MARK)) return;
          fs.writeFileSync(file, mine.map((h) => h.text).join("") + current);
        } catch {
          // A log that cannot be annotated stays as the adapter wrote it.
        }
      });
      headers.delete(stepId);
    },
    async run(spec) {
      if (lost) return lostResult(spec, lost);
      const resolved = resolveImage();
      if (!resolved) return refusal(spec, "the tools image is not available in the engine; a tool is never run as a host process");
      const scope = currentScope();
      const step = scope?.stepId ?? "step";
      const ordinal = (ordinals.get(step) ?? 0) + 1;
      ordinals.set(step, ordinal);
      const cwd = path.resolve(spec.cwd);
      const inside = (base: string): boolean => {
        const rel = path.relative(base, cwd);
        return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
      };
      const workdir = pairs.some((p) => inside(p.host)) ? mapHostPaths(cwd, pairs) : CONTAINER_WORKSPACE;
      const mounts: EngineMount[] = [
        { type: "volume", source: sourceVolumeName(input.workspaceId), target: CONTAINER_WORKSPACE },
        { type: "bind", source: path.resolve(input.runDir), target: CONTAINER_OUTPUT },
      ];
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(spec.env ?? {})) env[k] = mapHostPaths(v, pairs);
      // The step's dependency volumes and package cache, with their variables (they win over the adapter's: the tool
      // must find the project's environment inside the container, not a host value).
      const extra = scope?.stepId ? input.stepEnvironment?.(scope.stepId) : null;
      if (extra) {
        mounts.push(...extra.mounts);
        Object.assign(env, extra.env);
      }
      const resources = scope?.launch?.resources;
      const command = [spec.executable, ...spec.args].map((a) => mapHostPaths(a, pairs));
      const stepContainer = containerStepName(input.runId, step, ordinal);
      const record = { text: "", written: spec.stderrFile !== undefined };
      headers.set(step, [...(headers.get(step) ?? []), record]);
      const timeoutMs = spec.timeoutMs ?? scope?.launch?.timeoutMs;
      const result = await runInEngine(
        {
          image: resolved,
          command,
          name: stepContainer,
          logHeader: (docker) => (record.text = containerHeader({ command, workdir, container: stepContainer, image: resolved, runtime: docker.runtime, dockerArgs: docker.args })),
          labels: engineLabels({ kind: "step", version: input.version, workspace: input.workspaceId, run: input.runId }),
          mounts,
          network: scope?.launch?.network ?? "none",
          user,
          env,
          workdir,
          resources: {
            memoryMb: resources?.memoryMb ?? DEFAULT_RESOURCES.memoryMb,
            cpus: resources?.cpus ?? DEFAULT_RESOURCES.cpus,
            ...(resources?.tmpfsMb !== undefined ? { tmpfsMb: resources.tmpfsMb } : {}),
          },
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(spec.signal ? { signal: spec.signal } : {}),
          ...(spec.stdoutFile ? { stdoutFile: spec.stdoutFile } : {}),
          ...(spec.stderrFile ? { stderrFile: spec.stderrFile } : {}),
          ...(spec.onStdout ? { onStdout: spec.onStdout } : {}),
          ...(spec.onStderr ? { onStderr: spec.onStderr } : {}),
          stdin: spec.stdin ?? null,
        },
        context,
      );
      // A container that did not end well while the engine no longer answers: the engine was lost, the tool's own
      // verdict (if any) proves nothing.
      if (!result.cancelled && !result.timedOut && result.exitCode !== 0 && !lost && !(await engineReachable(context))) {
        lost = (result.stderr.trim().split("\n").filter(Boolean).pop() ?? "the container engine stopped answering").slice(0, 400);
        return { ...result, spawnError: { code: ENGINE_LOST, message: lost } };
      }
      return result;
    },
  };
}
