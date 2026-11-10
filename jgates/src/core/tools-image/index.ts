// The tools image this JGates needs, and the preflight that turns every engine or image problem into one plan
// blocker with a reason code and one action (ADR-0004, PLAN-image.md section 2). The pin file ships in the package
// (release/tools-image.json); until publication it holds the local image id of jgates-tools:dev.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectEngineSync, inspectImageSync, type EngineContext, type EngineDetection } from "../engine/index.js";
import { formatBytes, formatMegabytes, resolveReason, type ReasonAction } from "../reasons/index.js";

export interface ToolsImagePin {
  schemaVersion: number;
  name: string;
  /** Image reference; by digest once published. */
  reference: string;
  /** Image id until publication, the index digest after it. */
  digest: string;
  imageVersion: string;
  jgatesVersion: string;
  platform: string;
  sizeBytes: number;
  published: boolean;
}

/** The label of the image that holds the JGates version it was built for (the same value as image.json). */
export const IMAGE_VERSION_LABEL = "org.jgates.version";

/** The pin file of the package: release/ sits next to dist/ (jgates/release/tools-image.json). */
export function pinFilePath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "release", "tools-image.json");
}

export function readToolsImagePin(file: string = pinFilePath()): ToolsImagePin {
  return JSON.parse(fs.readFileSync(file, "utf8")) as ToolsImagePin;
}

export interface ToolsImageTarget {
  reference: string;
  /** env: JGATES_TOOLS_IMAGE chose it (a development image); pin: the package's pin file. */
  source: "env" | "pin";
}

/** The image to use: JGATES_TOOLS_IMAGE (for example jgates-tools:dev) wins over the pin file. */
export function toolsImageTarget(env: NodeJS.ProcessEnv = process.env, pin: ToolsImagePin = readToolsImagePin()): ToolsImageTarget {
  const override = env.JGATES_TOOLS_IMAGE?.trim();
  return override ? { reference: override, source: "env" } : { reference: pin.reference, source: "pin" };
}

/**
 * Whether the plan checks the engine and the tools image. Container-first execution is not the default yet: the
 * check is on when JGATES_TOOLS_IMAGE names an image (development) or JGATES_CONTAINER_FIRST=1 asks for the pinned one.
 */
export function toolsImageGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.JGATES_TOOLS_IMAGE?.trim()) || env.JGATES_CONTAINER_FIRST === "1";
}

export interface ToolsImageBlocker {
  code: string;
  message: string;
  action: ReasonAction;
  /** Raw engine text, for a "Details" fold; never the main text. */
  details?: string;
}

export interface ToolsImagePreflightOptions {
  env?: NodeJS.ProcessEnv;
  /** The JGates version of this CLI. */
  version: string;
  /** Memory the plan's largest step needs. */
  requiredMemoryMb?: number;
  /** Language of the texts (default: the process language). */
  locale?: string;
  pin?: ToolsImagePin;
}

const blocker = (code: string, params: Record<string, string | number>, details: string | undefined, locale: string | undefined): ToolsImageBlocker => {
  const resolved = resolveReason(code, params, locale);
  return { code, message: resolved.message, action: resolved.action, ...(details ? { details } : {}) };
};

const megabytes = formatMegabytes;

/**
 * The blockers of the engine and the tools image, at most one for the engine and a single one for the image
 * (never one per capability): engine missing or stopped, unsupported platform, low memory, low disk (only when a
 * download is needed), image missing, image of another JGates version.
 */
export function toolsImagePreflight(options: ToolsImagePreflightOptions): ToolsImageBlocker[] {
  const env = options.env ?? process.env;
  const pin = options.pin ?? readToolsImagePin();
  const target = toolsImageTarget(env, pin);
  const context: EngineContext = { runnerOptions: { parentEnv: env } };
  const locale = options.locale;
  const pinMb = pin.sizeBytes > 0 ? Math.ceil((pin.sizeBytes * 2.2) / 1_000_000) : undefined;

  const image = (): ReturnType<typeof inspectImageSync> => inspectImageSync(target.reference, context);
  // The engine first, without the disk (it only matters when a download is needed).
  const engine: EngineDetection = detectEngineSync({ ...(options.requiredMemoryMb !== undefined ? { requiredMemoryMb: options.requiredMemoryMb } : {}), requiredDiskMb: 0 }, context);
  if (engine.code === "ENGINE_NOT_INSTALLED" || engine.code === "ENGINE_STOPPED") return [blocker(engine.code, {}, engine.details, locale)];
  if (engine.code === "UNSUPPORTED_PLATFORM") return [blocker(engine.code, { platform: `${engine.facts.os ?? "?"}/${engine.facts.arch ?? "?"}` }, engine.details, locale)];
  if (engine.code === "ENGINE_LOW_MEMORY") {
    const need = options.requiredMemoryMb ?? 4096;
    return [blocker("ENGINE_LOW_MEMORY", { have: megabytes(engine.facts.memoryMb ?? 0, locale), need: megabytes(need, locale) }, engine.details, locale)];
  }

  const found = image();
  if (!found) {
    const out = [blocker("IMAGE_MISSING", { size: formatBytes(pin.sizeBytes, locale), reference: target.reference }, `image ${target.reference} is not in the engine`, locale)];
    if (pinMb !== undefined) {
      const disk = detectEngineSync({ requiredDiskMb: pinMb, requiredMemoryMb: 0 }, context);
      if (disk.code === "DISK_LOW") out.push(blocker("DISK_LOW", { missing: megabytes(pinMb - (disk.facts.diskFreeMb ?? 0), locale) }, disk.details, locale));
    }
    return out;
  }
  const actual = found.labels[IMAGE_VERSION_LABEL] ?? "?";
  if (actual !== options.version) {
    return [blocker("IMAGE_VERSION_MISMATCH", { actual, expected: options.version, reference: target.reference }, `${target.reference} (${found.id})`, locale)];
  }
  return [];
}
