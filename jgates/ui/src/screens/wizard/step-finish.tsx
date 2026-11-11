// Steps 5 and 6: the project's dependencies (prepared now, or as soon as the tools finish downloading) and the review
// of the first validation, whose primary button starts it.
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { ErrorNotice, Loading, Pill, Spinner } from "../../components/common";
import { Icon } from "../../components/icons";
import { t, tOr } from "../../i18n";
import { advance, fetchDependencies, fetchSetup, prepareDependencies, type DependenciesInfo } from "./api";
import { EquivalentCommand, StepNav, useJob } from "./parts";
import type { StepProps } from "./Wizard";

const STATE_TONE: Record<string, "green" | "gold" | "red" | "blue" | undefined> = { ready: "green", failed: "red", outdated: "gold", missing: undefined, "not-ready": undefined };

interface UnitEvent {
  unit: { unit: string; status: string; message: string; details: string | null };
}

export function DependenciesStep({ view, act, apply, busy, back }: StepProps) {
  const [info, setInfo] = useState<DependenciesInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    fetchDependencies().then((next) => {
      setInfo(next);
      setError(null);
    }, setError);
  }, []);
  useEffect(load, [load]);

  const depsRef = view.setup.jobs.dependencies;
  const pullRef = view.setup.jobs.pull;
  const deps = useJob(depsRef?.id ?? null, depsRef?.known ?? true);
  const pull = useJob(view.setup.dependencies === "queued" ? (pullRef?.id ?? null) : null, pullRef?.known ?? true);
  // The pull ended: the server started the queued dependencies; learn their job.
  const pullState = pull?.state ?? null;
  useEffect(() => {
    if (pullState === "done" || pullState === "failed") fetchSetup().then(apply, () => undefined);
  }, [pullState, apply]);
  const depsState = deps?.state ?? null;
  useEffect(() => {
    if (depsState === "done" || depsState === "failed") load();
  }, [depsState, load]);

  if (!info) return error ? <ErrorNotice error={error} onRetry={load} /> : <Loading />;
  const outcomes = new Map((deps?.events ?? []).filter((e) => e.type === "dependencies-unit").map((e) => [(e as unknown as UnitEvent).unit.unit, (e as unknown as UnitEvent).unit]));
  const queued = view.setup.dependencies === "queued";
  const running = deps?.state === "running";

  return (
    <div className="stack" data-testid="wizard-step-dependencies">
      <p className="wizard-lead">{t("wizard_deps_lead")}</p>
      {error ? <ErrorNotice error={error} /> : null}
      {info.units.length === 0 ? <p>{t("wizard_deps_none")}</p> : null}
      <ul className="wizard-cards" aria-label={t("wizard_deps_list")}>
        {info.units.map((u) => {
          const outcome = outcomes.get(u.unit);
          return (
            <li key={u.unit} className="card flat stack" data-unit={u.unit} data-state={outcome?.status ?? u.state}>
              <div className="row wrap">
                <strong className="mono">{u.unit}</strong>
                <Pill tone={STATE_TONE[u.state]}>{tOr(`wizard_deps_state_${u.state.replace(/-/g, "_")}`, u.state)}</Pill>
              </div>
              <p className="small">
                {[u.manager ?? "?", u.lockfile ?? t("wizard_project_no_lockfile"), u.languageVersion ? `${u.ecosystem} ${u.languageVersion}` : u.ecosystem].join(" · ")}
              </p>
              {u.components.length > 1 ? <p className="small muted">{t("wizard_deps_components", { components: u.components.join(", ") })}</p> : null}
              {outcome ? (
                <details>
                  <summary>{outcome.message}</summary>
                  {outcome.details ? <pre className="wizard-pre">{outcome.details}</pre> : <p className="small muted">{t("wizard_deps_no_log")}</p>}
                </details>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div role="status" aria-live="polite" data-testid="wizard-deps-status" data-state={queued ? "queued" : running ? "running" : (deps?.state ?? view.setup.dependencies)}>
        {queued ? <p className="notice">{t("wizard_deps_queued")}</p> : null}
        {running ? <p className="spinner-text">{t("wizard_deps_running")}</p> : null}
        {deps?.state === "done" ? <p>{t("wizard_deps_done")}</p> : null}
      </div>
      {deps?.state === "failed" ? <p className="notice error" role="alert">{t("wizard_deps_failed")}</p> : null}
      {info.units.length > 0 && !queued && !running ? (
        <div className="row wrap">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void act(prepareDependencies)}>
            <Icon name="play" />
            {deps?.state === "failed" ? t("wizard_deps_retry") : t("wizard_deps_prepare")}
          </button>
        </div>
      ) : null}
      <EquivalentCommand command="jgates deps prepare" />
      <StepNav onBack={back} busy={busy} onSkip={info.units.length > 0 ? () => void act(() => advance("dependencies", { skip: true })) : null} onNext={() => void act(() => advance("dependencies"))} />
    </div>
  );
}

interface PlanAnswer {
  planHash: string;
  approvable: boolean;
  plan: {
    groups: {
      willRun: Array<{ id: string; label: string; category: string | null; networkKind?: "none" | "bridge"; network: boolean }>;
      notApplicableRequirements?: Array<{ message: string; reasonCode?: string }>;
    };
    blocked: { code: string; message: string } | null;
    blockers: Array<{ code: string; message: string }>;
  };
}

export function ReviewStep({ view, act, apply, busy, back, finished }: StepProps) {
  const [plan, setPlan] = useState<PlanAnswer | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [building, setBuilding] = useState(false);
  const [armed, setArmed] = useState(false);
  const pullRef = view.setup.jobs.pull;
  const depsRef = view.setup.jobs.dependencies;
  const pull = useJob(pullRef?.id ?? null, pullRef?.known ?? true);
  const deps = useJob(depsRef?.id ?? null, depsRef?.known ?? true);
  // The first validation waits for the download and for dependencies being installed (queued ones follow the download).
  const waiting = pull?.state === "running" || deps?.state === "running";

  // When the pull ends the queued dependencies get their job: read the view again.
  const pullState = pull?.state ?? null;
  useEffect(() => {
    if (pullState === "done" || pullState === "failed") fetchSetup().then(apply, () => undefined);
  }, [pullState, apply]);

  const build = useCallback(async () => {
    setBuilding(true);
    setError(null);
    try {
      setPlan(await api<PlanAnswer>("POST", "/api/plans", {}));
    } catch (e) {
      setError(e);
    } finally {
      setBuilding(false);
    }
  }, []);
  // The plan is built once the preparation that changes it (the tools image) is over, and again when it ends.
  useEffect(() => {
    if (!waiting) void build();
  }, [waiting, build]);

  const start = useCallback(
    (hash: string) =>
      void act(async () => {
        const answer = await advance("review", { planHash: hash });
        finished(answer.run?.id ?? null);
        return answer;
      }),
    [act, finished],
  );
  // "Executar assim que estiver pronto": the run starts by itself once the preparation ended and the plan can run.
  useEffect(() => {
    if (armed && !waiting && !building && plan?.approvable) {
      setArmed(false);
      start(plan.planHash);
    }
  }, [armed, waiting, building, plan, start]);

  const blockers = plan ? (plan.plan.blocked ? [plan.plan.blocked, ...plan.plan.blockers] : plan.plan.blockers) : [];
  const phase = (label: string, state: string) => (
    <li className="row wrap" data-phase={label}>
      <span className="grow">{t(`wizard_review_phase_${label}`)}</span>
      <Pill tone={state === "done" || state === "ready" ? "green" : state === "failed" ? "red" : state === "skipped" ? "gold" : undefined}>{tOr(`wizard_review_state_${state.replace(/-/g, "_")}`, state)}</Pill>
    </li>
  );
  const pullPhase = pull ? pull.state : pullRef ? "unknown" : "ready";
  const depsPhase = view.setup.dependencies === "skipped" ? "skipped" : view.setup.dependencies === "queued" ? "queued" : (deps?.state ?? (view.setup.dependencies === "idle" ? "on-run" : "unknown"));

  return (
    <div className="stack" data-testid="wizard-step-review">
      <p className="wizard-lead">{t("wizard_review_lead")}</p>
      <section className="stack" aria-labelledby="wizard-review-prep">
        <h2 id="wizard-review-prep">{t("wizard_review_prep")}</h2>
        <ul className="wizard-plain wizard-phases" aria-live="polite">
          {phase("tools", pullPhase)}
          {phase("dependencies", depsPhase)}
        </ul>
        {waiting ? <p className="notice">{t("wizard_review_waiting")}</p> : null}
      </section>
      {error ? <ErrorNotice error={error} onRetry={() => void build()} /> : null}
      {building ? <p className="spinner-text" role="status">{t("wizard_review_building")}</p> : null}
      {plan && !building ? (
        <section className="stack" aria-labelledby="wizard-review-plan" data-testid="wizard-plan" data-approvable={plan.approvable ? "true" : "false"}>
          <h2 id="wizard-review-plan">{t("wizard_review_plan", { count: plan.plan.groups.willRun.length })}</h2>
          <ul className="wizard-plain wizard-steps">
            {plan.plan.groups.willRun.map((item) => (
              <li key={item.id} className="row wrap">
                <span className="grow">{item.label}</span>
                {item.category ? <span className="small muted">{tOr(`wizard_category_${item.category}`, item.category)}</span> : null}
                <Pill tone={item.networkKind === "bridge" || item.network ? "gold" : undefined}>{item.networkKind === "bridge" || item.network ? t("wizard_review_network") : t("wizard_review_no_network")}</Pill>
              </li>
            ))}
          </ul>
          {(plan.plan.groups.notApplicableRequirements ?? []).length > 0 ? (
            <details>
              <summary>{t("wizard_review_not_applicable", { count: (plan.plan.groups.notApplicableRequirements ?? []).length })}</summary>
              <ul className="wizard-plain">
                {(plan.plan.groups.notApplicableRequirements ?? []).map((entry, i) => (
                  <li key={`${entry.reasonCode ?? ""}-${i}`} className="small">
                    {entry.message}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {blockers.length > 0 && !waiting ? (
            <div className="notice warn" role="alert">
              <Icon name="alert" />
              <ul className="wizard-plain grow">
                {blockers.map((b) => (
                  <li key={b.code + b.message}>{b.message}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
      {armed ? <p className="small" role="status">{t("wizard_review_armed")}</p> : null}
      <EquivalentCommand command="jgates run" />
      <StepNav
        onBack={back}
        busy={busy || building}
        onSkip={view.configured ? () => void act(async () => {
          const answer = await advance("review", { skip: true });
          finished(null);
          return answer;
        }) : null}
        skipLabel={t("wizard_review_skip")}
        nextLabel={waiting ? t("wizard_review_run_when_ready") : t("wizard_review_run")}
        nextDisabled={waiting ? armed : !plan?.approvable}
        onNext={() => {
          if (waiting) setArmed(true);
          else if (plan) start(plan.planHash);
        }}
        extra={building ? <Spinner /> : null}
      />
    </div>
  );
}
