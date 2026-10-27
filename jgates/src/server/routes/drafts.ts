// Drafts: the text typed in the editor and not saved, kept in the data folder (never in the project) so a reload of the
// page does not lose it. The browser names an instance and a binding; the draft only reaches the project file through
// the document service, with the revision it was typed over.
import {
  DraftError,
  discardDraft,
  draftStatusOf,
  readDraft,
  removeDraft,
  saveDraft,
  type DraftStatus,
} from "../../core/drafts/index.js";
import { DocumentError, previewEdit, saveDocument, validateText, formatOf, type DocumentErrorCode } from "../../core/documents/index.js";
import { draftsOfPlan } from "../../core/plan/index.js";
import { HttpError, refuse } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";
import { translator } from "../../i18n/index.js";
import { PLAN_HASH_PATTERN, findPlan } from "./plans.js";
import { ID_PATTERN } from "./tools.js";

const t = translator("drafts");
const ENTRY_PATTERN = "^(?![/~])(?!.*\\\\)(?!(?:.*/)?\\.{1,2}(?:/|$))(?!.*//)[^\\u0000]{1,1024}$";
const MAX_TEXT = 2 * 1024 * 1024;
const REVISION = { anyOf: [{ type: "string", pattern: "^[0-9a-f]{64}$" }, { type: "null" }] };

const params = {
  type: "object",
  properties: { instance: { type: "string", pattern: ID_PATTERN }, binding: { type: "string", pattern: ID_PATTERN } },
  required: ["instance", "binding"],
  additionalProperties: false,
};
const entry = { type: "string", pattern: ENTRY_PATTERN };

const STATUS: Partial<Record<DocumentErrorCode, number>> = {
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
};

function guarded<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof DocumentError) throw new HttpError(STATUS[error.code] ?? 500, error.code, error.message, error.fix, { details: error.details });
    if (error instanceof DraftError) throw new HttpError(error.code === "DRAFT_TOO_LARGE" ? 413 : 403, error.code, error.message, error.fix);
    throw error;
  }
}

const withEntry = (value: unknown): { entry?: string } => (typeof value === "string" ? { entry: value } : {});

/** What the browser needs of a draft: where it is, which revision it sits on and how it differs from the disk. */
function view(server: ServerContext, status: DraftStatus, includeText: boolean) {
  const { draft } = status;
  let preview: { changed: boolean; diff: string; validation: unknown } | null = null;
  if (!status.orphan) {
    try {
      const p = previewEdit(server.projectDir, draft.ref.instance, draft.ref.binding, { text: draft.text, ...(draft.ref.entry !== null ? { entry: draft.ref.entry } : {}) });
      preview = { changed: p.changed, diff: p.diff, validation: p.validation };
    } catch (error) {
      if (!(error instanceof DocumentError)) throw error;
    }
  }
  return {
    ref: draft.ref,
    relPath: draft.relPath,
    baseRevision: draft.baseRevision,
    currentRevision: status.currentRevision,
    stale: status.stale,
    orphan: status.orphan,
    updatedAt: draft.updatedAt,
    ...(includeText ? { text: draft.text } : {}),
    diff: preview?.diff ?? "",
    validation: preview?.validation ?? validateText(formatOf(draft.relPath ?? "x.txt"), draft.text),
  };
}

export const routes: RouteDefinition[] = [
  {
    // Every pending draft of the workspace; with `plan`, each one says whether that plan uses its document and with
    // which hash (the run reads exactly the saved file that hash names).
    method: "GET",
    path: "/api/drafts",
    query: { type: "object", properties: { plan: { type: "string", pattern: PLAN_HASH_PATTERN } }, additionalProperties: false },
    handler({ query, server }) {
      const plan = query.plan !== undefined ? findPlan(server, query.plan) : null;
      if (query.plan !== undefined && !plan) throw refuse(404, "PLAN_NOT_FOUND");
      const offers = draftsOfPlan(plan, server.projectDir, server.home, server.workspace.id);
      const drafts = offers.map((o) => ({ ...view(server, o, false), usedByPlan: o.usedByPlan, planSha256: o.planSha256 }));
      return { status: 200, json: { schemaVersion: 1, status: "OK", planHash: plan?.planHash ?? null, drafts } };
    },
  },
  {
    method: "GET",
    path: "/api/drafts/:instance/:binding",
    params,
    query: { type: "object", properties: { entry }, additionalProperties: false },
    handler({ params: p, query, server }) {
      const status = guarded(() => draftStatusOf(server.projectDir, server.home, server.workspace.id, p.instance as string, p.binding as string, withEntry(query.entry).entry));
      if (!status || !status.differs) return { status: 200, json: { schemaVersion: 1, status: "OK", draft: null } };
      return { status: 200, json: { schemaVersion: 1, status: "OK", draft: view(server, status, true) } };
    },
  },
  {
    method: "PUT",
    path: "/api/drafts/:instance/:binding",
    params,
    maxBody: 3 * MAX_TEXT,
    body: { type: "object", properties: { text: { type: "string", maxLength: MAX_TEXT }, baseRevision: REVISION, entry }, required: ["text", "baseRevision"], additionalProperties: false },
    handler({ params: p, body, server }) {
      const b = body as { text: string; baseRevision: string | null; entry?: string };
      const draft = guarded(() =>
        saveDraft(server.projectDir, server.home, server.workspace.id, p.instance as string, p.binding as string, { text: b.text, baseRevision: b.baseRevision, ...withEntry(b.entry) }),
      );
      return { status: 200, json: { schemaVersion: 1, status: "OK", saved: draft !== null, updatedAt: draft?.updatedAt ?? null } };
    },
  },
  {
    method: "DELETE",
    path: "/api/drafts/:instance/:binding",
    params,
    query: { type: "object", properties: { entry }, additionalProperties: false },
    handler({ params: p, query, server }) {
      const removed = guarded(() => discardDraft(server.projectDir, server.home, server.workspace.id, p.instance as string, p.binding as string, withEntry(query.entry).entry));
      return { status: 200, json: { schemaVersion: 1, status: "OK", removed } };
    },
  },
  {
    // Saves the draft into the project file with the revision it was typed over; a moved file is a conflict, and an
    // invalid text needs the explicit allowInvalid (the same choice as in the text editor).
    method: "POST",
    path: "/api/drafts/:instance/:binding/save",
    params,
    body: { type: "object", properties: { entry, allowInvalid: { type: "boolean" } }, additionalProperties: false },
    handler({ params: p, body, server }) {
      const b = body as { entry?: string; allowInvalid?: boolean };
      const instance = p.instance as string;
      const binding = p.binding as string;
      const status = guarded(() => draftStatusOf(server.projectDir, server.home, server.workspace.id, instance, binding, b.entry));
      const draft = status?.draft && readDraft(server.home, server.workspace.id, status.draft.identity);
      if (!status || !draft) throw new HttpError(404, "DRAFT_NOT_FOUND", t("drafts_not_found"), t("drafts_not_found_fix"));
      const result = guarded(() =>
        saveDocument(server.projectDir, instance, binding, {
          expectedRevision: draft.baseRevision,
          text: draft.text,
          ...(b.allowInvalid ? { allowInvalid: true } : {}),
          ...withEntry(b.entry),
        }),
      );
      if (result.status === "conflict") throw refuse(409, "REVISION_CONFLICT", {}, { ref: result.ref, identity: result.identity, conflict: result.conflict, diff: result.diff });
      removeDraft(server.home, server.workspace.id, draft.identity);
      server.log(`draft saved ${instance}/${binding}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", save: result } };
    },
  },
];
