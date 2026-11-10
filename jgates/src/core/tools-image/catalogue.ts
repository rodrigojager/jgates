// The tools of the JGates tools image, read without starting anything (container-first, ADR-0004): inside the image
// from /etc/jgates/image.json (in-image mode), on the host from the package's mirror of the pinned image's image.json
// (release/image-tools.json, rewritten by `npm run image:build`). A probe never spawns a tool to learn its version:
// the image records it. The one exception is an explicit JGATES_<TOOL> override inside the image (advanced CI setups),
// whose executable the adapter's own probe still asks; outside the image an override is ignored, since no tool ever
// runs as a host process.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { imageJsonPath, readImageJson, stepMode } from "../runner/in-image.js";
import { findOnPath } from "../runner/path-lookup.js";

export interface ImageToolCatalogue {
  /** image: /etc/jgates/image.json of the image this process runs in; release: the package's mirror of the pinned image. */
  source: "image" | "release";
  file: string;
  imageVersion: string | null;
  /** Tool name (the adapters' manifest toolName) -> version. */
  tools: Record<string, string>;
}

/** The mirror of the pinned image's image.json that ships in the package (jgates/release/image-tools.json). */
export function releaseToolsFile(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "release", "image-tools.json");
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function stringTools(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRecord(raw)) for (const [name, version] of Object.entries(raw)) if (typeof version === "string" && version.trim() !== "") out[name] = version.trim();
  return out;
}

let releaseCache: { file: string; mtimeMs: number; catalogue: ImageToolCatalogue | null } | null = null;

function readRelease(file: string): ImageToolCatalogue | null {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  if (releaseCache && releaseCache.file === file && releaseCache.mtimeMs === mtimeMs) return releaseCache.catalogue;
  let catalogue: ImageToolCatalogue | null = null;
  try {
    const doc: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (isRecord(doc)) catalogue = { source: "release", file, imageVersion: typeof doc.imageVersion === "string" ? doc.imageVersion : null, tools: stringTools(doc.tools) };
  } catch {
    catalogue = null;
  }
  releaseCache = { file, mtimeMs, catalogue };
  return catalogue;
}

/** The tools the image has: this image's own image.json in in-image mode, the pinned image's mirror on the host. */
export function imageToolCatalogue(env: NodeJS.ProcessEnv = process.env): ImageToolCatalogue | null {
  const own = readImageJson(env);
  if (own) return { source: "image", file: imageJsonPath(env), imageVersion: typeof own.imageVersion === "string" ? own.imageVersion : null, tools: stringTools(own.tools) };
  return readRelease(releaseToolsFile());
}

/** Adapter tool names that are not tools of the image: JGates's own checks, the user's command, the per-stack compiler
 * (build-check probes each compiler under its own name) and CodeQL, which is customer supplied and lives in its own
 * volume (its absence is CUSTOMER_SUPPLIED, fixed by `jgates tools prepare-codeql`, never TOOL_MISSING), and Jest,
 * which is the project's own dev dependency (installed into the dependency volume). */
export const NOT_IMAGE_TOOLS: ReadonlySet<string> = new Set(["compiler", "formatter", "jgates-file-size", "generic-command", "quality-gate", "quality-sidecar-pii", "jgates-supply-chain", "codeql", "jest"]);

/** The command of a tool on the image's PATH, where it differs from the tool's image.json name. */
const IMAGE_COMMANDS: Readonly<Record<string, string>> = {
  "import-linter": "lint-imports",
  "dependency-cruiser": "depcruise",
  typescript: "tsc",
  schemathesis: "st",
  "quality-sidecar": "quality-sidecar",
  zap: "zap.sh",
};

export function imageCommand(tool: string): string {
  return IMAGE_COMMANDS[tool] ?? tool;
}

/** Semantic versions have three parts; image.json keeps a tool's own form ("2.16" for Import Linter). */
export function normalizeToolVersion(version: string): string {
  const v = version.replace(/^v/, "");
  return /^\d+\.\d+$/.test(v) ? `${v}.0` : v;
}

export interface ImageToolProbe {
  /** The tool's command inside the image, or null when the image does not have it. */
  executable: string | null;
  version: string | null;
  problem: "not_found" | null;
  detail: string;
}

/** Whether the image has the tool, and its version, from image.json. Starts nothing. */
export function probeImageTool(tool: string, env: NodeJS.ProcessEnv = process.env): ImageToolProbe {
  const catalogue = imageToolCatalogue(env);
  const version = catalogue?.tools[tool];
  if (!catalogue || version === undefined) {
    const where = catalogue ? `${catalogue.file}${catalogue.imageVersion ? `, image ${catalogue.imageVersion}` : ""}` : "image.json";
    return { executable: null, version: null, problem: "not_found", detail: `${tool} is not in the JGates tools image (${where})` };
  }
  // In the image the command is resolved on its PATH (a step's environment may not carry PATH); in a step container
  // on the host, the engine resolves the bare command inside the image.
  const command = imageCommand(tool);
  const executable = catalogue.source === "image" ? (findOnPath(command, env) ?? command) : command;
  return { executable, version: normalizeToolVersion(version), problem: null, detail: "" };
}

/** The value of a JGATES_<TOOL> override, honoured only inside the tools image; null on the host or when unset. */
export function inImageOverride(env: NodeJS.ProcessEnv, variable: string): string | null {
  const value = env[variable]?.trim();
  return value && stepMode(env) === "in-image" ? value : null;
}

/**
 * Inside the image only: the command beside the interpreter JGATES_PYTHON names (the same virtual environment), which
 * an override of the Python brings along with it; null otherwise.
 */
export function besideOverridePython(env: NodeJS.ProcessEnv, command: string): string | null {
  const python = inImageOverride(env, "JGATES_PYTHON");
  if (!python) return null;
  for (const name of process.platform === "win32" ? [`${command}.exe`, command] : [command]) {
    const candidate = path.join(path.dirname(python), name);
    try {
      if (fs.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {
      // not there
    }
  }
  return null;
}

/**
 * The image's answer for a tool, unless JGates runs inside the image and an override names another executable (one
 * of `variables`, or the tool's command beside the JGATES_PYTHON interpreter): then null, and the adapter's probe asks
 * that executable (a native process is allowed in the image).
 */
export function imageProbeUnlessOverridden(tool: string, env: NodeJS.ProcessEnv, ...variables: string[]): ImageToolProbe | null {
  if (variables.some((v) => inImageOverride(env, v) !== null)) return null;
  if (variables.length > 0 && besideOverridePython(env, imageCommand(tool)) !== null) return null;
  return probeImageTool(tool, env);
}
