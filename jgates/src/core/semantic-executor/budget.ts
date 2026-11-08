// The budget of one investigation: calls, tokens and time, with capacity reserved for the required validation before
// any exploration starts. Exploration (reconnaissance, hunting) spends only what is left after the reserve; validation
// may spend everything. Usage is the provider's own report; a call without a report is counted with an estimate that
// is disclosed as such (usage.reported false), never presented as real usage.
import type { SemanticRigor } from "../semantic-scope/index.js";
import type { BudgetDimension, BudgetLimits, BudgetReserve, StageRole } from "./types.js";

/** Share of each limit set aside for the required validation, by rigor. */
export const RESERVE_FRACTION: Readonly<Record<SemanticRigor, number>> = { quick: 0.25, standard: 0.34, deep: 0.5 };
/** Calls of an investigation when the plan sets no limit, by rigor. */
export const DEFAULT_CALLS: Readonly<Record<SemanticRigor, number>> = { quick: 12, standard: 24, deep: 48 };
/** Turns of one context when the stage sets none, by role and rigor. */
export const DEFAULT_TURNS: Readonly<Record<StageRole, Record<SemanticRigor, number>>> = {
  explore: { quick: 6, standard: 12, deep: 20 },
  validate: { quick: 3, standard: 6, deep: 10 },
};

export function budgetLimits(options: { rigor: SemanticRigor; maxCalls: number | null; maxTokens: number | null; maxSeconds: number | null; callTimeoutSeconds: number }): BudgetLimits {
  const maxCalls = options.maxCalls ?? DEFAULT_CALLS[options.rigor];
  return {
    maxCalls,
    maxTokens: options.maxTokens,
    maxSeconds: options.maxSeconds ?? options.callTimeoutSeconds * maxCalls,
  };
}

/** The validation reserve: a share of every limit, at least one call when the module validates anything. */
export function reserveFor(limits: BudgetLimits, rigor: SemanticRigor, validates: boolean): BudgetReserve {
  if (!validates) return { calls: 0, tokens: limits.maxTokens === null ? null : 0, seconds: 0 };
  const share = RESERVE_FRACTION[rigor];
  // Rounded to a thousandth first, so 300 x 0.34 is 102 and not 103 (binary fractions).
  const part = (n: number): number => Math.ceil(Math.round(n * share * 1000) / 1000);
  return {
    calls: Math.min(limits.maxCalls, Math.max(1, part(limits.maxCalls))),
    tokens: limits.maxTokens === null ? null : part(limits.maxTokens),
    seconds: part(limits.maxSeconds),
  };
}

export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  /** false: the backend reported nothing and these numbers are an estimate. */
  reported: boolean;
}

export type BudgetCheck = { ok: true; finalCall: boolean; timeLeftMs: number } | { ok: false; dimension: BudgetDimension; message: string };

export interface UsageSnapshot {
  calls: number;
  tokens: { input: number; output: number; total: number; reported: boolean; reportedCalls: number; estimatedCalls: number; estimated: number };
  seconds: number;
  byStage: Record<string, { calls: number; input: number; output: number; estimatedCalls: number }>;
}

export class BudgetMeter {
  private calls = 0;
  private input = 0;
  private output = 0;
  private estimated = 0;
  private reportedCalls = 0;
  private estimatedCalls = 0;
  private readonly byStage: UsageSnapshot["byStage"] = {};
  private readonly started: number;

  constructor(
    readonly limits: BudgetLimits,
    readonly reserve: BudgetReserve,
    private readonly clock: () => number = Date.now,
  ) {
    this.started = clock();
  }

  tokensUsed(): number {
    return this.input + this.output;
  }

  elapsedMs(): number {
    return this.clock() - this.started;
  }

  /** Whether one more call of this role fits, and whether it is the last one the role may make. */
  check(role: StageRole): BudgetCheck {
    const explore = role === "explore";
    const callLimit = explore ? this.limits.maxCalls - this.reserve.calls : this.limits.maxCalls;
    if (this.calls >= callLimit) {
      return { ok: false, dimension: "calls", message: explore ? `the exploration share of ${callLimit} call(s) is spent (${this.reserve.calls} reserved for validation)` : `the budget of ${this.limits.maxCalls} call(s) is spent` };
    }
    if (this.limits.maxTokens !== null) {
      const tokenLimit = explore ? this.limits.maxTokens - (this.reserve.tokens ?? 0) : this.limits.maxTokens;
      if (this.tokensUsed() >= tokenLimit) {
        return { ok: false, dimension: "tokens", message: explore ? `the exploration share of ${tokenLimit} token(s) is spent (${this.tokensUsed()} used, ${this.reserve.tokens ?? 0} reserved for validation)` : `the budget of ${this.limits.maxTokens} token(s) is spent (${this.tokensUsed()} used)` };
      }
    }
    const timeLimit = (explore ? this.limits.maxSeconds - this.reserve.seconds : this.limits.maxSeconds) * 1000;
    const timeLeftMs = timeLimit - this.elapsedMs();
    if (timeLeftMs <= 0) {
      return { ok: false, dimension: "time", message: explore ? `the exploration share of ${Math.round(timeLimit / 1000)} s is spent` : `the budget of ${this.limits.maxSeconds} s is spent` };
    }
    return { ok: true, finalCall: this.calls + 1 >= callLimit, timeLeftMs };
  }

  record(stage: string, usage: CallUsage): void {
    this.calls++;
    this.input += usage.inputTokens;
    this.output += usage.outputTokens;
    if (usage.reported) this.reportedCalls++;
    else {
      this.estimatedCalls++;
      this.estimated += usage.inputTokens + usage.outputTokens;
    }
    const s = (this.byStage[stage] ??= { calls: 0, input: 0, output: 0, estimatedCalls: 0 });
    s.calls++;
    s.input += usage.inputTokens;
    s.output += usage.outputTokens;
    if (!usage.reported) s.estimatedCalls++;
  }

  snapshot(): UsageSnapshot {
    return {
      calls: this.calls,
      tokens: {
        input: this.input,
        output: this.output,
        total: this.input + this.output,
        reported: this.estimatedCalls === 0,
        reportedCalls: this.reportedCalls,
        estimatedCalls: this.estimatedCalls,
        estimated: this.estimated,
      },
      seconds: Math.round(this.elapsedMs() / 100) / 10,
      byStage: JSON.parse(JSON.stringify(this.byStage)) as UsageSnapshot["byStage"],
    };
  }
}

/** A rough token estimate (4 characters per token) for a call whose backend reported no usage. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);
