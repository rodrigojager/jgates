// `jgates status`: one report of readiness (PLAN-lifecycle.md section 1). The engine, the tools image of this release,
// the extension images, the age of the advisory data, the dependencies and services of the current workspace and what
// JGates occupies on the disk. It only reads: it never pulls, creates a volume or starts a container for a purpose other
// than reading a small file. Setup uses the same report to decide whether the machine is ready.
import path from "node:path";
import {
  detectEngine,
  engineRuntime,
  inspectImageSync,
  listManaged,
  managedUsage,
  type EngineContext,
  type EngineDetection,
  type EngineReasonCode,
} from "../engine/index.js";
import { agesOf, DATABASES, dataMaxAgeDaysOf, readDataStatusSync, type DatabaseAge, type DataReadState } from "../data/index.js";
import { discoverWorkspace } from "../discovery/index.js";
import { installUnits, loadDependencySettings, planUnit, readDepsState } from "../deps/index.js";
import { resolveHome } from "../home/index.js";
import { workspaceId } from "../ids/index.js";
import { formatBytes, formatMegabytes, resolveReason, type ReasonAction } from "../reasons/index.js";
import { dockerInstallRecipe, dockerStartRecipe, detectSystem, previewOf, type RecipePreview } from "../install/index.js";
import { stepMode } from "../runner/in-image.js";
import { IMAGE_VERSION_LABEL, readToolsImagePin, toolsImageTarget, type ToolsImagePin } from "../tools-image/index.js";

export interface LifecycleReason {
  code: string;
  message: string;
  action: ReasonAction;
  /** The install or start recipe of the engine (never run silently): commands to show, with sudo where the system needs it. */
  recipe?: RecipePreview;
  /** Raw engine text, for a details fold; never the main text. */
  details?: string;
}

export type EngineState = "ready" | "not-installed" | "stopped" | "unsupported" | "low-memory";
export type ImageState = "ready" | "missing" | "version-mismatch" | "unknown";
export type DependencyState = "ready" | "outdated" | "missing" | "failed" | "not-ready";

export interface StatusReport {
  schemaVersion: 1;
  /** container: the engine runs the checks; in-image: JGates runs inside the tools image and there is nothing to set up. */
  mode: "container" | "in-image";
  /** The engine and the tools image of this release are in place: a run can start. */
  ready: boolean;
  engine: {
    state: EngineState;
    runtime: string;
    serverVersion: string | null;
    os: string | null;
    arch: string | null;
    memoryMb: number | null;
    cpus: number | null;
  };
  image: {
    reference: string;
    source: "env" | "pin";
    state: ImageState;
    id: string | null;
    version: string | null;
    expectedVersion: string;
    pinDigest: string;
    published: boolean;
  };
  extension: { images: Array<{ name: string; sizeBytes: number }> };
  data: {
    /** fresh: every database is within the limit; stale or missing: at least one is not. */
    state: "fresh" | "stale" | "missing";
    read: DataReadState;
    maxAgeDays: number;
    databases: DatabaseAge[];
  };
  workspace: {
    id: string;
    path: string;
    dependencies: Array<{ unit: string; components: string[]; state: DependencyState }>;
    services: { running: number };
  } | null;
  disk: {
    /** Free space where the image would go (the host disk the engine stores on); null when it could not be read. */
    freeMb: number | null;
    managedBytes: number | null;
    volumes: Array<{ name: string; sizeBytes: number }>;
    images: Array<{ name: string; sizeBytes: number }>;
  };
  /** What stops a run (engine, image). */
  reasons: LifecycleReason[];
  /** What does not stop the start but leaves checks incomplete (advisory data). */
  warnings: LifecycleReason[];
}

export interface StatusOptions {
  env?: NodeJS.ProcessEnv;
  /** The JGates version of this CLI (the tools image has to carry the same one). */
  version: string;
  /** The project whose workspace is reported; null: no workspace section. */
  projectDir?: string | null;
  pin?: ToolsImagePin;
  locale?: string;
  /** Skip the scan of the project (its dependencies and services): setup reports the machine, not a workspace. */
  light?: boolean;
}

export const engineContextOf = (env: NodeJS.ProcessEnv): EngineContext => ({ runtime: engineRuntime(env), runnerOptions: { parentEnv: env } });

const ENGINE_STATE: Record<EngineReasonCode, EngineState> = {
  ENGINE_NOT_INSTALLED: "not-installed",
  ENGINE_STOPPED: "stopped",
  UNSUPPORTED_PLATFORM: "unsupported",
  ENGINE_LOW_MEMORY: "low-memory",
  DISK_LOW: "ready",
  IMAGE_PULL_FAILED: "ready",
};

/** The reason of an engine detection (null when the engine is usable), with the recipe that fixes it where there is one. */
export function engineReason(detection: EngineDetection, locale?: string, requiredMemoryMb = 4096): LifecycleReason | null {
  const code = detection.code;
  if (code === null || code === "DISK_LOW" || code === "IMAGE_PULL_FAILED") return null;
  const params =
    code === "UNSUPPORTED_PLATFORM"
      ? { platform: `${detection.facts.os ?? "?"}/${detection.facts.arch ?? "?"}` }
      : code === "ENGINE_LOW_MEMORY"
        ? { have: formatMegabytes(detection.facts.memoryMb ?? 0, locale), need: formatMegabytes(requiredMemoryMb, locale) }
        : {};
  const resolved = resolveReason(code, params, locale);
  const system = detectSystem();
  const recipe = code === "ENGINE_NOT_INSTALLED" ? previewOf(dockerInstallRecipe(system)) : code === "ENGINE_STOPPED" ? previewOf(dockerStartRecipe(system)) : undefined;
  return { code, message: resolved.message, action: resolved.action, ...(recipe ? { recipe } : {}), ...(detection.details ? { details: detection.details } : {}) };
}

const EMPTY_FACTS = { serverVersion: null, os: null, arch: null, memoryMb: null, cpus: null } as const;

async function dependencySummary(projectDir: string, env: NodeJS.ProcessEnv, engine: EngineContext, imageId: string | null) {
  const workspace = workspaceId(projectDir);
  const home = resolveHome({ env });
  const { inventory } = discoverWorkspace(projectDir);
  const { units } = installUnits(inventory.classifications.filter((c) => c.approvable));
  const settings = loadDependencySettings(projectDir);
  const record = readDepsState(home, workspace);
  let volumes: string[] | null = null;
  try {
    volumes = (await listManaged("volume", { kind: "deps", workspace }, engine)).map((v) => v.name);
  } catch {
    volumes = null;
  }
  const dependencies = units.map((unit) => {
    const planned = planUnit(unit, { projectDir, workspace, imageId, governed: false, settings, env, vault: true });
    const installed = record.units[unit.id];
    const failure = record.failures[unit.id];
    let state: DependencyState;
    if (planned.blocked) state = "not-ready";
    else if (failure && failure.key === planned.key) state = "failed";
    else if (installed && volumes !== null && volumes.includes(installed.volume)) state = installed.key === planned.key ? "ready" : "outdated";
    else state = "missing";
    return { unit: unit.id, components: unit.components, state };
  });
  return { id: workspace, dependencies };
}

/** Collects the report. Never throws for an engine that is missing, stopped or odd: that is the answer. */
export async function collectStatus(options: StatusOptions): Promise<StatusReport> {
  const env = options.env ?? process.env;
  const locale = options.locale;
  const pin = options.pin ?? readToolsImagePin();
  const target = toolsImageTarget(env, pin);
  const context = engineContextOf(env);
  const projectDir = options.projectDir === undefined ? process.cwd() : options.projectDir;
  const maxAgeDays = projectDir ? dataMaxAgeDaysOf(projectDir) : 7;
  const base = {
    schemaVersion: 1 as const,
    image: { reference: target.reference, source: target.source, pinDigest: pin.digest, published: pin.published, expectedVersion: options.version },
    extension: { images: [] as Array<{ name: string; sizeBytes: number }> },
    data: { read: "no-image" as DataReadState, maxAgeDays, databases: agesOf({ schemaVersion: 1, databases: {} }, new Date(), maxAgeDays), state: "missing" as StatusReport["data"]["state"] },
    workspace: null as StatusReport["workspace"],
    disk: { freeMb: null as number | null, managedBytes: null as number | null, volumes: [] as StatusReport["disk"]["volumes"], images: [] as StatusReport["disk"]["images"] },
  };

  if (stepMode(env) === "in-image") {
    return {
      ...base,
      mode: "in-image",
      ready: true,
      engine: { state: "ready", runtime: "-", ...EMPTY_FACTS },
      image: { ...base.image, state: "ready", id: null, version: options.version },
      reasons: [],
      warnings: [],
    };
  }

  const detection = await detectEngine({ requiredDiskMb: 1 }, context);
  const engineBlock = engineReason(detection, locale);
  const facts = detection.facts;
  const engine: StatusReport["engine"] = {
    state: detection.code ? (ENGINE_STATE[detection.code] ?? "ready") : "ready",
    runtime: context.runtime ?? "docker",
    serverVersion: facts.serverVersion,
    os: facts.os,
    arch: facts.arch,
    memoryMb: facts.memoryMb,
    cpus: facts.cpus,
  };
  const reasons: LifecycleReason[] = [];
  const warnings: LifecycleReason[] = [];
  if (engineBlock) reasons.push(engineBlock);
  const disk = { ...base.disk, freeMb: facts.diskFreeMb };
  if (engine.state === "not-installed" || engine.state === "stopped" || engine.state === "unsupported") {
    return { ...base, mode: "container", ready: false, engine, image: { ...base.image, state: "unknown", id: null, version: null }, disk, reasons, warnings };
  }

  const found = inspectImageSync(target.reference, context);
  let imageState: ImageState = "ready";
  const version = found?.labels[IMAGE_VERSION_LABEL] ?? null;
  if (!found) {
    imageState = "missing";
    const r = resolveReason("IMAGE_MISSING", { size: formatBytes(pin.sizeBytes, locale), reference: target.reference }, locale);
    reasons.push({ code: "IMAGE_MISSING", message: r.message, action: r.action, details: `image ${target.reference} is not in the engine` });
  } else if (version !== options.version) {
    imageState = "version-mismatch";
    const r = resolveReason("IMAGE_VERSION_MISMATCH", { actual: version ?? "?", expected: options.version, reference: target.reference }, locale);
    reasons.push({ code: "IMAGE_VERSION_MISMATCH", message: r.message, action: r.action, details: `${target.reference} (${found.id})` });
  }

  // Data: read with one helper container, only when the image exists to run it.
  let data = base.data;
  if (found) {
    const read = readDataStatusSync(env, options.version);
    const databases = agesOf(read.status, new Date(), maxAgeDays);
    data = { read: read.state, maxAgeDays, databases, state: databases.some((d) => d.state === "missing") ? "missing" : databases.some((d) => d.state === "stale") ? "stale" : "fresh" };
  }
  for (const d of data.databases) {
    if (d.state === "missing") warnings.push(withAction("DATA_MISSING", { database: DATABASES[d.id].tool }, locale));
    else if (d.state === "stale") warnings.push(withAction("DATA_STALE", { database: DATABASES[d.id].tool, days: d.ageDays ?? 0, max: data.maxAgeDays }, locale));
  }

  // Disk use of what JGates created, by label.
  try {
    const usage = await managedUsage({}, context);
    disk.managedBytes = usage.totalBytes;
    disk.volumes = usage.volumes.map((v) => ({ name: v.name, sizeBytes: v.sizeBytes }));
    disk.images = usage.images.map((i) => ({ name: i.name, sizeBytes: i.sizeBytes }));
  } catch {
    disk.managedBytes = null;
  }
  let extension = base.extension;
  try {
    extension = { images: (await listManaged("image", { kind: "extension-image" }, context)).map((i) => ({ name: i.name, sizeBytes: i.sizeBytes ?? 0 })) };
  } catch {
    extension = base.extension;
  }

  let workspace: StatusReport["workspace"] = null;
  if (projectDir && !options.light) {
    try {
      const summary = await dependencySummary(projectDir, env, context, found?.id ?? null);
      let running = 0;
      try {
        running = (await listManaged("container", { kind: "services", workspace: summary.id }, context)).filter((c) => c.state === "running").length;
      } catch {
        running = 0;
      }
      workspace = { id: summary.id, path: path.resolve(projectDir), dependencies: summary.dependencies, services: { running } };
    } catch {
      workspace = null;
    }
  }

  const blocking = reasons.length > 0;
  return {
    ...base,
    mode: "container",
    ready: !blocking,
    engine,
    image: { ...base.image, state: imageState, id: found?.id ?? null, version },
    extension,
    data,
    workspace,
    disk,
    reasons,
    warnings,
  };
}

function withAction(code: string, params: Record<string, string | number>, locale?: string): LifecycleReason {
  const r = resolveReason(code, params, locale);
  return { code, message: r.message, action: r.action };
}
