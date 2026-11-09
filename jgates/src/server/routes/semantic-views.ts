// Read-only views of the Semantic/AI area of the UI: the options of a run (saved settings, methods per purpose, rigor
// reserves, prerequisites), the AI mascots of one Semantic run, the results summary of one run (examined now / reused /
// unresolved / out of scope, scope completion apart from repository coverage, confirmation apart from severity, usage)
// and the mascots of a sequence, where each gate keeps its own family: the Quality snapshot comes only from the Quality
// projection (core/mascots) of the Quality run, the Semantic one only from core/semantic-mascots. Nothing here starts,
// changes or cancels a run (that is semantic-runs.ts), and every file is found by run ID, never by a path from the request.
import fs from "node:fs";
import path from "node:path";
import { INVESTIGATION_RECORD, RESERVE_FRACTION, DEFAULT_CALLS } from "../../core/semantic-executor/index.js";
import { projectSemanticMascots, type SemanticMascotSnapshot, type SemanticStageInput } from "../../core/semantic-mascots/index.js";
import { SEMANTIC_RUN_ID_PATTERN, buildSemanticPlan, readSemanticRun, resolveQualityRun, semanticMethodCatalog, type SemanticRunView } from "../../core/semantic/index.js";
import { SCOPE_LEDGER_FILE, SCOPE_RECORD_FILE, SEMANTIC_PURPOSES, SEMANTIC_RIGORS, type SemanticPurpose } from "../../core/semantic-scope/index.js";
import { SEQUENCE_ID_PATTERN, readSequence } from "../../core/sequence/index.js";
import type { RunResult } from "../../core/run/types.js";
import { translator } from "../../i18n/index.js";
import { HttpError, refuse } from "../http.js";
import { runMascots } from "../mascots.js";
import type { RouteDefinition, ServerContext } from "../types.js";

const tSequence = translator("sequence");

type Rec = Record<string, unknown>;

const runParams = { type: "object", properties: { id: { type: "string", pattern: SEMANTIC_RUN_ID_PATTERN } }, required: ["id"], additionalProperties: false };
const sequenceParams = { type: "object", properties: { id: { type: "string", pattern: SEQUENCE_ID_PATTERN } }, required: ["id"], additionalProperties: false };

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A JSON file inside a run folder (null when it is missing, unreadable or not an object; symlinks are not followed). */
function readRunJson(dir: string, rel: string): Rec | null {
  const file = path.join(dir, ...rel.split("/"));
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return isRec(value) ? value : null;
  } catch {
    return null;
  }
}

function semanticRunOr404(server: ServerContext, id: string): SemanticRunView {
  const view = readSemanticRun(server.home, server.workspace.id, id);
  if (!view) throw refuse(404, "RUN_NOT_FOUND", { runId: id });
  return view;
}

/** The investigation record of a run: the final one in the outcome, else the checkpoint the executor writes while it goes. */
function investigationOf(view: SemanticRunView): Rec | null {
  const fromOutcome = view.result?.semanticRun?.outcome?.investigation;
  if (isRec(fromOutcome)) return fromOutcome;
  return readRunJson(view.dir, INVESTIGATION_RECORD);
}

/**
 * The stage records the AI mascots are projected from, all from the run's own files: the run's steps (the context step
 * and the review step) and, when the review is an investigation, its module stages instead of the single review step.
 */
export function semanticStagesOf(view: SemanticRunView): SemanticStageInput[] {
  const steps = list(view.result?.stages).filter(isRec);
  const investigation = investigationOf(view);
  const moduleId = isRec(investigation?.module) && typeof investigation.module.id === "string" ? investigation.module.id : null;
  const moduleStages = list(investigation?.stages)
    .filter(isRec)
    .filter((s) => typeof s.id === "string" && typeof s.state === "string")
    .map((s): SemanticStageInput => ({
      id: moduleId && !String(s.id).includes("/") ? `${moduleId}/${String(s.id)}` : String(s.id),
      state: String(s.state),
      ...(typeof s.required === "boolean" ? { required: s.required } : {}),
      ...(typeof s.role === "string" ? { role: s.role } : {}),
      ...(s.verify === true || s.mode === "verify" ? { verify: true } : {}),
    }));
  const out: SemanticStageInput[] = [];
  for (const step of steps) {
    const id = typeof step.id === "string" ? step.id : null;
    if (!id) continue;
    // The review step is the investigation itself: its module stages say who did what.
    if (id === "semantic-review" && moduleStages.length > 0) {
      out.push(...moduleStages);
      continue;
    }
    out.push({ id, state: typeof step.state === "string" ? step.state : "pending", required: true });
  }
  if (steps.length === 0) out.push(...moduleStages);
  return out;
}

/** The AI mascots of one Semantic run, from its actual state (live heartbeat, cancel, stage records). */
export function semanticMascotsOf(view: SemanticRunView): SemanticMascotSnapshot {
  const result = view.result;
  const cancelled = result?.stopped?.cause === "cancelled" || (result?.partial !== true && result?.decision === "cancelled");
  return projectSemanticMascots({ stages: semanticStagesOf(view), runId: view.runId, running: view.lifecycle === "running", cancelled });
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const ratio = (part: number, whole: number): number | null => (whole > 0 ? Math.min(1, part / whole) : null);

/** The results summary of one Semantic run, built from the run's records (plan, scope, ledger, outcome). */
export function semanticReportOf(view: SemanticRunView): Rec {
  const result = view.result;
  const outcome = result?.semanticRun?.outcome ?? null;
  const plan = view.plan;
  const planScope = isRec(plan?.scope) && isRec(plan.scope.resolution) ? plan.scope.resolution : null;
  const completion = isRec(planScope?.completion) ? planScope.completion : null;
  const scopeRecord = readRunJson(view.dir, SCOPE_RECORD_FILE);
  const units = isRec(scopeRecord?.units) ? scopeRecord.units : null;
  const ledger = readRunJson(view.dir, SCOPE_LEDGER_FILE);
  const ledgerUnits = list(ledger?.units).filter(isRec);
  const unitIds = (v: unknown): string[] => list(v).filter(isRec).map((u) => String(u.id ?? "")).filter(Boolean);
  const examined = unitIds(units?.examined);
  const reused = unitIds(units?.reused);
  const omitted = list(units?.omitted).filter(isRec).map((u) => ({ id: String(u.id ?? ""), reason: String(u.reason ?? "") }));
  const excluded = isRec(planScope?.exclusions) ? list(planScope.exclusions.excluded).filter(isRec).map((e) => ({ id: String(e.path ?? ""), reason: isRec(e.reason) ? String(e.reason.message ?? "") : "" })) : [];
  const unresolved = ledgerUnits.filter((u) => u.state === "unresolved").map((u) => ({ id: String(u.id ?? ""), reason: isRec(u.reason) ? String(u.reason.message ?? "") : "" }));
  const withFindings = ledgerUnits.filter((u) => u.state === "findings").map((u) => String(u.id ?? ""));
  const subjects = count(completion?.subjects);
  const repositoryFiles = count(completion?.repositoryFiles);
  const covered = examined.length + reused.length;
  const investigation = investigationOf(view);
  const coverage = isRec(investigation?.coverage) ? investigation.coverage : null;
  const conclusion = isRec(outcome?.conclusion) ? outcome.conclusion : null;
  const findings = list(conclusion?.findings)
    .filter(isRec)
    .map((f) => ({
      severity: String(f.severity ?? "unknown"),
      confirmation: typeof f.confirmation === "string" ? f.confirmation : "needs-validation",
      category: String(f.category ?? "general"),
      message: String(f.message ?? ""),
      path: typeof f.path === "string" ? f.path : null,
      line: typeof f.line === "number" ? f.line : null,
    }));
  const byConfirmation: Record<string, number> = { confirmed: 0, "needs-validation": 0, rejected: 0 };
  for (const f of findings) byConfirmation[f.confirmation] = (byConfirmation[f.confirmation] ?? 0) + 1;
  const bySeverity: Record<string, number> = {};
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  const usage = isRec(investigation?.usage) ? investigation.usage : null;
  const budget = isRec(investigation?.budget) ? investigation.budget : null;
  return {
    runId: view.runId,
    lifecycle: view.lifecycle,
    decision: view.decision,
    complete: view.complete,
    partial: view.partial,
    reviewState: view.reviewState,
    reason: typeof outcome?.reason === "string" ? outcome.reason : null,
    summary: typeof result?.summary === "string" ? result.summary : null,
    purpose: typeof plan?.purpose === "string" ? plan.purpose : null,
    rigor: typeof plan?.rigor === "string" ? plan.rigor : null,
    methods: result?.semanticRun?.methods ?? [],
    provider: view.provider,
    model: view.model,
    mode: typeof planScope?.mode === "string" ? planScope.mode : null,
    units: {
      examinedNow: examined,
      reused,
      unresolved,
      outOfScope: [...excluded, ...omitted],
      withFindings,
    },
    scope: {
      subjects,
      toExamine: count(completion?.toExamine),
      covered,
      repositoryFiles,
      claim: typeof completion?.claim === "string" ? completion.claim : null,
      /** Share of the declared scope that was examined now or carried by reuse: never the repository's coverage. */
      completion: ratio(covered, subjects),
      /** Share of the repository's files that this run's conclusions cover. */
      repositoryCoverage: ratio(covered, repositoryFiles),
      inheritedCoverage: isRec(planScope?.inheritedCoverage) ? planScope.inheritedCoverage.state ?? null : null,
    },
    investigation: coverage
      ? { basis: coverage.basis ?? null, subjects: count(coverage.subjects), examined: count(coverage.examined), notExamined: count(coverage.notExamined), gaps: list(coverage.gaps).filter(isRec).slice(0, 200) }
      : null,
    findings,
    confirmation: byConfirmation,
    severity: bySeverity,
    usage: {
      calls: count(outcome?.calls),
      durationMs: typeof outcome?.durationMs === "number" ? outcome.durationMs : null,
      cost: outcome?.cost ?? null,
      tokens: usage && isRec(usage.tokens) ? { input: count(usage.tokens.input), output: count(usage.tokens.output), reported: usage.tokens.reported === true } : null,
      budget: budget ? { limits: budget.limits ?? null, reserve: budget.reserve ?? null, exhausted: budget.exhausted ?? null } : null,
    },
  };
}

export const routes: RouteDefinition[] = [
  {
    // What the configuration and setup screens offer: the saved settings (jgates.yml), the methods each purpose plans,
    // the rigors with their validation reserve and default call budget, the prerequisites and the blockers.
    method: "GET",
    path: "/api/semantic/options",
    query: { type: "object", properties: { purpose: { enum: [...SEMANTIC_PURPOSES] } }, additionalProperties: false },
    handler({ query, server }) {
      const purpose = (query.purpose as SemanticPurpose | undefined) ?? "general-review";
      const plan = buildSemanticPlan({ workspacePath: server.workspace.path, home: server.home, purpose });
      const latest = resolveQualityRun(server.home, server.workspace.id, "latest");
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          gate: "semantic",
          purpose,
          purposes: [...SEMANTIC_PURPOSES],
          rigors: SEMANTIC_RIGORS.map((id) => ({ id, reserve: RESERVE_FRACTION[id], defaultCalls: DEFAULT_CALLS[id] })),
          methods: plan.methods,
          // Every method this build knows (the setup offers them for an explicit selection), with availability.
          catalog: semanticMethodCatalog(),
          settings: plan.settings,
          controls: plan.scope.controls,
          prerequisites: plan.prerequisites,
          ready: plan.ready,
          blockers: plan.blockers,
          latestQualityRun: latest?.runId ?? null,
        },
      };
    },
  },
  {
    method: "GET",
    path: "/api/semantic/runs/:id/mascots",
    params: runParams,
    handler({ params, server }) {
      const view = semanticRunOr404(server, params.id as string);
      return { status: 200, json: { schemaVersion: 1, status: "OK", gate: "semantic", runId: view.runId, lifecycle: view.lifecycle, mascots: semanticMascotsOf(view) } };
    },
  },
  {
    method: "GET",
    path: "/api/semantic/runs/:id/report",
    params: runParams,
    handler({ params, server }) {
      const view = semanticRunOr404(server, params.id as string);
      return { status: 200, json: { schemaVersion: 1, status: "OK", gate: "semantic", report: semanticReportOf(view), mascots: semanticMascotsOf(view) } };
    },
  },
  {
    // The mascots of a sequence, one family per gate: Quality's six domains from its own run, the four AI mascots from
    // the Semantic run. A gate the sequence has not started yet has no snapshot (null).
    method: "GET",
    path: "/api/sequences/:id/mascots",
    params: sequenceParams,
    handler({ params, server }) {
      const id = params.id as string;
      const sequence = readSequence(server.home, server.workspace.id, id);
      if (!sequence) {
        const key = "sequence_api_sequence_not_found";
        throw new HttpError(404, "SEQUENCE_NOT_FOUND", tSequence(key, { id }), null, {});
      }
      const qualityRef = sequence.record.runs.find((r) => r.gate === "quality") ?? null;
      const semanticRef = sequence.record.runs.find((r) => r.gate === "semantic") ?? null;
      let quality: Rec | null = null;
      if (qualityRef) {
        const found = resolveQualityRun(server.home, server.workspace.id, qualityRef.runId);
        let result: RunResult | null = null;
        try {
          result = found ? (JSON.parse(fs.readFileSync(path.join(found.dir, "result.json"), "utf8")) as RunResult) : null;
        } catch {
          result = null;
        }
        quality = runMascots(server, qualityRef.runId, result, { orphan: result?.partial === true }) as unknown as Rec;
      }
      const semanticView = semanticRef ? readSemanticRun(server.home, server.workspace.id, semanticRef.runId) : null;
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          sequenceId: id,
          runs: sequence.record.runs,
          quality: quality ? { runId: qualityRef?.runId ?? null, mascots: quality } : null,
          semantic: semanticView ? { runId: semanticView.runId, mascots: semanticMascotsOf(semanticView) } : null,
        },
      };
    },
  },
];
