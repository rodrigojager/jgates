// Environment: the same diagnosis as `jgates doctor` and the explicit preparation step ("Preparar").
import { PrepareError, diagnoseEnvironment, prepareInstance, previewPrepare } from "../../core/prepare/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition } from "../types.js";
import { ID_PATTERN } from "./tools.js";

const STATUS_FOR: Record<string, number> = { INSTANCE_NOT_FOUND: 404, PREPARE_NOT_SUPPORTED: 422, VERSION_DOWNGRADE: 409, IMAGE_NOT_FOUND: 422, RUNTIME_MISSING: 422 };

function toHttp(error: PrepareError): HttpError {
  return new HttpError(STATUS_FOR[error.code] ?? 422, error.code, error.message, error.fix, error.details);
}

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/environment",
    handler({ server }) {
      return { status: 200, json: { status: "OK", ...diagnoseEnvironment(server.projectDir) } };
    },
  },
  {
    // dryRun (the default) only shows versions and network; false downloads, stores and pins.
    method: "POST",
    path: "/api/environment/prepare",
    body: {
      type: "object",
      properties: {
        instance: { type: "string", pattern: ID_PATTERN },
        dryRun: { type: "boolean" },
        allowVersionChange: { type: "boolean" },
        image: { type: "string", minLength: 1, maxLength: 512 },
      },
      required: ["instance"],
      additionalProperties: false,
    },
    timeoutMs: 180_000,
    async handler({ body, server }) {
      const input = body as { instance: string; dryRun?: boolean; allowVersionChange?: boolean; image?: string };
      const options = input.image ? { image: input.image } : {};
      try {
        const preview = previewPrepare(server.projectDir, input.instance, options);
        if (input.dryRun !== false) return { status: 200, json: { schemaVersion: 1, status: "OK", dryRun: true, preview } };
        const result = await prepareInstance(server.projectDir, input.instance, { ...options, allowVersionChange: input.allowVersionChange === true });
        server.log(`prepare ${input.instance} ${result.image ? result.image.pinned : (result.rules?.hash ?? "-")}`);
        return { status: 200, json: { schemaVersion: 1, status: "OK", dryRun: false, preview, result, environment: diagnoseEnvironment(server.projectDir) } };
      } catch (error) {
        if (error instanceof PrepareError) throw toHttp(error);
        throw error;
      }
    },
  },
];
