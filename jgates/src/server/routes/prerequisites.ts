// Prerequisites: what has to be in place before a validation runs (the container engine, the JGates tools image, Git's
// trust in the folder, an instance's data), shown on top of the Overview and the Environment, and the action of each
// one after a confirmation. No tool is ever installed on the host (container-first). The engine and Git answers come
// from the cached facts (core/engine/facts.ts): reading the list never blocks the server.
import { withEngineFacts, invalidateEngineFacts, invalidateGitFacts } from "../../core/engine/facts.js";
import { assessEnvironment } from "../../core/install/index.js";
import { fixPrerequisite, listPrerequisites, PrerequisiteError, type Prerequisite } from "../../core/prerequisites/index.js";
import { refreshPath, refreshPathAsync } from "../../core/env-refresh/index.js";
import { HttpError } from "../http.js";
import { collectStatus } from "../../core/lifecycle/index.js";
import { readinessOf } from "./environment.js";
import type { RouteDefinition, ServerContext } from "../types.js";

/**
 * Where the person fixes an item: a UI route (without the leading "#/"), or null when the item is fixed in place (the
 * confirmation dialog runs it). CodeQL (customer supplied) is prepared in Ambiente, at its own section.
 */
export function routeOf(item: Prerequisite): string | null {
  if (item.id === "docker") return "environment?section=engine";
  if (item.id === "image") return "environment?section=image";
  if (item.id === "data") return "environment?section=data";
  if (item.kind !== "manual") return null;
  if (item.id.startsWith("manual:runtime:")) return "environment?section=engine";
  return item.names.some((n) => /codeql/i.test(n)) || /codeql/i.test(item.id) ? "environment?section=codeql" : "tools";
}

/** Every item carries its action route; an item with a route no longer asks the person to copy a command. */
export function withRoutes<T extends { items: Prerequisite[] }>(list: T): T & { items: Array<Prerequisite & { route: string | null }> } {
  return {
    ...list,
    items: list.items.map((item) => {
      const route = routeOf(item);
      if (route === null) return { ...item, route };
      return { ...item, route, action: item.action === "copy" ? null : item.action, fix: item.kind === "manual" ? null : item.fix };
    }),
  };
}

const listOf = async (server: ServerContext) => withRoutes(await withEngineFacts(() => listPrerequisites(server.projectDir), { prime: { version: server.version, gitDir: server.projectDir } }));

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/prerequisites",
    timeoutMs: 120_000,
    async handler({ server }) {
      if (!server.policyMode) await refreshPathAsync();
      const list = await listOf(server);
      // The one definition of ready (engine, image, data, dependencies: routes/environment.ts) decides, next to the
      // essential items of this list; the doctor card says "ready" only when both agree.
      // Only the status is read (no CodeQL volume read, which would block the server).
      const env = readinessOf(await withEngineFacts(() => collectStatus({ env: process.env, version: server.version, projectDir: server.projectDir }), { prime: { version: server.version } }));
      return { status: 200, json: { schemaVersion: 1, status: "OK", ...list, ready: list.ready && env.ready, notReady: env.notReady } };
    },
  },
  {
    // The body names one item of the list; the UI sends it only after the person confirmed the commands it showed.
    method: "POST",
    path: "/api/prerequisites/fix",
    body: {
      type: "object",
      properties: { id: { type: "string", enum: ["docker", "image", "git", "data"] } },
      required: ["id"],
      additionalProperties: false,
    },
    // Downloading the tools image takes a while: allow the time a pull may take.
    timeoutMs: 1_800_000,
    async handler({ body, server }) {
      const { id } = body as { id: string };
      if (!server.policyMode) refreshPath({ force: true });
      // The assessment is read from the facts (it may be computed more than once); the fix itself runs once, outside.
      const assessment = await withEngineFacts(() => assessEnvironment(server.projectDir), { prime: { version: server.version, gitDir: server.projectDir } });
      let outcome;
      try {
        outcome = await fixPrerequisite(server.projectDir, id, { assessment });
      } catch (error) {
        if (error instanceof PrerequisiteError) {
          throw new HttpError(error.code === "PREREQUISITE_NOT_FOUND" ? 404 : 422, error.code, error.message, null);
        }
        throw error;
      } finally {
        // Whatever the fix did (an engine started, an image pulled, a folder trusted), the next reads ask again.
        invalidateEngineFacts();
        invalidateGitFacts();
      }
      server.log(`prerequisite ${id} ${outcome.status}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", outcome, ...(await listOf(server)) } };
    },
  },
];
