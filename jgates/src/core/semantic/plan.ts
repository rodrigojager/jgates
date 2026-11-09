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
import { investigationModuleFor, SEMANTIC_MODULES, unavailableModules } from "../semantic-modules/index.js";
import { prepareScopeRun, resolveSemanticScope, scopeControls, type ScopeControls, type ScopeRequest, type SemanticPurpose, type SemanticRigor, type SemanticScopeResolution } from "../semantic-scope/index.js";
import { semanticRunsDir } from "./store.js";

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
/** At most this many methods in one selection (each one becomes its own Semantic run). */
export const MAX_SELECTED_METHODS = 9;
/** A method ID as the CLI, the API and the UI accept it. */
export const METHOD_ID_PATTERN = "^[a-z][a-z0-9-]{1,63}$";

/** One selectable Semantic method: built-in modules (available or not) and the context-only review. */
export interface SemanticMethodInfo {
  id: string;
  title: string;
  /** Whether this build can execute it (its module was built, or it is a context-only review). */
  available: boolean;
  /** Why it cannot run (its module's material is missing). */
  reason: string | null;
  /** The purposes that plan it by default (empty: only an explicit selection runs it). */
  purposes: SemanticPurpose[];
  /** Whether the method checks its own applicability before any context starts. */
  checksApplicability: boolean;
}

/** Every Semantic method this build knows, in the registry's order. */
export function semanticMethodCatalog(): SemanticMethodInfo[] {
  const purposesOf = (id: string): SemanticPurpose[] => (Object.entries(PURPOSE_METHODS) as Array<[SemanticPurpose, readonly string[]]>).filter(([, ids]) => ids.includes(id)).map(([p]) => p);
  return SEMANTIC_MODULES.map((entry) => {
    const module = investigationModuleFor([entry.method]);
    const missing = unavailableModules.find((u) => u.method === entry.method);
    return {
      id: entry.method,
      title: module?.title ?? entry.method,
      available: methodAvailable(entry.method),
      reason: missing ? missing.reason : null,
      purposes: purposesOf(entry.method),
      checksApplicability: typeof module?.applicability === "function",
    };
  });
}

/** Whether a method of the plan applies to this scope, as its module's own check answers before any context starts. */
export interface MethodApplicability {
  /** always: the module has no check. unchecked: not previewed (method unavailable, or the scope is blocked). */
  state: "applicable" | "not-applicable" | "always" | "unchecked" | "error";
  code?: string;
  missing?: string;
  reason?: string;
}

export interface PlannedMethod {
  id: string;
  title: string;
  available: boolean;
  /** purpose: the purpose's default; explicit: named by --method / methods. */
  selectedBy: "purpose" | "explicit";
  /** The preview of the method's applicability check (the run checks it again with its own settings). */
  applicability: MethodApplicability;
}

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
  /** The purpose shortcut that picked the methods (CLI --purpose / API purpose); null when methods were named, and for the UI. */
  purpose: SemanticPurpose | null;
  /** Depth of the examination; independent of the scope. */
  rigor: SemanticRigor;
  /** Consumption limits asked for this run (null: the settings' limits apply); independent of the scope. */
  budget: SemanticBudget;
  /** The resolved scope (subjects, context, impact, reuse, inherited coverage) and the controls that produced it. */
  scope: { controls: ScopeControls; resolution: SemanticScopeResolution };
  /** The methods to run, in order; with more than one, each one runs as its own Semantic run (one sem_ ID each). */
  methods: PlannedMethod[];
  /** purpose: the purpose decided the methods; explicit: the caller named them. */
  methodSelection: "purpose" | "explicit";
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
  /** Methods named explicitly (in order); absent or empty: the purpose's methods. */
  methods?: readonly string[] | null;
}

/**
 * The applicability of each method, as its module's own check answers on this scope (host-only, nothing is sent): the
 * same check the run does before any context starts, here without the run's provider settings (their read refusals).
 */
function previewApplicability(ids: readonly string[], options: { workspacePath: string; resolution: SemanticScopeResolution; rigor: SemanticRigor; env: NodeJS.ProcessEnv; home: string; wsId: string }): Map<string, MethodApplicability> {
  const out = new Map<string, MethodApplicability>();
  const checked = ids.filter((id) => typeof investigationModuleFor([id])?.applicability === "function");
  for (const id of ids) {
    const module = investigationModuleFor([id]);
    if (!methodAvailable(id)) out.set(id, { state: "unchecked", reason: "the method is not available in this build" });
    else if (!module?.applicability) out.set(id, { state: "always" });
  }
  if (checked.length === 0) return out;
  if (options.resolution.blockers.length > 0) {
    for (const id of checked) out.set(id, { state: "unchecked", reason: "the scope is blocked" });
    return out;
  }
  let prep: ReturnType<typeof prepareScopeRun>;
  try {
    prep = prepareScopeRun({ workspacePath: options.workspacePath, resolution: options.resolution, methods: ids, env: options.env });
  } catch (error) {
    for (const id of checked) out.set(id, { state: "unchecked", reason: `the scope could not be prepared: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}` });
    return out;
  }
  const readable = (p: string): boolean => prep.guard.check(p).allowed;
  const readFile = (p: string): string | null => {
    try {
      return readable(p) ? prep.guard.read(p) : null;
    } catch {
      return null;
    }
  };
  // A folder that is never created: a module that looks at earlier runs sees the workspace's Semantic history.
  const runDir = path.join(semanticRunsDir(options.home, options.wsId), "plan-preview");
  for (const id of checked) {
    const module = investigationModuleFor([id]);
    try {
      const answer = module!.applicability!({ scope: prep, rigor: options.rigor, runDir, workspacePath: options.workspacePath, env: options.env, readableFiles: () => prep.guard.readable(), readable, readFile });
      out.set(id, answer.applicable ? { state: "applicable" } : { state: "not-applicable", code: answer.code, missing: answer.missing, reason: answer.reason.slice(0, 600) });
    } catch (error) {
      out.set(id, { state: "error", code: "APPLICABILITY_CHECK_FAILED", reason: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    }
  }
  return out;
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
  const explicit = (request.methods ?? []).filter((m) => typeof m === "string" && m !== "");
  const methodSelection: SemanticPlan["methodSelection"] = explicit.length > 0 ? "explicit" : "purpose";
  const methodIds = methodSelection === "explicit" ? [...new Set(explicit)] : [...(PURPOSE_METHODS[purpose] ?? [GENERAL_REVIEW])];
  const catalog = semanticMethodCatalog();
  if (methodIds.length > MAX_SELECTED_METHODS) blockers.push({ code: "SEMANTIC_TOO_MANY_METHODS", message: t("semantic_blocker_too_many_methods", { count: methodIds.length, max: MAX_SELECTED_METHODS }) });
  for (const id of methodIds) {
    if (!catalog.some((m) => m.id === id) && !AVAILABLE_METHODS.has(id)) blockers.push({ code: "SEMANTIC_METHOD_UNKNOWN", message: t("semantic_blocker_method_unknown", { method: id, known: catalog.map((m) => m.id).join(", ") }) });
    else if (!methodAvailable(id)) blockers.push({ code: "SEMANTIC_METHOD_UNAVAILABLE", message: ts("scope_plan_method_unavailable", { method: id }) });
  }
  // The scope is resolved from the scope request alone: purpose, rigor and budget never enter it.
  const resolution = resolveSemanticScope({ workspacePath, request: request.scope ?? null, home, env, methods: methodIds });
  for (const b of resolution.blockers) blockers.push(b);
  if (resolution.blockers.length === 0 && !resolution.workingTreeMatchesTarget && methodIds.some((id) => WORKING_TREE_METHODS.has(id))) {
    blockers.push({ code: "SCOPE_TARGET_NOT_CHECKED_OUT", message: ts("scope_plan_target_not_checked_out") });
  }
  const applicability = previewApplicability(methodIds, { workspacePath, resolution, rigor, env, home, wsId });
  const methods: PlannedMethod[] = methodIds.map((id) => {
    const info = catalog.find((m) => m.id === id);
    return { id, title: info?.title ?? id, available: methodAvailable(id), selectedBy: methodSelection, applicability: applicability.get(id) ?? { state: "unchecked" } };
  });
  const scope = { controls: scopeControls(purpose), resolution };
  // The hash covers what decides the run: the method IDs, never the applicability preview (the run checks it again).
  // The purpose is only a shortcut for a method list, so it never enters the hash: `--purpose security` and `--method security-audit` plan the same run.
  const planHash = contentHash({ v: 2, gate: "semantic", workspace: workspacePath, methods: methodIds.map((id) => ({ id })), settings, quality: attached, rigor, budget, scopeHash: resolution.scopeHash });
  return {
    schemaVersion: 1,
    gate: "semantic",
    planHash,
    createdAt: (request.now ?? (() => new Date()))().toISOString(),
    workspace: { id: wsId, path: workspacePath },
    purpose: methodSelection === "explicit" || !request.purpose ? null : purpose,
    rigor,
    budget,
    scope,
    methods,
    methodSelection,
    settings,
    prerequisites,
    quality: { requirement: "none", attached },
    ready: blockers.length === 0,
    blockers,
  };
}
