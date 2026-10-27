// Explicit preparation: the only step that downloads or installs anything. `previewPrepare` shows the versions and the
// network first and changes nothing; `prepareInstance` either downloads the Semgrep registry rules once, stores them by
// hash under <JGATES_HOME>/tools/<hash> and pins the hash (and the tool version) in .jgates/lock.json, or, for an
// instance that runs in a container, resolves its image (a tag or a digest), reads the tool version from the image
// label and pins the image id or repository digest with that version in .jgates/lock.json. The plan reads the image
// only from the lock.
import { parse as parseYaml } from "yaml";
import { translator } from "../../i18n/index.js";
import { builtinManifests } from "../../adapters/manifests.js";
import { probeSemgrep } from "../../adapters/semgrep/probe.js";
import type { AdapterManifest } from "../catalog/index.js";
import { ensureHome, resolveHome } from "../home/index.js";
import { LOCK_FILE, readLock, writeLock, type LockedImage, type LockedRules } from "../lock/index.js";
import { resolveToolBindings, type ToolInstance } from "../tools/index.js";
import { diagnoseEnvironment, preparationKindOf, type ToolStatus } from "./environment.js";
import {
  CONTAINER_ONLY_ADAPTERS,
  containerRuntime,
  DIGEST_IMAGE,
  inspectImage,
  pinnedReference,
  pullImage,
  repositoryOf,
  versionFromLabels,
  type ImageInspection,
} from "./image.js";
import { compareVersions, parseVersion, satisfiesRange } from "./semver.js";
import { DownloadError, SEMGREP_RULES_REF, download, hostOf, preparedRulesOf, semgrepRulesUrl, storeRules, toolsDir } from "./store.js";

export * from "./environment.js";
export * from "./semver.js";
export * from "./image.js";
export { SEMGREP_RULES_FILE, SEMGREP_RULES_REF, preparedRulesOf, semgrepRulesUrl, toolsDir, preparedDir } from "./store.js";

export class PrepareError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fix: string | null = null,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PrepareError";
  }
}

export interface PrepareOptions {
  env?: NodeJS.ProcessEnv;
  manifests?: AdapterManifest[];
  /** Accept a lower tool version than the one pinned in the lock (never silent). */
  allowVersionChange?: boolean;
  /** Image to prepare for a container instance (a tag or a digest reference); default: the one the lock already
   * names, else the adapter's default (the sidecar image of the security scanners). */
  image?: string;
}

export interface PreparePreview {
  schemaVersion: 1;
  instance: string;
  adapter: string;
  /** What the preparation pins: a rule set or a container image. */
  kind: "rules" | "image";
  /** Tool versions: what is installed (for an image: what its label says), the adapter range and what the lock pins. */
  versions: { tool: string; installed: string | null; range: string; pinned: string | null; state: ToolStatus["state"] };
  /** The rule set that would be downloaded (kind rules). */
  rules: { ref: string; url: string; state: ToolStatus["preparation"]["state"]; hash: string | null } | null;
  /** The image that would be pinned (kind image): where its reference came from and whether the runtime has it. */
  image: { reference: string | null; source: "option" | "lock" | "default" | null; present: boolean; id: string | null; pinned: string | null; runtime: string | null } | null;
  /** Network: always for rules; for an image, only when it is not in the runtime and was named explicitly (a pull). */
  network: { required: boolean; hosts: string[]; url: string | null };
  /** What the preparation writes. */
  writes: string[];
}

export interface PrepareResult {
  schemaVersion: 1;
  instance: string;
  adapter: string;
  kind: "rules" | "image";
  rules: LockedRules | null;
  image: LockedImage | null;
  /** The previous rule set hash, or the previous image id. */
  previousHash: string | null;
  changed: boolean;
  toolVersion: string | null;
  lockFile: string;
  /** The image was pulled from its registry by this preparation. */
  pulled?: boolean;
}

function locate(projectDir: string, instanceId: string, options: PrepareOptions) {
  const t = translator("prepare");
  const env = options.env ?? process.env;
  const manifests = options.manifests ?? builtinManifests();
  const resolved = resolveToolBindings(projectDir, { manifests, skipInventory: true });
  const instance = resolved.instances.find((i) => i.id === instanceId);
  if (!instance) {
    const available = resolved.instances.map((i) => i.id).join(", ") || "-";
    throw new PrepareError("INSTANCE_NOT_FOUND", t("prepare_instance_not_found", { name: instanceId }), t("prepare_instance_not_found_fix", { available }));
  }
  const manifest = manifests.find((m) => m.id === instance.adapter);
  const kind = manifest ? preparationKindOf(manifest.id, instance.runner) : null;
  if (!manifest || kind === null) {
    throw new PrepareError("PREPARE_NOT_SUPPORTED", t("prepare_not_supported", { name: instanceId, adapter: instance.adapter }), t("prepare_not_supported_fix"));
  }
  return { env, manifests, instance, manifest, kind, t };
}

/** The image reference to prepare and where it came from: the option, the lock, the adapter default. */
function imageReference(instance: ToolInstance, options: PrepareOptions, projectDir: string): { reference: string | null; source: "option" | "lock" | "default" | null } {
  if (options.image && options.image.trim() !== "") return { reference: options.image.trim(), source: "option" };
  const locked = readLock(projectDir).lock.tools[instance.id]?.image?.reference;
  if (locked) return { reference: locked, source: "lock" };
  const fallback = CONTAINER_ONLY_ADAPTERS[instance.adapter];
  return fallback ? { reference: fallback, source: "default" } : { reference: null, source: null };
}

/** The registry a pull of the reference would reach (docker.io when the reference names none). */
export function registryOf(reference: string): string {
  const first = repositoryOf(reference).split("/")[0] ?? "";
  return reference.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost") ? first : "docker.io";
}

/** A pull is attempted only for a reference somebody named (the option or the lock), never for the default name:
 * the sidecar image is built locally, and pulling its name from a public registry could fetch somebody else's image. */
const mayPull = (source: "option" | "lock" | "default" | null): boolean => source === "option" || source === "lock";

/** Versions and network, before anything runs. Changes nothing. */
export function previewPrepare(projectDir: string, instanceId: string, options: PrepareOptions = {}): PreparePreview {
  const { env, manifests, manifest, kind, instance } = locate(projectDir, instanceId, options);
  const diagnosis = diagnoseEnvironment(projectDir, { env, manifests });
  const status = diagnosis.tools.find((x) => x.instance === instanceId) as ToolStatus;
  if (kind === "image") {
    const { reference, source } = imageReference(instance, options, projectDir);
    const runtime = containerRuntime(env);
    const found = runtime.path && reference ? inspectImage(runtime.path, reference, env) : null;
    const image = found?.ok ? found.image : null;
    const label = image ? versionFromLabels(image.labels, manifest.toolName, !Object.hasOwn(CONTAINER_ONLY_ADAPTERS, manifest.id)) : null;
    const pull = image === null && reference !== null && mayPull(source);
    return {
      schemaVersion: 1,
      instance: instanceId,
      adapter: manifest.id,
      kind,
      versions: { tool: manifest.toolName, installed: label?.version ?? null, range: manifest.toolVersionRange, pinned: status.lock.pinned, state: status.state },
      rules: null,
      image: { reference, source, present: image !== null, id: image?.id ?? null, pinned: reference && image ? pinnedReference(reference, image) : null, runtime: runtime.path },
      network: { required: pull, hosts: pull && reference ? [registryOf(reference)] : [], url: null },
      writes: [LOCK_FILE],
    };
  }
  const url = semgrepRulesUrl(env);
  const home = resolveHome({ env });
  return {
    schemaVersion: 1,
    instance: instanceId,
    adapter: manifest.id,
    kind,
    versions: { tool: manifest.toolName, installed: status.version, range: manifest.toolVersionRange, pinned: status.lock.pinned, state: status.state },
    rules: { ref: SEMGREP_RULES_REF, url, state: status.preparation.state, hash: status.preparation.hash },
    image: null,
    network: { required: true, hosts: [hostOf(url)], url },
    writes: [LOCK_FILE, toolsDir(home)],
  };
}

function checkRulesText(text: string): void {
  const t = translator("prepare");
  let doc: unknown;
  try {
    doc = parseYaml(text, { schema: "core" });
  } catch (error) {
    throw new PrepareError("RULES_INVALID", t("prepare_rules_invalid", { detail: (error as Error).message.split("\n")[0] ?? "" }));
  }
  const rules = doc && typeof doc === "object" ? (doc as { rules?: unknown }).rules : undefined;
  if (!Array.isArray(rules) || rules.length === 0 || !rules.every((r) => r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string")) {
    throw new PrepareError("RULES_INVALID", t("prepare_rules_invalid", { detail: "rules" }));
  }
}

/** Downloads, stores and pins. The only function in the product that touches the network. */
export async function prepareInstance(projectDir: string, instanceId: string, options: PrepareOptions = {}): Promise<PrepareResult> {
  const located = locate(projectDir, instanceId, options);
  if (located.kind === "image") return prepareImage(projectDir, located.instance, located.manifest, options);
  const { env, manifest, t } = located;
  const lockRead = readLock(projectDir);
  if (lockRead.problem) throw new PrepareError("LOCK_INVALID", t("prepare_lock_invalid", { file: LOCK_FILE, detail: lockRead.problem }), t("prepare_lock_invalid_fix", { file: LOCK_FILE }));
  const probe = probeSemgrep(env);
  const previous = lockRead.lock.tools[instanceId] ?? null;
  // No silent downgrade: a tool older than the pinned one needs an explicit decision.
  const installed = parseVersion(probe.version);
  const pinned = parseVersion(previous?.toolVersion ?? null);
  if (installed && pinned && compareVersions(installed, pinned) < 0 && !options.allowVersionChange) {
    throw new PrepareError("VERSION_DOWNGRADE", t("prepare_downgrade", { tool: manifest.toolName, found: probe.version ?? "?", pinned: previous?.toolVersion ?? "?", file: LOCK_FILE }), t("prepare_downgrade_fix"));
  }
  const url = semgrepRulesUrl(env);
  let bytes: Buffer;
  try {
    bytes = await download(url);
  } catch (error) {
    if (error instanceof DownloadError) {
      throw new PrepareError(error.code, t(`prepare_download_${error.code.toLowerCase()}`, { url, detail: error.message }), t("prepare_download_fix"));
    }
    throw error;
  }
  checkRulesText(bytes.toString("utf8"));
  const home = ensureHome(resolveHome({ env }));
  const rules = storeRules(home, SEMGREP_RULES_REF, url, bytes);
  const previousHash = preparedRulesOf(lockRead.lock, instanceId, home).entry?.hash ?? null;
  const others = (previous?.rules ?? []).filter((r) => r.ref !== SEMGREP_RULES_REF);
  lockRead.lock.tools[instanceId] = {
    adapter: manifest.id,
    adapterVersion: manifest.adapterVersion,
    toolVersion: probe.version,
    preparedAt: new Date().toISOString(),
    rules: [...others, rules],
  };
  writeLock(projectDir, lockRead.lock);
  return { schemaVersion: 1, instance: instanceId, adapter: manifest.id, kind: "rules", rules, image: null, previousHash, changed: previousHash !== rules.hash, toolVersion: probe.version, lockFile: LOCK_FILE };
}

/**
 * Pins the container image of an instance: the reference is inspected (pulled first only when it was named and the
 * runtime does not have it), the tool version comes from the image label and must fit the adapter range, and the lock
 * gets the image id or repository digest the runner will start. A tag is never what the plan runs.
 */
function prepareImage(projectDir: string, instance: ToolInstance, manifest: AdapterManifest, options: PrepareOptions): PrepareResult {
  const t = translator("prepare");
  const env = options.env ?? process.env;
  const lockRead = readLock(projectDir);
  if (lockRead.problem) throw new PrepareError("LOCK_INVALID", t("prepare_lock_invalid", { file: LOCK_FILE, detail: lockRead.problem }), t("prepare_lock_invalid_fix", { file: LOCK_FILE }));
  const { reference, source } = imageReference(instance, options, projectDir);
  if (!reference) throw new PrepareError("IMAGE_REQUIRED", t("prepare_image_required", { name: instance.id, tool: manifest.toolName }), t("prepare_image_required_fix", { name: instance.id }));
  if (/\s/.test(reference) || reference.startsWith("-")) throw new PrepareError("IMAGE_INVALID", t("prepare_image_invalid", { image: reference }), t("prepare_image_required_fix", { name: instance.id }));
  const runtime = containerRuntime(env);
  if (!runtime.path) throw new PrepareError("RUNTIME_MISSING", t("prepare_image_runtime_missing", { image: reference, runtime: runtime.name }), t("prepare_fix_docker_required"));

  let found = inspectImage(runtime.path, reference, env);
  let pulled = false;
  if (!found.ok && mayPull(source)) {
    const pull = pullImage(runtime.path, reference, env);
    if (pull.ok) {
      pulled = true;
      found = inspectImage(runtime.path, reference, env);
    } else found = { ok: false, detail: pull.detail };
  }
  if (!found.ok) {
    const fix = source === "default" ? t("prepare_image_build_fix", { name: instance.id }) : t("prepare_image_pull_fix", { image: reference });
    throw new PrepareError("IMAGE_NOT_FOUND", t("prepare_image_not_found", { image: reference, detail: found.detail }), fix);
  }
  const image: ImageInspection = found.image;
  const label = versionFromLabels(image.labels, manifest.toolName, !Object.hasOwn(CONTAINER_ONLY_ADAPTERS, manifest.id));
  if (!label) {
    throw new PrepareError("IMAGE_NO_VERSION", t("prepare_image_no_version", { image: reference, tool: manifest.toolName, label: `org.jgates.tool.${manifest.toolName}.version` }), t("prepare_image_no_version_fix"));
  }
  if (satisfiesRange(label.version, manifest.toolVersionRange) !== true) {
    throw new PrepareError(
      "IMAGE_INCOMPATIBLE",
      t("prepare_incompatible", { tool: manifest.toolName, version: label.version, range: manifest.toolVersionRange, what: manifest.id }),
      t("prepare_fix_incompatible", { tool: manifest.toolName, range: manifest.toolVersionRange }),
    );
  }
  const previous = lockRead.lock.tools[instance.id] ?? null;
  const installed = parseVersion(label.version);
  const pinnedVersion = parseVersion(previous?.toolVersion ?? null);
  if (installed && pinnedVersion && compareVersions(installed, pinnedVersion) < 0 && !options.allowVersionChange) {
    throw new PrepareError("VERSION_DOWNGRADE", t("prepare_downgrade", { tool: manifest.toolName, found: label.version, pinned: previous?.toolVersion ?? "?", file: LOCK_FILE }), t("prepare_downgrade_fix"));
  }
  const pinned = pinnedReference(reference, image);
  if (!DIGEST_IMAGE.test(pinned)) throw new PrepareError("IMAGE_NOT_FOUND", t("prepare_image_not_found", { image: reference, detail: "no digest" }), t("prepare_image_pull_fix", { image: reference }));
  const locked: LockedImage = { reference, id: image.id, pinned, versionLabel: label.label };
  const previousHash = previous?.image?.id ?? null;
  lockRead.lock.tools[instance.id] = {
    adapter: manifest.id,
    adapterVersion: manifest.adapterVersion,
    toolVersion: label.version,
    preparedAt: new Date().toISOString(),
    ...(previous?.rules ? { rules: previous.rules } : {}),
    image: locked,
  };
  writeLock(projectDir, lockRead.lock);
  return {
    schemaVersion: 1,
    instance: instance.id,
    adapter: manifest.id,
    kind: "image",
    rules: null,
    image: locked,
    previousHash,
    changed: previousHash !== image.id || previous?.image?.pinned !== pinned,
    toolVersion: label.version,
    lockFile: LOCK_FILE,
    pulled,
  };
}
