// Runs the bridge for a reviewed plan: the plan, not the option flags, says which subchecks are required.
// What the plan put in "notApplicableOrDisabled" is disabled in the result with the origin the plan gives, even when
// the sidecar ran it anyway.
import type { DisableOrigin } from "../../core/contract/index.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import type { BridgeRequest } from "../../core/bridge/index.js";
import type { AdapterContext, AdapterOutput } from "../../core/run/types.js";
import { qualityBridgeManifest } from "./manifest.js";
import { executeBridge } from "./index.js";
import { ADAPTER_ID, stageIdOf, type SubcheckPlan } from "./requirements.js";

const RUN_DIR_TOKEN = "{runDir}";

/** Origin of a plan item that is off, in the vocabulary of the result. */
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

const reasonOf = (item: PlanItem): string => `${item.reason.message} (${item.state.originLabel})`;

/** One SubcheckPlan per subcheck of the manifest, decided only by the plan's items. */
export function subchecksFromPlan(plan: Plan, subcheckIds: string[]): SubcheckPlan[] {
  const forSub = (id: string, list: PlanItem[]): PlanItem[] => list.filter((i) => i.adapter === ADAPTER_ID && i.subcheck === id);
  return subcheckIds.map((id) => {
    const stageId = stageIdOf(id);
    const on = forSub(id, plan.groups.willRun);
    const off = forSub(id, plan.groups.notApplicableOrDisabled);
    if (on.length > 0) {
      const mandatory = on.some((i) => i.requirement === "required");
      const extra = off.map((i) => ({ id: `${stageId}#${i.capabilities[0] ?? "?"}`, origin: disableOrigin(i), reason: reasonOf(i) }));
      return {
        subcheckId: id,
        stageId,
        required: true,
        reason: on[0]!.reason.message,
        skipMeans: mandatory ? "blocked" : "not_applicable",
        ...(extra.length > 0 ? { extraDisabled: extra } : {}),
      } satisfies SubcheckPlan;
    }
    const first = off.find((i) => i.state.runOnly || i.state.reason === "ONLY_EXCLUDED") ?? off[0];
    const origin: DisableOrigin = first ? disableOrigin(first) : "profile";
    const reason = first ? reasonOf(first) : "not selected by the plan";
    return { subcheckId: id, stageId, required: false, reason, disabled: { origin, reason }, skipMeans: "blocked", forced: true } satisfies SubcheckPlan;
  });
}

/** The bridge request of the plan, with the run folder in place of the {runDir} token. */
export function requestFromPlan(plan: Plan, context: AdapterContext): BridgeRequest | null {
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID);
  const stdin = invocation?.command.stdin;
  if (!stdin) return null;
  const request = JSON.parse(JSON.stringify(stdin).split(RUN_DIR_TOKEN).join(context.runDir.replace(/\\/g, "\\\\"))) as BridgeRequest;
  request.target = context.workspacePath;
  return request;
}

/** Runs the bridge exactly as the plan says. */
export async function runBridgeFromPlan(context: AdapterContext, plan: Plan): Promise<AdapterOutput> {
  const request = requestFromPlan(plan, context);
  if (!request) throw new Error("the plan has no bridge invocation");
  const ids = (qualityBridgeManifest.subchecks ?? []).map((s) => s.id);
  return executeBridge(context, request, subchecksFromPlan(plan, ids));
}
