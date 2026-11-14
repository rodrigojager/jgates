// The project's waivers for the screens: the list with each entry's state, a preview of the entry and of the file change
// before anything is written, the write (with what an undo needs), the removal, and the undo. Every route calls the same
// functions as `jgates waivers` (core/waiver-file), so the screens and the terminal give the same answer for the same
// request. No waiver logic lives here, and no handler calls the engine or git (ADR-0010): the file is read through the
// project cache and the last validation comes from the data folder.
import path from "node:path";
import { cachedProject, invalidateProjectCache } from "../../core/cache/project.js";
import {
  commitChange,
  entryId,
  findRunResult,
  lastResult,
  listWaivers,
  prepareAdd,
  prepareRemove,
  readWaiverFile,
  undoChange,
  type PreparedChange,
  type UndoData,
  type WaiverFileRead,
  type WaiverFileRefusal,
  type WaiverListing,
} from "../../core/waiver-file/index.js";
import { translator } from "../../i18n/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";
import { assertWritable } from "./templates.js";

const t = translator("waivers");

/** The parameters a refusal's message names, as text (the same ones the command gives its messages). */
function paramsOf(refusal: WaiverFileRefusal): Record<string, string | number> {
  const d = refusal.details;
  const out: Record<string, string | number> = { detail: refusal.message };
  for (const [k, v] of Object.entries(d)) if (typeof v === "string" || typeof v === "number") out[k] = v;
  const candidates = d.candidates;
  if (Array.isArray(candidates)) {
    out.candidates = candidates
      .map((c) => {
        if (!c || typeof c !== "object") return String(c);
        const r = c as Record<string, unknown>;
        return `${r.fingerprint}  ${r.tool}  ${r.rule}  ${r.path ?? ""}${r.line ? `:${r.line}` : ""}`;
      })
      .join("; ");
  }
  const problem = d.problem as { message?: string; line?: number; column?: number } | undefined;
  if (problem) {
    out.problem = problem.message ?? "";
    out.place = problem.line !== undefined ? t("waivers_place", { line: problem.line, column: problem.column ?? 1 }) : t("waivers_place_unknown");
  }
  return out;
}

const STATUS: Partial<Record<string, number>> = {
  WAIVER_FILE_CHANGED: 409,
  WAIVER_ALREADY_EXISTS: 409,
  WAIVER_RUN_NOT_FOUND: 404,
  WAIVER_NO_RUN: 404,
  WAIVER_FINDING_NOT_FOUND: 404,
  WAIVER_NOT_FOUND: 404,
  WAIVER_WRITE_FAILED: 500,
};

/** A refusal of the core as an HTTP error, with the message of the command. */
function failure(refusal: WaiverFileRefusal): HttpError {
  const params = paramsOf(refusal);
  const key = `waivers_refused_${refusal.code.toLowerCase()}`;
  return new HttpError(STATUS[refusal.code] ?? 422, refusal.code, t(key, params), t(`${key}_fix`, params), refusal.details);
}

/** The project's file, read through the project cache: it is read again only when the file or its folder changed. */
function readFile(server: ServerContext): WaiverFileRead | WaiverFileRefusal {
  return cachedProject("waivers-file:", [server.projectDir], () => readWaiverFile(server.projectDir));
}

/**
 * The entries of the file with their state against the last validation of the workspace: what `GET /api/waivers` answers
 * and what `review.waivers` of `POST /api/plans` carries. A file that cannot be used is reported as `problem`, never thrown.
 */
export function waiverListing(server: ServerContext): WaiverListing {
  const read = readFile(server);
  if (!("target" in read)) return { file: ".jgates/waivers.json", exists: false, revision: "absent", problem: { message: read.message }, runId: null, waivers: [] };
  const last = lastResult(server.home, server.workspace.id);
  return listWaivers(read, last?.result ?? null, last?.runId ?? null, new Date());
}

const entryOf = (e: unknown): Record<string, unknown> => ({ id: entryId(e as Record<string, unknown>), ...(e as Record<string, unknown>) });

/** What the preview and the write say about a change; the write adds the undo and the updated list. */
function describe(prepared: PreparedChange): Record<string, unknown> {
  return {
    file: prepared.file,
    created: !prepared.existed,
    revision: prepared.revision,
    diff: prepared.diff,
    ...(prepared.kind === "add" ? { entries: prepared.entries.map(entryOf) } : { removed: prepared.removed }),
  };
}

function commit(server: ServerContext, prepared: PreparedChange, preview: boolean): { status: number; json: unknown } {
  if (preview) return { status: 200, json: { schemaVersion: 1, status: "OK", preview: true, ...describe(prepared) } };
  const outcome = commitChange(prepared);
  if (!outcome.ok) throw failure(outcome);
  invalidateProjectCache();
  server.log(`waivers ${prepared.kind}: ${prepared.kind === "add" ? prepared.entries.length : prepared.removed.length} in ${prepared.file}`);
  return { status: 200, json: { schemaVersion: 1, status: "OK", preview: false, ...describe(prepared), revision: outcome.revision, undo: outcome.undo, waivers: waiverListing(server) } };
}

const REVISION = { type: "string", minLength: 1, maxLength: 64 };

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/waivers",
    handler({ server }) {
      return { status: 200, json: { schemaVersion: 1, status: "OK", ...waiverListing(server) } };
    },
  },
  {
    // `preview: true` answers with the entry and the diff of the file and writes nothing. The anchors come from the stored
    // result of `runId`; a request never computes one. A missing date or reason is refused by the core, with its message.
    method: "POST",
    path: "/api/waivers",
    body: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1, maxLength: 128 },
        fingerprints: { type: "array", items: { type: "string", minLength: 1, maxLength: 80 }, maxItems: 100 },
        until: { type: "string", maxLength: 64 },
        reason: { type: "string", maxLength: 4000 },
        expectedRevision: REVISION,
        preview: { type: "boolean" },
      },
      required: ["runId", "fingerprints"],
      additionalProperties: false,
    },
    handler({ body, server }) {
      assertWritable();
      const b = body as { runId: string; fingerprints: string[]; until?: string; reason?: string; expectedRevision?: string; preview?: boolean };
      const run = findRunResult(server.home, server.workspace.id, b.runId);
      if (!run.ok) throw failure(run);
      const prepared = prepareAdd(server.projectDir, {
        result: run.result,
        findings: b.fingerprints,
        until: b.until,
        reason: b.reason,
        now: new Date(),
        ...(b.expectedRevision !== undefined ? { expectedRevision: b.expectedRevision } : {}),
      });
      if (!prepared.ok) throw failure(prepared);
      return commit(server, prepared, b.preview === true);
    },
  },
  {
    // Puts the file back as it was before a write (what the write's `undo` carries), when nothing changed it since.
    method: "POST",
    path: "/api/waivers/undo",
    body: {
      type: "object",
      properties: {
        undo: {
          type: "object",
          properties: {
            file: { type: "string", minLength: 1, maxLength: 200 },
            expectedRevision: REVISION,
            previous: { type: ["string", "null"], maxLength: 4_000_000 },
          },
          required: ["file", "expectedRevision", "previous"],
          additionalProperties: false,
        },
      },
      required: ["undo"],
      additionalProperties: false,
    },
    maxBody: 8_000_000,
    handler({ body, server }) {
      assertWritable();
      const undo = (body as { undo: UndoData }).undo;
      // Only the project's own waiver file is ever put back, whatever the request names.
      const outcome = undoChange(server.projectDir, { ...undo, file: path.posix.join(".jgates", "waivers.json") });
      if (!outcome.ok) throw failure(outcome);
      invalidateProjectCache();
      server.log("waivers undo");
      return { status: 200, json: { schemaVersion: 1, status: "OK", revision: outcome.revision, waivers: waiverListing(server) } };
    },
  },
  {
    // Removes one entry (its id, or a unique prefix) and answers with the undo.
    method: "DELETE",
    path: "/api/waivers/:id",
    params: { type: "object", properties: { id: { type: "string", pattern: "^[0-9a-f]{4,64}$" } }, required: ["id"], additionalProperties: false },
    query: { type: "object", properties: { expectedRevision: REVISION }, additionalProperties: false },
    handler({ params, query, server }) {
      assertWritable();
      const prepared = prepareRemove(server.projectDir, { ids: [params.id as string], now: new Date(), ...(query.expectedRevision !== undefined ? { expectedRevision: query.expectedRevision } : {}) });
      if (!prepared.ok) throw failure(prepared);
      return commit(server, prepared, false);
    },
  },
];
