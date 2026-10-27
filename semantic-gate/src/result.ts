import { SemanticGateError } from "./errors.js";
import type {
  CommandRecord,
  GateResult,
  GateStatus,
  GitReviewContext,
  ObjectiveInput,
  SemanticFinding,
  SemanticGateConfig,
} from "./types.js";

export function parseProviderResult(text: string): unknown {
  const trimmed = stripMarkdownFence(text.trim());
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // Fall through to the actionable error below.
      }
    }
  }
  throw new SemanticGateError("Provider did not return valid JSON.", "parse", text.slice(0, 1000));
}

export function normalizeGateResult(
  parsed: unknown,
  context: {
    config: SemanticGateConfig;
    objective: ObjectiveInput;
    gitContext: GitReviewContext;
    provider: string;
    model?: string;
  },
): GateResult {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SemanticGateError("Provider JSON result must be an object.", "parse", parsed);
  }
  const raw = parsed as Record<string, unknown>;
  const findings = normalizeFindings(raw.findings);
  const hardBlockers = normalizeStringArray(raw.hardBlockers);
  const blockingFindings = findings.filter((finding) => finding.severity === "blocking");
  const score = clampScore(numberOr(raw.score, scoreFromFindings(findings)));
  const status = normalizeStatus(raw.status, score, context.config.threshold, hardBlockers.length + blockingFindings.length);

  const result: GateResult = {
    gate: "semantic",
    status,
    score,
    threshold: context.config.threshold,
    deterministicSummaryUsed: false,
    objectiveSource: context.objective.source,
    changesReviewed: stringOr(raw.changesReviewed, summarizeChanges(context.gitContext)),
    scoreAppliesTo: scoreAppliesToForScope(context.config.scope),
    hardBlockers: hardBlockers.length
      ? hardBlockers
      : blockingFindings.map((finding) => `${finding.path ?? "unknown"}: ${finding.message}`),
    scoreBreakdown: normalizeBreakdown(raw.scoreBreakdown),
    commandsExecuted: context.gitContext.commandsExecuted,
    findings,
    requiredFixPlan: normalizeStringArray(raw.requiredFixPlan),
    rerunCommands: normalizeStringArray(raw.rerunCommands, [
      "semantic-gate run --scope changed --objective-file <objective-file> --json",
      "quality-gate . --scope changed --json --no-interactive",
    ]),
    approvalNotes: stringOr(raw.approvalNotes, "No approval notes returned by provider."),
    residualRisks: normalizeStringArray(raw.residualRisks),
    contextWarnings: [
      ...context.gitContext.warnings,
      ...normalizeStringArray(raw.contextWarnings),
    ],
    provider: context.provider,
  };
  if (context.model !== undefined) {
    result.model = context.model;
  }

  if (result.status === "APPROVED" && result.score < result.threshold) {
    result.status = "NEEDS_CHANGES";
  }
  if (result.hardBlockers.length > 0 && result.status === "APPROVED") {
    result.status = "REJECTED";
    result.score = Math.min(result.score, 69);
  }
  return result;
}

export function mergeLocalFallbackResult(
  partials: GateResult[],
  context: {
    config: SemanticGateConfig;
    objective: ObjectiveInput;
    gitContext: GitReviewContext;
    provider: string;
    model?: string;
  },
): GateResult {
  const findings = partials.flatMap((partial) => partial.findings);
  const hardBlockers = partials.flatMap((partial) => partial.hardBlockers);
  const minScore = partials.reduce((lowest, partial) => Math.min(lowest, partial.score), 100);
  const status: GateStatus =
    hardBlockers.length > 0 || findings.some((finding) => finding.severity === "blocking")
      ? "REJECTED"
      : minScore >= context.config.threshold
        ? "APPROVED"
        : "NEEDS_CHANGES";

  const result: GateResult = {
    gate: "semantic",
    status,
    score: status === "REJECTED" ? Math.min(minScore, 69) : minScore,
    threshold: context.config.threshold,
    deterministicSummaryUsed: false,
    objectiveSource: context.objective.source,
    changesReviewed: summarizeChanges(context.gitContext),
    scoreAppliesTo: scoreAppliesToForScope(context.config.scope),
    hardBlockers,
    scoreBreakdown: defaultBreakdown(),
    commandsExecuted: context.gitContext.commandsExecuted,
    findings,
    requiredFixPlan: unique(partials.flatMap((partial) => partial.requiredFixPlan)),
    rerunCommands: [
      "semantic-gate run --scope changed --objective-file <objective-file> --json",
      "quality-gate . --scope changed --json --no-interactive",
    ],
    approvalNotes: "Merged locally from chunk-level semantic reviews because final synthesis was unavailable.",
    residualRisks: unique(partials.flatMap((partial) => partial.residualRisks)),
    contextWarnings: context.gitContext.warnings,
    provider: context.provider,
  };
  if (context.model !== undefined) {
    result.model = context.model;
  }
  return result;
}

function stripMarkdownFence(text: string): string {
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch?.[1]?.trim() ?? text;
}

function normalizeStatus(value: unknown, score: number, threshold: number, blockerCount: number): GateStatus {
  if (value === "APPROVED" || value === "NEEDS_CHANGES" || value === "REJECTED") {
    return value;
  }
  if (blockerCount > 0) {
    return "REJECTED";
  }
  return score >= threshold ? "APPROVED" : "NEEDS_CHANGES";
}

function scoreAppliesToForScope(scope: SemanticGateConfig["scope"]): GateResult["scoreAppliesTo"] {
  return scope === "full" ? "entire-project" : scope === "paths" ? "selected-paths" : "changed-files";
}

function normalizeFindings(value: unknown): SemanticFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const finding: SemanticFinding = {
        severity: normalizeSeverity(item.severity),
        category: stringOr(item.category, "maintainability"),
        message: stringOr(item.message, "Finding returned without a message."),
      };
      if (typeof item.path === "string") {
        finding.path = item.path;
      }
      if (typeof item.line === "number") {
        finding.line = item.line;
      }
      if (typeof item.requiredFix === "string") {
        finding.requiredFix = item.requiredFix;
      }
      return finding;
    });
}

function normalizeSeverity(value: unknown): SemanticFinding["severity"] {
  if (value === "blocking" || value === "important" || value === "suggestion" || value === "nit") {
    return value;
  }
  return "important";
}

function normalizeBreakdown(value: unknown): GateResult["scoreBreakdown"] {
  if (Array.isArray(value) && value.length > 0) {
    return value
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map((item) => ({
        category: stringOr(item.category, "unknown"),
        weight: numberOr(item.weight, 0),
        score: numberOr(item.score, 0),
        observations: stringOr(item.observations, ""),
      }));
  }
  return defaultBreakdown();
}

function defaultBreakdown(): GateResult["scoreBreakdown"] {
  return [
    { category: "functional", weight: 25, score: 0, observations: "No provider breakdown returned." },
    { category: "tests", weight: 20, score: 0, observations: "No provider breakdown returned." },
    { category: "security", weight: 20, score: 0, observations: "No provider breakdown returned." },
    { category: "maintainability", weight: 15, score: 0, observations: "No provider breakdown returned." },
    { category: "architecture", weight: 10, score: 0, observations: "No provider breakdown returned." },
    { category: "performance", weight: 10, score: 0, observations: "No provider breakdown returned." },
  ];
}

function normalizeCommands(value: unknown, fallback: CommandRecord[]): CommandRecord[] {
  if (!Array.isArray(value) || value.length === 0) {
    return fallback;
  }
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      command: stringOr(item.command, ""),
      result: stringOr(item.result, ""),
      purpose: stringOr(item.purpose, ""),
    }));
}

function normalizeStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value.map(String).filter(Boolean);
}

function scoreFromFindings(findings: SemanticFinding[]): number {
  if (findings.some((finding) => finding.severity === "blocking")) {
    return 69;
  }
  if (findings.some((finding) => finding.severity === "important")) {
    return 84;
  }
  if (findings.length > 0) {
    return 92;
  }
  return 100;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function summarizeChanges(context: GitReviewContext): string {
  return `${context.changedFiles.length} changed file(s): ${context.changedFiles.map((file) => file.path).slice(0, 12).join(", ")}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
