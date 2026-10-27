// Forms by instance id (Options tab): the browser sends field intents, never a path or a whole document. The backend
// resolves the binding, applies the intents as a minimal patch through the codec and saves through the document
// service with the revision the form was read from.
import { DocumentError } from "../../core/documents/index.js";
import { FormError, openForm, previewForm, saveForm, type FormErrorCode } from "../../core/forms/index.js";
import { HttpError, refuse } from "../http.js";
import type { RouteDefinition } from "../types.js";
import { ID_PATTERN } from "./tools.js";

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
