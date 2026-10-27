// Result contract of a JGates run.
// Pure and fail-closed: the decision is computed from facts, never assumed.

export const RESULT_SCHEMA_VERSION = 1;

export const STAGE_STATES = [
  "pending",
  "running",
  "completed",
  "not_applicable",
  "disabled",
  "blocked",
  "error",
  "timeout",
  "cancelled",
] as const;
export type StageState = (typeof STAGE_STATES)[number];

export const DECISIONS = ["passed", "failed", "incomplete", "invalid", "cancelled"] as const;
export type Decision = (typeof DECISIONS)[number];

export const DISABLE_ORIGINS = ["template", "profile", "project", "component", "run"] as const;
export type DisableOrigin = (typeof DISABLE_ORIGINS)[number];

export const EXIT_CODES = {
  passed: 0,
  failed: 1,
  incomplete: 2,
  invalid: 3,
  internal: 4,
  cancelled: 130,
} as const;

export interface StageResult {
  id: string;
  /** Requirement this stage evidences; defaults to the stage id. */
  requirementId?: string;
  state: StageState;
  /** Blocking violations found by a stage that completed. */
  blockingViolations?: number;
  /** false when the tool output could not be interpreted: the stage then proves nothing. */
  interpreted?: boolean;
  /**
   * The analyzed project controls this result (it ran the project's code, or read evidence the project produced). It
   * can fail the run; it satisfies its requirement only when the decision trusts self-reported results.
   */
  selfReported?: boolean;
  reason?: string;
}

export interface Requirement {
  id: string;
  /** false: strictly optional analysis; an error there is shown but never blocks. */
  required: boolean;
}

export interface Disabled {
  id: string;
  origin: DisableOrigin;
}

export interface DecisionInput {
  /** false when the configuration or the contract could not be resolved. */
  resolved: boolean;
  cancelled?: boolean;
  requirements: Requirement[];
  stages: StageResult[];
  disabled?: Disabled[];
  /** false: a selfReported stage never satisfies its requirement (jgates ci unless its policy trusts them). Default true. */
  selfReportedSatisfies?: boolean;
}

export interface DecisionOutcome {
  decision: Decision;
  complete: boolean;
  reduced: boolean;
  exitCode: number;
  /** Required requirements with no satisfying stage. */
  unsatisfied: Array<{ requirementId: string; state: StageState | "missing" }>;
  /** Optional stages that did not complete well: shown, never blocking. */
  warnings: Array<{ stageId: string; state: StageState }>;
  disabled: Disabled[];
  blockingViolations: number;
}

export function exitCodeFor(decision: Decision): number {
  return EXIT_CODES[decision];
}

function satisfies(stage: StageResult, selfReportedSatisfies = true): boolean {
  if (stage.interpreted === false) return false;
  if (stage.selfReported === true && !selfReportedSatisfies) return false;
  return stage.state === "completed" || stage.state === "not_applicable";
}

/** Computes the run decision. Precedence: cancelled, invalid, failed, incomplete, passed. */
export function computeDecision(input: DecisionInput): DecisionOutcome {
  const disabled = input.disabled ?? [];
  const reduced = disabled.some((d) => d.origin === "run");
  const disabledIds = new Set(disabled.map((d) => d.id));
  const optionalIds = new Set(input.requirements.filter((r) => !r.required).map((r) => r.id));
  const ok = (s: StageResult): boolean => satisfies(s, input.selfReportedSatisfies !== false);

  const unsatisfied: DecisionOutcome["unsatisfied"] = [];
  for (const req of input.requirements) {
    if (!req.required || disabledIds.has(req.id)) continue;
    const mine = input.stages.filter((s) => (s.requirementId ?? s.id) === req.id);
    if (mine.length === 0) {
      unsatisfied.push({ requirementId: req.id, state: "missing" });
    } else if (!mine.every(ok)) {
      const bad = mine.find((s) => !ok(s))!;
      unsatisfied.push({ requirementId: req.id, state: bad.state });
    }
  }

  const warnings: DecisionOutcome["warnings"] = [];
  for (const s of input.stages) {
    if (optionalIds.has(s.requirementId ?? s.id) && !ok(s) && s.state !== "disabled") {
      warnings.push({ stageId: s.id, state: s.state });
    }
  }

  const blockingViolations = input.stages.reduce(
    (n, s) => n + (s.state === "completed" ? Math.max(0, s.blockingViolations ?? 0) : 0),
    0,
  );
  const complete = unsatisfied.length === 0;

  let decision: Decision;
  if (input.cancelled) decision = "cancelled";
  else if (!input.resolved) decision = "invalid";
  else if (blockingViolations > 0) decision = "failed";
  else if (!complete) decision = "incomplete";
  else decision = "passed";

  return {
    decision,
    complete: decision === "invalid" ? false : complete,
    reduced,
    exitCode: exitCodeFor(decision),
    unsatisfied,
    warnings,
    disabled,
    blockingViolations,
  };
}
