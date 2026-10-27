// Normalizes one bridge answer into the result contract: one composite stage, one stage per subcheck
// (and per extra evidence tool), findings with rule, location and severity, all fail-closed.
import { computeDecision, type StageState } from "../../core/contract/index.js";
import type { BridgeOutcome, BridgeSubcheck } from "../../core/bridge/index.js";
import type {
  AdapterOutput,
  BlockingReason,
  NormalizedSeverity,
  ResultDisabled,
  ResultFinding,
  ResultRequirement,
  ResultStage,
} from "../../core/run/types.js";
import { qualityBridgeManifest } from "./manifest.js";
import { ADAPTER_ID, COMPOSITE_STAGE_ID, stageIdOf, type SubcheckPlan } from "./requirements.js";

// Mirrors quality_sidecar/policy.py (evaluate_policy): what makes the legacy verdict REJECTED.
// Kept here so a NEEDS_CHANGES verdict (tool missing in mode full) never hides a blocking finding.
const BLOCKING_CATEGORIES = new Set([
  "architecture-policy",
  "change-policy",
  "contract-policy",
  "coverage",
  "quality-budget",
  "quality-evidence",
  "secrets",
  "test-quality",
]);
const BLOCKING_TOOLS = new Set(["change-policy", "dependency-graph", "quality-budget", "quality-evidence", "test-quality"]);
const FILE_SIZE_RULES = new Set(["budget.file-lines", "budget.file-bytes"]);
const SEVERITIES = new Set<NormalizedSeverity>(["critical", "high", "medium", "low", "info"]);

const COMPOSITE_REASON = "runs the quality sidecar and its built-in analyses (budgets, policy, PII when enabled)";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const posInt = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : undefined);

export function normalizeSeverity(native: string): NormalizedSeverity {
  const lower = native.toLowerCase();
  return SEVERITIES.has(lower as NormalizedSeverity) ? (lower as NormalizedSeverity) : "unknown";
}

function stateOf(status: BridgeSubcheck["status"], skipMeans: SubcheckPlan["skipMeans"]): StageState {
  switch (status) {
    case "ok":
    case "findings":
      return "completed";
    case "skipped":
      return skipMeans;
    case "missing":
      return "blocked";
    case "timeout":
      return "timeout";
    default:
      return "error";
  }
}

function defaultReason(status: BridgeSubcheck["status"]): string | undefined {
  if (status === "missing") return "tool not available on the local path";
  if (status === "skipped") return "skipped by the sidecar";
  return undefined;
}

const labels = new Map((qualityBridgeManifest.subchecks ?? []).map((s) => [s.id, s.label]));

interface ExtraTool {
  name: string;
  status: BridgeSubcheck["status"];
  reason?: string;
}

/** Tools the report lists that are not one of the manifest subchecks (evidence tools configured by policy). */
function extraTools(report: Rec | undefined, known: Set<string>): ExtraTool[] {
  const tools = Array.isArray(report?.tools) ? (report.tools as unknown[]) : [];
  const out: ExtraTool[] = [];
  const statuses = new Set(["ok", "findings", "skipped", "missing", "timeout", "error"]);
  for (const t of tools) {
    if (!isRec(t)) continue;
    const name = str(t.name);
    if (!name || known.has(name)) continue;
    const status = (statuses.has(String(t.status)) ? t.status : "error") as BridgeSubcheck["status"];
    const summary = isRec(t.summary) ? t.summary : {};
    const reason = str(summary.reason) ?? str(t.error);
    out.push(reason === undefined ? { name, status } : { name, status, reason });
  }
  return out;
}

interface FindingDraft extends ResultFinding {
  active: boolean;
}

function readFindings(report: Rec | undefined, stageFor: (tool: string, rule: string) => string): { drafts: FindingDraft[]; malformed: number } {
  const list = Array.isArray(report?.findings) ? (report.findings as unknown[]) : [];
  const drafts: FindingDraft[] = [];
  let malformed = 0;
  for (const item of list) {
    if (!isRec(item) || !str(item.rule) || !str(item.message)) {
      malformed++;
      continue;
    }
    const tool = str(item.tool) ?? "unknown";
    const ruleId = item.rule as string;
    const severity = str(item.severity) ?? "unknown";
    const waived = item.allowed === true;
    const draft: FindingDraft = {
      stageId: stageFor(tool, ruleId),
      tool,
      ruleId,
      severity,
      normalizedSeverity: normalizeSeverity(severity),
      message: item.message as string,
      origin: ADAPTER_ID,
      blocking: false,
      waived,
      active: !waived,
    };
    const category = str(item.category);
    if (category) draft.category = category;
    const file = str(item.path);
    if (file) {
      const location: NonNullable<ResultFinding["location"]> = { path: file };
      const line = posInt(item.line);
      const column = posInt(item.column);
      if (line !== undefined) location.line = line;
      if (column !== undefined) location.column = column;
      draft.location = location;
    }
    const fingerprint = str(item.fingerprint);
    if (fingerprint) draft.fingerprint = fingerprint;
    const waiverReason = str(item.allowed_reason);
    if (waived && waiverReason) draft.waiverReason = waiverReason;
    drafts.push(draft);
  }
  return { drafts, malformed };
}

function markBlocking(drafts: FindingDraft[], report: Rec | undefined): { unattributedRejection: boolean } {
  const mark = (d: FindingDraft, reason: BlockingReason) => {
    if (d.blocking) return;
    d.blocking = true;
    d.blockingReason = reason;
  };
  const active = drafts.filter((d) => d.active);
  for (const d of active) {
    if (d.normalizedSeverity === "critical") mark(d, "critical");
    else if (d.category && BLOCKING_CATEGORIES.has(d.category)) mark(d, "blocking-category");
    else if (BLOCKING_TOOLS.has(d.tool)) mark(d, "blocking-tool");
  }
  const score = isRec(report?.score) ? report.score : undefined;
  if (score && typeof score.value === "number" && typeof score.threshold === "number" && score.value < score.threshold) {
    for (const d of active) mark(d, "score-below-threshold");
  }
  // Never looser than the legacy verdict: REJECTED always leaves at least one blocking violation.
  if (report?.status === "REJECTED" && !drafts.some((d) => d.blocking)) {
    for (const d of active) mark(d, "legacy-verdict");
    return { unattributedRejection: active.length === 0 };
  }
  return { unattributedRejection: false };
}

/** Builds the stages, requirements, disabled list and findings of one bridge run. */
export function normalizeBridge(outcome: BridgeOutcome, plans: SubcheckPlan[]): Omit<AdapterOutput, "logs" | "outputs"> {
  const label = qualityBridgeManifest.displayName;
  const requirements: ResultRequirement[] = [{ id: COMPOSITE_STAGE_ID, required: true, reason: COMPOSITE_REASON }];
  const disabled: ResultDisabled[] = [];
  for (const p of plans) {
    requirements.push({ id: p.stageId, required: p.required, reason: p.reason });
    if (p.disabled) disabled.push({ id: p.stageId, origin: p.disabled.origin, reason: p.disabled.reason });
    for (const extra of p.extraDisabled ?? []) disabled.push({ id: extra.id, origin: extra.origin, reason: extra.reason });
  }
  const subStage = (p: SubcheckPlan, state: StageState, reason?: string): ResultStage => {
    const stage: ResultStage = {
      id: p.stageId,
      label: labels.get(p.subcheckId) ?? p.subcheckId,
      kind: "subcheck",
      parentId: COMPOSITE_STAGE_ID,
      adapter: ADAPTER_ID,
      state,
    };
    if (reason) stage.reason = reason;
    return stage;
  };

  // The bridge did not deliver a usable answer: the composite stage is in error, the enabled subchecks are blocked.
  const failure =
    outcome.kind === "failure"
      ? { state: (outcome.code === "timeout" ? "timeout" : "error") as StageState, reason: `${outcome.code}: ${outcome.message}`, native: undefined }
      : !outcome.response.ok
        ? {
            state: "error" as StageState,
            reason: `${outcome.response.error?.code ?? "error"}: ${outcome.response.error?.message ?? "the bridge reported an error"}`,
            native: outcome.response.status,
          }
        : null;
  if (failure) {
    const composite: ResultStage = { id: COMPOSITE_STAGE_ID, label, kind: "composite", adapter: ADAPTER_ID, state: failure.state, reason: failure.reason };
    if (failure.native) composite.nativeStatus = failure.native;
    const stages = [composite, ...plans.map((p) => (p.disabled ? subStage(p, "disabled", p.disabled.reason) : subStage(p, "blocked", "the bridge did not answer")))];
    return { stages, requirements, disabled, findings: [] };
  }

  const response = (outcome as Extract<BridgeOutcome, { kind: "response" }>).response;
  const report = isRec(response.report) ? response.report : undefined;
  const known = new Set(plans.map((p) => p.subcheckId));
  const extras = extraTools(report, known);
  const extraNames = new Set(extras.map((e) => e.name));
  const stageFor = (tool: string, rule: string): string => {
    if (FILE_SIZE_RULES.has(rule) && known.has("file-size")) return stageIdOf("file-size");
    if (known.has(tool) || extraNames.has(tool)) return stageIdOf(tool);
    return COMPOSITE_STAGE_ID;
  };
  const forcedIds = new Set(plans.filter((p) => p.forced && p.disabled).map((p) => p.stageId));
  const read = readFindings(report, stageFor);
  // What the plan turned off is not evidence of this run: its findings do not count.
  const drafts = read.drafts.filter((d) => !forcedIds.has(d.stageId));
  const malformed = read.malformed;
  const marked = markBlocking(drafts, report);
  // A REJECTED verdict caused only by what the plan turned off is not an unexplained rejection.
  const droppedActive = read.drafts.some((d) => forcedIds.has(d.stageId) && d.active);
  const unattributedRejection = marked.unattributedRejection && !droppedActive;
  const findings: ResultFinding[] = drafts.map(({ active: _active, ...f }) => f);
  const activeBy = new Map<string, number>();
  const blockingBy = new Map<string, number>();
  for (const d of drafts) {
    if (d.active) activeBy.set(d.stageId, (activeBy.get(d.stageId) ?? 0) + 1);
    if (d.blocking) blockingBy.set(d.stageId, (blockingBy.get(d.stageId) ?? 0) + 1);
  }
  const counted = (stage: ResultStage): ResultStage => {
    stage.findings = activeBy.get(stage.id) ?? 0;
    const blocking = blockingBy.get(stage.id) ?? 0;
    if (blocking > 0) stage.blockingViolations = blocking;
    return stage;
  };

  const byId = new Map(response.subchecks.map((s) => [s.id, s]));
  const stages: ResultStage[] = [];
  for (const p of plans) {
    const sub = byId.get(p.subcheckId);
    let stage: ResultStage;
    if (!sub) {
      stage = p.disabled ? subStage(p, "disabled", p.disabled.reason) : subStage(p, "error", "subcheck missing from the bridge response");
      if (!p.disabled) stage.interpreted = false;
    } else if (p.disabled && (p.forced || (sub.status !== "ok" && sub.status !== "findings"))) {
      // Off for this selection; evidence that did run (ok/findings) is kept below instead.
      stage = subStage(p, "disabled", p.disabled.reason);
      stage.nativeStatus = sub.status;
    } else {
      const state = stateOf(sub.status, p.skipMeans);
      const detail = sub.reason ?? sub.error;
      const fallback = defaultReason(sub.status);
      stage = subStage(p, state, sub.status === "missing" && detail ? `${fallback}: ${detail}` : (detail ?? fallback));
      stage.nativeStatus = sub.status;
    }
    stages.push(counted(stage));
  }
  for (const e of extras) {
    const id = stageIdOf(e.name);
    requirements.push({ id, required: true, reason: "evidence tool reported by the sidecar" });
    const stage: ResultStage = {
      id,
      label: e.name,
      kind: "evidence",
      parentId: COMPOSITE_STAGE_ID,
      adapter: ADAPTER_ID,
      state: stateOf(e.status, "blocked"),
      nativeStatus: e.status,
    };
    const reason = e.reason ?? defaultReason(e.status);
    if (reason) stage.reason = reason;
    stages.push(counted(stage));
  }

  const composite: ResultStage = counted({
    id: COMPOSITE_STAGE_ID,
    label,
    kind: "composite",
    adapter: ADAPTER_ID,
    state: "completed",
    nativeStatus: response.status,
  });
  if (unattributedRejection) {
    composite.blockingViolations = (composite.blockingViolations ?? 0) + 1;
    composite.reason = "legacy verdict REJECTED without an attributable finding";
  }
  if (malformed > 0) {
    composite.interpreted = false;
    composite.reason = `${malformed} finding(s) in the report could not be interpreted`;
  }
  // Never looser than the legacy verdict: a NEEDS_CHANGES the stages do not explain leaves the composite unproven.
  // A subcheck the plan turned off but the sidecar still tried (and could not run) explains that verdict.
  const explainedByPlan = plans.some((p) => p.forced && p.disabled && ["missing", "timeout", "error"].includes(byId.get(p.subcheckId)?.status ?? ""));
  if (response.status === "NEEDS_CHANGES" && composite.interpreted !== false && !explainedByPlan) {
    const check = computeDecision({
      resolved: true,
      requirements: requirements.map(({ id, required }) => ({ id, required })),
      stages: [composite, ...stages],
      disabled,
    });
    if (check.complete) {
      const summary = isRec(report?.summary) ? report.summary : {};
      const reasons = Array.isArray(summary.reasons) ? summary.reasons.filter((r): r is string => typeof r === "string") : [];
      composite.interpreted = false;
      composite.reason = `legacy verdict NEEDS_CHANGES not explained by the subchecks${reasons.length ? `: ${reasons.join(" ")}` : ""}`;
    }
  }
  return { stages: [composite, ...stages], requirements, disabled, findings };
}
