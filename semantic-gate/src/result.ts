import { SemanticGateError } from "./errors.js";
import type {
  CommandRecord,
  GateResult,
  GateStatus,
  GitReviewContext,
  InvalidReasonCode,
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

export interface NormalizeContext {
  config: SemanticGateConfig;
  objective: ObjectiveInput;
  gitContext: GitReviewContext;
  provider: string;
  model?: string;
}

/** Parses and normalizes raw provider text; unusable text becomes an INVALID result instead of throwing. */
export function normalizeProviderText(text: string, context: NormalizeContext): GateResult {
  if (!text || !text.trim()) {
    return invalidGateResult("empty-output", ["Provider returned no text."], context);
  }
  let parsed: unknown;
  try {
    parsed = parseProviderResult(text);
  } catch {
    return invalidGateResult("malformed-output", ["Provider output is not valid JSON."], context);
  }
  return normalizeGateResult(parsed, context);
}

/** A result that can never be favorable: status INVALID, score 0, with a machine-readable reason code. */
export function invalidGateResult(
  reasonCode: InvalidReasonCode,
  reasons: string[],
  context: NormalizeContext,
  findings: SemanticFinding[] = [],
): GateResult {
  const result: GateResult = {
    gate: "semantic",
    status: "INVALID",
    score: 0,
    threshold: context.config.threshold,
    deterministicSummaryUsed: false,
    objectiveSource: context.objective.source,
    changesReviewed: summarizeChanges(context.gitContext),
    scoreAppliesTo: scoreAppliesToForScope(context.config.scope),
    hardBlockers: [],
    scoreBreakdown: defaultBreakdown(),
    commandsExecuted: context.gitContext.commandsExecuted,
    findings,
    requiredFixPlan: ["Rerun the semantic review; the model output could not be validated."],
    rerunCommands: [
      "semantic-gate run --scope changed --objective-file <objective-file> --json",
      "quality-gate . --scope changed --json --no-interactive",
    ],
    approvalNotes: `Invalid model output (${reasonCode}): ${reasons.join("; ")}`,
    residualRisks: ["The semantic review did not produce a valid verdict; the change is unreviewed."],
    contextWarnings: [...context.gitContext.warnings],
    provider: context.provider,
    reasonCode,
    reasons,
  };
  if (context.model !== undefined) {
    result.model = context.model;
  }
  return result;
}

const STATUSES = ["APPROVED", "NEEDS_CHANGES", "REJECTED"];
const SEVERITIES = ["blocking", "important", "suggestion", "nit"];
const CONFIRMATIONS = ["confirmed", "needs-validation", "rejected"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Strict check of the raw model object. Returns null when usable. */
function validateRaw(raw: Record<string, unknown>, context: NormalizeContext): { code: InvalidReasonCode; reasons: string[] } | null {
  if (Object.keys(raw).length === 0) {
    return { code: "empty-output", reasons: ["Provider returned an empty object."] };
  }
  const missing = ["status", "score", "findings"].filter((key) => raw[key] === undefined);
  if (missing.length > 0) {
    return { code: "missing-field", reasons: missing.map((key) => `Missing required field: ${key}.`) };
  }
  const invalid: string[] = [];
  if (typeof raw.status !== "string" || !STATUSES.includes(raw.status)) {
    invalid.push("status must be APPROVED, NEEDS_CHANGES or REJECTED.");
  }
  if (typeof raw.score !== "number" || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > 100) {
    invalid.push("score must be a number between 0 and 100.");
  }
  if (!Array.isArray(raw.findings)) {
    invalid.push("findings must be an array.");
  }
  if (raw.scoreBreakdown !== undefined && (!Array.isArray(raw.scoreBreakdown) || !raw.scoreBreakdown.every(isRecord))) {
    invalid.push("scoreBreakdown must be an array of objects.");
  }
  for (const key of ["hardBlockers", "requiredFixPlan", "residualRisks", "contextWarnings", "rerunCommands"]) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) {
      invalid.push(`${key} must be an array.`);
    }
  }
  if (Array.isArray(raw.findings)) {
    raw.findings.forEach((item, index) => {
      if (!isRecord(item)) {
        invalid.push(`findings[${index}] must be an object.`);
        return;
      }
      if (typeof item.severity !== "string" || !SEVERITIES.includes(item.severity)) {
        invalid.push(`findings[${index}].severity is missing or unknown.`);
      }
      if (typeof item.message !== "string" || !item.message.trim()) {
        invalid.push(`findings[${index}].message is missing.`);
      }
      if (item.path !== undefined && typeof item.path !== "string") {
        invalid.push(`findings[${index}].path must be a string.`);
      }
      if (item.confirmation !== undefined && (typeof item.confirmation !== "string" || !CONFIRMATIONS.includes(item.confirmation))) {
        invalid.push(`findings[${index}].confirmation must be confirmed, needs-validation or rejected.`);
      }
    });
  }
  if (invalid.length > 0) {
    return { code: "invalid-field", reasons: invalid };
  }
  const known = new Set(context.gitContext.changedFiles.map((file) => normalizePath(file.path)));
  const unknown: string[] = [];
  (raw.findings as Array<Record<string, unknown>>).forEach((item, index) => {
    if (typeof item.path === "string" && !known.has(normalizePath(item.path))) {
      unknown.push(`findings[${index}] cites a file that was not in the review context: ${item.path}`);
    }
  });
  if (unknown.length > 0) {
    return { code: "unknown-evidence", reasons: unknown };
  }
  return null;
}

export function normalizeGateResult(parsed: unknown, context: NormalizeContext): GateResult {
  if (!isRecord(parsed)) {
    return invalidGateResult("not-an-object", ["Provider JSON result must be an object."], context);
  }
  const raw = parsed;
  const problem = validateRaw(raw, context);
  if (problem) {
    return invalidGateResult(problem.code, problem.reasons, context, problem.code === "unknown-evidence" ? normalizeFindings(raw.findings) : []);
  }
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
  const invalid = partials.filter((partial) => partial.status === "INVALID");
  if (invalid.length > 0) {
    return invalidGateResult(
      "incomplete-chunk",
      invalid.flatMap((partial) => partial.reasons ?? [partial.approvalNotes]),
      context as NormalizeContext,
      partials.flatMap((partial) => partial.findings),
    );
  }
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
      finding.confirmation =
        item.confirmation === "confirmed" || item.confirmation === "needs-validation" || item.confirmation === "rejected"
          ? item.confirmation
          : "needs-validation";
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
