// Metrics of a result: unit, numerator and denominator when they apply, component, scope and origin. Percentages are
// never added up without weighting, so each metric stands alone with the numbers it came from.
import type { ResultFinding, ResultMetric } from "../run/types.js";

export function ratioMetric(m: Omit<ResultMetric, "value" | "unit"> & { numerator: number; denominator: number; unit?: "percent" | "ratio" }): ResultMetric {
  const unit = m.unit ?? "percent";
  const raw = m.denominator === 0 ? 0 : m.numerator / m.denominator;
  return { ...m, unit, value: unit === "percent" ? Math.round(raw * 10000) / 100 : raw };
}

/** Counts every run gets: findings in total, not waived and blocking. */
export function findingMetrics(findings: ResultFinding[], scope: string): ResultMetric[] {
  const count = (id: string, label: string, n: number): ResultMetric => ({ id, label, unit: "count", value: n, scope, origin: "jgates" });
  return [
    count("findings.total", "Findings", findings.length),
    count("findings.active", "Findings not waived", findings.filter((f) => !f.waived).length),
    count("findings.blocking", "Blocking findings", findings.filter((f) => f.blocking).length),
  ];
}
