// Whether the extension image of a project is built for the current key (synchronous: the plan asks it while it is built).
import { engineCommandSync, inspectImageSync, LABEL_KIND, LABEL_MANAGED, LABEL_WORKSPACE, type EngineContext } from "../engine/index.js";
import { toolsImageTarget } from "../tools-image/index.js";
import { extensionKey, extensionRepository, extensionTag, hasExtension, LABEL_EXTENSION_BASE, LABEL_EXTENSION_KEY } from "./key.js";

export type ExtensionStatus = "none" | "ready" | "outdated" | "unknown";
/** Why a built image no longer fits: nothing built yet, the files changed, or the tools image changed (a JGates update). */
export type ExtensionCause = "never-built" | "files-changed" | "base-changed";

export interface ExtensionState {
  /** The project has `.jgates/image/Dockerfile`. */
  present: boolean;
  /** none: no Dockerfile; ready: built for the current key; outdated: must be rebuilt; unknown: the tools image is not there to key on. */
  status: ExtensionStatus;
  key: string | null;
  tag: string | null;
  /** Image id of the built image when ready (the digest the plan pins). */
  digest: string | null;
  /** Image id of the tools image the key was computed on. */
  baseDigest: string | null;
  cause: ExtensionCause | null;
}

export interface ExtensionStateOptions {
  projectDir: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
  /** The tools image id when the caller already read it (null: the engine does not have the image). */
  baseDigest?: string | null;
}

const NONE: ExtensionState = { present: false, status: "none", key: null, tag: null, digest: null, baseDigest: null, cause: null };

export function extensionState(options: ExtensionStateOptions): ExtensionState {
  if (!hasExtension(options.projectDir)) return NONE;
  const context: EngineContext = { runnerOptions: { parentEnv: options.env } };
  const baseDigest = options.baseDigest !== undefined ? options.baseDigest : (inspectImageSync(toolsImageTarget(options.env).reference, context)?.id ?? null);
  if (baseDigest === null) return { ...NONE, present: true, status: "unknown" };
  const key = extensionKey(options.projectDir, baseDigest) as string;
  const tag = extensionTag(options.workspace, key);
  const built = inspectImageSync(tag, context);
  if (built && built.labels[LABEL_EXTENSION_KEY] === key) return { present: true, status: "ready", key, tag, digest: built.id, baseDigest, cause: null };
  return { present: true, status: "outdated", key, tag, digest: null, baseDigest, cause: causeOf(options.workspace, baseDigest, context) };
}

/** What the images this workspace built earlier say about why the current key has none. */
function causeOf(workspace: string, baseDigest: string, context: EngineContext): ExtensionCause {
  const listed = engineCommandSync(
    ["image", "ls", "--no-trunc", "--format", "{{json .}}", "--filter", `label=${LABEL_MANAGED}=true`, "--filter", `label=${LABEL_KIND}=extension-image`, "--filter", `label=${LABEL_WORKSPACE}=${workspace}`],
    context,
  );
  if (listed.spawnError || listed.exitCode !== 0) return "never-built";
  const repository = extensionRepository(workspace);
  const rows = listed.stdout
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l) as { ID?: string; Repository?: string; Tag?: string })
    .filter((row) => row.Repository === repository && row.ID);
  if (rows.length === 0) return "never-built";
  const bases = rows.map((row) => inspectImageSync(row.ID as string, context)?.labels[LABEL_EXTENSION_BASE]);
  return bases.some((b) => b === baseDigest) ? "files-changed" : "base-changed";
}
