// Comparison of a run with the run marked as baseline: findings are told apart by fingerprint into new, resolved and
// kept. A different policy, rules or scope (or a reduced or partial run) is reported as a warning and the comparison
// is flagged not comparable: the lists are still there, but they must not be read as a like-for-like diff.
import type { BaselineComparison, ResultFinding, RunResult } from "../run/types.js";
import { isInformational, isReview } from "./wording.js";

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

  const m = matchFindings(baseline.findings ?? [], current.findings);
  // Informational findings (they do not block) are counted apart: `new` and `kept` hold the blocking side only.
  const keptInformational = m.keptFlags.filter((flag, i) => flag && isInformational(current.findings[i]!)).length;
  const blockingSide = (f: ResultFinding): boolean => !isInformational(f) && f.review !== true;
  const kept = m.keptFlags.filter((flag, i) => flag && blockingSide(current.findings[i]!)).length;
  const informationalNow = current.findings.filter(isInformational).length;
  const resolvedInformational = m.resolved.filter(isInformational).length;
  const keptReview = m.keptFlags.filter((flag, i) => flag && isReview(current.findings[i]!)).length;
  const reviewNow = current.findings.filter(isReview).length;
  const resolvedReview = m.resolved.filter(isReview).length;
  const resolved = m.resolved.map((f) => ({
    fingerprint: f.fingerprint!,
    ruleId: f.ruleId,
    tool: f.tool,
    ...(f.location?.path ? { path: f.location.path } : {}),
    ...(typeof f.location?.line === "number" ? { line: f.location.line } : {}),
  }));
  return {
    runId: baseline.runId,
    comparable: warnings.length === 0,
    warnings,
    new: current.findings.filter(blockingSide).length - kept,
    kept,
    newInformational: informationalNow - keptInformational,
    keptInformational,
    resolvedInformational,
    newReview: reviewNow - keptReview,
    keptReview,
    resolvedReview,
    resolved,
    matchedBy: m.matchedBy,
  };
}

/** Marks each finding of the current run as new or kept against the baseline. */
export function markBaselineState(findings: ResultFinding[], baseline: Pick<RunResult, "findings">): ResultFinding[] {
  const m = matchFindings(baseline.findings ?? [], findings);
  return findings.map((f, i) => ({ ...f, baselineState: m.keptFlags[i] ? ("unchanged" as const) : ("new" as const) }));
}

export interface FindingMatch {
  /** Per current finding: matched a baseline finding. */
  keptFlags: boolean[];
  /** Baseline findings with no match, in baseline order. */
  resolved: ResultFinding[];
  matchedBy: NonNullable<BaselineComparison["matchedBy"]>;
}

const groupOf = (f: ResultFinding): string => JSON.stringify([f.tool, f.ruleId, f.location?.path ?? ""]);

/**
 * The one matcher of the baseline comparison. Findings are grouped by tool, rule and path. A group whose findings, on both
 * sides, all carry an anchor is matched by anchor; every other group is matched by the fingerprint v1 as always. Never a mix
 * inside one group.
 */
export function matchFindings(before: ResultFinding[], now: ResultFinding[]): FindingMatch {
  const groups = new Map<string, { b: ResultFinding[]; c: ResultFinding[] }>();
  const slot = (f: ResultFinding) => {
    const key = groupOf(f);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { b: [], c: [] }));
    return g;
  };
  for (const f of before) slot(f).b.push(f);
  for (const f of now) slot(f).c.push(f);

  const byAnchor = new Map<string, boolean>();
  let anchorGroups = 0;
  let fingerprintGroups = 0;
  for (const [key, g] of groups) {
    const useAnchor = g.b.length > 0 && g.c.length > 0 && g.b.every((f) => !!f.anchor) && g.c.every((f) => !!f.anchor);
    byAnchor.set(key, useAnchor);
    if (g.b.length > 0 && g.c.length > 0) useAnchor ? anchorGroups++ : fingerprintGroups++;
  }
  const keyOf = (f: ResultFinding): string | undefined => (byAnchor.get(groupOf(f)) ? f.anchor : f.fingerprint);

  const known = new Set<string>();
  for (const f of before) {
    const k = keyOf(f);
    if (k) known.add(groupOf(f) + "\n" + k);
  }
  const seen = new Set<string>();
  const keptFlags = now.map((f) => {
    const k = keyOf(f);
    const full = k ? groupOf(f) + "\n" + k : "";
    if (k && known.has(full)) {
      seen.add(full);
      return true;
    }
    return false;
  });
  const emitted = new Set<string>();
  const resolved: ResultFinding[] = [];
  for (const f of before) {
    const k = keyOf(f);
    if (!k) continue;
    const full = groupOf(f) + "\n" + k;
    if (seen.has(full) || emitted.has(full)) continue;
    emitted.add(full);
    resolved.push(f);
  }
  const matchedBy = anchorGroups > 0 && fingerprintGroups > 0 ? "mixed" : anchorGroups > 0 ? "anchor" : "fingerprint";
  return { keptFlags, resolved, matchedBy };
}
