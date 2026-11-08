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

const t = translator("semantic");

/** The one method of this version: the general review of the semantic-gate package (T15+ add the investigation). */
export const GENERAL_REVIEW = "general-review";

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
  const methods = [{ id: GENERAL_REVIEW }];
  const planHash = contentHash({ v: 1, gate: "semantic", workspace: workspacePath, methods, settings, quality: attached });
  return {
    schemaVersion: 1,
    gate: "semantic",
    planHash,
    createdAt: (request.now ?? (() => new Date()))().toISOString(),
    workspace: { id: wsId, path: workspacePath },
    methods,
    settings,
    prerequisites,
    quality: { requirement: "none", attached },
    ready: blockers.length === 0,
    blockers,
  };
}
