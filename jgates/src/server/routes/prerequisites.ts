// Prerequisites: what has to be in place before a validation runs (Docker, Git's trust in the folder, the tools JGates
// installs), shown on top of the Overview and the Environment, and the action of each one after a confirmation.
import { fixPrerequisite, listPrerequisites, PrerequisiteError } from "../../core/prerequisites/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition } from "../types.js";

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/prerequisites",
    handler({ server }) {
      return { status: 200, json: { schemaVersion: 1, status: "OK", ...listPrerequisites(server.projectDir) } };
    },
  },
  {
    // The body names one item of the list; the UI sends it only after the person confirmed the commands it showed.
    method: "POST",
    path: "/api/prerequisites/fix",
    body: {
      type: "object",
      properties: { id: { type: "string", enum: ["docker", "git", "tools"] } },
      required: ["id"],
      additionalProperties: false,
    },
    // Installing the Python tools downloads packages: allow the time pip may take.
    timeoutMs: 600_000,
    async handler({ body, server }) {
      const { id } = body as { id: string };
      try {
        const outcome = await fixPrerequisite(server.projectDir, id);
        server.log(`prerequisite ${id} ${outcome.status}`);
        return { status: 200, json: { schemaVersion: 1, status: "OK", outcome, ...listPrerequisites(server.projectDir) } };
      } catch (error) {
        if (error instanceof PrerequisiteError) {
          throw new HttpError(error.code === "PREREQUISITE_NOT_FOUND" ? 404 : 422, error.code, error.message, null);
        }
        throw error;
      }
    },
  },
];
