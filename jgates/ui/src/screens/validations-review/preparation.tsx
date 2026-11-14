// The "Preparação" group of the review: what happens before the checks (sync, dependencies, services, the own image),
// with a rough time and the network each step uses, and the one control that downloads the tools when they are missing.
import { useEffect, useState } from "react";
import { Pill } from "../../components/common";
import { Icon } from "../../components/icons";
import { fetchEnvironmentState, type EnvironmentState } from "../../api/environment";
import { getLocale, t } from "../../i18n";
import { JobButton, PullProgress, useSectionJob } from "../environment/sections";
import { PendingPreparations, type PendingPreparation } from "./not-running";

type Network = "none" | "bridge";

interface PrepStep {
  id: "sync" | "dependencies" | "services" | "extension";
  network: Network;
  /** What the step does, in one sentence. */
  text: string;
  /** Why the network is what it is: "sem rede (garantido)" or "com rede: registros de pacotes". */
  networkText: string;
  estimate: string;
  /** Already done earlier: nothing to wait for. */
  done: boolean;
}

/** The environment as the review needs it: read again whenever the plan is built again. */
export function useEnvironmentForReview(version: number): EnvironmentState | null {
  const [state, setState] = useState<EnvironmentState | null>(null);
  useEffect(() => {
    let alive = true;
    fetchEnvironmentState(getLocale()).then(
      (s) => alive && setState(s),
      () => alive && setState(null),
    );
    return () => {
      alive = false;
    };
  }, [version]);
  return state;
}

/** The steps that come before the checks of this plan; empty when the checks do not run in containers. */
export function preparationSteps(plan: any, env: EnvironmentState | null): PrepStep[] {
  // Container-first plans carry the container inputs (and the network of every step); a plan without them runs elsewhere.
  if (!plan?.inputs?.container) return [];
  const container = plan.inputs.container;
  const out: PrepStep[] = [{ id: "sync", network: "none", text: t("vrev_prep_sync"), networkText: t("vrev_prep_net_none"), estimate: t("vrev_prep_sync_estimate"), done: false }];

  const keys = Object.keys(container.dependencyKeys ?? {});
  if (keys.length > 0) {
    const units = ((env?.sections?.dependencies as any)?.units ?? []) as Array<{ components: string[]; state: string }>;
    const pending = keys.filter((component) => !units.some((u) => u.components.includes(component) && u.state === "ready"));
    out.push(
      pending.length === 0
        ? { id: "dependencies", network: "none", text: t("vrev_prep_deps_ready", { components: keys.join(", ") }), networkText: t("vrev_prep_net_none"), estimate: t("vrev_prep_deps_ready_estimate"), done: true }
        : { id: "dependencies", network: "bridge", text: t("vrev_prep_deps_first", { components: pending.join(", ") }), networkText: t("vrev_prep_net_packages"), estimate: t("vrev_prep_deps_first_estimate"), done: false },
    );
  }

  const services: string[] = container.services ?? [];
  if (services.length > 0) {
    out.push({ id: "services", network: "bridge", text: t("vrev_prep_services", { services: services.join(", ") }), networkText: t("vrev_prep_net_services"), estimate: t("vrev_prep_services_estimate"), done: false });
  }

  const extension = ((plan?.blockers ?? []) as Array<{ code: string }>).some((b) => b.code === "EXTENSION_OUTDATED") || (env?.sections?.extension?.reasons ?? []).some((r) => r.code === "EXTENSION_OUTDATED");
  if (extension) {
    out.push({ id: "extension", network: "bridge", text: t("vrev_prep_extension"), networkText: t("vrev_prep_net_extension"), estimate: t("vrev_prep_extension_estimate"), done: false });
  }
  return out;
}

export function PreparationGroup({ steps, pending = [], onChanged }: { steps: PrepStep[]; pending?: PendingPreparation[]; onChanged?: () => void }) {
  if (steps.length === 0 && pending.length === 0) return null;
  return (
    <section className="card flat stack" aria-labelledby="vrev-prep" data-testid="preparation">
      <h2 id="vrev-prep">{t("vrev_prep_title")}</h2>
      <p className="muted">{t("vrev_prep_lead")}</p>
      <ol className="stack" style={{ margin: 0, paddingLeft: 18, gap: 10 }}>
        {steps.map((s) => (
          <li key={s.id} data-prep={s.id} data-network={s.network} data-done={s.done}>
            <div className="row wrap">
              <strong>{t(`vrev_prep_name_${s.id}`)}</strong>
              <Pill tone={s.done ? "green" : undefined}>{s.done ? t("vrev_prep_ready") : s.estimate}</Pill>
              <Pill tone={s.network === "bridge" ? "gold" : "green"}>
                <Icon name={s.network === "bridge" ? "link" : "check"} />
                <span data-testid="prep-network">{s.networkText}</span>
              </Pill>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              {s.text}
            </p>
          </li>
        ))}
      </ol>
      {pending.length > 0 ? <PendingPreparations items={pending} onChanged={onChanged ?? (() => undefined)} /> : null}
    </section>
  );
}

/** The single TOOL_MISSING action: "Baixar as ferramentas do JGates", with the progress right here, then the plan is built again. */
export function ToolsDownload({ onDone }: { onDone: () => void }) {
  const job = useSectionJob("pull", onDone);
  const running = job.state === "running" || job.state === "starting";
  return (
    <div className="stack tight" data-testid="tools-download" data-state={job.state}>
      <div className="row wrap">
        <JobButton job={job} label={t("vrev_tools_download")} running={t("vrev_tools_downloading")} />
      </div>
      {running ? <PullProgress events={job.events} /> : null}
      {job.state === "failed" ? <p className="small" role="alert">{t("vrev_tools_failed")}</p> : null}
    </div>
  );
}
