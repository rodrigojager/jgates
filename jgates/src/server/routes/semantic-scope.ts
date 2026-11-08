// The scope preview of a Semantic run through the API: the scope controls (the same for every purpose) and the
// resolution of a scope request before any model work (subjects, supporting context with reasons, exclusions, unknowns,
// recommended expansion, reuse of prior evidence, inherited coverage, completion counts and blockers). It drives the
// same service as `jgates semantic plan --scope ...` (core/semantic buildSemanticPlan) and never starts a run, calls a
// provider or writes anything.
import { buildSemanticPlan } from "../../core/semantic/index.js";
import { CONTEXT_POLICIES, SEMANTIC_PURPOSES, SEMANTIC_RIGORS, scopeControls, type ScopeRequest, type SemanticPurpose, type SemanticRigor } from "../../core/semantic-scope/index.js";
import { translator } from "../../i18n/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition } from "../types.js";

const t = translator("semantic-scope");

const NO_CONTROL = "^[^\\u0000-\\u001f\\u007f]+$";
const pathString = { type: "string", minLength: 1, maxLength: 500, pattern: NO_CONTROL };
const pathList = { type: "array", maxItems: 200, items: pathString };
const count = { type: "integer", minimum: 0, maximum: 1_000_000_000 };

/** JSON Schema of a scope request (also accepted by POST /api/semantic/runs). */
export const scopeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { enum: ["full", "selected", "incremental"] },
    subjects: {
      type: "array",
      maxItems: 200,
      items: { type: "object", additionalProperties: false, required: ["kind", "value"], properties: { kind: { enum: ["path", "subsystem"] }, value: pathString } },
    },
    exclusions: pathList,
    base: { type: "string", minLength: 1, maxLength: 200, pattern: "^[^\\u0000-\\u001f\\u007f -][^\\u0000-\\u001f\\u007f ]*$" },
    target: { type: "string", minLength: 1, maxLength: 200, pattern: "^[^\\u0000-\\u001f\\u007f -][^\\u0000-\\u001f\\u007f ]*$" },
    dirty: { oneOf: [{ enum: ["none", "all"] }, pathList] },
    baseline: { type: "string", pattern: "^(latest|sem_[0-9]{8}T[0-9]{6}Z_[0-9a-f]{8})$" },
    context: {
      type: "object",
      additionalProperties: false,
      properties: { policy: { enum: [...CONTEXT_POLICIES] }, maxFiles: count, maxDepth: count, maxBytes: count, allow: pathList },
    },
  },
};

/** The run choices that never change the scope, plus the scope itself (also accepted by POST /api/semantic/runs). */
export const choiceProperties = {
  purpose: { enum: [...SEMANTIC_PURPOSES] },
  rigor: { enum: [...SEMANTIC_RIGORS] },
  budget: { type: "object", additionalProperties: false, properties: { maxCalls: count, maxTokens: count } },
  scope: scopeSchema,
};

const previewBody = { type: "object", additionalProperties: false, properties: choiceProperties };

interface PreviewBody {
  purpose?: SemanticPurpose;
  rigor?: SemanticRigor;
  budget?: { maxCalls?: number; maxTokens?: number };
  scope?: ScopeRequest;
}

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/semantic/scope/controls",
    query: { type: "object", properties: { purpose: { enum: [...SEMANTIC_PURPOSES] } }, additionalProperties: false },
    handler({ query }) {
      const purpose = (query.purpose as SemanticPurpose | undefined) ?? "general-review";
      return { status: 200, json: { schemaVersion: 1, status: "OK", gate: "semantic", purpose, controls: scopeControls(purpose) } };
    },
  },
  {
    // A preview: the plan a run with these choices would get, scope resolved, nothing started or written.
    method: "POST",
    path: "/api/semantic/scope/preview",
    body: previewBody,
    handler({ body, server }) {
      if (server.policyMode) throw new HttpError(409, "SEMANTIC_POLICY_MODE", t("scope_api_policy_mode"), null);
      const request = (body ?? {}) as PreviewBody;
      const plan = buildSemanticPlan({
        workspacePath: server.workspace.path,
        home: server.home,
        ...(request.purpose ? { purpose: request.purpose } : {}),
        ...(request.rigor ? { rigor: request.rigor } : {}),
        ...(request.budget ? { budget: request.budget } : {}),
        scope: request.scope ?? null,
      });
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          gate: "semantic",
          purpose: plan.purpose,
          rigor: plan.rigor,
          budget: plan.budget,
          controls: plan.scope.controls,
          resolution: plan.scope.resolution,
          ready: plan.ready,
          blockers: plan.blockers,
          planHash: plan.planHash,
        },
      };
    },
  },
];
