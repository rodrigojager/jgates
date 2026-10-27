// Local Semgrep rules of an instance: the list of rule files with their syntax and contract check, and renaming a
// file. Creating and editing a rule go through the document routes (PUT with expectedRevision null creates).
import { DocumentError } from "../../core/documents/index.js";
import { RULES_BINDING, collectRuleSource, issuesOf, renameRuleFile, searchRuleFiles } from "../../core/rules/index.js";
import { HttpError, refuse } from "../http.js";
import type { RouteDefinition } from "../types.js";
import { ID_PATTERN } from "./tools.js";

const ENTRY_PATTERN = "^(?![/~])(?!.*\\\\)(?!(?:.*/)?\\.{1,2}(?:/|$))(?!.*//)[^\\u0000]{1,1024}$";
const params = {
  type: "object",
  properties: { instance: { type: "string", pattern: ID_PATTERN } },
  required: ["instance"],
  additionalProperties: false,
};

const STATUS: Record<string, number> = {
  INSTANCE_NOT_FOUND: 404,
  BINDING_NOT_FOUND: 404,
  ENTRY_NOT_FOUND: 404,
  BINDING_REFUSED: 403,
  ENTRY_NOT_ALLOWED: 403,
  DOCUMENT_READ_ONLY: 403,
  DOCUMENT_EXISTS: 409,
  PATH_CHANGED: 409,
};

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/rules/:instance",
    params,
    query: { type: "object", properties: { binding: { type: "string", pattern: ID_PATTERN }, q: { type: "string", maxLength: 200 } }, additionalProperties: false },
    handler({ params: p, query, server }) {
      const source = collectRuleSource(server.projectDir, p.instance as string, query.binding ?? RULES_BINDING);
      if (source.problem?.code === "NO_BINDING" && source.adapter === "") throw refuse(404, "INSTANCE_NOT_FOUND", { name: p.instance as string });
      const files = (query.q ? searchRuleFiles(source, query.q) : source.files).map(({ abs: _abs, ...file }) => file);
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          rules: {
            instance: source.instance,
            binding: source.binding,
            kind: source.kind,
            relPath: source.relPath,
            access: source.access,
            include: source.include,
            exists: source.exists,
            valid: source.valid,
            problem: source.problem,
            duplicates: source.duplicates,
            issues: issuesOf(source),
            total: source.files.length,
            files,
          },
        },
      };
    },
  },
  {
    method: "POST",
    path: "/api/rules/:instance/rename",
    params,
    body: {
      type: "object",
      properties: {
        from: { type: "string", pattern: ENTRY_PATTERN },
        to: { type: "string", pattern: ENTRY_PATTERN },
        expectedRevision: { type: "string", pattern: "^[0-9a-f]{64}$" },
        binding: { type: "string", pattern: ID_PATTERN },
      },
      required: ["from", "to", "expectedRevision"],
      additionalProperties: false,
    },
    handler({ params: p, body, server }) {
      const b = body as { from: string; to: string; expectedRevision: string; binding?: string };
      let result;
      try {
        result = renameRuleFile(server.projectDir, p.instance as string, { from: b.from, to: b.to, expectedRevision: b.expectedRevision, ...(b.binding ? { binding: b.binding } : {}) });
      } catch (error) {
        if (error instanceof DocumentError) throw new HttpError(STATUS[error.code] ?? 400, error.code, error.message, error.fix, { details: error.details });
        throw error;
      }
      if (result.status === "conflict") throw refuse(409, "REVISION_CONFLICT", {}, { from: result.from, current: result.current });
      server.log(`rule renamed ${p.instance}: ${b.from} -> ${b.to}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", rename: result } };
    },
  },
];
