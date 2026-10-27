// The budgets of the quality gate are mandatory in jgates ci: the CI policy may tighten them, never turn them off or
// loosen them past the standard profile of the quality gate (the profile the governed bridge request runs with).

/** Ceilings of the standard profile (PROFILE_BUDGETS["standard"] of quality_sidecar/metrics.py; 0: no ceiling). */
export const STANDARD_BUDGET_CEILINGS: Readonly<Record<string, number>> = {
  maxFileBytes: 2 * 1024 * 1024,
  maxFileLines: 5_000,
  maxScopeBytes: 0,
  maxScopeLines: 0,
  maxChangedFiles: 100,
  maxChangedLines: 20_000,
  maxDiffBytes: 10 * 1024 * 1024,
  maxBinaryFiles: 20,
  hotspotMinCommits: 150,
  hotspotMinChurn: 50_000,
};

export interface BudgetProblem {
  /** "/budgets/enabled" or "/budgets/<key>". */
  pointer: string;
  /** English detail for logs. */
  detail: string;
  ceiling?: number;
}

/** What makes a quality policy weaker than the mandatory budgets; null when it is acceptable. */
export function budgetProblem(doc: Record<string, unknown>): BudgetProblem | null {
  const budgets = doc.budgets;
  if (budgets === undefined || budgets === null) return null;
  if (typeof budgets !== "object" || Array.isArray(budgets)) return { pointer: "/budgets", detail: "budgets must be an object" };
  const record = budgets as Record<string, unknown>;
  if (record.enabled === false) return { pointer: "/budgets/enabled", detail: "the policy cannot disable the mandatory budgets" };
  for (const [key, ceiling] of Object.entries(STANDARD_BUDGET_CEILINGS)) {
    if (ceiling === 0 || !(key in record)) continue;
    const value = record[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > ceiling) {
      return { pointer: `/budgets/${key}`, detail: `${key} must be an integer between 1 and the standard ceiling ${ceiling}`, ceiling };
    }
  }
  return null;
}
