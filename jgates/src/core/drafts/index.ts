import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { DocumentError, openDocument, type DocumentRef } from "../documents/index.js";
import { ensureWorkspaceDirs, workspaceDir } from "../home/index.js";

/**
 * Drafts: the text a person typed and did not save. A draft lives in the data
 * folder, <JGATES_HOME>/workspaces/<id>/drafts/<hash of the document identity>.json (0600, folder 0700), one per physical
 * document, with the revision of the file it was typed over. Writing a draft never touches the project: the file only
 * changes when the person saves it through the document service.
 */

export const DRAFTS_DIR = "drafts";
export const DRAFT_SCHEMA_VERSION = 1;
/** Same limit as the document service. */
export const MAX_DRAFT_BYTES = 2 * 1024 * 1024;

const t = translator("drafts");

export type DraftErrorCode = "DRAFT_TOO_LARGE" | "DRAFT_NOT_EDITABLE";

export class DraftError extends Error {
  constructor(
    readonly code: DraftErrorCode,
    message: string,
    readonly fix: string | null = null,
  ) {
    super(message);
    this.name = "DraftError";
  }
}

export interface Draft {
  schemaVersion: 1;
  ref: DocumentRef;
  /** Canonical real path of the document: the key of the draft. */
  identity: string;
  /** Workspace-relative path with forward slashes (null under an external root). */
  relPath: string | null;
  /** Revision (sha256 of the bytes) of the file the text was typed over; null when the file did not exist. */
  baseRevision: string | null;
  text: string;
  updatedAt: string;
}

export interface DraftStatus {
  draft: Draft;
  /** Revision of the file on disk now (null when absent). */
  currentRevision: string | null;
  /** The file changed since the draft was typed (the draft is still kept). */
  stale: boolean;
  /** The draft text is not what is on disk (a draft equal to the disk is dropped, so this is normally true). */
  differs: boolean;
  /** The document could not be opened any more (binding removed, file now outside the roots...). */
  orphan: boolean;
}

export function draftsDir(home: string, wsId: string): string {
  return path.join(workspaceDir(home, wsId), DRAFTS_DIR);
}

const keyOf = (identity: string): string => crypto.createHash("sha256").update(identity).digest("hex").slice(0, 40);

export function draftFile(home: string, wsId: string, identity: string): string {
  return path.join(draftsDir(home, wsId), `${keyOf(identity)}.json`);
}

function isDraft(value: unknown): value is Draft {
  if (value === null || typeof value !== "object") return false;
  const d = value as Draft;
  return d.schemaVersion === DRAFT_SCHEMA_VERSION && typeof d.identity === "string" && typeof d.text === "string" && typeof d.ref?.instance === "string" && typeof d.ref?.binding === "string";
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The draft of a document, or null when there is none or the file cannot be read. */
export function readDraft(home: string, wsId: string, identity: string): Draft | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(draftFile(home, wsId, identity), "utf8")) as unknown;
    return isDraft(parsed) && parsed.identity === identity ? parsed : null;
  } catch {
    return null;
  }
}

/** Removes the draft of a document; true when there was one. */
export function removeDraft(home: string, wsId: string, identity: string): boolean {
  try {
    fs.rmSync(draftFile(home, wsId, identity));
    return true;
  } catch {
    return false;
  }
}

/** Every draft of the workspace, oldest first. */
export function listDrafts(home: string, wsId: string): Draft[] {
  const dir = draftsDir(home, wsId);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Draft[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as unknown;
      if (isDraft(parsed)) out.push(parsed);
    } catch {
      // A damaged file is not a draft; it is left alone.
    }
  }
  return out.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

export interface SaveDraftRequest {
  /** Entry of a directory binding. */
  entry?: string;
  text: string;
  /** Revision the person was editing over (the one the editor read). */
  baseRevision: string | null;
}

/**
 * Keeps the text as the draft of the document instance × binding (× entry). A text equal to the file on disk is not a
 * draft: the existing one is dropped and null is returned. The project file is only read.
 */
export function saveDraft(dir: string, home: string, wsId: string, instance: string, binding: string, request: SaveDraftRequest, now: Date = new Date()): Draft | null {
  if (Buffer.byteLength(request.text, "utf8") > MAX_DRAFT_BYTES) throw new DraftError("DRAFT_TOO_LARGE", t("drafts_too_large", { max: MAX_DRAFT_BYTES }), t("drafts_too_large_fix"));
  const doc = openDocument(dir, instance, binding, request.entry !== undefined ? { entry: request.entry } : {});
  if (doc.state !== "editable") throw new DraftError("DRAFT_NOT_EDITABLE", t("drafts_not_editable", { path: doc.relPath ?? doc.path, state: doc.state }), t("drafts_not_editable_fix"));
  if ((doc.text ?? "") === request.text && doc.exists) {
    removeDraft(home, wsId, doc.identity);
    return null;
  }
  ensureWorkspaceDirs(home, wsId);
  const draft: Draft = {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    ref: doc.ref,
    identity: doc.identity,
    relPath: doc.relPath,
    baseRevision: request.baseRevision,
    text: request.text,
    updatedAt: now.toISOString(),
  };
  writeAtomic(draftFile(home, wsId, doc.identity), `${JSON.stringify(draft, null, 2)}\n`);
  return draft;
}

/**
 * Compares a draft with the file on disk now. A draft that has become equal to the file (saved elsewhere) is dropped
 * and reported with `differs` false.
 */
export function inspectDraft(dir: string, home: string, wsId: string, draft: Draft): DraftStatus {
  try {
    const doc = openDocument(dir, draft.ref.instance, draft.ref.binding, draft.ref.entry !== null ? { entry: draft.ref.entry } : {});
    const same = doc.exists && doc.text === draft.text;
    if (same) removeDraft(home, wsId, draft.identity);
    return { draft, currentRevision: doc.revision, stale: doc.revision !== draft.baseRevision, differs: !same, orphan: doc.identity !== draft.identity };
  } catch (error) {
    if (error instanceof DocumentError) return { draft, currentRevision: null, stale: true, differs: true, orphan: true };
    throw error;
  }
}

/** The draft of one document with its status, or null. */
export function draftStatusOf(dir: string, home: string, wsId: string, instance: string, binding: string, entry?: string): DraftStatus | null {
  let identity: string;
  try {
    identity = openDocument(dir, instance, binding, entry !== undefined ? { entry } : {}).identity;
  } catch (error) {
    if (error instanceof DocumentError) return null;
    throw error;
  }
  const draft = readDraft(home, wsId, identity);
  return draft ? inspectDraft(dir, home, wsId, draft) : null;
}

/** Drops the draft of a document (after it was saved or discarded). */
export function discardDraft(dir: string, home: string, wsId: string, instance: string, binding: string, entry?: string): boolean {
  try {
    const doc = openDocument(dir, instance, binding, entry !== undefined ? { entry } : {});
    return removeDraft(home, wsId, doc.identity);
  } catch (error) {
    if (error instanceof DocumentError) return false;
    throw error;
  }
}

/** Every draft of the workspace with its status; drafts equal to the disk are dropped on the way. */
export function listDraftStatuses(dir: string, home: string, wsId: string): DraftStatus[] {
  return listDrafts(home, wsId)
    .map((d) => inspectDraft(dir, home, wsId, d))
    .filter((s) => s.differs);
}
