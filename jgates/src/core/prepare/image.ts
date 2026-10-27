// Container images pinned in .jgates/lock.json. `jgates tools prepare` resolves the image an instance runs in (a tag
// or a digest reference), reads the tool version from the image label and pins the repository digest or the image id;
// the plan reads only the lock and checks, with `image inspect`, that the pinned image is still in the runtime. No
// environment variable chooses an image: the lock is the only source, so the same commit plans the same image.
import { spawnSync } from "node:child_process";
import { findOnPath } from "../bridge/index.js";
import { DOCKER_CLIENT_ENV } from "../runner/index.js";
import { readLock, type LockedImage } from "../lock/index.js";

/** `name@sha256:<64 hex>` or an image id `sha256:<64 hex>`: the forms the container runner accepts. */
export const DIGEST_IMAGE = /^(?:[A-Za-z0-9][A-Za-z0-9._\-/:]*@)?sha256:[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/** The sidecar image (quality-gate/Dockerfile), the one the security scanners run in when no other is given. */
export const SIDECAR_IMAGE = "jgates/quality-sidecar:latest";

/** Adapters that run only on the container runner, with the image `tools prepare` uses when none is given. */
export const CONTAINER_ONLY_ADAPTERS: Readonly<Record<string, string>> = {
  gitleaks: SIDECAR_IMAGE,
  trivy: SIDECAR_IMAGE,
  "osv-scanner": SIDECAR_IMAGE,
  checkov: SIDECAR_IMAGE,
};

/** Adapters that run on the container runner only when tools.yml says `runner: container` (no default image). */
export const CONTAINER_OPTIONAL_ADAPTERS: ReadonlySet<string> = new Set(["ruff"]);

/** Whether an instance of this adapter, with this runner in tools.yml, runs in a container (and so needs an image). */
export function runsInContainer(adapter: string, runner: string | null | undefined): boolean {
  if (Object.hasOwn(CONTAINER_ONLY_ADAPTERS, adapter)) return true;
  return CONTAINER_OPTIONAL_ADAPTERS.has(adapter) && runner === "container";
}

/** The label that carries the version of one tool of the image (an image may carry several tools). */
export const toolVersionLabel = (tool: string): string => `org.jgates.tool.${tool}.version`;
/** The label of an image that carries one tool only (jgates/docker/ruff/Dockerfile). */
export const SINGLE_TOOL_VERSION_LABEL = "org.jgates.tool.version";

/** The instruction every "image not prepared" message points to. */
export const prepareImageCommand = (instance: string): string => `jgates tools prepare --instance ${instance}`;

/** Environment of the runtime client: the basic variables and the Docker connection settings, nothing else. */
export function runtimeClientEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", ...DOCKER_CLIENT_ENV]) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** JGATES_CONTAINER_RUNTIME (default docker), looked up on the PATH. */
export function containerRuntime(env: NodeJS.ProcessEnv): { name: string; path: string | null } {
  const name = env.JGATES_CONTAINER_RUNTIME?.trim() || "docker";
  return { name, path: findOnPath(name, env) };
}

const lastLine = (r: { error?: Error | undefined; stderr?: string | null; status: number | null }): string =>
  (r.error?.message ?? r.stderr ?? "").trim().split(/\r?\n/).slice(-1)[0] || `exit ${r.status ?? "-"}`;

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function stringLabels(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRec(raw)) for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  return out;
}

/** The labels of an image (`image inspect --format {{json .Config.Labels}}`), or why they could not be read. */
export function imageLabels(runtime: string, image: string, env: NodeJS.ProcessEnv): { ok: true; labels: Record<string, string> } | { ok: false; detail: string } {
  const r = spawnSync(runtime, ["image", "inspect", "--format", "{{json .Config.Labels}}", image], { encoding: "utf8", timeout: 30_000, env: runtimeClientEnv(env), windowsHide: true });
  if (r.status !== 0) return { ok: false, detail: lastLine(r) };
  try {
    return { ok: true, labels: stringLabels(JSON.parse(r.stdout.trim() || "null")) };
  } catch {
    return { ok: true, labels: {} };
  }
}

export interface ImageInspection {
  id: string;
  repoDigests: string[];
  labels: Record<string, string>;
}

/** The id, repository digests and labels of an image (`image inspect <ref>`, the JSON array the runtime prints). */
export function inspectImage(runtime: string, reference: string, env: NodeJS.ProcessEnv): { ok: true; image: ImageInspection } | { ok: false; detail: string } {
  const r = spawnSync(runtime, ["image", "inspect", reference], { encoding: "utf8", timeout: 30_000, env: runtimeClientEnv(env), windowsHide: true });
  if (r.status !== 0) return { ok: false, detail: lastLine(r) };
  let doc: unknown;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    return { ok: false, detail: "image inspect: unreadable answer" };
  }
  const first = Array.isArray(doc) ? doc[0] : doc;
  if (!isRec(first) || typeof first.Id !== "string" || !IMAGE_ID.test(first.Id)) return { ok: false, detail: "image inspect: no image id" };
  const repoDigests = Array.isArray(first.RepoDigests) ? first.RepoDigests.filter((d): d is string => typeof d === "string" && DIGEST_IMAGE.test(d)) : [];
  const labels = stringLabels(isRec(first.Config) ? first.Config.Labels : undefined);
  return { ok: true, image: { id: first.Id, repoDigests, labels } };
}

/** `docker pull <reference>`: the only call that may reach a registry, and only from `tools prepare`. */
export function pullImage(runtime: string, reference: string, env: NodeJS.ProcessEnv): { ok: boolean; detail: string } {
  const r = spawnSync(runtime, ["pull", reference], { encoding: "utf8", timeout: 1_800_000, env: runtimeClientEnv(env), windowsHide: true });
  return { ok: r.status === 0, detail: r.status === 0 ? "" : lastLine(r) };
}

/** The tool version an image declares: org.jgates.tool.<tool>.version, or the single-tool label when it is allowed. */
export function versionFromLabels(labels: Record<string, string>, tool: string, singleTool: boolean): { version: string; label: string } | null {
  const candidates = [toolVersionLabel(tool), ...(singleTool ? [SINGLE_TOOL_VERSION_LABEL] : [])];
  for (const label of candidates) {
    const version = labelVersion(labels, label);
    if (version) return { version, label };
  }
  return null;
}

/** The version written in one label (`1.2.3`, `v1.2.3`), or null. */
export function labelVersion(labels: Record<string, string>, label: string): string | null {
  const raw = labels[label];
  return typeof raw === "string" ? (/^v?(\d+\.\d+\.\d+\S*)$/.exec(raw.trim())?.[1] ?? null) : null;
}

/** The repository part of a reference (registry/name, without the tag or the digest). */
export function repositoryOf(reference: string): string {
  const at = reference.indexOf("@");
  const name = at >= 0 ? reference.slice(0, at) : reference;
  const slash = name.lastIndexOf("/");
  const colon = name.lastIndexOf(":");
  return colon > slash ? name.slice(0, colon) : name;
}

/** What the runner starts: the reference itself when it is a digest, else the repository digest of the same
 * repository, else the image id (a locally built image has no repository digest). Never a tag. */
export function pinnedReference(reference: string, inspection: ImageInspection): string {
  if (DIGEST_IMAGE.test(reference)) return reference;
  const repo = repositoryOf(reference);
  return inspection.repoDigests.find((d) => repositoryOf(d) === repo) ?? inspection.id;
}

export type LockedImageProblem = "runtime_missing" | "lock_invalid" | "image_unprepared" | "image_missing" | "image_changed";

export interface LockedImageProbe {
  /** Absolute path of the container runtime client, or null when it was not found. */
  runtime: string | null;
  /** The runtime name or path that was looked up. */
  runtimeName: string;
  /** The pinned reference the runner starts (from the lock), or null. */
  image: string | null;
  /** The pinned entry of the lock, when there is one. */
  locked: LockedImage | null;
  /** The tool version pinned with the image. */
  version: string | null;
  problem: LockedImageProblem | null;
  detail: string;
  /** The command that prepares (or prepares again) the image. */
  command: string;
}

/** The image of an instance as pinned in the lock, checked against the runtime (the image must still be there and
 * still say the pinned version). Reads; never pulls, builds or writes. */
export function probeLockedImage(input: { env: NodeJS.ProcessEnv; dir: string; instance: string }): LockedImageProbe {
  const rt = containerRuntime(input.env);
  const command = prepareImageCommand(input.instance);
  const lock = readLock(input.dir);
  const entry = lock.lock.tools[input.instance];
  const locked = entry?.image ?? null;
  const base = { runtime: rt.path, runtimeName: rt.name, image: locked?.pinned ?? null, locked, version: locked ? (entry?.toolVersion ?? null) : null, command };
  if (!rt.path) return { ...base, problem: "runtime_missing", detail: rt.name };
  if (lock.problem) return { ...base, problem: "lock_invalid", detail: lock.problem };
  if (!locked) return { ...base, problem: "image_unprepared", detail: lock.file };
  const read = imageLabels(rt.path, locked.pinned, input.env);
  if (!read.ok) return { ...base, problem: "image_missing", detail: read.detail };
  // The pinned image must still say the pinned version in the same label (an id or a digest never changes, so this
  // only fails for a lock edited by hand).
  const found = labelVersion(read.labels, locked.versionLabel);
  if (found === null || found !== base.version) return { ...base, problem: "image_changed", detail: found ?? locked.versionLabel };
  return { ...base, problem: null, detail: "" };
}
