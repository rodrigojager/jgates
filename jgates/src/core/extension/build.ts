// Builds the extension image of a project: `.jgates/image/Dockerfile` on top of the tools image (build argument
// JGATES_TOOLS), tagged `jgates-ext-<ws>:<key>` with the JGates labels. A build is a preparation the user asks for, never
// part of a run, and it is the one place with a network (the Dockerfile's install lines). The engine module does the work.
import fs from "node:fs";
import path from "node:path";
import {
  engineBuild,
  engineCommand,
  engineLabels,
  inspectImage,
  pruneManaged,
  LABEL_KIND,
  LABEL_MANAGED,
  LABEL_WORKSPACE,
  type EngineContext,
} from "../engine/index.js";
import { resolveHome } from "../home/index.js";
import { toolsImageTarget } from "../tools-image/index.js";
import { BASE_ARG, extensionKey, extensionPaths, extensionRepository, extensionTag, hasExtension, LABEL_EXTENSION_BASE, LABEL_EXTENSION_KEY } from "./key.js";

export type BuildErrorCode = "NO_EXTENSION" | "TOOLS_IMAGE_MISSING" | "DOCKERFILE_BASE" | "BUILD_FAILED" | "ENGINE_ERROR";

export interface BuildExtensionOptions {
  projectDir: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
  /** JGates version, written into the image labels. */
  version: string;
  /** Called with each chunk of the build output as it arrives. */
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
  /** Rebuild even when an image for the current key exists. */
  force?: boolean;
}

export interface BuildExtensionOutcome {
  ok: boolean;
  /** false: an image for the current key was already there. */
  built: boolean;
  tag: string | null;
  key: string | null;
  /** Image id of the built image. */
  digest: string | null;
  /** The tools image the build started from (reference and id). */
  base: { reference: string; digest: string } | null;
  /** The build log on disk (null when nothing was built). */
  logFile: string | null;
  /** Tags of this workspace's earlier extension images that were removed. */
  removed: string[];
  error?: { code: BuildErrorCode; message: string; details: string };
}

const fail = (code: BuildErrorCode, message: string, details = "", partial: Partial<BuildExtensionOutcome> = {}): BuildExtensionOutcome => ({
  ok: false,
  built: false,
  tag: null,
  key: null,
  digest: null,
  base: null,
  logFile: null,
  removed: [],
  ...partial,
  error: { code, message, details },
});

/** The Dockerfile must read the tools image from the build argument, so JGates can pin it. */
export function dockerfileUsesBase(text: string): boolean {
  return new RegExp(`^\\s*ARG\\s+${BASE_ARG}\\b`, "m").test(text) && new RegExp(`^\\s*FROM\\s+\\$\\{?${BASE_ARG}\\}?(\\s|$)`, "m").test(text);
}

export async function buildExtension(options: BuildExtensionOptions): Promise<BuildExtensionOutcome> {
  const context: EngineContext = { runnerOptions: { parentEnv: options.env } };
  if (!hasExtension(options.projectDir)) return fail("NO_EXTENSION", "no .jgates/image/Dockerfile");
  const { dir, dockerfile } = extensionPaths(options.projectDir);
  if (!dockerfileUsesBase(fs.readFileSync(dockerfile, "utf8"))) return fail("DOCKERFILE_BASE", `the Dockerfile must start with ARG ${BASE_ARG} and FROM \${${BASE_ARG}}`);
  try {
    const reference = toolsImageTarget(options.env).reference;
    const base = await inspectImage(reference, context);
    if (!base) return fail("TOOLS_IMAGE_MISSING", `the tools image ${reference} is not in the engine`);
    const key = extensionKey(options.projectDir, base.id) as string;
    const tag = extensionTag(options.workspace, key);
    const common = { tag, key, digest: null, base: { reference, digest: base.id } };
    const existing = await inspectImage(tag, context);
    if (existing && existing.labels[LABEL_EXTENSION_KEY] === key && options.force !== true) {
      return { ok: true, built: false, ...common, digest: existing.id, logFile: null, removed: [] };
    }

    const logFile = path.join(resolveHome({ env: options.env }), "workspaces", options.workspace, "logs", "extension-build.log");
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(logFile, "", { mode: 0o600 });
    const result = await engineBuild(
      {
        contextDir: dir,
        tag,
        buildArgs: { [BASE_ARG]: reference },
        labels: {
          ...engineLabels({ kind: "extension-image", version: options.version, workspace: options.workspace }),
          [LABEL_EXTENSION_KEY]: key,
          [LABEL_EXTENSION_BASE]: base.id,
        },
        onOutput: (chunk) => {
          fs.appendFileSync(logFile, chunk);
          options.onOutput?.(chunk);
        },
        ...(options.signal ? { signal: options.signal } : {}),
      },
      context,
    );
    if (result.spawnError) return fail("ENGINE_ERROR", "the engine could not be started", result.spawnError.message, { ...common, logFile });
    if (result.exitCode !== 0) {
      const tail = `${result.stderr}\n${result.stdout}`.trim().split(/\r?\n/).slice(-20).join("\n");
      return fail("BUILD_FAILED", `the build ended with exit code ${result.exitCode ?? "-"}`, tail, { ...common, logFile });
    }
    const built = await inspectImage(tag, context);
    if (!built) return fail("BUILD_FAILED", "the build ended but the image is not there", "", { ...common, logFile });

    // The earlier images of this workspace (other keys) are of no use now: untag them, then prune what became dangling.
    const removed = await removeOtherTags(options.workspace, tag, context);
    await pruneManaged(["image"], {}, context);
    return { ok: true, built: true, ...common, digest: built.id, logFile, removed };
  } catch (error) {
    return fail("ENGINE_ERROR", "the engine failed", error instanceof Error ? `${error.message}${"details" in error ? `: ${String((error as { details: unknown }).details)}` : ""}` : String(error));
  }
}

async function removeOtherTags(workspace: string, keep: string, context: EngineContext): Promise<string[]> {
  const listed = await engineCommand(
    ["image", "ls", "--no-trunc", "--format", "{{json .}}", "--filter", `label=${LABEL_MANAGED}=true`, "--filter", `label=${LABEL_KIND}=extension-image`, "--filter", `label=${LABEL_WORKSPACE}=${workspace}`],
    context,
  );
  if (listed.spawnError || listed.exitCode !== 0) return [];
  const repository = extensionRepository(workspace);
  const tags = listed.stdout
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l) as { Repository?: string; Tag?: string })
    .filter((row) => row.Repository === repository && row.Tag && row.Tag !== "<none>")
    .map((row) => `${row.Repository}:${row.Tag}`)
    .filter((ref) => ref !== keep);
  const removed: string[] = [];
  for (const ref of tags) {
    const gone = await engineCommand(["image", "rm", ref], context, 60_000);
    if (!gone.spawnError && gone.exitCode === 0) removed.push(ref);
  }
  return removed;
}
