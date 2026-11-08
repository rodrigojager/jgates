// Whether a Quality run lets a combined sequence advance to Semantic. The answer comes only from facts the Quality run
// already records through the core decision (core/contract computeDecision): its decision, complete, reduced and partial
// fields, the state of its stages, its own source identity (run.json) compared with the current source, the scope its
// plan declared and executed, and the sequence policy. There is no separate UI rule: the CLI, the server and the screens
// read this one assessment. Failure, incomplete or partial evidence, reduced runs, invalid configuration, cancellation,
// errors, timeouts, a changed or unverifiable source and a scope the policy does not accept never advance; optional
// warnings never block when the decision passed. The assessment never rewrites the Quality decision: it copies it.
import type { SourceMatchCode } from "../gates/source.js";
import { sourceMatch } from "../gates/source.js";
import type { EvidenceFreshness, GateRunIdentity, SourceIdentity } from "../gates/types.js";
import type { PlanScopeKind } from "../plan/types.js";
import type { RunResult } from "../run/types.js";
import { translator } from "../../i18n/index.js";
import type { QualityCoveragePolicy } from "./selection.js";

const t = translator("sequence");

export type AssessmentStatus = "advance" | "paused" | "stopped" | "cancelled";

/** The scope a Quality run declared and executed, and what it covers: scope completion is not repository coverage. */
export interface QualityScopeReport {
  requested: PlanScopeKind | null;
  effective: PlanScopeKind | null;
  paths: string[];
  base: string | null;
  head: string | null;
  /** Why the executed scope differs from the requested one (a tool that only runs on the whole repository). */
  note: string | null;
  /** complete: every required check of the declared scope finished and was satisfied. */
  completion: "complete" | "incomplete";
  /** repository: the run examined the whole repository; declared-scope: only what it declared; none: unknown. */
  repositoryCoverage: "repository" | "declared-scope" | "none";
  /** Whether the Quality scope covers the Semantic subjects (null without a Semantic scope to compare). */
  coversSemantic: boolean | null;
  /** Semantic subjects outside the Quality scope ("*" for a Semantic scope of the whole repository). */
  uncoveredSubjects: string[];
}

export interface QualityAssessment {
  schemaVersion: 1;
  approved: boolean;
  status: AssessmentStatus;
  /** QUALITY_APPROVED, or the first reason it was refused. */
  code: string;
  message: string;
  /** Every reason the advancement was refused, in order of precedence. */
  reasons: Array<{ code: string; message: string }>;
  quality: {
    runId: string;
    /** The Quality run's own decision fields, copied as recorded (never rewritten). */
    decision: string | null;
    complete: boolean;
    reduced: boolean;
    partial: boolean;
    exitCode: number | null;
    /** Required stages that did not finish well (state error, timeout, blocked, cancelled...). */
    problemStages: Array<{ id: string; state: string; reason: string | null }>;
    warnings: number;
  };
  freshness: {
    state: EvidenceFreshness;
    code: SourceMatchCode | "SOURCE_NOT_RECORDED" | "SOURCE_NOT_COMPUTED";
    qualitySourceId: string | null;
    currentSourceId: string | null;
    /** run-identity: the Quality run recorded its source (run.json); derived: read from an older result.json. */
    recorded: "run-identity" | "derived" | "none";
  };
  scope: QualityScopeReport;
  policy: { qualityCoverage: QualityCoveragePolicy };
  checkedAt: string;
}

/** What a Quality run left on disk, as the assessment reads it. */
export interface QualityEvidence {
  runId: string;
  result: RunResult | null;
  /** The run identity: its run.json when the producer wrote one, else derived from result.json. */
  identity: GateRunIdentity | null;
  identityRecorded: boolean;
  /** The scope block of the plan the run executed (plan.json), when it was kept. */
  planScope: { requested: PlanScopeKind; effective: PlanScopeKind; paths: string[]; base: string | null; head: string | null; note: string | null } | null;
}

/** The Semantic scope the sequence would run, to check that the Quality scope covers it. */
export interface SemanticScopeShape {
  mode: "full" | "selected" | "incremental";
  /** Selected: the subjects (workspace-relative paths). */
  subjects: string[];
  base: string | null;
}

export interface AssessInput {
  quality: QualityEvidence;
  /** The source identity as it is now (null when it could not be computed). */
  current: SourceIdentity | null;
  policy: QualityCoveragePolicy;
  semanticScope: SemanticScopeShape | null;
  now?: Date;
}

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");

/** A subject inside a declared path (the path itself or below it). */
function within(subject: string, root: string): boolean {
  const s = norm(subject);
  const r = norm(root);
  return r === "" || r === "." || s === r || s.startsWith(`${r}/`);
}

/** The scope report of a Quality run against the Semantic scope (scope completion kept apart from repository coverage). */
export function qualityScopeReport(evidence: QualityEvidence, semantic: SemanticScopeShape | null): QualityScopeReport {
  const scope = evidence.planScope;
  const result = evidence.result;
  const completion: QualityScopeReport["completion"] = result && result.complete === true && result.partial !== true ? "complete" : "incomplete";
  const effective = scope?.effective ?? null;
  const repositoryCoverage: QualityScopeReport["repositoryCoverage"] = effective === "full" ? "repository" : effective === null ? "none" : "declared-scope";
  let uncovered: string[] = [];
  let covers: boolean | null = null;
  if (semantic) {
    if (repositoryCoverage === "repository") uncovered = [];
    else if (repositoryCoverage === "none") uncovered = semantic.mode === "selected" ? [...semantic.subjects] : ["*"];
    else if (effective === "paths") {
      uncovered = semantic.mode === "selected" ? semantic.subjects.filter((s) => !(scope?.paths ?? []).some((p) => within(s, p))) : ["*"];
    } else if (effective === "changed") {
      // A changed-files Quality run covers an incremental Semantic run of the same comparison anchor, nothing wider.
      uncovered = semantic.mode === "incremental" && semantic.base !== null && semantic.base === (scope?.base ?? null) ? [] : semantic.mode === "selected" ? [...semantic.subjects] : ["*"];
    }
    covers = uncovered.length === 0;
  }
  return {
    requested: scope?.requested ?? null,
    effective,
    paths: [...(scope?.paths ?? [])],
    base: scope?.base ?? null,
    head: scope?.head ?? null,
    note: scope?.note ?? null,
    completion,
    repositoryCoverage,
    coversSemantic: covers,
    uncoveredSubjects: uncovered,
  };
}

const NOT_OK = new Set(["error", "timeout", "blocked", "cancelled", "pending", "running"]);

/** Assesses the Quality prerequisite of a combined sequence. Pure: reads only what it is given. */
export function assessQualityPrerequisite(input: AssessInput): QualityAssessment {
  const { quality } = input;
  const result = quality.result;
  const now = input.now ?? new Date();
  const reasons: Array<{ code: string; message: string }> = [];
  const add = (code: string, params: Record<string, string | number> = {}): void => void reasons.push({ code, message: t(`sequence_reason_${code.toLowerCase()}`, { runId: quality.runId, ...params }) });
  const required = new Set((result?.requirements ?? []).filter((r) => r.required).map((r) => r.id));
  const problemStages = (result?.stages ?? [])
    .filter((s) => NOT_OK.has(s.state) && (required.size === 0 || required.has(s.requirementId ?? s.id)))
    .map((s) => ({ id: s.id, state: s.state, reason: s.reason ?? null }));
  const partial = result?.partial === true;

  if (!result) add("QUALITY_RUN_UNREADABLE");
  else {
    if (partial) add("QUALITY_PARTIAL");
    switch (result.decision) {
      case "cancelled":
        add("QUALITY_CANCELLED");
        break;
      case "invalid":
        add("QUALITY_INVALID");
        break;
      case "failed":
        add("QUALITY_FAILED", { count: result.blockingViolations ?? 0 });
        break;
      default:
        break;
    }
    if (result.decision !== "cancelled") {
      const timeouts = problemStages.filter((s) => s.state === "timeout");
      const errors = problemStages.filter((s) => s.state === "error");
      if (timeouts.length > 0) add("QUALITY_TIMEOUT", { stages: timeouts.map((s) => s.id).join(", ") });
      if (errors.length > 0) add("QUALITY_ERROR", { stages: errors.map((s) => s.id).join(", ") });
    }
    if ((result.decision === "incomplete" || result.complete !== true) && !["cancelled", "invalid"].includes(result.decision) && !partial) {
      add("QUALITY_INCOMPLETE", { count: result.unsatisfied?.length ?? 0 });
    }
    if (result.reduced === true) add("QUALITY_REDUCED");
    if (result.decision !== "passed" && !reasons.length) add("QUALITY_NOT_PASSED", { decision: String(result.decision) });
  }

  // Freshness: the Quality run's own source identity against the source as it is now.
  let freshness: QualityAssessment["freshness"];
  const recorded: QualityAssessment["freshness"]["recorded"] = quality.identity ? (quality.identityRecorded ? "run-identity" : "derived") : "none";
  if (!quality.identity) {
    freshness = { state: "unknown", code: "SOURCE_NOT_RECORDED", qualitySourceId: null, currentSourceId: input.current?.id ?? null, recorded };
  } else if (!input.current) {
    freshness = { state: "unknown", code: "SOURCE_NOT_COMPUTED", qualitySourceId: quality.identity.source.id, currentSourceId: null, recorded };
  } else {
    const match = sourceMatch(quality.identity.source, input.current);
    freshness = {
      state: match.same ? "current" : match.code === "DIFFERENT_SOURCE" ? "stale" : "unknown",
      code: match.code,
      qualitySourceId: quality.identity.source.id,
      currentSourceId: input.current.id,
      recorded,
    };
  }
  const sourceReasons: string[] = [];
  if (freshness.state === "stale") {
    add("SOURCE_CHANGED");
    sourceReasons.push("SOURCE_CHANGED");
  } else if (freshness.state === "unknown") {
    add("SOURCE_UNVERIFIABLE", { code: freshness.code });
    sourceReasons.push("SOURCE_UNVERIFIABLE");
  }

  // Scope: completion of the declared scope is not repository coverage; the policy says which one is required.
  const scope = qualityScopeReport(quality, input.semanticScope);
  if (scope.repositoryCoverage !== "repository") {
    if (input.policy === "repository") add("QUALITY_SCOPE_NOT_PERMITTED", { scope: scope.effective ?? "-" });
    else if (scope.coversSemantic === false) add("QUALITY_SCOPE_MISMATCH", { subjects: scope.uncoveredSubjects.slice(0, 10).join(", ") });
  }

  const approved = reasons.length === 0;
  let status: AssessmentStatus = "advance";
  if (!approved) {
    if (result?.decision === "cancelled") status = "cancelled";
    else if (reasons.every((r) => sourceReasons.includes(r.code))) status = "paused";
    else status = "stopped";
  }
  const first = reasons[0];
  return {
    schemaVersion: 1,
    approved,
    status,
    code: approved ? "QUALITY_APPROVED" : (first?.code ?? "QUALITY_NOT_PASSED"),
    message: approved ? t("sequence_reason_quality_approved", { runId: quality.runId }) : (first?.message ?? ""),
    reasons,
    quality: {
      runId: quality.runId,
      decision: result?.decision ?? null,
      complete: result?.complete === true,
      reduced: result?.reduced === true,
      partial,
      exitCode: typeof result?.exitCode === "number" ? result.exitCode : null,
      problemStages,
      warnings: result?.warnings?.length ?? 0,
    },
    freshness,
    scope,
    policy: { qualityCoverage: input.policy },
    checkedAt: now.toISOString(),
  };
}

/** Coverage of a whole sequence: each gate's scope completion next to its repository coverage, never a blanket claim. */
export interface SequenceCoverage {
  quality: QualityScopeReport | null;
  semantic: {
    mode: SemanticScopeShape["mode"];
    subjects: number;
    completion: "complete" | "incomplete" | "not-run";
    repositoryCoverage: "repository" | "declared-scope";
  } | null;
  /** What the sequence approved, at most: the whole repository only when both gates covered it and completed. */
  approvedScope: "repository" | "declared-scope" | "none";
  /** Always false: a sequence never claims the repository is safe, only what each gate checked. */
  blanketClaim: false;
  message: string;
}

export function sequenceCoverage(
  quality: QualityScopeReport | null,
  semantic: { mode: SemanticScopeShape["mode"]; subjects: number; result: Pick<RunResult, "decision" | "complete" | "partial"> | null } | null,
  approved: boolean,
): SequenceCoverage {
  const semanticReport = semantic
    ? {
        mode: semantic.mode,
        subjects: semantic.subjects,
        completion: (semantic.result ? (semantic.result.complete === true && semantic.result.partial !== true ? "complete" : "incomplete") : "not-run") as "complete" | "incomplete" | "not-run",
        repositoryCoverage: (semantic.mode === "full" ? "repository" : "declared-scope") as "repository" | "declared-scope",
      }
    : null;
  const passedBoth = approved && semantic?.result?.decision === "passed" && semanticReport?.completion === "complete";
  const approvedScope: SequenceCoverage["approvedScope"] = !passedBoth
    ? "none"
    : quality?.repositoryCoverage === "repository" && semanticReport?.repositoryCoverage === "repository"
      ? "repository"
      : "declared-scope";
  return {
    quality,
    semantic: semanticReport,
    approvedScope,
    blanketClaim: false,
    message: t(`sequence_coverage_${approvedScope.replace("-", "_")}`),
  };
}
