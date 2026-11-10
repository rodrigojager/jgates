// `jgates setup`: makes the machine ready, idempotently (PLAN-lifecycle.md section 1). In order: the engine (guidance, never
// a silent install), the free disk (before any download), the tools image at the pinned reference (pulled with progress, or
// loaded from a tarball), the shared volumes, the advisory data. A ready machine finishes with nothing to pull and nothing
// to refresh. CodeQL is never touched here: it needs the user's acceptance of its terms (`jgates tools prepare-codeql`).
import {
  EngineError,
  IMAGE_USER,
  detectEngine,
  engineLabels,
  ensureVolume,
  inspectImageSync,
  pullImage,
  type PullProgress,
} from "../engine/index.js";
import { DATABASE_IDS, DATABASES, updateData, type DatabaseId, type UpdateProgress } from "../data/index.js";
import { TOOLCHAINS_VOLUME } from "../deps/toolchains.js";
import { DEFAULT_CACHE_VOLUME } from "../deps/prepare.js";
import { executeRecipe, dockerStartRecipe, detectSystem, type InstallExecutor } from "../install/index.js";
import { formatBytes, formatMegabytes, resolveReason } from "../reasons/index.js";
import { stepMode } from "../runner/in-image.js";
import { IMAGE_VERSION_LABEL, readToolsImagePin, toolsImageTarget, type ToolsImagePin } from "../tools-image/index.js";
import { translator } from "../../i18n/index.js";
import { collectStatus, engineContextOf, engineReason, type LifecycleReason, type StatusReport } from "./status.js";
import { importImage } from "./transfer.js";

export type SetupStepId = "engine" | "disk" | "image" | "volumes" | "data";
export type SetupStepState = "done" | "skipped" | "failed";

export interface SetupStep {
  id: SetupStepId;
  state: SetupStepState;
  message: string;
}

/** The objects the progress callback gets (the CLI writes them to stderr as JSON lines with --json). */
export type SetupEvent =
  | { type: "setup-step"; step: SetupStepId; state: "started" | SetupStepState; message?: string }
  | { type: "image-pull"; phase: PullProgress["phase"]; downloaded: number; total: number; layer?: string; attempt?: number }
  | { type: "data-update"; database: DatabaseId; state: UpdateProgress["state"]; message?: string };

export interface SetupOptions {
  env?: NodeJS.ProcessEnv;
  version: string;
  projectDir?: string | null;
  /** Refresh the advisory data (default true). */
  withData?: boolean;
  /** Load the image from a tarball written by `tools export` instead of pulling it. */
  from?: string;
  /** `--yes`: start a stopped engine when its start command needs no sudo, then wait for it. */
  yes?: boolean;
  pin?: ToolsImagePin;
  /** Where the free space is measured when no helper container can be (the engine's storage on this host). */
  hostDiskPath?: string;
  /** What runs the start command of a stopped engine (tests give a fake one). */
  executor?: InstallExecutor;
  /** Milliseconds to wait for a started engine. */
  startTimeoutMs?: number;
  onEvent?: (event: SetupEvent) => void;
  locale?: string;
}

export interface SetupResult {
  /** The machine can run checks: the status after the steps says so. */
  ready: boolean;
  /** The image was downloaded (or loaded) now. */
  pulled: boolean;
  steps: SetupStep[];
  /** What went wrong in the steps (disk, pull) on top of what the status reports. */
  reasons: LifecycleReason[];
  status: StatusReport;
}

/** Free space the download needs: compressed + unpacked + 10 % (PLAN-lifecycle.md section 3). */
export interface DiskRequirement {
  compressedBytes: number;
  uncompressedBytes: number;
  totalBytes: number;
  totalMb: number;
}

/**
 * The pin says the compressed size (`compressedBytes`, or `sizeBytes`) and may say the unpacked size
 * (`uncompressedBytes`); without it the unpacked size is estimated with the ratio measured on the first complete image
 * (1,93 GB compressed, 5,58 GB unpacked).
 */
export function diskRequirement(pin: ToolsImagePin): DiskRequirement {
  const extra = pin as ToolsImagePin & { compressedBytes?: number; uncompressedBytes?: number };
  const compressedBytes = extra.compressedBytes ?? pin.sizeBytes;
  const uncompressedBytes = extra.uncompressedBytes ?? Math.round(compressedBytes * 2.9);
  const totalBytes = Math.ceil((compressedBytes + uncompressedBytes) * 1.1);
  return { compressedBytes, uncompressedBytes, totalBytes, totalMb: Math.ceil(totalBytes / (1024 * 1024)) };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const t = translator("lifecycle", options.locale);
  const env = options.env ?? process.env;
  const pin = options.pin ?? readToolsImagePin();
  const target = toolsImageTarget(env, pin);
  const context = engineContextOf(env);
  const emit = options.onEvent ?? (() => undefined);
  const steps: SetupStep[] = [];
  const reasons: LifecycleReason[] = [];
  let pulled = false;

  const finish = async (): Promise<SetupResult> => {
    const status = await collectStatus({ env, version: options.version, projectDir: options.projectDir ?? null, pin, ...(options.locale ? { locale: options.locale } : {}) });
    return { ready: status.ready && reasons.length === 0, pulled, steps, reasons, status };
  };
  const step = (id: SetupStepId, state: SetupStepState, message: string): void => {
    steps.push({ id, state, message });
    emit({ type: "setup-step", step: id, state, message });
  };

  if (stepMode(env) === "in-image") {
    step("engine", "skipped", t("lifecycle_step_in_image"));
    return finish();
  }

  // 1. Engine.
  emit({ type: "setup-step", step: "engine", state: "started" });
  let detection = await detectEngine({ requiredDiskMb: 0 }, context);
  if (detection.code === "ENGINE_STOPPED" && options.yes) {
    const recipe = dockerStartRecipe(detectSystem());
    const usesSudo = recipe.commands.some((c) => c === "sudo" || c.startsWith("sudo "));
    if (recipe.available && !usesSudo) {
      const outcome = await executeRecipe(recipe, { confirmed: true, interactive: false, env, ...(options.executor ? { executor: options.executor } : {}) });
      if (outcome.status === "installed") {
        const deadline = Date.now() + (options.startTimeoutMs ?? 120_000);
        while (detection.code === "ENGINE_STOPPED" && Date.now() < deadline) {
          await sleep(Math.min(2000, Math.max(50, deadline - Date.now())));
          detection = await detectEngine({ requiredDiskMb: 0 }, context);
        }
      }
    }
  }
  const engineBlock = engineReason(detection, options.locale);
  if (detection.code === "ENGINE_NOT_INSTALLED" || detection.code === "ENGINE_STOPPED" || detection.code === "UNSUPPORTED_PLATFORM") {
    step("engine", "failed", engineBlock?.message ?? detection.code);
    return finish();
  }
  step("engine", "done", t("lifecycle_step_engine_ok", { version: detection.facts.serverVersion ?? "?" }));
  // Low memory is reported by the status (it blocks runs); the downloads can still go on.

  // 2. The image.
  const present = inspectImageSync(target.reference, context);
  const current = present !== null && present.labels[IMAGE_VERSION_LABEL] === options.version;
  if (current) {
    step("disk", "skipped", t("lifecycle_step_disk_not_needed"));
    step("image", "skipped", t("lifecycle_step_image_present", { image: target.reference }));
  } else if (options.from) {
    emit({ type: "setup-step", step: "image", state: "started" });
    step("disk", "skipped", t("lifecycle_step_disk_not_needed"));
    try {
      const loaded = await importImage({ env, version: options.version, file: options.from, pin });
      pulled = true;
      step("image", "done", t("lifecycle_step_image_loaded", { image: loaded.reference }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: string }).code ?? "IMPORT_FAILED";
      reasons.push({ ...pullFailed(message, options.locale), details: `${code}: ${message}` });
      step("image", "failed", message);
      return finish();
    }
  } else {
    // Disk first, before the first byte is downloaded.
    emit({ type: "setup-step", step: "disk", state: "started" });
    const need = diskRequirement(pin);
    const space = await detectEngine({ requiredDiskMb: 1, ...(options.hostDiskPath ? { hostDiskPath: options.hostDiskPath } : {}) }, context);
    const free = space.facts.diskFreeMb;
    if (free !== null && free < need.totalMb) {
      const resolved = resolveReason("DISK_LOW", { missing: formatMegabytes(need.totalMb - free, options.locale), need: formatMegabytes(need.totalMb, options.locale), have: formatMegabytes(free, options.locale) }, options.locale);
      reasons.push({ code: "DISK_LOW", message: resolved.message, action: resolved.action, details: `needs ${need.totalBytes} bytes (compressed ${need.compressedBytes} + unpacked ${need.uncompressedBytes} + 10 %), ${free} MB free` });
      step("disk", "failed", resolved.message);
      return finish();
    }
    step("disk", "done", free === null ? t("lifecycle_step_disk_unknown") : t("lifecycle_step_disk_ok", { free: formatMegabytes(free, options.locale), need: formatMegabytes(need.totalMb, options.locale) }));

    emit({ type: "setup-step", step: "image", state: "started" });
    try {
      await pullImage(
        target.reference,
        {
          expectedBytes: need.compressedBytes,
          onProgress: (e) => emit({ type: "image-pull", phase: e.phase, downloaded: e.downloaded, total: e.total, ...(e.layer ? { layer: e.layer } : {}), ...(e.attempt ? { attempt: e.attempt } : {}) }),
        },
        context,
      );
      pulled = true;
    } catch (error) {
      const details = error instanceof EngineError ? error.details : error instanceof Error ? error.message : String(error);
      const failure = pullFailed(details.split(/\r?\n/).filter(Boolean).at(-1) ?? details, options.locale);
      reasons.push({ ...failure, details });
      step("image", "failed", failure.message);
      return finish();
    }
    const after = inspectImageSync(target.reference, context);
    if (!after) {
      const failure = pullFailed(t("lifecycle_step_image_not_found", { image: target.reference }), options.locale);
      reasons.push({ ...failure, details: `image ${target.reference} is not in the engine after the pull` });
      step("image", "failed", failure.message);
      return finish();
    }
    step("image", "done", t("lifecycle_step_image_pulled", { image: target.reference, size: formatBytes(need.compressedBytes, options.locale) }));
  }

  // The image of this release is there; a version mismatch after the pull is reported by the status.
  const image = inspectImageSync(target.reference, context);
  if (!image || image.labels[IMAGE_VERSION_LABEL] !== options.version) {
    step("volumes", "skipped", t("lifecycle_step_volumes_no_image"));
    step("data", "skipped", t("lifecycle_step_data_no_image"));
    return finish();
  }

  // 3. Shared volumes (labelled; created once).
  emit({ type: "setup-step", step: "volumes", state: "started" });
  const helperLabels = engineLabels({ kind: "helper", version: options.version });
  const created: string[] = [];
  try {
    if (await ensureVolume(DEFAULT_CACHE_VOLUME, { labels: engineLabels({ kind: "deps", version: options.version }), helperLabels, image: image.id, owner: IMAGE_USER }, context)) created.push(DEFAULT_CACHE_VOLUME);
    if (await ensureVolume(TOOLCHAINS_VOLUME, { labels: engineLabels({ kind: "toolchain", version: options.version }), helperLabels, image: image.id, owner: IMAGE_USER }, context)) created.push(TOOLCHAINS_VOLUME);
    step("volumes", created.length > 0 ? "done" : "skipped", created.length > 0 ? t("lifecycle_step_volumes_created", { count: created.length, names: created.join(", ") }) : t("lifecycle_step_volumes_present"));
  } catch (error) {
    const message = t("lifecycle_step_volumes_failed", { error: error instanceof Error ? error.message : String(error) });
    step("volumes", "failed", message);
    reasons.push({ code: "ENGINE_STOPPED", ...pickEngineStopped(options.locale), details: message });
    return finish();
  }

  // 4. Advisory data: only what is missing or older than the limit.
  if (options.withData === false) {
    step("data", "skipped", t("lifecycle_step_data_declined"));
    return finish();
  }
  emit({ type: "setup-step", step: "data", state: "started" });
  const before = await collectStatus({ env, version: options.version, projectDir: options.projectDir ?? null, pin, light: true });
  const due = before.data.databases.filter((d) => d.state !== "fresh").map((d) => d.id);
  if (due.length === 0) {
    step("data", "skipped", t("lifecycle_step_data_fresh"));
    return finish();
  }
  try {
    const result = await updateData({
      env,
      version: options.version,
      only: DATABASE_IDS.filter((id) => due.includes(id)),
      onProgress: (e) => emit({ type: "data-update", database: e.database, state: e.state, ...(e.message ? { message: e.message } : {}) }),
    });
    const failed = result.databases.filter((d) => !d.ok);
    if (result.blocked || failed.length > 0) {
      step("data", "failed", result.blocked ?? t("lifecycle_step_data_failed", { count: failed.length, names: failed.map((d) => DATABASES[d.id].tool).join(", ") }));
      reasons.push(
        ...failed.map((d) => {
          const r = resolveReason("DATA_MISSING", { database: DATABASES[d.id].tool }, options.locale);
          return { code: "DATA_MISSING", message: r.message, action: r.action, ...(d.error ? { details: d.error } : {}) } as LifecycleReason;
        }),
      );
    } else step("data", "done", t("lifecycle_step_data_updated", { count: result.databases.length }));
  } catch (error) {
    const message = t("lifecycle_step_data_error", { error: error instanceof Error ? error.message : String(error) });
    step("data", "failed", message);
    reasons.push({ code: "DATA_MISSING", ...pickData(options.locale), details: message });
  }
  return finish();
}

function pullFailed(reason: string, locale?: string): LifecycleReason {
  const r = resolveReason("IMAGE_PULL_FAILED", { reason: reason.replace(/[.\s]+$/, "") }, locale);
  return { code: "IMAGE_PULL_FAILED", message: r.message, action: r.action };
}

function pickEngineStopped(locale?: string): Pick<LifecycleReason, "message" | "action"> {
  const r = resolveReason("ENGINE_STOPPED", {}, locale);
  return { message: r.message, action: r.action };
}

function pickData(locale?: string): Pick<LifecycleReason, "message" | "action"> {
  const r = resolveReason("DATA_MISSING", { database: "advisory" }, locale);
  return { message: r.message, action: r.action };
}
