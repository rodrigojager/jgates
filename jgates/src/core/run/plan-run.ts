// Executes a reviewed plan: one executor step per invocation (the bridge, then one per tool instance of every other
// adapter), each with a preflight of what it needs, in dependency order. The items of the other adapters that the
// plan left off are disabled with the origin the plan gives.
import fs from "node:fs";
import path from "node:path";
import type { CacheSubject } from "../cache/index.js";
import { hashesOfPlan } from "../provenance/index.js";
import type { DisableOrigin } from "../contract/index.js";
import { normalizeBridge } from "../../adapters/quality-bridge/normalize.js";
import { runBridgeFromPlan, subchecksFromPlan } from "../../adapters/quality-bridge/from-plan.js";
import { qualityBridgeManifest } from "../../adapters/quality-bridge/manifest.js";
import { ADAPTER_ID as BRIDGE_ID } from "../../adapters/quality-bridge/requirements.js";
import { resolvePython, resolveSidecarDir } from "../bridge/index.js";
import { translator } from "../../i18n/index.js";
import { externalAdapter } from "../plan/adapters.js";
import type { Plan, PlanItem } from "../plan/types.js";
import { executeSteps, mergeOutputs, preflight, substituteTokens, type PreflightProblem, type RunStep } from "../runner/index.js";
import type { AdapterContext, AdapterOutput, CacheableStep, ResultDisabled } from "./types.js";

function disableOrigin(item: PlanItem): DisableOrigin {
  if (item.state.runOnly || item.state.reason === "ONLY_EXCLUDED") return "run";
  switch (item.state.origin) {
    case "template":
      return "template";
    case "project":
    case "policy":
      return "project";
    default:
      return "profile";
  }
}

/**
 * Items of the other adapters that the plan left off: disabled with the origin the plan gives. The bridge records its
 * own disabled subchecks when it runs; when the plan leaves it out entirely (every subcheck off, for example by
 * --only), its items are recorded here, so a run the plan calls reduced is reduced in the result too.
 */
export function planDisabled(plan: Plan): ResultDisabled[] {
  const bridgeRuns = plan.invocations.some((inv) => inv.adapter === qualityBridgeManifest.id);
  return plan.groups.notApplicableOrDisabled
    .filter((i) => (externalAdapter(i.adapter) !== undefined || (i.adapter === qualityBridgeManifest.id && !bridgeRuns)) && !i.state.enabled)
    .map((i) => ({ id: i.id, origin: disableOrigin(i), reason: `${i.reason.message} (${i.state.originLabel})` }));
}

const bridgeSubcheckIds = (): string[] => (qualityBridgeManifest.subchecks ?? []).map((s) => s.id);

/** The bridge's stages and requirements when it does not run (a failure outcome normalized against the plan). */
function bridgeSkeleton(plan: Plan): AdapterOutput {
  const out = normalizeBridge(
    { kind: "failure", code: "spawn-failed", message: "not run", interpreter: null, exitCode: null, stdout: "", stderr: "", durationMs: 0 },
    subchecksFromPlan(plan, bridgeSubcheckIds()),
  );
  return { ...out, logs: [], outputs: [] };
}

/** What the bridge needs right before it starts: the Python and the sidecar package (looked up now, not at planning). */
function bridgePreflight(context: AdapterContext): PreflightProblem[] {
  const t = translator("runner");
  const { interpreter, tried } = resolvePython(context.env);
  const problems: PreflightProblem[] = [];
  if (!interpreter) problems.push({ code: "RUNTIME_MISSING", message: t("runner_bridge_python_missing", { python: tried.join(", ") || "python" }) });
  const sidecarDir = resolveSidecarDir(context.env);
  if (!sidecarDir || !fs.existsSync(path.join(sidecarDir, "quality_sidecar", "__main__.py"))) {
    problems.push({ code: "PREREQUISITE_MISSING", message: t("runner_bridge_sidecar_missing", { dir: sidecarDir ?? "-" }) });
  }
  return problems;
}

function itemsOf(plan: Plan, adapter: string, tool: string): PlanItem[] {
  return plan.groups.willRun.filter((i) => i.adapter === adapter && i.tool === tool);
}

function externalSkeleton(plan: Plan, adapter: string, tool: string): AdapterOutput {
  const items = itemsOf(plan, adapter, tool);
  return {
    stages: items.map((i) => ({ id: i.id, label: i.label, kind: "step" as const, adapter, state: "pending" as const })),
    requirements: items.map((i) => ({ id: i.id, required: i.requirement === "required", reason: i.reason.message })),
    disabled: [],
    findings: [],
    logs: [],
    outputs: [],
  };
}

/**
 * Generic preflight of a tool instance whose adapter said it is available: the executable (the container runtime
 * when the plan runs the instance in a container), the working directory
 * and the configuration files the plan hashed still exist. An adapter that reported the tool unavailable at
 * planning reports it itself (with its own instruction), so nothing is checked here for it.
 */
function externalPreflight(context: AdapterContext, plan: Plan, invocation: Plan["invocations"][number]): PreflightProblem[] {
  const items = itemsOf(plan, invocation.adapter, invocation.id);
  if (items.some((i) => i.availability.status !== "available")) return [];
  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const files = new Set<string>();
  // Only files of the workspace the plan hashed; built-in references (builtin:templates/...) are not files.
  const isWorkspaceFile = (file: string): boolean => path.isAbsolute(file) || !/^[a-z][a-z0-9+.-]*:/i.test(file);
  for (const item of items) for (const f of item.configFiles) if (f.sha256 !== null && isWorkspaceFile(f.file)) files.add(path.resolve(context.workspacePath, f.file));
  return preflight({
    // On the container runner the host needs the runtime (docker); the tool's executable is inside the image.
    executable: invocation.command.container?.runtime ?? invocation.command.executable,
    env: { PATH: context.env.PATH ?? "", ...(context.env.PATHEXT ? { PATHEXT: context.env.PATHEXT } : {}) },
    cwd: substituteTokens(invocation.command.cwd, tokens),
    configFiles: [...files],
  });
}

/** Step ids each step depends on, from the dependsOn of its items (an item id maps to the step that runs it). */
function dependenciesOf(stepOfItem: Map<string, string>, stepId: string, items: PlanItem[]): string[] {
  const deps = new Set<string>();
  for (const item of items) {
    for (const dep of item.dependsOn ?? []) {
      const owner = stepOfItem.get(dep) ?? dep;
      if (owner !== stepId) deps.add(owner);
    }
  }
  return [...deps];
}

/**
 * What the result of a step depends on, for the cache of results: its invocation and items (tool versions, rules,
 * commands, configuration files with their hashes, limits), the scope and profile of the plan and the hashes of the
 * configuration, policy, templates, tools and inventory. The planHash itself is left out, so a change that does not
 * touch this step (another tool turned off) does not invalidate it. Network, code-changing and project-code
 * steps are never cacheable.
 */
function cacheSubject(plan: Plan, hashes: ReturnType<typeof hashesOfPlan>, invocation: Plan["invocations"][number], items: PlanItem[]): CacheSubject {
  const t = translator("cache");
  const { plan: _planHash, ...rest } = hashes;
  const blockers: CacheSubject["blockers"] = [];
  if (items.some((i) => i.network)) blockers.push({ code: "NETWORK", message: t("cache_blocker_network") });
  if (items.some((i) => i.effects.mayChangeCode)) blockers.push({ code: "MAY_CHANGE_CODE", message: t("cache_blocker_may_change_code") });
  if (items.some((i) => i.effects.executesProjectCode)) blockers.push({ code: "EXECUTES_PROJECT_CODE", message: t("cache_blocker_executes_project_code") });
  const configs = new Set<string>();
  const isWorkspaceFile = (file: string): boolean => path.isAbsolute(file) || !/^[a-z][a-z0-9+.-]*:/i.test(file);
  for (const item of items) for (const f of item.configFiles) if (isWorkspaceFile(f.file)) configs.add(f.file);
  return {
    material: { invocation, items, scope: plan.scope, profile: plan.profile, hashes: rest },
    configs: [...configs],
    blockers,
  };
}

/** One step per invocation of the plan: the bridge first, then the other adapters in plan order. */
export function planSteps(context: AdapterContext, plan: Plan): CacheableStep[] {
  const hashes = hashesOfPlan(plan);
  const stepOfItem = new Map<string, string>();
  for (const item of plan.groups.willRun) {
    if (item.adapter === BRIDGE_ID) stepOfItem.set(item.id, BRIDGE_ID);
    else if (item.adapter) stepOfItem.set(item.id, item.tool);
  }
  const steps: CacheableStep[] = [];
  const bridge = plan.invocations.find((i) => i.adapter === BRIDGE_ID);
  if (bridge) {
    const items = plan.groups.willRun.filter((i) => i.adapter === BRIDGE_ID);
    steps.push({
      id: BRIDGE_ID,
      label: qualityBridgeManifest.displayName,
      dependsOn: dependenciesOf(stepOfItem, BRIDGE_ID, items),
      preflight: () => bridgePreflight(context),
      skeleton: () => bridgeSkeleton(plan),
      run: () => runBridgeFromPlan(context, plan),
      cacheSubject: cacheSubject(plan, hashes, bridge, items),
    });
  }
  for (const invocation of plan.invocations) {
    if (invocation.adapter === BRIDGE_ID) continue;
    const adapter = externalAdapter(invocation.adapter);
    if (!adapter) continue;
    const items = itemsOf(plan, invocation.adapter, invocation.id);
    steps.push({
      id: invocation.id,
      label: items[0]?.label ?? invocation.id,
      dependsOn: dependenciesOf(stepOfItem, invocation.id, items),
      preflight: () => externalPreflight(context, plan, invocation),
      skeleton: () => externalSkeleton(plan, invocation.adapter, invocation.id),
      run: () => adapter.run(context, plan, invocation.id),
      cacheSubject: cacheSubject(plan, hashes, invocation, items),
    });
  }
  return steps;
}

/** Runs a plan with the executor and merges the outputs (for callers that do not go through executeRun). */
export async function runPlan(context: AdapterContext, plan: Plan, options: { failFast?: boolean } = {}): Promise<AdapterOutput> {
  const executed = await executeSteps(planSteps(context, plan), { ...(context.signal ? { signal: context.signal } : {}), failFast: options.failFast === true });
  const merged = mergeOutputs(executed.reports.map((r) => r.output));
  merged.disabled.push(...planDisabled(plan));
  return merged;
}

