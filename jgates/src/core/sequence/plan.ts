// The plan of a gate selection: which gates, where that choice came from, the Quality plan (core/plan buildPlan, or a
// received plan), the Semantic plan (core/semantic buildSemanticPlan) and how the sequence advances. The CLI
// (`jgates run --gates ... --dry-run`, and every combined run before it starts) and the server route
// (POST /api/sequence/plan) build it with this one function, so the same request gives the same plan in both.
// Building it starts nothing, calls no provider and writes nothing in the workspace.
import fs from "node:fs";
import path from "node:path";
import { selectionFromOptions } from "../../adapters/quality-bridge/index.js";
import type { BridgeSelection } from "../../adapters/quality-bridge/requirements.js";
import { ROOT_FILE } from "../config/load/index.js";
import { resolveHome } from "../home/index.js";
import { contentHash, workspaceId } from "../ids/index.js";
import { buildPlan } from "../plan/index.js";
import type { Plan, PlanScopeKind } from "../plan/types.js";
import { legacyPlan } from "../run/legacy-plan.js";
import { buildSemanticPlan, type SemanticPlan } from "../semantic/plan.js";
import type { ScopeRequest, SemanticPurpose, SemanticRigor } from "../semantic-scope/index.js";
import type { GateKind } from "../gates/types.js";
import { translator } from "../../i18n/index.js";
import type { SemanticScopeShape } from "./approval.js";
import { isCombined, resolveGateSelection, type GateSelection, type QualityCoveragePolicy } from "./selection.js";

const t = translator("sequence");

export interface QualityPlanRequest {
  scope?: PlanScopeKind;
  paths?: string[];
  base?: string;
  head?: string;
  skip?: string[];
  only?: string[];
  templates?: string[];
}

export interface SemanticPlanChoices {
  purpose?: SemanticPurpose;
  rigor?: SemanticRigor;
  budget?: { maxCalls?: number; maxTokens?: number } | null;
  /** The Semantic scope; derived from the Quality scope when absent (paths: selected, changed: incremental, full). */
  scope?: ScopeRequest | null;
}

export interface GatePlanRequest {
  workspacePath: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** JGates version (enters the Quality plan's hash). */
  version: string;
  now?: () => Date;
  /** The run-only gate choice (--gates, the API's `gates`); otherwise the saved selection. */
  gates?: GateKind[];
  profile?: string;
  quality?: QualityPlanRequest;
  /** A Quality plan received as a file (already validated against the workspace); takes the place of building one. */
  qualityPlan?: Plan;
  /** Without jgates.yml and plan flags: the option-driven bridge selection (the legacy run's flags). */
  legacySelection?: BridgeSelection;
  semantic?: SemanticPlanChoices;
  /** Semantic only: a Quality run to attach as evidence ("latest" or a run_ ID). */
  attachQuality?: string | null;
}

export interface GatePlanBlocker {
  gate: GateKind;
  code: string;
  message: string;
  details?: unknown;
}

export interface GatePlan {
  schemaVersion: 1;
  kind: "jgates-gate-plan";
  workspace: { id: string; path: string };
  selection: GateSelection;
  /** The Quality plan (null when Quality is not selected or the plan could not be built: see qualityError). */
  quality: Plan | null;
  qualitySource: "built" | "file" | "options" | null;
  qualityError: { code: string; message: string; fix: string | null; errors: unknown[]; diagnostics: unknown[] } | null;
  semantic: SemanticPlan | null;
  /** Hash of what decides the Semantic run apart from the attached Quality report (settings, methods, scope...). */
  semanticSettingsHash: string | null;
  /** The Semantic scope request the plan was built with (the run uses the same). */
  semanticRequest: { purpose: SemanticPurpose | null; rigor: SemanticRigor | null; budget: { maxCalls?: number; maxTokens?: number } | null; scope: ScopeRequest | null } | null;
  advancement: { condition: "quality-approved" | "none"; qualityCoverage: QualityCoveragePolicy };
  ready: boolean;
  blockers: GatePlanBlocker[];
}

/** The Semantic scope matching the Quality plan's scope: the same subjects for both gates by default. */
export function semanticScopeFromQuality(scope: { requested: PlanScopeKind; paths: string[]; base: string | null; head: string | null } | null): ScopeRequest | null {
  if (!scope) return null;
  if (scope.requested === "paths" && scope.paths.length > 0) return { mode: "selected", subjects: scope.paths.map((value) => ({ kind: "path" as const, value })) };
  if (scope.requested === "changed") return { mode: "incremental", ...(scope.base ? { base: scope.base } : {}), ...(scope.head ? { target: scope.head } : {}) };
  return null;
}

/** The shape of a Semantic scope request the assessment compares with the Quality scope. */
export function semanticScopeShape(scope: ScopeRequest | null | undefined): SemanticScopeShape {
  if (!scope || !scope.mode || scope.mode === "full") return { mode: "full", subjects: [], base: null };
  if (scope.mode === "selected") return { mode: "selected", subjects: (scope.subjects ?? []).filter((s) => s.kind === "path").map((s) => s.value), base: null };
  return { mode: "incremental", subjects: [], base: scope.base ?? null };
}

/** What decides a Semantic run apart from the attached Quality report: equal before and after Quality when nothing changed. */
export function semanticSettingsHash(plan: SemanticPlan): string {
  return contentHash({ v: 1, settings: plan.settings, methods: plan.methods.map((m) => m.id), purpose: plan.purpose, rigor: plan.rigor, budget: plan.budget, scopeHash: plan.scope?.resolution?.scopeHash ?? null });
}

/** The Quality plan of the request: the received one, the one built from the configuration, or the option-driven one. */
export function buildQualityPlan(request: GatePlanRequest): { plan: Plan; source: "built" | "file" | "options" } | { error: NonNullable<GatePlan["qualityError"]> } {
  if (request.qualityPlan) return { plan: request.qualityPlan, source: "file" };
  const dir = path.resolve(request.workspacePath);
  const q = request.quality ?? {};
  const flags = request.profile !== undefined || q.scope !== undefined || (q.paths?.length ?? 0) > 0 || q.base !== undefined || q.head !== undefined || (q.skip?.length ?? 0) > 0 || (q.only?.length ?? 0) > 0 || (q.templates?.length ?? 0) > 0;
  if (!flags && !fs.existsSync(path.join(dir, ROOT_FILE))) {
    const selection = request.legacySelection ?? (selectionFromOptions({}) as BridgeSelection);
    return { plan: legacyPlan(dir, selection, { version: request.version, ...(request.env ? { env: request.env } : {}) }), source: "options" };
  }
  const built = buildPlan(dir, {
    ...(request.profile !== undefined ? { profile: request.profile } : {}),
    ...(q.scope !== undefined ? { scope: q.scope } : {}),
    ...(q.base !== undefined ? { base: q.base } : {}),
    ...(q.head !== undefined ? { head: q.head } : {}),
    paths: q.paths ?? [],
    skip: q.skip ?? [],
    only: q.only ?? [],
    templates: q.templates ?? [],
    version: request.version,
    compare: false,
    ...(request.home !== undefined ? { home: request.home } : {}),
    ...(request.env ? { env: request.env } : {}),
  });
  if (!built.ok) return { error: { code: built.error.code, message: built.error.message, fix: built.error.fix ?? null, errors: built.errors, diagnostics: built.diagnostics } };
  return { plan: built.plan, source: "built" };
}

/** The blockers of a Quality plan that cannot run (a missing required coverage has its own code). */
export function qualityPlanBlockers(plan: Plan): GatePlanBlocker[] {
  if (!plan.blocked && plan.approvable) return [];
  const blockers = plan.blocked ? [plan.blocked, ...plan.blockers] : plan.blockers;
  return blockers.map((b) => ({
    gate: "quality" as const,
    code: b.code === "REQUIREMENT_UNCOVERED" ? "QUALITY_COVERAGE_MISSING" : "QUALITY_PLAN_NOT_APPROVABLE",
    message: b.code === "REQUIREMENT_UNCOVERED" ? t("sequence_quality_coverage_missing", { detail: b.message }) : t("sequence_quality_plan_not_approvable", { code: b.code, detail: b.message }),
    details: { planBlocker: b },
  }));
}

/** Builds the plan of a gate selection (see the file comment). */
export function buildGatePlan(request: GatePlanRequest): GatePlan {
  const env = request.env ?? process.env;
  const home = request.home ?? resolveHome({ env });
  const dir = path.resolve(request.workspacePath);
  const selection = resolveGateSelection(dir, { ...(request.profile !== undefined ? { profile: request.profile } : {}), ...(request.gates ? { gates: request.gates } : {}) });
  const blockers: GatePlanBlocker[] = [];
  let quality: Plan | null = null;
  let qualitySource: GatePlan["qualitySource"] = null;
  let qualityError: GatePlan["qualityError"] = null;
  if (selection.gates.includes("quality")) {
    const built = buildQualityPlan({ ...request, home, env });
    if ("error" in built) {
      qualityError = built.error;
      // A requirement the policy locks but the selection leaves without a check is missing required coverage, not a
      // malformed configuration; anything else that keeps the plan from being built is an invalid configuration.
      const locked = built.error.code === "LOCKED_REQUIREMENT" || built.error.errors.some((e) => (e as { code?: unknown }).code === "LOCKED_REQUIREMENT");
      blockers.push(
        locked
          ? { gate: "quality", code: "QUALITY_COVERAGE_MISSING", message: t("sequence_quality_coverage_missing", { detail: built.error.message }), details: { errors: built.error.errors } }
          : { gate: "quality", code: "QUALITY_INVALID", message: t("sequence_quality_invalid", { code: built.error.code, detail: built.error.message }), details: { errors: built.error.errors } },
      );
    } else {
      quality = built.plan;
      qualitySource = built.source;
      blockers.push(...qualityPlanBlockers(built.plan));
    }
  }
  let semantic: SemanticPlan | null = null;
  let semanticRequest: GatePlan["semanticRequest"] = null;
  if (selection.gates.includes("semantic")) {
    const choices = request.semantic ?? {};
    const scope = choices.scope !== undefined ? choices.scope : quality ? semanticScopeFromQuality(quality.scope) : semanticScopeFromQuality(request.quality?.scope ? { requested: request.quality.scope, paths: request.quality.paths ?? [], base: request.quality.base ?? null, head: request.quality.head ?? null } : null);
    semanticRequest = { purpose: choices.purpose ?? null, rigor: choices.rigor ?? null, budget: choices.budget ?? null, scope };
    semantic = buildSemanticPlan({
      workspacePath: dir,
      home,
      env,
      ...(request.now ? { now: request.now } : {}),
      // In a combined selection the Quality report is attached after Quality ran (its run ID is not known yet).
      quality: isCombined(selection.gates) ? null : (request.attachQuality ?? null),
      ...(choices.purpose ? { purpose: choices.purpose } : {}),
      ...(choices.rigor ? { rigor: choices.rigor } : {}),
      ...(choices.budget ? { budget: choices.budget } : {}),
      scope,
    });
    for (const b of semantic.blockers) blockers.push({ gate: "semantic", code: b.code, message: b.message });
  }
  return {
    schemaVersion: 1,
    kind: "jgates-gate-plan",
    workspace: { id: workspaceId(dir), path: dir },
    selection,
    quality,
    qualitySource,
    qualityError,
    semantic,
    semanticSettingsHash: semantic ? semanticSettingsHash(semantic) : null,
    semanticRequest,
    advancement: { condition: isCombined(selection.gates) ? "quality-approved" : "none", qualityCoverage: selection.policy.qualityCoverage },
    ready: blockers.length === 0,
    blockers,
  };
}
