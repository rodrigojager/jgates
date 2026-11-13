// Configuração > Imagem de extensão: the Dockerfile of the project's own image (.jgates/image/Dockerfile), its state (ready,
// outdated and why) and "Reconstruir", which runs the same build as `jgates tools build-extension`. The Dockerfile is only
// read here; it is changed in the project (or by adding an own tool). The state is read from the engine facts cache
// (ADR-0010: no engine call blocks the server) and the build is asynchronous.
import fs from "node:fs";
import { buildExtension, extensionPaths, extensionState, hasExtension, EXTENSION_DIR, EXTENSION_DOCKERFILE, type ExtensionState } from "../../core/extension/index.js";
import { withEngineFacts, invalidateEngineFacts } from "../../core/engine/facts.js";
import { workspaceId } from "../../core/ids/index.js";
import { translator } from "../../i18n/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";

const MAX_DOCKERFILE_BYTES = 256 * 1024;
const FILE = `${EXTENSION_DIR}/${EXTENSION_DOCKERFILE}`;

/** The servers that have a build running: one at a time per project. */
const building = new WeakSet<ServerContext>();

function readDockerfile(projectDir: string): { text: string; truncated: boolean; bytes: number } | null {
  if (!hasExtension(projectDir)) return null;
  const abs = extensionPaths(projectDir).dockerfile;
  const buffer = fs.readFileSync(abs);
  return { text: buffer.subarray(0, MAX_DOCKERFILE_BYTES).toString("utf8"), truncated: buffer.length > MAX_DOCKERFILE_BYTES, bytes: buffer.length };
}

async function stateOf(server: ServerContext): Promise<ExtensionState> {
  const workspace = workspaceId(server.projectDir);
  return withEngineFacts(() => extensionState({ projectDir: server.projectDir, workspace, env: process.env }), { prime: { version: server.version } });
}

async function describe(server: ServerContext): Promise<Record<string, unknown>> {
  const dockerfile = readDockerfile(server.projectDir);
  let state: ExtensionState | null = null;
  try {
    state = await stateOf(server);
  } catch {
    // The engine could not be asked: the Dockerfile is still shown, the state says it is unknown.
  }
  const t = translator("extension");
  return {
    schemaVersion: 1,
    status: "OK",
    file: FILE,
    exists: dockerfile !== null,
    dockerfile,
    state: state ? { status: state.status, cause: state.cause, tag: state.tag } : { status: dockerfile ? "unknown" : "none", cause: null, tag: null },
    building: building.has(server),
    texts: { build: t("extension_build_description") },
  };
}

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/extension",
    timeoutMs: 60_000,
    async handler({ server }) {
      return { status: 200, json: await describe(server) };
    },
  },
  {
    // "Reconstruir": the build of `jgates tools build-extension`, forced, on the synced copy of the Dockerfile's folder.
    method: "POST",
    path: "/api/extension/build",
    timeoutMs: 1_800_000,
    body: { type: "object", additionalProperties: false },
    async handler({ server }) {
      const t = translator("extension");
      if (!hasExtension(server.projectDir)) throw new HttpError(404, "NO_EXTENSION", t("extension_build_none"), t("extension_build_none_fix"));
      if (building.has(server)) throw new HttpError(409, "BUILD_RUNNING", t("extension_build_running"), t("extension_build_running_fix"));
      building.add(server);
      let outcome: Awaited<ReturnType<typeof buildExtension>>;
      try {
        outcome = await buildExtension({ projectDir: server.projectDir, workspace: workspaceId(server.projectDir), env: process.env, version: server.version, force: true });
      } finally {
        building.delete(server);
      }
      invalidateEngineFacts();
      server.log(`extension image build ${outcome.ok ? "ok" : (outcome.error?.code ?? "failed")}`);
      const code = outcome.error?.code ?? "BUILD_FAILED";
      const failure = outcome.ok
        ? null
        : {
            code,
            message:
              code === "TOOLS_IMAGE_MISSING"
                ? t("extension_build_no_tools_image")
                : code === "DOCKERFILE_BASE"
                  ? t("extension_build_base_arg")
                  : code === "ENGINE_ERROR"
                    ? t("extension_build_engine", { detail: outcome.error?.details ?? outcome.error?.message ?? "-" })
                    : t("extension_build_failed", { message: outcome.error?.message ?? "-" }),
            fix:
              code === "TOOLS_IMAGE_MISSING"
                ? t("extension_build_no_tools_image_fix")
                : code === "DOCKERFILE_BASE"
                  ? t("extension_build_base_arg_fix")
                  : t("extension_build_failed_fix", { log: outcome.logFile ?? "-" }),
            details: (outcome.error?.details ?? "").slice(-4000),
          };
      return { status: 200, json: { ...(await describe(server)), build: { ok: outcome.ok, built: outcome.built, tag: outcome.tag, logFile: outcome.logFile, removed: outcome.removed, failure } } };
    },
  },
];
