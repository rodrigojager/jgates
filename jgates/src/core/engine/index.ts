// Engine module (ADR-0004): the only code that talks to the container engine, always through runSpec.
// This is the S0 skeleton: runtime and tools image selection, the JGates labels, labelled volumes initialized by a
// root helper, image inspection and one `docker run` per container under the step contract (`--pull never`,
// read-only root, tmpfs /tmp, no capabilities, no new privileges, limits, network off unless declared, a minimal
// environment). Detection, pulls with progress, kill by run label, compose and pruning come with the complete module.
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ENV_ALLOWLIST, runSpec, type ExecutionResult, type RunnerOptions } from "../runner/process.js";
import { currentScope } from "../runner/scope.js";

/** Development image, used when JGATES_TOOLS_IMAGE asks for it (and until the pin file exists). */
export const DEV_TOOLS_IMAGE = "jgates-tools:dev";
/** The image user of the steps on Windows and macOS hosts. */
export const IMAGE_USER = "10001:10001";
export const DEFAULT_RESOURCES = { memoryMb: 4096, cpus: 2, pids: 1024, tmpfsMb: 256 } as const;
/** Environment every container gets: caches and bytecode kept out of the sources and out of the read-only root. */
export const BASE_CONTAINER_ENV: Readonly<Record<string, string>> = { HOME: "/tmp/home", PYTHONDONTWRITEBYTECODE: "1" };
/** Connection settings of the engine client; they stay on the host side and never reach a container. */
export const ENGINE_CLIENT_ENV: readonly string[] = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "XDG_RUNTIME_DIR"];

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
  /** `none` unless the item declares network. */
  network?: "none" | "bridge";
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
    spec.network ?? "none",
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

/** One engine client command (not a container run): inspect, volume create/rm, and so on. */
export function engineCommand(args: string[], context: EngineContext = {}, timeoutMs = 60_000): Promise<ExecutionResult> {
  return runSpec({ executable: context.runtime ?? engineRuntime(), args, cwd: os.tmpdir(), timeoutMs, signal: NEVER }, clientOptions(context));
}

export type EngineRunResult = ExecutionResult & { name: string; args: string[]; removalRequested: boolean; runtimeFailure: boolean };

/** Runs one container under the contract; a cancelled or timed-out run also removes the container by name. */
export async function runInEngine(spec: EngineRunSpec, context: EngineContext = {}): Promise<EngineRunResult> {
  const runtime = context.runtime ?? engineRuntime();
  const { args, name } = buildRunArgs(spec);
  const options = clientOptions(context);
  const abort = spec.signal ?? currentScope()?.signal;
  let removal: Promise<unknown> | null = null;
  const requestRemoval = (): Promise<unknown> => (removal ??= engineCommand(["rm", "--force", name], { ...context, runtime }, 30_000).catch(() => undefined));
  const onAbort = (): void => void requestRemoval();
  abort?.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await runSpec(
      {
        executable: runtime,
        args,
        cwd: os.tmpdir(),
        ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
        ...(spec.signal ? { signal: spec.signal } : {}),
        ...(spec.stdoutFile ? { stdoutFile: spec.stdoutFile } : {}),
        ...(spec.stderrFile ? { stderrFile: spec.stderrFile } : {}),
      },
      options,
    );
    if (result.cancelled || result.timedOut || (result.exitCode === null && !result.spawnError)) await requestRemoval();
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
