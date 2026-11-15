// How a Semantic finding is identified in a run's result: the rule ID it is stored under and its fingerprint (v1, as for
// every finding: tool, rule, path and occurrence). The service stores the findings with these fingerprints and a module
// that names its findings in its own records (the requirements ledger of asvs-review) computes the same ones.
import { assignFingerprints } from "../results/fingerprint.js";
import type { ResultFinding } from "../run/types.js";

/** The tool every Semantic finding is stored under. */
export const SEMANTIC_FINDING_TOOL = "semantic-gate";

/** The rule ID of a Semantic finding of a category. */
export const semanticRuleId = (category: string): string => `semantic/${category || "general"}`;

/**
 * The fingerprints of a run's Semantic findings, in order: the same list the service stores (every finding of the run,
 * by category, repository path and line), so a fingerprint here is the one the stored finding carries.
 */
export function semanticFindingFingerprints(findings: ReadonlyArray<{ category: string; path: string | null; line: number | null }>): string[] {
  const shaped = findings.map(
    (f): ResultFinding => ({
      stageId: "semantic-review",
      tool: SEMANTIC_FINDING_TOOL,
      ruleId: semanticRuleId(f.category),
      category: f.category,
      severity: "unknown",
      normalizedSeverity: "unknown",
      message: "",
      ...(f.path ? { location: { path: f.path, ...(f.line !== null ? { line: f.line } : {}) } } : {}),
      blocking: false,
      waived: false,
    }),
  );
  return assignFingerprints(shaped).map((f) => f.fingerprint as string);
}
