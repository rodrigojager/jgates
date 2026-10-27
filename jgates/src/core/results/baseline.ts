// Comparison of a run with the run marked as baseline: findings are told apart by fingerprint into new, resolved and
// kept. A different policy, rules or scope (or a reduced or partial run) is reported as a warning and the comparison
// is flagged not comparable: the lists are still there, but they must not be read as a like-for-like diff.
import type { BaselineComparison, ResultFinding, RunResult } from "../run/types.js";

type Warning = BaselineComparison["warnings"][number];

const hashesOf = (r: Pick<RunResult, "provenance">): Record<string, string> => {
  const h = (r.provenance as { hashes?: Record<string, string> } | undefined)?.hashes;
  return h && typeof h === "object" ? h : {};
};

function differs(a: Record<string, string>, b: Record<string, string>, keys: string[]): boolean {
  return keys.some((k) => a[k] !== undefined && b[k] !== undefined && a[k] !== b[k]);
}

export function compareWithBaseline(
  baseline: Pick<RunResult, "findings" | "provenance" | "selection" | "reduced" | "runId" | "partial">,
  current: Pick<RunResult, "findings" | "provenance" | "selection" | "reduced">,
): BaselineComparison {
  const warnings: Warning[] = [];
  const bh = hashesOf(baseline);
  const ch = hashesOf(current);
  if (baseline.partial) warnings.push({ code: "BASELINE_PARTIAL", message: "the baseline run did not finish" });
  if (baseline.reduced || current.reduced) warnings.push({ code: "REDUCED_RUN", message: "a run with checks switched off for that run is a partial round" });
  if (differs(bh, ch, ["policy"])) warnings.push({ code: "POLICY_CHANGED", message: "the policy differs between the baseline and this run" });
  if (differs(bh, ch, ["config", "templates", "tools", "nativeFiles"])) {
    warnings.push({ code: "RULES_CHANGED", message: "the rules, tools or configuration differ between the baseline and this run" });
  }
  const scopeOf = (r: { selection?: RunResult["selection"] }) => JSON.stringify([r.selection?.scope ?? null, r.selection?.request ?? null]);
  if (scopeOf(baseline) !== scopeOf(current)) warnings.push({ code: "SCOPE_CHANGED", message: "the scope differs between the baseline and this run" });

  const before = new Map<string, ResultFinding>();
  for (const f of baseline.findings ?? []) if (f.fingerprint) before.set(f.fingerprint, f);
  const seen = new Set<string>();
  let kept = 0;
  let added = 0;
  for (const f of current.findings) {
    if (f.fingerprint && before.has(f.fingerprint)) {
      kept++;
      seen.add(f.fingerprint);
    } else added++;
  }
  const resolved = [...before.values()]
    .filter((f) => !seen.has(f.fingerprint!))
    .map((f) => ({ fingerprint: f.fingerprint!, ruleId: f.ruleId, tool: f.tool, ...(f.location?.path ? { path: f.location.path } : {}) }));
  return { runId: baseline.runId, comparable: warnings.length === 0, warnings, new: added, kept, resolved };
}

/** Marks each finding of the current run as new or kept against the baseline. */
export function markBaselineState(findings: ResultFinding[], baseline: Pick<RunResult, "findings">): ResultFinding[] {
  const known = new Set((baseline.findings ?? []).map((f) => f.fingerprint).filter(Boolean));
  return findings.map((f) => ({ ...f, baselineState: f.fingerprint && known.has(f.fingerprint) ? ("unchanged" as const) : ("new" as const) }));
}
