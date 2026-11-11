// Engine module (ADR-0004): the only code that talks to the container engine, always through runSpec.
// This is the S0 skeleton: runtime and tools image selection, the JGates labels, labelled volumes initialized by a
// root helper, image inspection and one `docker run` per container under the step contract (`--pull never`,
// read-only root, tmpfs /tmp, no capabilities, no new privileges, limits, network off unless declared, a minimal
// environment), plus detection, pulls with progress and retry, listing/removal/kill/prune by JGates label, sizes and compose.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildEnv, DEFAULT_ENV_ALLOWLIST, runSpec, type ExecutionResult, type RunnerOptions } from "../runner/process.js";
import { currentScope, runInScope } from "../runner/scope.js";

/** Development image, used when JGATES_TOOLS_IMAGE asks for it (and until the pin file exists). */
export const DEV_TOOLS_IMAGE = "jgates-tools:dev";
/** The image user of the steps on Windows and macOS hosts. */
export const IMAGE_USER = "10001:10001";
export const DEFAULT_RESOURCES = { memoryMb: 4096, cpus: 2, pids: 1024, tmpfsMb: 256 } as const;
/** Environment every container gets: caches and bytecode kept out of the sources and out of the read-only root. */
// HOME is the tmpfs itself: a folder under it would not exist in a fresh container (--read-only, --tmpfs /tmp), and
// tools such as dotnet refuse to start without an existing home.
export const BASE_CONTAINER_ENV: Readonly<Record<string, string>> = { HOME: "/tmp", PYTHONDONTWRITEBYTECODE: "1" };
/**
 * Connection settings of the engine client; they stay on the host side and never reach a container. ProgramFiles is how
 * the Docker CLI on Windows finds its system plugins (`compose` lives in %ProgramFiles%\Docker\cli-plugins).
 */
export const ENGINE_CLIENT_ENV: readonly string[] = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "XDG_RUNTIME_DIR", "ProgramFiles"];

export const LABEL_MANAGED = "org.jgates.managed";
export const LABEL_KIND = "org.jgates.kind";
export const LABEL_WORKSPACE = "org.jgates.workspace";
export const LABEL_RUN = "org.jgates.run";
export const LABEL_VERSION = "org.jgates.version";

export type EngineObjectKind = "step" | "helper" | "sync" | "deps" | "services" | "data" | "extension-image" | "toolchain";

export class EngineSpecError extends Error {
  constructor(
    readonly code: "BAD_NAME" | "BAD_MOUNT" | "BAD_LABEL" | "BAD_ENV" | "BAD_USER" | "BAD_LIMIT" | "BAD_IMAGE",
    message: string,
  ) {
    super(message);
    this.name = "EngineSpecError";
  }
}

/** The engine executable: JGATES_CONTAINER_RUNTIME, otherwise `docker`. */
export function engineRuntime(env: NodeJS.ProcessEnv = process.env): string {
  return env.JGATES_CONTAINER_RUNTIME?.trim() || "docker";
}

/** The tools image reference: JGATES_TOOLS_IMAGE (for example jgates-tools:dev), otherwise the development image. */
export function toolsImageReference(env: NodeJS.ProcessEnv = process.env): string {
  return env.JGATES_TOOLS_IMAGE?.trim() || DEV_TOOLS_IMAGE;
}

export interface EngineLabelInput {
  kind: EngineObjectKind;
  /** JGates version that creates the object. */
  version: string;
  workspace?: string;
  run?: string;
  /** Extra labels (for example org.jgates.dev=true in development tests). */
  extra?: Record<string, string>;
}

/** The labels every engine object JGates creates carries; cleanup selects by them, never by name. */
export function engineLabels(input: EngineLabelInput): Record<string, string> {
  return {
    ...(input.extra ?? {}),
    [LABEL_MANAGED]: "true",
    [LABEL_KIND]: input.kind,
    [LABEL_VERSION]: input.version,
    ...(input.workspace ? { [LABEL_WORKSPACE]: input.workspace } : {}),
    ...(input.run ? { [LABEL_RUN]: input.run } : {}),
  };
}

const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

/** `jgates-<ws>-src`: the synchronized copy of a workspace. */
export function sourceVolumeName(workspace: string): string {
  return checkedVolumeName(`jgates-${workspace}-src`);
}

/** `jgates-<ws>-deps-<component>`: the Linux dependencies of one component. */
export function dependencyVolumeName(workspace: string, component: string): string {
  return checkedVolumeName(`jgates-${workspace}-deps-${component}`);
}

function checkedVolumeName(name: string): string {
  if (!VOLUME_NAME.test(name)) throw new EngineSpecError("BAD_NAME", `invalid volume name: ${name}`);
  return name;
}

export interface EngineMount {
  type: "volume" | "bind";
  /** Volume name, or an absolute host path for a bind mount. */
  source: string;
  /** Absolute path inside the container. */
  target: string;
  readonly?: boolean;
}

export interface EngineResources {
  memoryMb?: number;
  cpus?: number;
  pids?: number;
  tmpfsMb?: number;
}

export interface EngineRunSpec {
  /** Image id (sha256:...) or local reference; the run never pulls. */
  image: string;
  command: string[];
  /** Labels of the container (see engineLabels). */
  labels: Record<string, string>;
  name?: string;
  mounts?: EngineMount[];
  /**
   * `none` unless the item declares network (`bridge`); a step that uses the run's compose services joins that project's
   * network by name (`jgates-<ws>-<run>_default`). `host` and `container:<id>` are never accepted.
   */
  network?: "none" | "bridge" | (string & {});
  /** `uid:gid`; the image user by default. */
  user?: string;
  /** Declared variables, on top of BASE_CONTAINER_ENV. */
  env?: Record<string, string>;
  workdir?: string;
  resources?: EngineResources;
  /** Capabilities given back after `--cap-drop ALL` (only the root helper that sets volume owners uses CHOWN). */
  capAdd?: Array<"CHOWN" | "FOWNER" | "DAC_OVERRIDE">;
  /** Executables may run from /tmp (dependency installs build packages there); off for steps. */
  tmpExec?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  stdoutFile?: string;
  stderrFile?: string;
  /** Text written to the container's stdin (adds `--interactive`); absent or null: stdin is closed. */
  stdin?: string | null;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Header of the stderr log, built from the exact `docker run` line that is started. */
  logHeader?: (docker: { runtime: string; args: string[]; name: string }) => string;
}

function positive(value: number | undefined, fallback: number, name: string, integer: boolean): number {
  const v = value ?? fallback;
  if (!Number.isFinite(v) || v <= 0 || (integer && !Number.isInteger(v))) throw new EngineSpecError("BAD_LIMIT", `${name} must be a positive ${integer ? "integer" : "number"}: ${String(v)}`);
  return v;
}

function mountArg(mount: EngineMount): string {
  if (!path.posix.isAbsolute(mount.target) || /[,\n\r\0]/.test(mount.target)) throw new EngineSpecError("BAD_MOUNT", `invalid mount target: ${mount.target}`);
  let source = mount.source;
  if (mount.type === "volume") {
    checkedVolumeName(source);
  } else {
    if (!path.isAbsolute(source)) throw new EngineSpecError("BAD_MOUNT", `a bind mount needs an absolute host path: ${source}`);
    source = path.resolve(source);
    if (/[,\n\r\0]/.test(source)) throw new EngineSpecError("BAD_MOUNT", `the host path has a character a mount cannot carry: ${JSON.stringify(source)}`);
    if (/docker\.sock/.test(source)) throw new EngineSpecError("BAD_MOUNT", "the engine socket is never mounted");
  }
  return `type=${mount.type},src=${source},dst=${mount.target}${mount.readonly ? ",readonly" : ""}`;
}

export function containerName(prefix = "jgates"): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

/** The `docker run` arguments of a spec (validated); a pure function, so a fake engine can record them. */
export function buildRunArgs(spec: EngineRunSpec): { args: string[]; name: string } {
  if (!spec.image || /\s/.test(spec.image)) throw new EngineSpecError("BAD_IMAGE", `invalid image: ${spec.image}`);
  const name = spec.name ?? containerName();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) throw new EngineSpecError("BAD_NAME", `invalid container name: ${name}`);
  const user = spec.user ?? IMAGE_USER;
  if (!/^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/.test(user)) throw new EngineSpecError("BAD_USER", `invalid user: ${user}`);
  if (spec.labels[LABEL_MANAGED] !== "true" || !spec.labels[LABEL_KIND]) throw new EngineSpecError("BAD_LABEL", "every container carries the JGates labels (managed and kind)");
  const memoryMb = positive(spec.resources?.memoryMb, DEFAULT_RESOURCES.memoryMb, "memoryMb", true);
  const cpus = positive(spec.resources?.cpus, DEFAULT_RESOURCES.cpus, "cpus", false);
  const pids = positive(spec.resources?.pids, DEFAULT_RESOURCES.pids, "pids", true);
  const tmpfsMb = positive(spec.resources?.tmpfsMb, DEFAULT_RESOURCES.tmpfsMb, "tmpfsMb", true);
  const network = spec.network ?? "none";
  if (network === "host" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(network)) throw new EngineSpecError("BAD_NAME", `invalid network: ${network}`);

  const args = [
    "run",
    "--rm",
    "--init",
    "--pull",
    "never",
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
    ...(spec.stdin !== undefined && spec.stdin !== null ? ["--interactive"] : []),
    "--cap-drop",
    "ALL",
    ...(spec.capAdd ?? []).flatMap((cap) => ["--cap-add", cap]),
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    `/tmp:rw,${spec.tmpExec ? "exec" : "noexec"},nosuid,nodev,size=${tmpfsMb}m`,
    "--user",
    user,
  ];
  for (const mount of spec.mounts ?? []) args.push("--mount", mountArg(mount));
  if (spec.workdir) args.push("--workdir", spec.workdir);
  for (const [k, v] of Object.entries(spec.labels)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(k) || /[\n\r\0]/.test(v)) throw new EngineSpecError("BAD_LABEL", `invalid label: ${k}`);
    args.push("--label", `${k}=${v}`);
  }
  for (const [k, v] of Object.entries({ ...BASE_CONTAINER_ENV, ...(spec.env ?? {}) })) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || /[\n\r\0]/.test(v)) throw new EngineSpecError("BAD_ENV", `invalid environment variable: ${k}`);
    args.push("--env", `${k}=${v}`);
  }
  args.push(spec.image, ...spec.command);
  return { args, name };
}

export interface EngineContext {
  runtime?: string;
  runnerOptions?: RunnerOptions;
}

function clientOptions(context: EngineContext): RunnerOptions {
  const options = context.runnerOptions ?? {};
  return { ...options, envAllowlist: [...(options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST), ...ENGINE_CLIENT_ENV] };
}

/** Never-aborting signal: cleanup must run even when the run itself was cancelled. */
const NEVER = new AbortController().signal;

/**
 * One engine client command (not a container run): inspect, volume create/rm, and so on. It runs outside the execution
 * scope of the step that may be calling it, so it is never taken for one of the step's processes (its exit code is not
 * the step's) and is never handed to the step launcher.
 */
export function engineCommand(args: string[], context: EngineContext = {}, timeoutMs = 60_000): Promise<ExecutionResult> {
  return runInScope({}, () => runSpec({ executable: context.runtime ?? engineRuntime(), args, cwd: os.tmpdir(), timeoutMs, signal: NEVER }, clientOptions(context)));
}

export interface EngineSyncResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError: { code: string; message: string } | null;
}

/**
 * A synchronous engine client command, for the plan (which is built synchronously) to ask the engine two cheap
 * questions: `info` and `image inspect`. Never used to run containers.
 */
export function engineCommandSync(args: string[], context: EngineContext = {}, timeoutMs = 20_000): EngineSyncResult {
  const executable = context.runtime ?? engineRuntime(context.runnerOptions?.parentEnv ?? process.env);
  const script = /\.(?:mjs|cjs|js)$/i.test(executable);
  const result = spawnSync(script ? process.execPath : executable, script ? [executable, ...args] : args, {
    cwd: os.tmpdir(),
    env: buildEnv({ env: {} }, clientOptions(context)),
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  const error = result.error as NodeJS.ErrnoException | undefined;
  const timedOut = error?.code === "ETIMEDOUT";
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status,
    timedOut,
    spawnError: error && !timedOut ? { code: error.code ?? "SPAWN", message: error.message } : null,
  };
}

export interface EngineRunSyncResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError: { code: string; message: string } | null;
  name: string;
  args: string[];
}

/**
 * One container run, synchronously, for the callers that cannot await (structured TOML editing is a synchronous codec).
 * The same contract and arguments as runInEngine; the text of `stdin` is the container's standard input. A timeout
 * removes the container by name.
 */
export function runInEngineSync(spec: EngineRunSpec, context: EngineContext = {}, maxBufferBytes = 64 * 1024 * 1024): EngineRunSyncResult {
  const runtime = context.runtime ?? engineRuntime(context.runnerOptions?.parentEnv ?? process.env);
  const { args, name } = buildRunArgs(spec);
  const script = /\.(?:mjs|cjs|js)$/i.test(runtime);
  const result = spawnSync(script ? process.execPath : runtime, script ? [runtime, ...args] : args, {
    cwd: os.tmpdir(),
    env: buildEnv({ env: {} }, clientOptions(context)),
    encoding: "utf8",
    input: spec.stdin ?? undefined,
    timeout: spec.timeoutMs ?? 120_000,
    windowsHide: true,
    shell: false,
    maxBuffer: maxBufferBytes,
  });
  const error = result.error as NodeJS.ErrnoException | undefined;
  const timedOut = error?.code === "ETIMEDOUT";
  if (timedOut) engineCommandSync(["rm", "--force", name], { ...context, runtime }, 30_000);
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status,
    timedOut,
    spawnError: error && !timedOut ? { code: error.code ?? "SPAWN", message: error.message } : null,
    name,
    args,
  };
}

/** Seconds `docker stop -t` waits before SIGKILL when a step timed out. */
export const STOP_GRACE_SEC = 5;

/** Whether the engine answers right now (`docker version` reaches the daemon); false after it vanished. */
export async function engineReachable(context: EngineContext = {}): Promise<boolean> {
  const result = await engineCommand(["version", "--format", "{{.Server.Version}}"], context, 15_000).catch(() => null);
  return result !== null && result.exitCode === 0 && !result.spawnError;
}

export type EngineRunResult =ExecutionResult & { name: string; args: string[]; removalRequested: boolean; runtimeFailure: boolean };

/** Runs one container under the contract; a cancelled or timed-out run also removes the container by name. */
export async function runInEngine(spec: EngineRunSpec, context: EngineContext = {}): Promise<EngineRunResult> {
  const runtime = context.runtime ?? engineRuntime();
  const { args, name } = buildRunArgs(spec);
  const options = clientOptions(context);
  const abort = spec.signal ?? currentScope()?.signal;
  let removal: Promise<unknown> | null = null;
  // A timeout stops the container first (`docker stop -t`: SIGTERM, then SIGKILL after the grace), then removes it by name.
  const requestRemoval = (timedOut = false): Promise<unknown> =>
    (removal ??= (async () => {
      if (timedOut) await engineCommand(["stop", "--time", String(STOP_GRACE_SEC), name], { ...context, runtime }, (STOP_GRACE_SEC + 20) * 1000).catch(() => undefined);
      await engineCommand(["rm", "--force", name], { ...context, runtime }, 30_000).catch(() => undefined);
    })());
  const onAbort = (): void => void requestRemoval();
  abort?.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await runSpec(
      {
        executable: runtime,
        args,
        cwd: os.tmpdir(),
        stdin: spec.stdin ?? null,
        ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
        ...(spec.signal ? { signal: spec.signal } : {}),
        ...(spec.stdoutFile ? { stdoutFile: spec.stdoutFile } : {}),
        ...(spec.stderrFile ? { stderrFile: spec.stderrFile } : {}),
        ...(spec.onStdout ? { onStdout: spec.onStdout } : {}),
        ...(spec.onStderr ? { onStderr: spec.onStderr } : {}),
        ...(spec.logHeader ? { logHeader: spec.logHeader({ runtime, args, name }) } : {}),
      },
      options,
    );
    if (result.timedOut) await requestRemoval(true);
    else if (result.cancelled || (result.exitCode === null && !result.spawnError)) await requestRemoval();
    else if (removal) await removal;
    return { ...result, name, args, removalRequested: removal !== null, runtimeFailure: result.exitCode !== null && result.exitCode >= 125 && result.exitCode <= 127 };
  } finally {
    abort?.removeEventListener("abort", onAbort);
  }
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly details: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

function must(result: ExecutionResult, what: string): string {
  if (result.spawnError) throw new EngineError(`${what}: the engine could not be started`, result.spawnError.message);
  if (result.exitCode !== 0) throw new EngineError(`${what} failed`, (result.stderr || result.stdout).trim());
  return result.stdout.trim();
}

export interface ImageFacts {
  id: string;
  labels: Record<string, string>;
  sizeBytes: number;
}

/** Facts of a local image, or null when the engine does not have it (never pulls). */
export async function inspectImage(reference: string, context: EngineContext = {}): Promise<ImageFacts | null> {
  const result = await engineCommand(["image", "inspect", "--format", "{{json .}}", reference], context);
  if (result.spawnError) throw new EngineError("image inspect: the engine could not be started", result.spawnError.message);
  if (result.exitCode !== 0) return null;
  const facts = JSON.parse(result.stdout) as { Id: string; Size?: number; Config?: { Labels?: Record<string, string> | null } };
  return { id: facts.Id, labels: facts.Config?.Labels ?? {}, sizeBytes: facts.Size ?? 0 };
}

export interface ImageManifest {
  schemaVersion: number;
  jgatesVersion: string;
  imageVersion: string;
  sourceRevision: string;
  tools: Record<string, string>;
  runtimes: Record<string, string>;
  defaults: Record<string, unknown>;
}

/** Reads /etc/jgates/image.json of an image in a container without network. */
export async function readImageManifest(image: string, labels: Record<string, string>, context: EngineContext = {}): Promise<ImageManifest> {
  const result = await runInEngine({ image, command: ["cat", "/etc/jgates/image.json"], labels, resources: { memoryMb: 128, cpus: 1, pids: 32 }, timeoutMs: 60_000 }, context);
  return JSON.parse(must(result, "reading /etc/jgates/image.json")) as ImageManifest;
}

/**
 * Creates a labelled volume when it does not exist and gives its root to `owner` with a root helper container (the
 * only container that runs as root, with CHOWN alone given back). Returns true when the volume was created now.
 */
export async function ensureVolume(
  name: string,
  input: { labels: Record<string, string>; image: string; owner?: string; helperLabels: Record<string, string> },
  context: EngineContext = {},
): Promise<boolean> {
  checkedVolumeName(name);
  const existing = await engineCommand(["volume", "inspect", "--format", "{{.Name}}", name], context);
  if (existing.spawnError) throw new EngineError("volume inspect: the engine could not be started", existing.spawnError.message);
  if (existing.exitCode === 0) return false;
  const labelArgs = Object.entries(input.labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
  must(await engineCommand(["volume", "create", ...labelArgs, name], context), `creating the volume ${name}`);
  const owner = input.owner ?? IMAGE_USER;
  const init = await runInEngine(
    {
      image: input.image,
      command: ["chown", owner, "/volume"],
      labels: input.helperLabels,
      user: "0:0",
      capAdd: ["CHOWN"],
      mounts: [{ type: "volume", source: name, target: "/volume" }],
      resources: { memoryMb: 128, cpus: 1, pids: 32 },
      timeoutMs: 60_000,
    },
    context,
  );
  must(init, `initializing the owner of the volume ${name}`);
  return true;
}

/** Removes a volume by name (only volumes this module created are named this way). */
export async function removeVolume(name: string, context: EngineContext = {}): Promise<void> {
  checkedVolumeName(name);
  await engineCommand(["volume", "rm", "--force", name], context);
}

// ---- detection ---------------------------------------------------------------------------------------------------

/** Engine reason codes of the shared catalogue (PLAN-guided-ux.md section 9) this module can produce. */
export type EngineReasonCode = "ENGINE_NOT_INSTALLED" | "ENGINE_STOPPED" | "ENGINE_LOW_MEMORY" | "DISK_LOW" | "UNSUPPORTED_PLATFORM" | "IMAGE_PULL_FAILED";

/** The memory a default step asks for (4096 MB); a daemon reports a little less than it was given, hence the margin. */
export const DEFAULT_REQUIRED_MEMORY_MB = 4096;
const MEMORY_MARGIN = 0.9;
/** Free disk required when the caller does not say (the pull needs compressed + unpacked size + 10 %). */
export const DEFAULT_REQUIRED_DISK_MB = 5120;

export interface EngineDetectionOptions {
  /** Memory the plan's largest step needs. */
  requiredMemoryMb?: number;
  /** Free disk the next download needs; 0 skips the check. */
  requiredDiskMb?: number;
  /** A local image to measure the engine's storage with (`df` in a helper container); without it the host disk is read. */
  image?: string;
  /** Labels of the helper container (kind `helper`); required with `image`. */
  helperLabels?: Record<string, string>;
  /** Host path whose free space stands in for the engine's storage when no image is available. */
  hostDiskPath?: string;
}

export interface EngineFacts {
  /** The client executable started (the CLI exists). */
  installed: boolean;
  /** The daemon answered. */
  running: boolean;
  serverVersion: string | null;
  os: string | null;
  arch: string | null;
  memoryMb: number | null;
  cpus: number | null;
  /** Free space of the engine's storage in MB; null when it could not be measured. */
  diskFreeMb: number | null;
  diskSource: "engine" | "host" | null;
}

export interface EngineDetection {
  /** null when the engine is ready for the requested work. */
  code: EngineReasonCode | null;
  facts: EngineFacts;
  /** Raw engine text (details only). */
  details: string;
}

const NO_FACTS: EngineFacts = { installed: false, running: false, serverVersion: null, os: null, arch: null, memoryMb: null, cpus: null, diskFreeMb: null, diskSource: null };

/** Parses the Available column of `df -Pk /` (1 KiB blocks) into MB. */
function parseDfFreeMb(text: string): number | null {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .find((cols) => cols.length >= 6 && /^\d+$/.test(cols[3] ?? ""));
  return line ? Math.floor(Number(line[3]) / 1024) : null;
}

async function measureDisk(options: EngineDetectionOptions, context: EngineContext): Promise<{ mb: number | null; source: "engine" | "host" | null }> {
  if (options.image && options.helperLabels) {
    try {
      const result = await runInEngine(
        { image: options.image, command: ["df", "-Pk", "/"], labels: options.helperLabels, resources: { memoryMb: 64, cpus: 1, pids: 16 }, timeoutMs: 30_000 },
        context,
      );
      const mb = result.exitCode === 0 ? parseDfFreeMb(result.stdout) : null;
      if (mb !== null) return { mb, source: "engine" };
    } catch {
      // Fall through to the host disk.
    }
  }
  try {
    const stats = await fs.promises.statfs(options.hostDiskPath ?? os.homedir());
    return { mb: Math.floor((Number(stats.bavail) * Number(stats.bsize)) / (1024 * 1024)), source: "host" };
  } catch {
    return { mb: null, source: null };
  }
}

/**
 * Detects the engine: CLI present, daemon reachable, version, OS/arch, memory, CPUs and free disk, and maps what is
 * wrong to one reason code (not installed, stopped, unsupported platform, low memory, low disk, in that order).
 */
export async function detectEngine(options: EngineDetectionOptions = {}, context: EngineContext = {}): Promise<EngineDetection> {
  const info = await engineCommand(["info", "--format", "{{json .}}"], context, 20_000);
  const classified = classifyInfo(info);
  if ("done" in classified) return classified.done;
  const { facts, details } = classified;
  const requiredMemory = options.requiredMemoryMb ?? DEFAULT_REQUIRED_MEMORY_MB;
  const requiredDisk = options.requiredDiskMb ?? DEFAULT_REQUIRED_DISK_MB;
  if (requiredDisk > 0) {
    const disk = await measureDisk(options, context);
    facts.diskFreeMb = disk.mb;
    facts.diskSource = disk.source;
  }
  return verdict(facts, details, requiredMemory, requiredDisk);
}

/**
 * The same detection for callers that cannot await (the plan): the disk is the host's, read with statfs, because no
 * helper container is started. Memory and disk are judged exactly like detectEngine.
 */
export function detectEngineSync(options: EngineDetectionOptions = {}, context: EngineContext = {}): EngineDetection {
  const info = engineCommandSync(["info", "--format", "{{json .}}"], context, 20_000);
  const classified = classifyInfo(info);
  if ("done" in classified) return classified.done;
  const { facts, details } = classified;
  const requiredMemory = options.requiredMemoryMb ?? DEFAULT_REQUIRED_MEMORY_MB;
  const requiredDisk = options.requiredDiskMb ?? DEFAULT_REQUIRED_DISK_MB;
  if (requiredDisk > 0) {
    try {
      const stats = fs.statfsSync(options.hostDiskPath ?? os.homedir());
      facts.diskFreeMb = Math.floor((Number(stats.bavail) * Number(stats.bsize)) / (1024 * 1024));
      facts.diskSource = "host";
    } catch {
      facts.diskFreeMb = null;
      facts.diskSource = null;
    }
  }
  return verdict(facts, details, requiredMemory, requiredDisk);
}

type InfoAnswer = Pick<ExecutionResult, "stdout" | "stderr" | "exitCode" | "timedOut" | "spawnError">;

function classifyInfo(info: InfoAnswer): { done: EngineDetection } | { facts: EngineFacts; details: string } {
  if (info.spawnError) return { done: { code: "ENGINE_NOT_INSTALLED", facts: NO_FACTS, details: info.spawnError.message } };
  if (info.exitCode !== 0 || info.timedOut) {
    return {
      done: {
        code: "ENGINE_STOPPED",
        facts: { ...NO_FACTS, installed: true },
        details: (info.stderr || info.stdout).trim() || (info.timedOut ? "the engine did not answer in time" : `exit code ${info.exitCode}`),
      },
    };
  }
  let parsed: { ServerVersion?: string; OSType?: string; Architecture?: string; MemTotal?: number; NCPU?: number };
  try {
    parsed = JSON.parse(info.stdout) as typeof parsed;
  } catch {
    return { done: { code: "ENGINE_STOPPED", facts: { ...NO_FACTS, installed: true }, details: `unreadable engine info: ${info.stdout.slice(0, 200)}` } };
  }
  const memoryMb = parsed.MemTotal ? Math.round(parsed.MemTotal / (1024 * 1024)) : null;
  const arch = parsed.Architecture ?? null;
  const facts: EngineFacts = {
    installed: true,
    running: true,
    serverVersion: parsed.ServerVersion ?? null,
    os: parsed.OSType ?? null,
    arch,
    memoryMb,
    cpus: parsed.NCPU ?? null,
    diskFreeMb: null,
    diskSource: null,
  };
  return { facts, details: `engine ${facts.serverVersion ?? "?"}, ${facts.os ?? "?"}/${arch ?? "?"}, ${memoryMb ?? "?"} MB, ${facts.cpus ?? "?"} CPUs` };
}

function verdict(facts: EngineFacts, details: string, requiredMemory: number, requiredDisk: number): EngineDetection {
  if (facts.os !== "linux" || !(facts.arch === "x86_64" || facts.arch === "amd64")) return { code: "UNSUPPORTED_PLATFORM", facts, details };
  if (facts.memoryMb !== null && facts.memoryMb < requiredMemory * MEMORY_MARGIN) return { code: "ENGINE_LOW_MEMORY", facts, details };
  if (requiredDisk > 0 && facts.diskFreeMb !== null && facts.diskFreeMb < requiredDisk) return { code: "DISK_LOW", facts, details };
  return { code: null, facts, details };
}

/** Facts of a local image, synchronously (the plan); null when the engine does not have it. */
export function inspectImageSync(reference: string, context: EngineContext = {}): ImageFacts | null {
  // No --format: the JSON array every engine prints, which the fake engine prints too.
  const result = engineCommandSync(["image", "inspect", reference], context);
  if (result.spawnError || result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as Array<{ Id: string; Size?: number; Config?: { Labels?: Record<string, string> | null } }>;
    const facts = parsed[0];
    if (!facts) return null;
    return { id: facts.Id, labels: facts.Config?.Labels ?? {}, sizeBytes: facts.Size ?? 0 };
  } catch {
    return null;
  }
}

// ---- pull with progress ------------------------------------------------------------------------------------------

export type PullPhase = "resolving" | "downloading" | "extracting" | "retrying" | "done";

/** The object the UI streams while an image is pulled. Downloaded bytes never decrease, even across retries. */
export interface PullProgress {
  phase: PullPhase;
  layer?: string;
  downloaded: number;
  total: number;
  /** Set on `retrying`: the attempt that is about to start (2 for the first retry). */
  attempt?: number;
}

export interface PullOptions {
  onProgress?: (event: PullProgress) => void;
  /** Total attempts; a dropped connection starts the next one, and the engine resumes the layers already complete. */
  attempts?: number;
  retryDelayMs?: number;
  /** Total size to report when the registry manifest cannot be read (the pin file's size). */
  expectedBytes?: number;
  signal?: AbortSignal;
  /** Per attempt. */
  timeoutMs?: number;
}

export interface PullResult {
  attempts: number;
  total: number;
  downloaded: number;
}

/** `repo` and, when present, the tag of a reference, without a digest. */
function referenceParts(reference: string): { repo: string; suffix: string } {
  const noDigest = reference.split("@")[0] ?? reference;
  const slash = noDigest.lastIndexOf("/");
  const colon = noDigest.indexOf(":", slash + 1);
  return colon === -1 ? { repo: noDigest, suffix: "" } : { repo: noDigest.slice(0, colon), suffix: noDigest.slice(colon) };
}

interface ManifestLayer {
  digest?: string;
  size?: number;
}
interface ManifestDoc {
  layers?: ManifestLayer[];
  manifests?: Array<{ digest?: string; platform?: { os?: string; architecture?: string } }>;
}

/** Compressed layer sizes by the 12-character id the pull output uses; empty when the registry cannot be read. */
export async function readLayerSizes(reference: string, context: EngineContext = {}): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const read = async (ref: string): Promise<ManifestDoc | null> => {
    const result = await engineCommand(["manifest", "inspect", ref], context, 60_000);
    if (result.spawnError || result.exitCode !== 0) return null;
    try {
      return JSON.parse(result.stdout) as ManifestDoc;
    } catch {
      return null;
    }
  };
  let doc = await read(reference);
  if (doc?.manifests && !doc.layers) {
    const pick = doc.manifests.find((m) => m.platform?.os === "linux" && m.platform.architecture === "amd64") ?? doc.manifests[0];
    doc = pick?.digest ? await read(`${referenceParts(reference).repo}@${pick.digest}`) : null;
  }
  for (const layer of doc?.layers ?? []) {
    const hex = layer.digest?.replace(/^sha256:/, "");
    if (hex && typeof layer.size === "number") sizes.set(hex.slice(0, 12), layer.size);
  }
  return sizes;
}

/**
 * Pulls an image, turning the engine's layer lines into aggregated byte progress. A dropped pull is retried: layers
 * already complete are not downloaded again, so the downloaded figure only goes up. Throws EngineError
 * (IMAGE_PULL_FAILED) when every attempt fails.
 */
export async function pullImage(reference: string, options: PullOptions = {}, context: EngineContext = {}): Promise<PullResult> {
  const runtime = context.runtime ?? engineRuntime();
  const emit = options.onProgress ?? (() => undefined);
  const sizes = await readLayerSizes(reference, context);
  let total = 0;
  for (const size of sizes.values()) total += size;
  if (total === 0) total = options.expectedBytes ?? 0;
  let downloaded = 0;
  const complete = new Set<string>();
  const send = (phase: PullPhase, layer?: string, attempt?: number): void => emit({ phase, ...(layer ? { layer } : {}), downloaded, total, ...(attempt ? { attempt } : {}) });
  send("resolving");
  const attempts = Math.max(1, options.attempts ?? 3);
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      send("retrying", undefined, attempt);
      if ((options.retryDelayMs ?? 1000) > 0) await new Promise((r) => setTimeout(r, options.retryDelayMs ?? 1000));
    }
    let pending = "";
    const handle = (line: string): void => {
      const match = /^([0-9a-f]{12}): (.+)$/.exec(line.trim());
      if (!match) return;
      const id = match[1] as string;
      const status = match[2] as string;
      if (/^(Download complete|Pull complete|Already exists)/.test(status)) {
        if (!complete.has(id)) {
          complete.add(id);
          downloaded += sizes.get(id) ?? 0;
        }
        send("downloading", id);
      } else if (/^Extracting/.test(status)) send("extracting", id);
      else if (/^(Pulling fs layer|Waiting|Downloading)/.test(status)) send("downloading", id);
    };
    const feed = (chunk: string): void => {
      pending += chunk;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? "";
      lines.forEach(handle);
    };
    const result = await runSpec(
      {
        executable: runtime,
        args: ["pull", reference],
        cwd: os.tmpdir(),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        onStdout: feed,
      },
      clientOptions(context),
    );
    if (pending) handle(pending);
    if (result.spawnError) throw new EngineError("IMAGE_PULL_FAILED", result.spawnError.message);
    if (result.cancelled) throw new EngineError("IMAGE_PULL_FAILED", "the pull was cancelled");
    if (result.exitCode === 0) {
      downloaded = Math.max(downloaded, total);
      send("done");
      return { attempts: attempt, total, downloaded };
    }
    lastError = (result.stderr || result.stdout).trim();
  }
  throw new EngineError("IMAGE_PULL_FAILED", lastError);
}

// ---- objects by label --------------------------------------------------------------------------------------------

export type EngineResource = "container" | "volume" | "image" | "network";

/** Which managed objects an operation concerns: always `org.jgates.managed=true`, narrowed by these. */
export interface ManagedScope {
  kind?: EngineObjectKind;
  workspace?: string;
  run?: string;
  /** Extra label filters, `key=value` (development tests mark their objects with org.jgates.test=<name>). */
  extraLabels?: Record<string, string>;
}

/** The `--filter label=...` arguments of a scope. Every list, remove, kill and prune call goes through this. */
export function managedFilterArgs(scope: ManagedScope = {}): string[] {
  const labels: Record<string, string> = { [LABEL_MANAGED]: "true", ...(scope.extraLabels ?? {}) };
  if (scope.kind) labels[LABEL_KIND] = scope.kind;
  if (scope.workspace) labels[LABEL_WORKSPACE] = scope.workspace;
  if (scope.run) labels[LABEL_RUN] = scope.run;
  return Object.entries(labels).flatMap(([k, v]) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(k) || /[\n\r\0]/.test(v)) throw new EngineSpecError("BAD_LABEL", `invalid label filter: ${k}`);
    return ["--filter", `label=${k}=${v}`];
  });
}

export interface ManagedObject {
  resource: EngineResource;
  /** Identifier to act on: the id of containers, images and networks, the name of volumes. */
  id: string;
  name: string;
  labels: Record<string, string>;
  /** Containers only. */
  state?: string;
  /** Images only (parsed from the engine's human size text). */
  sizeBytes?: number;
}

/** Docker's human sizes ("1.5GB", "230kB", "12B"; decimal units) in bytes. */
export function parseEngineSize(text: string | undefined): number {
  const match = /^\s*([\d.]+)\s*([kKMGTP]?i?)B\s*$/.exec(text ?? "");
  if (!match) return 0;
  const unit = (match[2] ?? "").toUpperCase().replace("I", "");
  const power = ["", "K", "M", "G", "T", "P"].indexOf(unit);
  return Math.round(Number(match[1]) * 1000 ** Math.max(0, power));
}

function parseLabels(text: string | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const part of (text ?? "").split(",")) {
    const at = part.indexOf("=");
    if (at > 0) labels[part.slice(0, at)] = part.slice(at + 1);
  }
  return labels;
}

function jsonLines(text: string): Array<Record<string, string>> {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, string>);
}

const LIST_COMMAND: Record<EngineResource, string[]> = {
  container: ["container", "ls", "--all", "--no-trunc"],
  volume: ["volume", "ls"],
  image: ["image", "ls", "--no-trunc"],
  network: ["network", "ls", "--no-trunc"],
};

/** Lists the objects of one resource that carry the JGates labels (and the scope's); never anything else. */
export async function listManaged(resource: EngineResource, scope: ManagedScope = {}, context: EngineContext = {}): Promise<ManagedObject[]> {
  const result = await engineCommand([...LIST_COMMAND[resource], "--format", "{{json .}}", ...managedFilterArgs(scope)], context);
  const text = must(result, `listing ${resource}s`);
  return jsonLines(text).map((row) => {
    const name = row.Name ?? row.Names ?? row.Repository ?? "";
    return {
      resource,
      id: resource === "volume" ? (row.Name ?? "") : (row.ID ?? ""),
      name,
      labels: parseLabels(row.Labels),
      ...(row.State ? { state: row.State } : {}),
      ...(resource === "image" ? { sizeBytes: parseEngineSize(row.Size) } : {}),
    };
  });
}

const REMOVE_COMMAND: Record<EngineResource, string[]> = {
  container: ["container", "rm", "--force"],
  volume: ["volume", "rm", "--force"],
  image: ["image", "rm"],
  network: ["network", "rm"],
};

/** Removes the managed objects of a resource and scope: selected by label, then removed by the ids that selection gave. */
export async function removeManaged(resource: EngineResource, scope: ManagedScope = {}, context: EngineContext = {}): Promise<ManagedObject[]> {
  const objects = await listManaged(resource, scope, context);
  if (objects.length === 0) return [];
  must(await engineCommand([...REMOVE_COMMAND[resource], ...objects.map((o) => o.id)], context, 120_000), `removing ${resource}s`);
  return objects;
}

/** Stops every running container of a run (label `org.jgates.run`), then removes them. Returns what was killed. */
export async function killRun(run: string, context: EngineContext = {}): Promise<ManagedObject[]> {
  const result = await engineCommand(["container", "ls", "--no-trunc", "--format", "{{json .}}", ...managedFilterArgs({ run })], context);
  const running = jsonLines(must(result, "listing the containers of the run")).map((row) => ({
    resource: "container" as const,
    id: row.ID ?? "",
    name: row.Names ?? "",
    labels: parseLabels(row.Labels),
    ...(row.State ? { state: row.State } : {}),
  }));
  if (running.length === 0) return [];
  const ids = running.map((o) => o.id);
  await engineCommand(["kill", ...ids], context, 30_000);
  await engineCommand(["container", "rm", "--force", ...ids], context, 60_000);
  return running;
}

/**
 * Prunes what the engine considers unused among the managed objects: stopped containers, unused networks, dangling
 * images and unused volumes. Always filtered by the JGates labels; nothing else is ever pruned.
 */
export async function pruneManaged(resources: EngineResource[], scope: ManagedScope = {}, context: EngineContext = {}): Promise<void> {
  const filters = managedFilterArgs(scope);
  for (const resource of resources) {
    const args = resource === "volume" ? ["volume", "prune", "--all", "--force"] : [resource, "prune", "--force"];
    must(await engineCommand([...args, ...filters], context, 120_000), `pruning ${resource}s`);
  }
}

export interface ManagedUsage {
  volumes: Array<{ name: string; sizeBytes: number; labels: Record<string, string> }>;
  images: Array<{ id: string; name: string; sizeBytes: number; labels: Record<string, string> }>;
  containers: Array<{ id: string; name: string; state: string | undefined }>;
  totalBytes: number;
}

/** Sizes of the managed objects: `system df -v` for volumes (filtered by label here), the label-filtered list for images. */
export async function managedUsage(scope: ManagedScope = {}, context: EngineContext = {}): Promise<ManagedUsage> {
  const result = await engineCommand(["system", "df", "-v", "--format", "{{json .}}"], context, 120_000);
  const doc = JSON.parse(must(result, "reading the engine disk usage")) as { Volumes?: Array<Record<string, string>> };
  const wanted = managedFilterArgs(scope)
    .filter((a) => a !== "--filter")
    .map((a) => a.replace(/^label=/, ""))
    .map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] as const);
  const volumes = (doc.Volumes ?? [])
    .map((v) => ({ name: v.Name ?? "", sizeBytes: parseEngineSize(v.Size), labels: parseLabels(v.Labels) }))
    .filter((v) => wanted.every(([k, val]) => v.labels[k] === val));
  const images = (await listManaged("image", scope, context)).map((o) => ({ id: o.id, name: o.name, sizeBytes: o.sizeBytes ?? 0, labels: o.labels }));
  const containers = (await listManaged("container", scope, context)).map((o) => ({ id: o.id, name: o.name, state: o.state }));
  const totalBytes = volumes.reduce((sum, v) => sum + v.sizeBytes, 0) + images.reduce((sum, i) => sum + i.sizeBytes, 0);
  return { volumes, images, containers, totalBytes };
}

// ---- compose -----------------------------------------------------------------------------------------------------

export interface ComposeSpec {
  /** Compose project name (`jgates-<ws>-services`); `down` touches only this project. */
  project: string;
  files: string[];
  /** Service names; each gets the JGates labels through a generated override file. */
  services: string[];
  labels: Record<string, string>;
  /** Folder of the generated label override (a run folder; never the project). */
  overrideDir: string;
  /** Seconds to wait for health checks. */
  waitTimeoutSec?: number;
  pull?: "never" | "missing";
  env?: Record<string, string>;
}

/** The compose override that puts the JGates labels on every service and on the default network. */
export function composeLabelOverride(services: string[], labels: Record<string, string>): string {
  const block = (indent: string): string => Object.entries(labels).map(([k, v]) => `${indent}${JSON.stringify(k)}: ${JSON.stringify(v)}`).join("\n");
  for (const service of services) if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(service)) throw new EngineSpecError("BAD_NAME", `invalid service name: ${service}`);
  return `services:\n${services.map((s) => `  ${s}:\n    labels:\n${block("      ")}`).join("\n")}\nnetworks:\n  default:\n    labels:\n${block("      ")}\n`;
}

function composeBase(spec: ComposeSpec, override: string | null): string[] {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(spec.project)) throw new EngineSpecError("BAD_NAME", `invalid compose project: ${spec.project}`);
  if (spec.labels[LABEL_MANAGED] !== "true") throw new EngineSpecError("BAD_LABEL", "compose objects carry the JGates labels");
  return ["compose", "--project-name", spec.project, ...[...spec.files, ...(override ? [override] : [])].flatMap((f) => ["-f", f])];
}

export async function composeUp(spec: ComposeSpec, context: EngineContext = {}): Promise<{ args: string[]; overrideFile: string }> {
  fs.mkdirSync(spec.overrideDir, { recursive: true });
  const overrideFile = path.join(spec.overrideDir, `${spec.project}.labels.yml`);
  fs.writeFileSync(overrideFile, composeLabelOverride(spec.services, spec.labels));
  const args = [...composeBase(spec, overrideFile), "up", "--detach", "--wait", "--wait-timeout", String(spec.waitTimeoutSec ?? 120), "--pull", spec.pull ?? "never"];
  must(await engineCommand(args, context, ((spec.waitTimeoutSec ?? 120) + 60) * 1000), "starting the compose services");
  return { args, overrideFile };
}

/** Stops and removes the services of the project, its networks and its volumes (project scope only). */
export async function composeDown(spec: Pick<ComposeSpec, "project" | "files" | "labels">, context: EngineContext = {}): Promise<string[]> {
  const args = [...composeBase({ ...spec, services: [], overrideDir: "" }, null), "down", "--volumes", "--remove-orphans", "--timeout", "10"];
  must(await engineCommand(args, context, 180_000), "stopping the compose services");
  return args;
}
