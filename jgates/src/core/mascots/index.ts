import type { Plan, PlanItem } from "../plan/types.js";
import type { RunEvent } from "../events/index.js";
import type { ResultStage, RunResult } from "../run/types.js";

export const MASCOT_DOMAINS = ["quality", "security", "dependencies", "tests", "architecture", "infrastructure"] as const;
/** The categories in one order everywhere: the quality mascot strip's, then the project's own checks. */
export const CATEGORY_ORDER: readonly string[] = [...MASCOT_DOMAINS, "custom"];
export function categoryRank(id: string): number {
  const at = CATEGORY_ORDER.indexOf(id);
  return at < 0 ? CATEGORY_ORDER.length : at;
}
export type MascotDomain = (typeof MASCOT_DOMAINS)[number];
export type MascotStatus = "waiting" | "processing" | "passed" | "failed" | "incomplete" | "blocked" | "error" | "timeout" | "cancelled" | "finished" | "disabled" | "not_applicable" | "invalid";
/**
 * Coverage subdimensions beneath each of the six domains (PLAN-experience, "Quality mascot domains"). They organize
 * the presentation only: a check has one primary domain and one subdimension, and its other capabilities are tags,
 * so no execution is ever counted twice. A subdimension without a selected check is reported as not covered.
 */
export const MASCOT_SUBDIMENSIONS: Readonly<Record<MascotDomain, readonly string[]>> = {
  quality: ["lint", "types", "builds", "maintainability", "reliability", "api-compatibility"],
  security: ["injection", "authorization", "tenant-isolation", "secrets", "cryptography", "privacy", "business-logic", "runtime-evidence", "hardening"],
  dependencies: ["vulnerabilities", "licenses", "supply-chain"],
  tests: ["unit-integration", "contracts", "properties", "mutation", "regressions", "post-patch"],
  architecture: ["layer-boundaries", "cycles", "cross-module-effects", "invariants"],
  infrastructure: ["iac", "ci-cd", "deployment", "images"],
};

/** The primary domain and subdimension of a capability, where the PLAN table differs from the catalog category or refines it. */
const CAPABILITY_PLACEMENT: Readonly<Record<string, { domain: MascotDomain; sub: string }>> = {
  lint: { domain: "quality", sub: "lint" },
  "format-check": { domain: "quality", sub: "lint" },
  typecheck: { domain: "quality", sub: "types" },
  duplication: { domain: "quality", sub: "maintainability" },
  "file-size": { domain: "quality", sub: "maintainability" },
  performance: { domain: "quality", sub: "reliability" },
  "api-compatibility": { domain: "quality", sub: "api-compatibility" },
  sast: { domain: "security", sub: "injection" },
  dataflow: { domain: "security", sub: "injection" },
  secrets: { domain: "security", sub: "secrets" },
  "secrets-history": { domain: "security", sub: "secrets" },
  pii: { domain: "security", sub: "privacy" },
  dast: { domain: "security", sub: "runtime-evidence" },
  dependencies: { domain: "dependencies", sub: "vulnerabilities" },
  licenses: { domain: "dependencies", sub: "licenses" },
  "supply-chain": { domain: "dependencies", sub: "supply-chain" },
  unit: { domain: "tests", sub: "unit-integration" },
  integration: { domain: "tests", sub: "unit-integration" },
  e2e: { domain: "tests", sub: "unit-integration" },
  coverage: { domain: "tests", sub: "unit-integration" },
  "api-contract": { domain: "tests", sub: "contracts" },
  tests: { domain: "tests", sub: "unit-integration" },
  properties: { domain: "tests", sub: "properties" },
  mutation: { domain: "tests", sub: "mutation" },
  architecture: { domain: "architecture", sub: "layer-boundaries" },
  iac: { domain: "infrastructure", sub: "iac" },
  "ci-cd": { domain: "infrastructure", sub: "ci-cd" },
  migration: { domain: "infrastructure", sub: "deployment" },
};

export interface MascotSubdimensionView {
  id: string;
  /** At least one selected check of the domain is placed here; false is a gap, never a pass. */
  covered: boolean;
  status: MascotStatus | "not_covered";
  hasFindings: boolean;
  /** Ids of the checks placed here (each check is in exactly one subdimension of one domain). */
  checks: string[];
}
export interface MascotDomainView {
  domain: MascotDomain;
  subdimensions: MascotSubdimensionView[];
  selection: "enabled" | "partial" | "disabled" | "unknown";
  status: MascotStatus;
  hasFindings: boolean;
  hasWarnings: boolean;
  coverageGap: boolean;
  excluded: number;
  runOnlyExcluded: number;
  progress: { completed: number; total: number } | null;
  checks: Array<{ id: string; label: string; enabled: boolean; origin: string | null; reason: string; status: MascotStatus; closed: boolean; subdimension: string | null; tags: string[] }>;
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
/** Primary domain of one plan item: the placement of its first known capability, otherwise its catalog category. */
function placementOf(item: PlanItem): { domain: MascotDomain; sub: string | null } | undefined {
  // A custom category (project or extension checks) is never guessed from a capability name.
  if (!domainOf(item.category)) return undefined;
  for (const c of item.capabilities ?? []) {
    const p = CAPABILITY_PLACEMENT[c];
    if (p) return p;
  }
  const domain = domainOf(item.category);
  return domain ? { domain, sub: null } : undefined;
}
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
  // A check replaced by another one (SUPERSEDED) or on only "when available" without its tool here (NOT_AVAILABLE_HERE)
  // was not switched off by anyone: counting it as "disabled" would read as a choice the person never made.
  const notChosenOff = new Set(["SUPERSEDED", "NOT_AVAILABLE_HERE"]);
  const all = [...(plan?.groups.willRun ?? []), ...(plan?.groups.notApplicableOrDisabled ?? []).filter((i) => !notChosenOff.has(i.reason.code))];
  const trust = result?.policy?.trustSelfReported !== false;
  // One primary domain per check: a stage shared by several capabilities (the bridge) belongs to the first domain, in
  // domain order, among its enabled items (otherwise among all), and its other capabilities become tags.
  const primary = new Map<string, MascotDomain>();
  const tagsOf = new Map<string, Set<string>>();
  for (const i of all) {
    const p = placementOf(i);
    if (!p) continue;
    const key = stageKey(i);
    const tags = tagsOf.get(key) ?? new Set<string>();
    for (const c of i.capabilities ?? []) tags.add(c);
    tagsOf.set(key, tags);
  }
  for (const pass of [true, false]) {
    for (const d of MASCOT_DOMAINS) {
      for (const i of all) {
        const key = stageKey(i);
        if (primary.has(key) || (pass && !i.state.enabled)) continue;
        if (placementOf(i)?.domain === d) primary.set(key, d);
      }
    }
  }
  const domains = MASCOT_DOMAINS.map((domain): MascotDomainView => {
    const items = all.filter((i) => placementOf(i)?.domain === domain && primary.get(stageKey(i)) === domain);
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
      const own = placementOf(i);
      const tags = [...(tagsOf.get(stageKey(i)) ?? [])].filter((c) => c !== i.capabilities[0]);
      return { id, label: i.label, enabled: i.state.enabled, origin: i.state.origin, reason, status, closed, subdimension: own?.sub ?? null, tags };
    });
    const subdimensions = MASCOT_SUBDIMENSIONS[domain].map((sub): MascotSubdimensionView => {
      const here = checks.filter((c) => c.subdimension === sub);
      const chosen = here.filter((c) => c.enabled);
      const subIds = new Set(chosen.flatMap((c) => [c.id, ...items.filter((i) => stageKey(i) === c.id).map((i) => i.id)]));
      const subFindings = chosen.some((c) => c.status === "failed") || (result?.findings ?? []).some((f) => subIds.has(f.stageId) && !f.waived && f.blocking);
      if (!chosen.length) return { id: sub, covered: false, status: "not_covered", hasFindings: false, checks: here.map((c) => c.id) };
      const statuses = chosen.map((c) => c.status);
      const order: MascotStatus[] = ["processing", "error", "timeout", "blocked", "cancelled", "incomplete", "finished", "waiting"];
      const status: MascotStatus = subFindings ? "failed" : (order.find((s) => statuses.includes(s)) ?? (statuses.every((s) => s === "not_applicable") ? "not_applicable" : "passed"));
      return { id: sub, covered: true, status, hasFindings: subFindings, checks: here.map((c) => c.id) };
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
      domain, subdimensions, selection: enabled.length ? disabled.length ? "partial" : "enabled" : disabled.length ? "disabled" : "unknown",
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
