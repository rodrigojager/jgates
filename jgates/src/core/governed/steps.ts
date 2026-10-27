// The steps of a jgates ci run: the plan's steps, whose stages are marked with what the run can trust, plus the step
// that reports the suppressions written in the analyzed code. Everything is decided from the plan and from the clean
// copy of the commit the run analyzes (the snapshot), never from the work tree:
//   - a stage of a self-reported tool (trust.ts) gets selfReported: true; the decision then does not let it satisfy
//     its requirement unless the policy trusts self-reported results (execution.trustSelfReported);
//   - MegaLinter's stage is self-reported when a linter of the list that runs MSBuild has project files to load;
//   - the coverage stage is refused when the commit itself carries coverage reports (evidence the project supplied).
import { translator } from "../../i18n/index.js";
import { ADAPTER_ID as BRIDGE_ID, stageIdOf } from "../../adapters/quality-bridge/requirements.js";
import type { Plan, PlanItem } from "../plan/types.js";
import type { RunStep } from "../runner/index.js";
import type { AdapterContext, AdapterOutput, CacheableStep, ResultStage } from "../run/types.js";
import { ciLinters, LinterListError, lintersFile, readBridgeLinters, type BridgeLinter } from "./linters.js";
import { findSuppressions, listTree, suppressionFinding, SUPPRESSIONS_STAGE, type SuppressionStatus, type TreeListing } from "./suppressions.js";
import { adapterTreatment, subcheckTreatment } from "./trust.js";

/** MSBuild project files: a linter that runs MSBuild loads (and executes) them. */
const MSBUILD_FILE = /(?:^|\/)(?:[^/]+\.(?:csproj|fsproj|vbproj|sln|slnx)|Directory\.Build\.(?:props|targets))$/i;
/** The coverage reports the quality gate reads by itself (SUPPORTED_COVERAGE_PATTERNS of the sidecar). */
const COVERAGE_REPORT = [
  /^coverage\/lcov\.info$/,
  /^lcov\.info$/,
  /^coverage\.xml$/,
  /^coverage\/coverage\.xml$/,
  /(?:^|\/)coverage\.cobertura\.xml$/,
  /^target\/site\/jacoco\/jacoco\.xml$/,
  /^build\/reports\/jacoco\/test\/jacocoTestReport\.xml$/,
  /^coverage\.out$/,
  /^clover\.xml$/,
  /^coverage\/clover\.xml$/,
];
const IGNORED_BY_COVERAGE = /(?:^|\/)(?:\.git|\.quality|node_modules|vendor|__pycache__)\//;

export interface GovernedFacts {
  listing: TreeListing;
  /** The list of MegaLinter's linters, or why it cannot be read (the run then fails closed). */
  linters: BridgeLinter[] | LinterListError;
  /** MSBuild project files of the snapshot. */
  msbuildFiles: string[];
  /** Coverage reports present in the commit. */
  coverageReports: string[];
}

/** What the run needs to know about the snapshot, read once before the steps start. */
export function governedFacts(context: AdapterContext): GovernedFacts {
  const listing = listTree(context.workspacePath);
  let linters: BridgeLinter[] | LinterListError;
  try {
    linters = readBridgeLinters(lintersFile(context.env));
  } catch (error) {
    linters = error instanceof LinterListError ? error : new LinterListError(String(error));
  }
  return {
    listing,
    linters,
    msbuildFiles: listing.files.filter((f) => MSBUILD_FILE.test(f)),
    coverageReports: listing.files.filter((f) => !IGNORED_BY_COVERAGE.test(f) && COVERAGE_REPORT.some((p) => p.test(f))),
  };
}

const bridgeRuns = (plan: Plan, subcheck: string): boolean => plan.groups.willRun.some((i) => i.adapter === BRIDGE_ID && i.subcheck === subcheck);
const adapterRuns = (plan: Plan, adapter: string): boolean => plan.groups.willRun.some((i) => i.adapter === adapter);

/** Stage id of a plan item: the bridge reports one stage per subcheck, the other adapters one per item. */
const stageOf = (item: PlanItem): string => (item.adapter === BRIDGE_ID && item.subcheck ? stageIdOf(item.subcheck) : item.id);

/** Linters of the list MegaLinter runs in jgates ci (none when the list cannot be read). */
const runningLinters = (facts: GovernedFacts): BridgeLinter[] => (facts.linters instanceof LinterListError ? [] : ciLinters(facts.linters));

/** Stage ids whose result the analyzed project controls in this run. */
export function selfReportedStages(plan: Plan, facts: GovernedFacts): Set<string> {
  const out = new Set<string>();
  for (const item of plan.groups.willRun) {
    if (item.adapter === BRIDGE_ID) {
      if (item.subcheck === "megalinter") {
        // An unreadable list proves nothing about what MegaLinter runs: its result is not trusted either.
        const msbuild = facts.linters instanceof LinterListError || (facts.msbuildFiles.length > 0 && runningLinters(facts).some((l) => l.executesProjectCode));
        if (msbuild) out.add(stageOf(item));
      } else if (subcheckTreatment(item.subcheck) !== "trusted") out.add(stageOf(item));
    } else if (adapterTreatment(item.adapter, item.effects.executesProjectCode) !== "trusted") out.add(stageOf(item));
  }
  return out;
}

/** What this run does with each kind of suppression comment. */
export function suppressionStatus(plan: Plan, facts: GovernedFacts): (kind: string) => SuppressionStatus {
  const linters = runningLinters(facts);
  const megalinter = bridgeRuns(plan, "megalinter");
  const neutralized = (runs: boolean, how: string): SuppressionStatus => (runs ? { state: "neutralized", how } : { state: "unused" });
  return (kind) => {
    switch (kind) {
      case "eslint":
        return neutralized(adapterRuns(plan, "eslint") || (megalinter && linters.some((l) => l.id === "JAVASCRIPT_ES")), "--no-inline-config");
      case "noqa":
        return neutralized(adapterRuns(plan, "ruff"), "--ignore-noqa");
      case "nosem":
        return neutralized(adapterRuns(plan, "semgrep") || bridgeRuns(plan, "semgrep"), "--disable-nosem");
      case "gitleaks":
        return neutralized(bridgeRuns(plan, "gitleaks"), "--ignore-gitleaks-allow");
      case "trivy":
        return neutralized(bridgeRuns(plan, "trivy"), "--show-suppressed");
      case "checkov":
        return neutralized(bridgeRuns(plan, "checkov"), "skipped checks reported as findings");
      case "jscpd":
        return bridgeRuns(plan, "jscpd") ? { state: "honored", by: stageIdOf("jscpd"), blocking: true } : { state: "unused" };
      default: {
        const linter = megalinter ? linters.find((l) => l.suppressionMarker === kind) : undefined;
        if (!linter) return { state: "unused" };
        return { state: "honored", by: `${stageIdOf("megalinter")} (${linter.id})`, blocking: linter.ci === "trusted" };
      }
    }
  };
}

/** The step that reports the suppression comments of the snapshot (always required in jgates ci). */
export function suppressionsStep(context: AdapterContext, plan: Plan, facts: GovernedFacts): RunStep {
  const t = translator("governed");
  const label = t("governed_suppressions_label");
  const requirements = [{ id: SUPPRESSIONS_STAGE, required: true, reason: t("governed_suppressions_reason") }];
  const output = (stage: ResultStage, findings: AdapterOutput["findings"] = []): AdapterOutput => ({ stages: [stage], requirements, disabled: [], findings, logs: [], outputs: [] });
  const base: ResultStage = { id: SUPPRESSIONS_STAGE, label, kind: "step", adapter: "jgates-ci", state: "pending" };
  return {
    id: SUPPRESSIONS_STAGE,
    label,
    skeleton: () => output(base),
    run: async () => {
      if (facts.linters instanceof LinterListError) {
        return output({ ...base, state: "error", interpreted: false, reason: t("governed_linters_unreadable", { detail: facts.linters.message }) });
      }
      if (facts.listing.truncated) {
        return output({ ...base, state: "error", interpreted: false, reason: t("governed_suppressions_truncated", { count: facts.listing.files.length }) });
      }
      const { hits, skipped } = findSuppressions(context.workspacePath, facts.listing.files, suppressionStatus(plan, facts));
      const findings = hits.map(suppressionFinding);
      const blocking = findings.filter((f) => f.blocking).length;
      const reason = t("governed_suppressions_done", { files: facts.listing.files.length, count: findings.length, blocking }) + (skipped.length > 0 ? ` ${t("governed_suppressions_skipped", { count: skipped.length, files: skipped.slice(0, 3).join(", ") })}` : "");
      return output({ ...base, state: "completed", blockingViolations: blocking, findings: findings.length, reason }, findings);
    },
  };
}

/** Marks the stages of one step's output: self-reported ones, and the coverage stage when the commit carries reports. */
export function markOutput(output: AdapterOutput, selfReported: Set<string>, facts: GovernedFacts): AdapterOutput {
  const t = translator("governed");
  const coverage = stageIdOf("coverage");
  const stages = output.stages.map((s): ResultStage => {
    let stage = s;
    if (selfReported.has(s.requirementId ?? s.id)) stage = { ...stage, selfReported: true };
    // A coverage verdict computed with a report the commit carries proves nothing, whatever it says.
    if (stage.id === coverage && facts.coverageReports.length > 0 && stage.state === "completed") {
      const files = facts.coverageReports.slice(0, 3).join(", ") + (facts.coverageReports.length > 3 ? ", ..." : "");
      stage = { ...stage, state: "error", interpreted: false, reason: t("governed_coverage_from_commit", { files }) };
    }
    return stage;
  });
  return { ...output, stages };
}

/** The plan's steps as jgates ci runs them: every output marked, and the suppressions step added. */
export function governSteps(context: AdapterContext, plan: Plan, steps: CacheableStep[], facts: GovernedFacts = governedFacts(context)): CacheableStep[] {
  const selfReported = selfReportedStages(plan, facts);
  const wrapped = steps.map((step): CacheableStep => ({
    ...step,
    skeleton: () => markOutput(step.skeleton(), selfReported, facts),
    run: async () => markOutput(await step.run(), selfReported, facts),
  }));
  return [...wrapped, suppressionsStep(context, plan, facts)];
}
