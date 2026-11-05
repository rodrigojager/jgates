import type { Plan, PlanItem } from "../plan/types.js";
import type { RunEvent } from "../events/index.js";
import type { ResultStage, RunResult } from "../run/types.js";

export const MASCOT_DOMAINS = ["quality", "security", "dependencies", "tests", "architecture", "infrastructure"] as const;
export type MascotDomain = (typeof MASCOT_DOMAINS)[number];
export type MascotStatus = "waiting" | "processing" | "passed" | "failed" | "incomplete" | "blocked" | "error" | "timeout" | "cancelled" | "finished" | "disabled" | "not_applicable" | "invalid";
export interface MascotDomainView {
  domain: MascotDomain;
  selection: "enabled" | "partial" | "disabled" | "unknown";
  status: MascotStatus;
  hasFindings: boolean;
  hasWarnings: boolean;
  coverageGap: boolean;
  excluded: number;
  runOnlyExcluded: number;
  progress: { completed: number; total: number } | null;
  checks: Array<{ id: string; label: string; enabled: boolean; origin: string | null; reason: string; status: MascotStatus; closed: boolean }>;
}
export interface MascotSnapshot {
  schemaVersion: 1;
  runId: string | null;
  planHash: string | null;
  revision: string;
  context: "configuration" | "run";
  settled: boolean;
  reduced: boolean;
  cancelling: boolean;
  evidenceUnavailable: boolean;
  domains: MascotDomainView[];
}
const domainOf = (category: string | null): MascotDomain | undefined => MASCOT_DOMAINS.find((d) => d === category);
const terminal = (state: string) => state !== "pending" && state !== "running";
const stageKey = (item: PlanItem) => item.adapter === "quality-bridge" ? item.tool : item.id;
const stepKey = (item: PlanItem) => item.command?.invocation ?? (item.adapter === "quality-bridge" ? "quality-bridge" : item.tool);

function stageStatus(stage: ResultStage | undefined, trust: boolean): MascotStatus {
  if (!stage) return "incomplete";
  if (stage.state === "pending") return "waiting";
  if (stage.state === "running") return "processing";
  if (stage.state !== "completed") return stage.state;
  if ((stage.blockingViolations ?? 0) > 0) return "failed";
  if (stage.interpreted === false || (stage.selfReported && !trust)) return "incomplete";
  return stage.interpreted === true && stage.blockingViolations === 0 ? "passed" : "finished";
}

/** Read-only presentation: no inferred tool names, no approval decisions, no duplicated composite evidence. */
export function projectMascots(input: {
  plan: Plan | null;
  result?: RunResult | null;
  events?: RunEvent[];
  runId?: string | null;
  running?: boolean;
  orphan?: boolean;
  invalid?: boolean;
}): MascotSnapshot {
  const { plan, result = null, events = [], running = false, orphan = false } = input;
  const context = input.runId || result ? "run" : "configuration";
  const runId = input.runId ?? result?.runId ?? null;
  const sorted = [...events].filter((e) => !runId || e.runId === runId).sort((a, b) => a.sequence - b.sequence);
  const steps = new Map<string, { state: string; cause?: string }>();
  const eventStages = new Map<string, ResultStage>();
  let cancelling = false;
  for (const e of sorted) {
    const d = e.data;
    if (e.type === "cancel-requested") cancelling = true;
    if (typeof d.step !== "string") continue;
    if (e.type === "step-started") steps.set(d.step, { state: "running" });
    if (e.type === "step-finished") steps.set(d.step, { state: "completed" });
    if (e.type === "step-skipped") steps.set(d.step, { state: "blocked", cause: String(d.cause) });
    if (e.type === "stage" && typeof d.stageId === "string") eventStages.set(d.stageId, { id: d.stageId, state: d.state as ResultStage["state"], ...(typeof d.reason === "string" ? { reason: d.reason } : {}) });
  }
  const stages = new Map((result?.stages ?? []).filter((s) => s.kind !== "composite").map((s) => [s.id, s]));
  const all = [...(plan?.groups.willRun ?? []), ...(plan?.groups.notApplicableOrDisabled ?? [])];
  const trust = result?.policy?.trustSelfReported !== false;
  const domains = MASCOT_DOMAINS.map((domain): MascotDomainView => {
    const items = all.filter((i) => domainOf(i.category) === domain);
    const enabled = items.filter((i) => i.state.enabled);
    const disabled = items.filter((i) => !i.state.enabled);
    const gaps = plan?.groups.uncoveredRequirements.filter((u) => u.category === domain) ?? [];
    const coverageGap = gaps.some((g) => g.reason !== "DISABLED_FOR_RUN" && g.reason !== "CHECKS_DISABLED");
    const unique = new Map<string, PlanItem>();
    for (const i of items) {
      const key = stageKey(i);
      // Shared bridge stages count once within each domain; an enabled pair wins over a disabled pair.
      if (!unique.has(key) || i.state.enabled) unique.set(key, i);
    }
    const checks = [...unique.entries()].map(([id, i]) => {
      let status: MascotStatus;
      const s = stages.get(i.id) ?? stages.get(id);
      const step = steps.get(stepKey(i));
      if (!i.state.enabled) status = "disabled";
      else if (context === "configuration") status = i.availability.status === "available" ? "waiting" : "blocked";
      else if (s && terminal(s.state)) status = stageStatus(s, trust);
      else if (running && step?.state === "running") status = "processing";
      else if (step?.state === "blocked") status = step.cause === "cancelled" ? "cancelled" : "blocked";
      else if (eventStages.has(id)) status = stageStatus(eventStages.get(id), trust);
      else if (step?.state === "completed") status = "finished";
      else if (running) status = "waiting";
      else status = result?.decision === "cancelled" ? "cancelled" : "incomplete";
      const closed = (!!s && terminal(s.state)) || (eventStages.has(id) && terminal(eventStages.get(id)!.state)) || step?.state === "completed" || step?.state === "blocked";
      const reason = s?.reason ?? eventStages.get(id)?.reason ?? (step?.state === "blocked" ? step.cause : undefined) ?? i.reason.message;
      return { id, label: i.label, enabled: i.state.enabled, origin: i.state.origin, reason, status, closed };
    });
    const selected = checks.filter((c) => c.enabled);
    const statuses = selected.map((c) => c.status);
    const ids = new Set([...unique.keys(), ...items.map((i) => i.id)]);
    const findings = (result?.findings ?? []).filter((f) => ids.has(f.stageId) && !f.waived);
    const hasFindings = statuses.includes("failed") || findings.some((f) => f.blocking);
    const hasWarnings = findings.some((f) => !f.blocking);
    let status: MascotStatus = "incomplete";
    const invalid = plan?.blockers.some((b) => b.code === "CONFIG_INVALID" && (!b.items?.length || b.items.some((id) => ids.has(id)))) === true;
    if (!selected.length && disabled.length && !coverageGap) status = "disabled";
    else if (invalid || input.invalid) status = "invalid";
    else if (statuses.includes("processing")) status = "processing";
    else if (running && statuses.includes("waiting")) status = "waiting";
    else if (hasFindings) status = "failed";
    else {
      const priority: MascotStatus[] = ["error", "timeout", "blocked", "cancelled", "incomplete", "finished", "waiting"];
      status = priority.find((s) => statuses.includes(s)) ?? (statuses.length ? statuses.every((s) => s === "not_applicable") ? "not_applicable" : "passed" : "incomplete");
      if (statuses.includes("disabled") && !["error", "timeout", "blocked", "cancelled"].includes(status)) status = "incomplete";
      if (coverageGap && !["error", "timeout", "blocked", "cancelled"].includes(status)) status = context === "configuration" ? "blocked" : "incomplete";
    }
    // An orphaned in-flight check cannot keep animating or claim completion.
    if (orphan && ["waiting", "processing", "finished"].includes(status)) status = "incomplete";
    return {
      domain, selection: enabled.length ? disabled.length ? "partial" : "enabled" : disabled.length ? "disabled" : "unknown",
      status, hasFindings, hasWarnings, coverageGap, excluded: disabled.length,
      runOnlyExcluded: disabled.filter((i) => i.state.runOnly).length,
      progress: context === "run" && selected.length ? { completed: selected.filter((c) => c.closed).length, total: selected.length } : null,
      checks,
    };
  });
  return {
    schemaVersion: 1, runId, planHash: plan?.planHash ?? null,
    revision: `${sorted.at(-1)?.sequence ?? 0}:${result?.finishedAt ?? ""}:${result?.partial === true ? "partial" : "final"}`,
    context, settled: context === "run" && !running, reduced: result?.reduced ?? plan?.selection.reduced ?? false,
    cancelling: running && cancelling, evidenceUnavailable: !plan, domains,
  };
}
