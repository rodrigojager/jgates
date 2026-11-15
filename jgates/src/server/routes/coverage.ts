// The ASVS coverage map for the screens: the map (the same answer as `jgates coverage asvs --json` for the same request),
// a preview of a change of the project's decisions (.jgates/asvs.json: the level, or a "not applicable" entry) before
// anything is written, the write with what an undo needs, and the undo. Every route calls the same functions as the command
// (core/coverage/asvs), so the screen and the terminal give the same answer. No handler calls the engine or git (ADR-0010):
// the map is built from stored files. A write is refused in governed (read-only) mode (ADR-0006).
import path from "node:path";
import { invalidateProjectCache } from "../../core/cache/project.js";
import {
  AsvsDataError,
  DEFAULT_ASVS_VERSION,
  buildAsvsMap,
  commitDecision,
  loadAsvs,
  prepareLevel,
  prepareNotApplicable,
  prepareRemoveNotApplicable,
  readAsvsDecisions,
  undoDecision,
  undoToken,
  type AsvsData,
  type AsvsDecisionRefusal,
  type AsvsMapRefusal,
  type AsvsMapRequest,
  type AsvsUndoData,
  type PreparedDecision,
} from "../../core/coverage/asvs/index.js";
import { normalizeLocale, translator, withLocale, type Locale } from "../../i18n/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";
import { assertWritable } from "./templates.js";

const FILE = ".jgates/asvs.json";

const STATUS: Partial<Record<string, number>> = {
  ASVS_FILE_CHANGED: 409,
  ASVS_ALREADY_NOT_APPLICABLE: 409,
  ASVS_DECISION_NOT_FOUND: 404,
  ASVS_TARGET_UNKNOWN: 404,
  ASVS_RUN_NOT_FOUND: 404,
  ASVS_SEMANTIC_RUN_NOT_FOUND: 404,
  ASVS_WRITE_FAILED: 500,
};

/** The language of the call: `lang` of the query (the screen's language), else the process language. */
function localeOf(lang: string | undefined): Locale | undefined {
  return normalizeLocale(lang) ?? undefined;
}

function inLocale<T>(lang: string | undefined, work: () => T): T {
  const locale = localeOf(lang);
  return locale ? withLocale(locale, work) : work();
}

/** The parameters a refusal's message names, as text (the same ones the command gives its messages). */
function paramsOf(refusal: AsvsDecisionRefusal | AsvsMapRefusal, t: ReturnType<typeof translator>): Record<string, string | number> {
  const out: Record<string, string | number> = { detail: refusal.message };
  for (const [k, v] of Object.entries(refusal.details)) if (typeof v === "string" || typeof v === "number") out[k] = v;
  const problem = (refusal.details as Record<string, unknown>).problem as { message?: string; line?: number; column?: number } | undefined;
  if (problem && typeof problem === "object") {
    out.problem = problem.message ?? "";
    out.place = problem.line !== undefined ? t("coverage_place", { line: problem.line, column: problem.column ?? 1 }) : t("coverage_place_unknown");
  }
  return out;
}

/** A refusal of the core as an HTTP error, with the message of the command. */
function failure(refusal: AsvsDecisionRefusal | AsvsMapRefusal, lang: string | undefined): HttpError {
  return inLocale(lang, () => {
    const t = translator("coverage");
    const params = paramsOf(refusal, t);
    const key = `coverage_refused_${refusal.code.toLowerCase()}`;
    return new HttpError(STATUS[refusal.code] ?? 422, refusal.code, t(key, params), t(`${key}_fix`, params), refusal.details);
  });
}

/** The ASVS data of the version the project's decisions name (the default version when the file does not say or is unusable). */
function dataFor(server: ServerContext): AsvsData {
  const read = readAsvsDecisions(server.projectDir);
  const version = "code" in read || read.problem ? DEFAULT_ASVS_VERSION : read.version;
  try {
    return loadAsvs(version);
  } catch (error) {
    if (!(error instanceof AsvsDataError)) throw error;
    return loadAsvs(DEFAULT_ASVS_VERSION);
  }
}

/** What the preview and the write say about a change (the same fields `jgates coverage asvs ... --json` gives). */
function describe(change: PreparedDecision): Record<string, unknown> {
  return { kind: change.kind, file: change.file, entry: change.entry, level: change.level, diff: change.diff, created: !change.existed, revision: change.revision };
}

const base = (server: ServerContext) => ({ schemaVersion: 1 as const, status: "OK" as const, tool: "jgates", version: server.version, workspace: { id: server.workspace.id, path: server.workspace.path } });

const REVISION = { type: "string", minLength: 1, maxLength: 64 };
const LANG = { enum: ["en", "pt-BR"] };

export const routes: RouteDefinition[] = [
  {
    // The map. `semanticRuns` is a comma-separated list of Semantic run ids; the other filters are those of the command
    // (`withSuggestion`: only the rows that carry a suggestion of "not applicable"). Confirming a suggestion is the
    // ordinary "not applicable" write below, with the suggestion's reason filled in by the screen.
    method: "GET",
    path: "/api/coverage/asvs",
    query: {
      type: "object",
      properties: {
        level: { type: "string", maxLength: 8 },
        run: { type: "string", maxLength: 128 },
        semanticRuns: { type: "string", maxLength: 2000 },
        state: { type: "string", maxLength: 40 },
        chapter: { type: "string", maxLength: 16 },
        subdimension: { type: "string", maxLength: 64 },
        deterministicOnly: { enum: ["true", "false", "1", "0"] },
        withSuggestion: { enum: ["true", "false", "1", "0"] },
        lang: LANG,
      },
      additionalProperties: false,
    },
    handler({ query, server }) {
      const request: AsvsMapRequest = { home: server.home, workspaceId: server.workspace.id, projectDir: server.projectDir, deterministicOnly: query.deterministicOnly === "true" || query.deterministicOnly === "1" };
      if (query.level) request.level = query.level;
      if (query.run) request.runId = query.run;
      const semantic = (query.semanticRuns ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
      if (semantic.length > 0) request.semanticRunIds = semantic;
      if (query.state) request.state = query.state;
      if (query.chapter) request.chapter = query.chapter;
      if (query.subdimension) request.subdimension = query.subdimension;
      if (query.withSuggestion === "true" || query.withSuggestion === "1") request.withSuggestion = true;
      const answer = inLocale(query.lang, () => buildAsvsMap(request));
      if ("ok" in answer) throw failure(answer, query.lang);
      return { status: 200, json: { ...base(server), ...answer } };
    },
  },
  {
    // A change of the project's decisions: the level, a "not applicable" entry, or its removal. `preview: true` answers with
    // the entry and the diff of the file and writes nothing.
    method: "POST",
    path: "/api/coverage/asvs/decisions",
    query: { type: "object", properties: { lang: LANG }, additionalProperties: false },
    body: {
      type: "object",
      properties: {
        action: { enum: ["level", "not-applicable", "remove"] },
        // The server's validator runs in strict mode, which refuses a union `type`; anyOf says the same.
        level: { anyOf: [{ type: "integer" }, { type: "string" }] },
        id: { type: "string", minLength: 1, maxLength: 32 },
        reason: { type: "string", maxLength: 4000 },
        expectedRevision: REVISION,
        preview: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    handler({ body, query, server }) {
      assertWritable();
      const b = body as { action: "level" | "not-applicable" | "remove"; level?: number | string; id?: string; reason?: string; expectedRevision?: string; preview?: boolean };
      const expected = b.expectedRevision !== undefined ? { expectedRevision: b.expectedRevision } : {};
      let prepared: PreparedDecision | AsvsDecisionRefusal;
      if (b.action === "level") {
        const read = readAsvsDecisions(server.projectDir);
        const version = "code" in read || read.problem ? DEFAULT_ASVS_VERSION : read.version;
        prepared = prepareLevel(server.projectDir, { level: b.level, version, ...expected });
      } else if (b.action === "remove") {
        prepared = prepareRemoveNotApplicable(server.projectDir, { id: b.id, ...expected });
      } else {
        prepared = prepareNotApplicable(server.projectDir, { data: dataFor(server), id: b.id, reason: b.reason, now: new Date(), ...expected });
      }
      if (!prepared.ok) throw failure(prepared, query.lang);
      if (b.preview === true) return { status: 200, json: { ...base(server), preview: true, written: false, ...describe(prepared) } };
      const outcome = commitDecision(prepared);
      if (!outcome.ok) throw failure(outcome, query.lang);
      invalidateProjectCache();
      server.log(`coverage asvs ${prepared.kind}: ${prepared.entry?.id ?? prepared.level ?? ""} in ${prepared.file}`);
      return { status: 200, json: { ...base(server), preview: false, written: true, ...describe(prepared), revision: outcome.revision, undo: { token: undoToken(outcome.undo), ...outcome.undo } } };
    },
  },
  {
    // Puts the file back as it was before a write (what the write's `undo` carries), when nothing changed it since.
    method: "POST",
    path: "/api/coverage/asvs/undo",
    query: { type: "object", properties: { lang: LANG }, additionalProperties: false },
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
          additionalProperties: true,
        },
      },
      required: ["undo"],
      additionalProperties: false,
    },
    maxBody: 8_000_000,
    handler({ body, query, server }) {
      assertWritable();
      const undo = (body as { undo: AsvsUndoData }).undo;
      // Only the project's own decisions file is ever put back, whatever the request names.
      const outcome = undoDecision(server.projectDir, { file: path.posix.join(".jgates", "asvs.json"), expectedRevision: undo.expectedRevision, previous: undo.previous });
      if (!outcome.ok) throw failure(outcome, query.lang);
      invalidateProjectCache();
      server.log("coverage asvs undo");
      return { status: 200, json: { ...base(server), file: FILE, revision: outcome.revision, undone: true } };
    },
  },
];
