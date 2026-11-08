// The plan of an independent Semantic run: what will run (the methods), with which provider, model, scope and limits,
// what it needs first (its own prerequisites: a configured provider and the semantic-gate package) and which Quality
// report, if any, is attached as evidence. A Semantic-only run never needs a Quality run: the Quality history is not a
// prerequisite. The plan is deterministic for the same settings (planHash); building it never calls a provider.
import fs from "node:fs";
import path from "node:path";
import { listRuns } from "../artifacts/index.js";
import { resolveHome } from "../home/index.js";
import { contentHash, workspaceId } from "../ids/index.js";
import { readSemanticState, semanticPackageAvailable } from "../../adapters/semantic-gate/index.js";
import { translator } from "../../i18n/index.js";
// The registry of investigation modules (importing it registers every built-in module, the security-audit baseline too).
import { investigationModuleFor } from "../semantic-modules/index.js";
import { resolveSemanticScope, scopeControls, type ScopeControls, type ScopeRequest, type SemanticPurpose, type SemanticRigor, type SemanticScopeResolution } from "../semantic-scope/index.js";

const t = translator("semantic");
const ts = translator("semantic-scope");

/** The one method of this version: the general review of the semantic-gate package (T15+ add the investigation). */
export const GENERAL_REVIEW = "general-review";
/** The security-audit baseline (its module arrives with the security baseline; until then a plan names it as unavailable). */
export const SECURITY_AUDIT = "security-audit";

/** The methods each purpose plans; the scope controls are the same for all of them. */
export const PURPOSE_METHODS: Readonly<Record<SemanticPurpose, readonly string[]>> = { "general-review": [GENERAL_REVIEW], security: [SECURITY_AUDIT] };
/** Methods this build can execute as a context-only review (the investigation modules register their own). */
export const AVAILABLE_METHODS: ReadonlySet<string> = new Set([GENERAL_REVIEW]);
/** Whether this build can execute a method: a context-only review or a registered investigation module. */
export function methodAvailable(id: string): boolean {
  return AVAILABLE_METHODS.has(id) || investigationModuleFor([id]) !== null;
}
/** Methods that read the review context from the working tree (a context-only call, or a module's host tools). */
const WORKING_TREE_METHODS: ReadonlySet<string> = new Set([GENERAL_REVIEW, SECURITY_AUDIT]);

export interface SemanticBudget {
  maxCalls: number | null;
  maxTokens: number | null;
}

export interface SemanticPrerequisite {
  id: "provider" | "package" | "quality-history";
  ok: boolean;
  /** false: informative only (the Quality history is never required). */
  required: boolean;
  message: string;
}

export interface SemanticPlan {
  schemaVersion: 1;
  gate: "semantic";
  /** sha256 of what decides the run (methods, settings, attached Quality run), never of when it was built. */
  planHash: string;
  createdAt: string;
  workspace: { id: string; path: string };
  /** What the run is for; it decides the methods, never the scope. */
  purpose: SemanticPurpose;
  /** Depth of the examination; independent of the scope. */
  rigor: SemanticRigor;
  /** Consumption limits asked for this run (null: the settings' limits apply); independent of the scope. */
  budget: SemanticBudget;
  /** The resolved scope (subjects, context, impact, reuse, inherited coverage) and the controls that produced it. */
  scope: { controls: ScopeControls; resolution: SemanticScopeResolution };
  methods: Array<{ id: string }>;
  settings: {
    state: "off" | "configured" | "invalid";
    provider: string | null;
    model: string | null;
    scope: string | null;
    limits: { timeoutSeconds: number; maxContextChars: number; maxCalls: number } | null;
    costPerCall: number | null;
    problems: string[];
  };
  prerequisites: SemanticPrerequisite[];
  /** none: a Semantic-only run needs no Quality run. attached: the Quality run given as evidence (or null). */
  quality: { requirement: "none"; attached: string | null };
  ready: boolean;
  blockers: Array<{ code: string; message: string }>;
}

export interface SemanticPlanRequest {
  workspacePath: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** A Quality run to attach as evidence: its run ID, or "latest" for the newest finished Quality run. */
  quality?: string | null;
  purpose?: SemanticPurpose;
  rigor?: SemanticRigor;
  budget?: Partial<SemanticBudget> | null;
  /** The scope to resolve (full, the recommended default, when absent). */
  scope?: ScopeRequest | null;
}

/** Resolves a Quality run reference ("latest" or a run_ ID) in the Quality history; null when there is none. */
export function resolveQualityRun(home: string, wsId: string, ref: string): { runId: string; dir: string } | null {
  const runs = listRuns(home, wsId);
  const run = ref === "latest" ? runs.find((r) => !r.partial) : runs.find((r) => r.runId === ref);
  if (!run || !fs.existsSync(path.join(run.dir, "result.json"))) return null;
  return { runId: run.runId, dir: run.dir };
}

export function buildSemanticPlan(request: SemanticPlanRequest): SemanticPlan {
  const env = request.env ?? process.env;
  const home = request.home ?? resolveHome({ env });
  const workspacePath = path.resolve(request.workspacePath);
  const wsId = workspaceId(workspacePath);
  const state = readSemanticState(workspacePath, { env });
  const s = state.settings;
  const settings: SemanticPlan["settings"] = {
    state: state.state,
    provider: state.provider,
    model: state.model,
    scope: state.scope,
    limits: s ? { timeoutSeconds: s.timeoutSeconds, maxContextChars: s.maxContextChars, maxCalls: s.maxCalls } : null,
    costPerCall: s?.costPerCall ?? null,
    problems: state.problems,
  };
  const blockers: SemanticPlan["blockers"] = [];
  const providerOk = state.state === "configured";
  if (!providerOk) {
    blockers.push(
      state.state === "off"
        ? { code: "SEMANTIC_NOT_CONFIGURED", message: t("semantic_blocker_not_configured") }
        : { code: "SEMANTIC_SETTINGS_INVALID", message: t("semantic_blocker_invalid", { problems: state.problems.join("; ") }) },
    );
  }
  const packageOk = semanticPackageAvailable(env);
  if (!packageOk) blockers.push({ code: "SEMANTIC_PACKAGE_MISSING", message: t("semantic_blocker_package") });
  let attached: string | null = null;
  if (request.quality) {
    const found = resolveQualityRun(home, wsId, request.quality);
    if (found) attached = found.runId;
    else blockers.push({ code: "QUALITY_RUN_NOT_FOUND", message: t("semantic_blocker_quality_not_found", { ref: request.quality }) });
  }
  const prerequisites: SemanticPrerequisite[] = [
    { id: "provider", ok: providerOk, required: true, message: providerOk ? t("semantic_prereq_provider_ok", { provider: state.provider ?? "-" }) : (blockers[0]?.message ?? "") },
    { id: "package", ok: packageOk, required: true, message: t(packageOk ? "semantic_prereq_package_ok" : "semantic_blocker_package") },
    { id: "quality-history", ok: true, required: false, message: t("semantic_prereq_quality_none") },
  ];
  const purpose: SemanticPurpose = request.purpose ?? "general-review";
  const rigor: SemanticRigor = request.rigor ?? "standard";
  const budget: SemanticBudget = { maxCalls: request.budget?.maxCalls ?? null, maxTokens: request.budget?.maxTokens ?? null };
  const methodIds = [...(PURPOSE_METHODS[purpose] ?? [GENERAL_REVIEW])];
  const methods = methodIds.map((id) => ({ id }));
  for (const id of methodIds) {
    if (!methodAvailable(id)) blockers.push({ code: "SEMANTIC_METHOD_UNAVAILABLE", message: ts("scope_plan_method_unavailable", { method: id, purpose }) });
  }
  // The scope is resolved from the scope request alone: purpose, rigor and budget never enter it.
  const resolution = resolveSemanticScope({ workspacePath, request: request.scope ?? null, home, env, methods: methodIds });
  for (const b of resolution.blockers) blockers.push(b);
  if (resolution.blockers.length === 0 && !resolution.workingTreeMatchesTarget && methodIds.some((id) => WORKING_TREE_METHODS.has(id))) {
    blockers.push({ code: "SCOPE_TARGET_NOT_CHECKED_OUT", message: ts("scope_plan_target_not_checked_out") });
  }
  const scope = { controls: scopeControls(purpose), resolution };
  const planHash = contentHash({ v: 2, gate: "semantic", workspace: workspacePath, methods, settings, quality: attached, purpose, rigor, budget, scopeHash: resolution.scopeHash });
  return {
    schemaVersion: 1,
    gate: "semantic",
    planHash,
    createdAt: (request.now ?? (() => new Date()))().toISOString(),
    workspace: { id: wsId, path: workspacePath },
    purpose,
    rigor,
    budget,
    scope,
    methods,
    settings,
    prerequisites,
    quality: { requirement: "none", attached },
    ready: blockers.length === 0,
    blockers,
  };
}
