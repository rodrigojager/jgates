// Forms by instance id (Options tab): the browser sends field intents, never a path or a whole document. The backend
// resolves the binding, applies the intents as a minimal patch through the codec and saves through the document
// service with the revision the form was read from.
//
// Derived forms (/api/forms/derived/..., ADR-0009): forms built from the configuration schemas and from the files as
// they are, for every configuration file, every adapter's settings and every tool instance, and a write of one key at a
// time with a revision check and a preview. The effective configuration they read origins from is the server's cached
// one (ADR-0010: no engine, no git in a handler).
import path from "node:path";
import { cachedProject, projectInventory, projectResolve } from "../../core/cache/project.js";
import { resolveConfig, type ResolveResult } from "../../core/config/resolve/index.js";
import { getLocale } from "../../i18n/index.js";
import { DocumentError } from "../../core/documents/index.js";
import { FormError, derived, openForm, previewForm, saveForm, type FormErrorCode } from "../../core/forms/index.js";
import { HttpError, refuse } from "../http.js";
import { modeOf } from "../policy-mode.js";
import type { RouteDefinition, ServerContext } from "../types.js";
import { ID_PATTERN } from "./tools.js";

const CONFIG_FILE_PATTERN = "^(jgates\\.yml|\\.jgates/(templates/)?[A-Za-z0-9][A-Za-z0-9._-]*\\.ya?ml|\\.jgates/lock\\.json)$";
const WRITABLE_FILE_PATTERN = "^(jgates\\.yml|\\.jgates/(templates/)?[A-Za-z0-9][A-Za-z0-9._-]*\\.ya?ml)$";
const HASH = "^[0-9a-f]{64}$";

const DERIVED_STATUS: Record<derived.DerivedFormErrorCode, number> = {
  FILE_NOT_CONFIG: 400,
  FILE_OUTSIDE_PROJECT: 403,
  FILE_GENERATED: 403,
  FILE_MISSING: 404,
  FILE_PARSE: 422,
  REVISION_CONFLICT: 409,
  EDIT_INVALID: 422,
  EDIT_FAILED: 422,
  PATH_INVALID: 400,
  VALUE_MISSING: 400,
  VALUE_YAML_INVALID: 400,
  INSTANCE_NOT_FOUND: 404,
  SCHEMA_NOT_FOUND: 404,
  ADAPTER_NOT_FOUND: 404,
};

async function derivedGuard<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof derived.DerivedFormError) throw new HttpError(DERIVED_STATUS[error.code] ?? 400, error.code, error.message, error.fix, error.details);
    throw error;
  }
}

/**
 * The effective configuration from the server's cache; null when it cannot be computed (the forms still work). A file
 * with a key the schema does not know makes the configuration invalid: the forms then read a lenient resolution (what
 * the files hold), so the values a file inherits still show while the person fixes it.
 */
function resolvedOf(server: ServerContext): ResolveResult | null {
  const dir = server.projectDir;
  try {
    const strict = projectResolve(dir);
    if (strict.ok) return strict;
    return cachedProject(`forms-resolve:${getLocale()}`, [path.resolve(dir)], () => resolveConfig(dir, { lenient: true, inventory: projectInventory(dir) }));
  } catch {
    return null;
  }
}

const editable = () => modeOf().mode !== "governed";

const keyEditBody = {
  type: "object",
  properties: {
    file: { type: "string", pattern: WRITABLE_FILE_PATTERN, maxLength: 256 },
    path: { type: "array", minItems: 1, maxItems: 32, items: { anyOf: [{ type: "string", minLength: 1, maxLength: 256 }, { type: "integer", minimum: 0 }] } },
    op: { enum: ["set", "remove"] },
    value: {},
    yaml: { type: "string", maxLength: 65536 },
    expectedRevision: { anyOf: [{ type: "string", pattern: HASH }, { type: "null" }] },
  },
  required: ["file", "path", "op", "expectedRevision"],
  additionalProperties: false,
};

const derivedRoutes: RouteDefinition[] = [
  {
    // What has a form: the schemas, the adapters (with their hand-written overlay or native-file form), the
    // configuration files of the project and its tool instances (hasForm is true for every one).
    method: "GET",
    path: "/api/forms/derived/index",
    timeoutMs: 30_000,
    async handler({ server }) {
      const index = await derivedGuard(() => derived.formsIndex(server.projectDir, { resolved: resolvedOf(server), editable: editable() }));
      return { status: 200, json: { ...index, status: "OK" } };
    },
  },
  {
    // ?schema=jgates.schema.json: the form of a configuration schema; ?adapter=zap: the settings form of an adapter.
    method: "GET",
    path: "/api/forms/derived/schema",
    query: {
      type: "object",
      properties: { schema: { type: "string", pattern: "^[a-z0-9-]+\\.schema\\.json$" }, adapter: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" } },
      additionalProperties: false,
      maxProperties: 1,
    },
    async handler({ query, server }) {
      const q = query as { schema?: string; adapter?: string };
      if (q.schema) return { status: 200, json: { status: "OK", form: await derivedGuard(() => derived.schemaForm(q.schema as string)) } };
      if (q.adapter) return { status: 200, json: { status: "OK", form: await derivedGuard(() => derived.adapterSchemaForm(q.adapter as string)) } };
      const index = derived.configSchemas();
      return { status: 200, json: { schemaVersion: 1, status: "OK", schemas: index, adapters: (await derived.formsIndex(server.projectDir, { editable: editable() })).adapters } };
    },
  },
  {
    method: "GET",
    path: "/api/forms/derived/file",
    query: { type: "object", properties: { file: { type: "string", pattern: CONFIG_FILE_PATTERN, maxLength: 256 } }, required: ["file"], additionalProperties: false },
    timeoutMs: 30_000,
    async handler({ query, server }) {
      const form = await derivedGuard(() => derived.openFileForm(server.projectDir, (query as { file: string }).file, { resolved: resolvedOf(server), editable: editable() }));
      return { status: 200, json: { status: "OK", form } };
    },
  },
  {
    method: "GET",
    path: "/api/forms/derived/instance/:instance",
    params: { type: "object", properties: { instance: { type: "string", pattern: ID_PATTERN } }, required: ["instance"], additionalProperties: false },
    timeoutMs: 30_000,
    async handler({ params: p, server }) {
      const form = await derivedGuard(() => derived.openInstanceForm(server.projectDir, p.instance as string, { resolved: resolvedOf(server), editable: editable() }));
      return { status: 200, json: { status: "OK", form } };
    },
  },
  {
    // The diff of one key edit and the problems it would bring; nothing is written.
    method: "POST",
    path: "/api/forms/derived/key/preview",
    body: keyEditBody,
    timeoutMs: 30_000,
    async handler({ body, server }) {
      const preview = await derivedGuard(() => derived.previewKeyEdit(server.projectDir, body as derived.KeyEditRequest, { resolved: resolvedOf(server) }));
      return { status: 200, json: { schemaVersion: 1, status: "OK", preview } };
    },
  },
  {
    // Sets or removes one key of one file, with the revision the form was read from.
    method: "PUT",
    path: "/api/forms/derived/key",
    body: keyEditBody,
    timeoutMs: 30_000,
    async handler({ body, server }) {
      const request = body as derived.KeyEditRequest;
      const save = await derivedGuard(() => derived.saveKeyEdit(server.projectDir, request, { resolved: resolvedOf(server) }));
      server.log(`form key ${save.status} ${request.file} ${request.op}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", save } };
    },
  },
];

const params = {
  type: "object",
  properties: { instance: { type: "string", pattern: ID_PATTERN } },
  required: ["instance"],
  additionalProperties: false,
};

const intents = {
  type: "array",
  maxItems: 200,
  items: {
    oneOf: [
      {
        type: "object",
        properties: { field: { type: "string", minLength: 1, maxLength: 256 }, op: { const: "set" }, value: {} },
        required: ["field", "op", "value"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { field: { type: "string", minLength: 1, maxLength: 256 }, op: { const: "inherit" } },
        required: ["field", "op"],
        additionalProperties: false,
      },
    ],
  },
};

const body = {
  type: "object",
  properties: {
    expectedRevision: { anyOf: [{ type: "string", pattern: "^[0-9a-f]{64}$" }, { type: "null" }] },
    intents,
  },
  required: ["expectedRevision", "intents"],
  additionalProperties: false,
};

const FORM_STATUS: Record<FormErrorCode, number> = {
  INSTANCE_NOT_FOUND: 404,
  FORM_NOT_FOUND: 404,
  FORM_NO_DOCUMENT: 422,
  FORM_UNAVAILABLE: 422,
  FORM_READ_ONLY: 403,
  FORM_FIELD_UNKNOWN: 400,
  FORM_FIELD_UNRECOGNIZED: 409,
  FORM_VALUE_INVALID: 422,
  FORM_PATCH_FAILED: 422,
};

const DOCUMENT_STATUS: Record<string, number> = {
  INSTANCE_NOT_FOUND: 404,
  BINDING_NOT_FOUND: 404,
  DOCUMENT_MISSING: 404,
  BINDING_REFUSED: 403,
  DOCUMENT_READ_ONLY: 403,
  DOCUMENT_NOT_TEXT: 422,
  DOCUMENT_ENCODING: 422,
  DOCUMENT_INVALID: 422,
  PATH_CHANGED: 409,
};

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof FormError) throw new HttpError(FORM_STATUS[error.code] ?? 400, error.code, error.message, error.fix, { details: error.details });
    if (error instanceof DocumentError) throw new HttpError(DOCUMENT_STATUS[error.code] ?? 500, error.code, error.message, error.fix, { details: error.details });
    throw error;
  }
}

export const routes: RouteDefinition[] = [
  ...derivedRoutes,
  {
    method: "GET",
    path: "/api/forms/:instance",
    params,
    timeoutMs: 30_000,
    async handler({ params: p, server }) {
      const form = await guarded(() => openForm(server.projectDir, p.instance as string));
      return { status: 200, json: { schemaVersion: 1, status: "OK", form } };
    },
  },
  {
    method: "POST",
    path: "/api/forms/:instance/preview",
    params,
    body,
    timeoutMs: 30_000,
    async handler({ params: p, body: b, server }) {
      const request = b as { expectedRevision: string | null; intents: never[] };
      const preview = await guarded(() => previewForm(server.projectDir, p.instance as string, request));
      if (preview.status === "conflict") throw refuse(409, "REVISION_CONFLICT", {}, { conflict: preview });
      return { status: 200, json: { schemaVersion: 1, status: "OK", preview } };
    },
  },
  {
    method: "PUT",
    path: "/api/forms/:instance",
    params,
    body,
    timeoutMs: 30_000,
    async handler({ params: p, body: b, server }) {
      const request = b as { expectedRevision: string | null; intents: never[] };
      const save = await guarded(() => saveForm(server.projectDir, p.instance as string, request));
      if (save.status === "conflict") throw refuse(409, "REVISION_CONFLICT", {}, { conflict: save });
      server.log(`form ${save.status} ${p.instance as string}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", save } };
    },
  },
];
