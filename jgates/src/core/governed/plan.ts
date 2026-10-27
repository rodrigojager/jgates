// The plan of an adapter's tool instance under a CI policy (jgates ci and its preview): an adapter the trust table
// excludes is unavailable with the reason and blocks the plan (the policy that turns it on is refused, exit 3); a
// self-reported one says so in its conditions.
import { translator } from "../../i18n/index.js";
import type { ExternalPlan } from "../plan/adapters.js";
import { ADAPTER_TRUST, adapterTreatment } from "./trust.js";

export function governExternalPlan(adapter: string, tool: string, planned: ExternalPlan): ExternalPlan {
  const t = translator("governed");
  const treatment = adapterTreatment(adapter, planned.effects?.executesProjectCode === true);
  if (treatment === "excluded") {
    const why = ADAPTER_TRUST[adapter] ? t(`governed_excluded_${adapter}`) : t("governed_adapter_unknown");
    return { ...planned, availability: { status: "unavailable", reason: t("governed_adapter_excluded", { tool, adapter, why }) }, blocksPlan: true };
  }
  if (treatment === "self-reported") return { ...planned, conditions: [...planned.conditions, t("governed_condition_self_reported", { adapter })] };
  return planned;
}
