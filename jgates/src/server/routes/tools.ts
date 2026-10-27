// Tool instances of the workspace with their bindings (the ids the document routes accept), the catalog of adapters,
// the area of a tool (effective configuration, rendered command), and the changes of tools.yml: create, rename and
// remove an instance, select the file of a binding, make a local override, template of a missing file.
import { toolCatalog, instanceAvailability } from "../../core/tools/catalog.js";
import { effectiveConfig } from "../../core/tools/effective.js";
import { renderExecution } from "../../core/tools/execution.js";
import { createInstance, createLocalOverride, InstanceError, removeInstance, renameInstance, setBindingPath, templateFor, type InstanceErrorCode } from "../../core/tools/instances.js";
import { DocumentError } from "../../core/documents/index.js";
import { resolveToolBindings } from "../../core/tools/index.js";
import { HttpError, refuse } from "../http.js";
import type { RouteDefinition } from "../types.js";

export const ID_PATTERN = "^[a-z0-9][a-z0-9._-]{0,127}$";

const STATUS: Record<InstanceErrorCode, number> = {
  INSTANCE_ID_INVALID: 400,
  INSTANCE_EXISTS: 409,
  INSTANCE_NOT_FOUND: 404,
  ADAPTER_UNKNOWN: 422,
  COMPONENT_UNKNOWN: 422,
  BINDING_NOT_FOUND: 404,
  BINDING_PATH_INVALID: 422,
  TOOLS_FILE_CONFLICT: 409,
  TOOLS_FILE_INVALID: 422,
  OVERRIDE_NOT_NEEDED: 409,
  OVERRIDE_EXISTS: 409,
  OVERRIDE_UNREADABLE: 422,
};

function guarded<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof InstanceError) throw new HttpError(STATUS[error.code] ?? 400, error.code, error.message, null, { details: error.details });
    // openDocument refuses an unknown instance or binding, or a link out of the root, with a DocumentError: never a 500.
    if (error instanceof DocumentError) throw new HttpError(error.code.endsWith("_NOT_FOUND") ? 404 : error.code === "BINDING_REFUSED" ? 403 : 422, error.code, error.message, error.fix, { details: error.details });
    throw error;
  }
}

const instanceParams = {
  type: "object",
  properties: { instance: { type: "string", pattern: ID_PATTERN } },
  required: ["instance"],
  additionalProperties: false,
};
const bindingParams = {
  type: "object",
  properties: { instance: { type: "string", pattern: ID_PATTERN }, binding: { type: "string", pattern: ID_PATTERN } },
  required: ["instance", "binding"],
  additionalProperties: false,
};
const relPath = { type: "string", minLength: 1, maxLength: 1024 };

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/tools",
    handler({ server }) {
      const r = resolveToolBindings(server.projectDir);
      return {
        status: 200,
        json: { schemaVersion: 1, status: "OK", ok: r.ok, configFile: r.configFile, externalRoots: r.externalRoots, instances: r.instances, documents: r.documents, diagnostics: r.diagnostics },
      };
    },
  },
  {
    method: "GET",
    path: "/api/tool-catalog",
    handler() {
      return { status: 200, json: { schemaVersion: 1, status: "OK", adapters: toolCatalog() } };
    },
  },
  {
    method: "GET",
    path: "/api/tool-availability",
    timeoutMs: 60_000,
    handler({ server }) {
      return { status: 200, json: { schemaVersion: 1, status: "OK", availability: instanceAvailability(server.projectDir) } };
    },
  },
  {
    method: "POST",
    path: "/api/tools",
    body: {
      type: "object",
      properties: { id: { type: "string", pattern: ID_PATTERN }, adapter: { type: "string", minLength: 1, maxLength: 128 }, component: { anyOf: [{ type: "string", minLength: 1, maxLength: 256 }, { type: "null" }] } },
      required: ["id", "adapter"],
      additionalProperties: false,
    },
    handler({ body, server }) {
      const b = body as { id: string; adapter: string; component?: string | null };
      const created = guarded(() => createInstance(server.projectDir, { id: b.id, adapter: b.adapter, component: b.component ?? null }));
      server.log(`tool created ${b.id}`);
      return { status: 201, json: { schemaVersion: 1, status: "OK", created } };
    },
  },
  {
    method: "GET",
    path: "/api/tools/:instance",
    params: instanceParams,
    handler({ params, server }) {
      const r = resolveToolBindings(server.projectDir);
      const instance = r.instances.find((i) => i.id === params.instance);
      if (!instance) throw refuse(404, "INSTANCE_NOT_FOUND", { name: params.instance as string });
      return { status: 200, json: { schemaVersion: 1, status: "OK", instance, diagnostics: r.diagnostics } };
    },
  },
  {
    method: "PUT",
    path: "/api/tools/:instance",
    params: instanceParams,
    body: { type: "object", properties: { name: { type: "string", pattern: ID_PATTERN } }, required: ["name"], additionalProperties: false },
    handler({ params, body, server }) {
      const renamed = guarded(() => renameInstance(server.projectDir, params.instance as string, (body as { name: string }).name));
      server.log(`tool renamed ${params.instance as string}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", renamed } };
    },
  },
  {
    method: "DELETE",
    path: "/api/tools/:instance",
    params: instanceParams,
    handler({ params, server }) {
      const removed = guarded(() => removeInstance(server.projectDir, params.instance as string));
      server.log(`tool removed ${params.instance as string}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", removed } };
    },
  },
  {
    method: "GET",
    path: "/api/tools/:instance/execution",
    params: instanceParams,
    timeoutMs: 30_000,
    handler({ params, server }) {
      const execution = renderExecution(server.projectDir, params.instance as string);
      if (!execution) throw refuse(404, "INSTANCE_NOT_FOUND", { name: params.instance as string });
      return { status: 200, json: { schemaVersion: 1, status: "OK", execution } };
    },
  },
  {
    method: "GET",
    path: "/api/tools/:instance/effective",
    params: instanceParams,
    timeoutMs: 30_000,
    async handler({ params, server }) {
      const effective = await effectiveConfig(server.projectDir, params.instance as string);
      if (!effective) throw refuse(404, "INSTANCE_NOT_FOUND", { name: params.instance as string });
      return { status: 200, json: { schemaVersion: 1, status: "OK", effective } };
    },
  },
  {
    method: "GET",
    path: "/api/tools/:instance/bindings/:binding/template",
    params: bindingParams,
    handler({ params, server }) {
      const r = resolveToolBindings(server.projectDir, { skipInventory: true });
      const instance = r.instances.find((i) => i.id === params.instance);
      if (!instance) throw refuse(404, "INSTANCE_NOT_FOUND", { name: params.instance as string });
      const binding = instance.bindings.find((b) => b.id === params.binding);
      if (!binding || binding.kind !== "file") throw new HttpError(404, "BINDING_NOT_FOUND", `The instance ${instance.id} has no file binding ${params.binding as string}.`, null);
      return { status: 200, json: { schemaVersion: 1, status: "OK", template: templateFor(instance.adapter, binding.declared) } };
    },
  },
  {
    method: "PUT",
    path: "/api/tools/:instance/bindings/:binding",
    params: bindingParams,
    body: { type: "object", properties: { path: relPath }, required: ["path"], additionalProperties: false },
    handler({ params, body, server }) {
      const changed = guarded(() => setBindingPath(server.projectDir, params.instance as string, params.binding as string, (body as { path: string }).path));
      server.log(`binding selected ${params.instance as string}/${params.binding as string}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", binding: changed } };
    },
  },
  {
    method: "POST",
    path: "/api/tools/:instance/bindings/:binding/override",
    params: bindingParams,
    body: { type: "object", properties: { path: relPath }, additionalProperties: false },
    handler({ params, body, server }) {
      const requested = (body as { path?: string }).path;
      const override = guarded(() => createLocalOverride(server.projectDir, params.instance as string, params.binding as string, requested));
      server.log(`local override ${params.instance as string}/${params.binding as string}`);
      return { status: 201, json: { schemaVersion: 1, status: "OK", override } };
    },
  },
];
