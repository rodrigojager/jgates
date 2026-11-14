// The one network line of a review: what the checks use, and what the preparation steps still to do use. Both lines of
// the review (Revisar and the wizard's step 6) take their list of steps from the same place as the preparation block,
// so the line never says "no network" above a step that downloads.
import { t, tOr } from "../../i18n";

/** The part of the plan the line reads. */
interface PlanNetwork {
  network: { required: boolean; policy: string; items: string[] };
}

/** A preparation step as the line sees it: its name, the network it uses and whether it was done already. */
export interface NetworkStep {
  name: string;
  network: "none" | "bridge";
  done?: boolean;
}

/** "Nenhuma verificação usa a rede. A preparação usa a rede em: Dependências." */
export function networkLine(plan: PlanNetwork, steps: NetworkStep[]): string {
  const checks = plan.network.required
    ? t(plan.network.items.length === 1 ? "vrev_network_needed_one" : "vrev_network_needed", { policy: tOr(`vrev_network_policy_${plan.network.policy}`, plan.network.policy), count: plan.network.items.length })
    : t("vrev_network_none");
  const using = steps.filter((s) => s.network === "bridge" && !s.done).map((s) => s.name);
  if (using.length === 0) return `${checks}. ${t("vrev_network_prep_none")}`;
  return `${checks}. ${t("vrev_network_prep", { steps: using.join(", ") })}`;
}
