// Documents by id: the browser names an instance and a binding (plus an entry of a directory binding) and the
// document service resolves the path, the root and the symlinks in the backend (never the browser).
import { DocumentError, openDocument, previewEdit, saveDocument, validateDocument, type DocumentErrorCode } from "../../core/documents/index.js";
import { HttpError, refuse } from "../http.js";
import type { RouteDefinition } from "../types.js";
import { ID_PATTERN } from "./tools.js";

// An entry is a relative path as the binding lists it: no absolute path, no backslash, no "." or ".." segment.
const ENTRY_PATTERN = "^(?![/~])(?!.*\\\\)(?!(?:.*/)?\\.{1,2}(?:/|$))(?!.*//)[^\\u0000]{1,1024}$";
const MAX_TEXT = 2 * 1024 * 1024;

const params = {
  type: "object",
  properties: { instance: { type: "string", pattern: ID_PATTERN }, binding: { type: "string", pattern: ID_PATTERN } },
  required: ["instance", "binding"],
  additionalProperties: false,
};
const entry = { type: "string", pattern: ENTRY_PATTERN };

const STATUS: Record<DocumentErrorCode, number> = {
  INSTANCE_NOT_FOUND: 404,
  BINDING_NOT_FOUND: 404,
  ENTRY_NOT_FOUND: 404,
  DOCUMENT_MISSING: 404,
  BINDING_REFUSED: 403,
  ENTRY_NOT_ALLOWED: 403,
  DOCUMENT_READ_ONLY: 403,
  BINDING_IS_DIRECTORY: 422,
  DOCUMENT_NOT_TEXT: 422,
  DOCUMENT_ENCODING: 422,
  DOCUMENT_INVALID: 422,
  DOCUMENT_EXISTS: 409,
  PATH_CHANGED: 409,
  WRITE_FAILED: 500,
  VERIFY_FAILED: 500,
};

/** Runs a document operation, turning a DocumentError into the matching HTTP refusal. */
function guarded<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof DocumentError) throw new HttpError(STATUS[error.code] ?? 400, error.code, error.message, error.fix, { details: error.details });
    throw error;
  }
}

const withEntry = (value: unknown): { entry?: string } => (typeof value === "string" ? { entry: value } : {});

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/documents/:instance/:binding",
    params,
    query: { type: "object", properties: { entry }, additionalProperties: false },
    handler({ params: p, query, server }) {
      const doc = guarded(() => openDocument(server.projectDir, p.instance as string, p.binding as string, withEntry(query.entry)));
      return { status: 200, json: { schemaVersion: 1, status: "OK", document: doc } };
    },
  },
  {
    method: "POST",
    path: "/api/documents/:instance/:binding/validate",
    params,
    maxBody: 3 * MAX_TEXT,
    body: { type: "object", properties: { text: { type: "string", maxLength: MAX_TEXT }, entry }, additionalProperties: false },
    handler({ params: p, body, server }) {
      const b = body as { text?: string; entry?: string };
      const validation = guarded(() =>
        validateDocument(server.projectDir, p.instance as string, p.binding as string, { ...withEntry(b.entry), ...(b.text !== undefined ? { text: b.text } : {}) }),
      );
      return { status: 200, json: { schemaVersion: 1, status: "OK", validation } };
    },
  },
  {
    method: "POST",
    path: "/api/documents/:instance/:binding/preview",
    params,
    maxBody: 3 * MAX_TEXT,
    body: { type: "object", properties: { text: { type: "string", maxLength: MAX_TEXT }, entry }, required: ["text"], additionalProperties: false },
    handler({ params: p, body, server }) {
      const b = body as { text: string; entry?: string };
      const preview = guarded(() => previewEdit(server.projectDir, p.instance as string, p.binding as string, { text: b.text, ...withEntry(b.entry) }));
      return { status: 200, json: { schemaVersion: 1, status: "OK", preview } };
    },
  },
  {
    method: "PUT",
    path: "/api/documents/:instance/:binding",
    params,
    maxBody: 6 * MAX_TEXT,
    body: {
      type: "object",
      properties: {
        expectedRevision: { anyOf: [{ type: "string", pattern: "^[0-9a-f]{64}$" }, { type: "null" }] },
        text: { type: "string", maxLength: MAX_TEXT },
        baseText: { type: "string", maxLength: MAX_TEXT },
        allowInvalid: { type: "boolean" },
        entry,
      },
      required: ["expectedRevision", "text"],
      additionalProperties: false,
    },
    handler({ params: p, body, server }) {
      const b = body as { expectedRevision: string | null; text: string; baseText?: string; allowInvalid?: boolean; entry?: string };
      const result = guarded(() =>
        saveDocument(server.projectDir, p.instance as string, p.binding as string, {
          expectedRevision: b.expectedRevision,
          text: b.text,
          ...(b.baseText !== undefined ? { baseText: b.baseText } : {}),
          ...(b.allowInvalid !== undefined ? { allowInvalid: b.allowInvalid } : {}),
          ...withEntry(b.entry),
        }),
      );
      if (result.status === "conflict") {
        const e = refuse(409, "REVISION_CONFLICT", {}, { ref: result.ref, identity: result.identity, conflict: result.conflict, diff: result.diff });
        throw e;
      }
      server.log(`document ${result.status} ${p.instance}/${p.binding}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", save: result } };
    },
  },
];
