// Step 6, the review of the first validation. It starts with the gate and the target (the same controls as Escolher),
// then the preparation still to do (one button per pending item), what the step is waiting for, the plan grouped by
// category with each row named by what is checked, and what will not run as items with their reason and buttons. The
// primary button runs the first Quality validation; with Semantic in the choice it goes on to the review screen, which
// owns the sequence of the two gates.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { QualityMascotStrip } from "../../components/QualityMascotStrip";
import { ErrorNotice, Pill, Spinner, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { useShell } from "../../app/shell-context";
import { t, tOr } from "../../i18n";
import { capabilityStates } from "../validations-review/capability-states";
import { GateTargetChoice, savedRequest, targetProblem, type ChooseSelection } from "../validations-review/gate-target";
import { networkLine } from "../validations-review/network";
import { NotRunningList, PendingPreparations, type NotRunningGroup, type PendingPreparation } from "../validations-review/not-running";
import { EMPTY_REQUEST, planBody, writeRequest, type ValidationRequest } from "../validations-review/request";
import { WaiversSection, hasWaiversToShow, type WaiverListing } from "../validations-review/waivers";
import { advance, fetchSetup } from "./api";
import { EquivalentCommand, StepNav, useJob } from "./parts";
import type { StepProps } from "./Wizard";


interface PlanAnswer {
  planHash: string;
  approvable: boolean;
  mascots?: unknown;
  plan: {
    profile: { id: string; chain?: Array<{ file: string }> } | null;
    groups: {
      willRun: Array<{ id: string; label: string; category: string | null; capabilities: string[]; networkKind?: "none" | "bridge"; network: boolean }>;
    };
    network: { required: boolean; policy: string; items: string[] };
    blocked: { code: string; message: string } | null;
    blockers: Array<{ code: string; message: string }>;
  };
  review: {
    catalog?: { categories: Array<{ id: string; label: string }>; capabilities: Array<{ id: string; label: string; category: string }> } | null;
    notRunning?: { total: number; groups: NotRunningGroup[] };
    preparations?: PendingPreparation[];
    waivers?: WaiverListing;
  };
}

export function ReviewStep({ view, act, apply, busy, back, finished }: StepProps) {
  const { info } = useShell();
  const choose = useAsync(() => api<ChooseSelection & Record<string, unknown>>("GET", "/api/validations/choose"), "wizard-choose");
  const [request, setRequest] = useState<ValidationRequest>(EMPTY_REQUEST);
  const [seeded, setSeeded] = useState(false);
  const [answer, setAnswer] = useState<PlanAnswer | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [building, setBuilding] = useState(false);
  const [armed, setArmed] = useState(false);
  const [busyPreps, setBusyPreps] = useState<string[]>([]);
  const pullRef = view.setup.jobs.pull;
  const depsRef = view.setup.jobs.dependencies;
  const pull = useJob(pullRef?.id ?? null, pullRef?.known ?? true);
  const deps = useJob(depsRef?.id ?? null, depsRef?.known ?? true);
  // The first validation waits for the download and for dependencies being installed (queued ones follow the download).
  const jobsRunning = pull?.state === "running" || deps?.state === "running";
  const waiting = jobsRunning || busyPreps.length > 0;

  const set = useCallback((patch: Partial<ValidationRequest>) => setRequest((r) => ({ ...r, ...patch })), []);
  // The recommended choice is the one the project saved as its default, or Quality on the whole workspace.
  useEffect(() => {
    if (choose.data && !seeded) {
      setSeeded(true);
      setRequest((r) => ({ ...r, ...savedRequest(choose.data?.saved) }));
    }
  }, [choose.data, seeded]);

  // When the pull ends the queued dependencies get their job: read the view again.
  const pullState = pull?.state ?? null;
  useEffect(() => {
    if (pullState === "done" || pullState === "failed") fetchSetup().then(apply, () => undefined);
  }, [pullState, apply]);

  const body = useMemo(() => planBody(request), [request]);
  const problem = targetProblem(request);
  const latest = useRef(0);
  const build = useCallback(async () => {
    const mine = ++latest.current;
    setBuilding(true);
    setError(null);
    try {
      const next = await api<PlanAnswer>("POST", "/api/plans", body);
      if (mine === latest.current) setAnswer(next);
    } catch (e) {
      if (mine === latest.current) {
        setAnswer(null);
        setError(e);
      }
    } finally {
      if (mine === latest.current) setBuilding(false);
    }
  }, [body]);
  // The plan is built once the choice is known and the preparation that changes it (the tools image) is over, and
  // again when the choice changes or the preparation ends. Semantic alone has no Quality plan to show.
  useEffect(() => {
    if (!seeded || jobsRunning || problem || request.gates === "semantic") return;
    void build();
  }, [seeded, jobsRunning, problem, request.gates, build]);

  const plan = answer?.plan ?? null;
  const review = answer?.review ?? {};
  const preparations = review.preparations ?? [];
  const approvable = Boolean(answer?.approvable) && request.gates === "quality" && !problem;
  const running = request.gates === "quality";

  const start = useCallback(
    (hash: string) =>
      void act(async () => {
        const result = await advance("review", { planHash: hash });
        finished(result.run?.id ?? null);
        return result;
      }),
    [act, finished],
  );
  // The gates that include Semantic go on in the review screen, which plans and runs the sequence; the wizard ends here.
  const goOn = useCallback(
    () =>
      void act(async () => {
        const result = await advance("review", { skip: true });
        writeRequest(request);
        finished(null, request.gates === "semantic" ? "/semantic/setup" : "/validations/review");
        return result;
      }),
    [act, finished, request],
  );
  // "Executar assim que estiver pronto": the run starts by itself once the preparation ended and the plan can run.
  useEffect(() => {
    if (armed && !waiting && !building && approvable && answer) {
      setArmed(false);
      start(answer.planHash);
    }
  }, [armed, waiting, building, approvable, answer, start]);

  const blockers = plan ? (plan.blocked ? [plan.blocked, ...plan.blockers] : plan.blockers) : [];
  const phase = (label: string, state: string) => (
    <li className="row wrap" data-phase={label}>
      <span className="grow">{t(`wizard_review_phase_${label}`)}</span>
      <Pill tone={state === "done" || state === "ready" ? "green" : state === "failed" ? "red" : state === "skipped" ? "gold" : undefined}>{tOr(`wizard_review_state_${state.replace(/-/g, "_")}`, state)}</Pill>
    </li>
  );
  const pullPhase = pull ? pull.state : pullRef ? "unknown" : "ready";
  const depsPhase = view.setup.dependencies === "skipped" ? "skipped" : view.setup.dependencies === "queued" ? "queued" : (deps?.state ?? (view.setup.dependencies === "idle" ? "on-run" : "unknown"));

  // Exactly what the step is waiting for, by name.
  const waitingFor = [
    ...(pull?.state === "running" || busyPreps.includes("tools") ? [t("wizard_wait_tools")] : []),
    ...(deps?.state === "running" || busyPreps.includes("dependencies") ? [t("wizard_wait_dependencies")] : []),
    ...(busyPreps.includes("data") ? [t("wizard_wait_data")] : []),
    ...(building ? [t("wizard_wait_plan")] : []),
  ];

  // The plan by what is checked: one row per capability that runs, with the tools that do it, grouped by category.
  const groups = useMemo(() => (plan ? capabilityStates(plan, review.catalog ?? null) : []), [plan, review.catalog]);
  const rows = groups.map((g) => ({ ...g, items: g.items.filter((s) => s.kind === "run") })).filter((g) => g.items.length > 0);
  const total = rows.reduce((n, g) => n + g.items.length, 0);
  const needsNetwork = (capability: string): boolean => (plan?.groups.willRun ?? []).some((i) => i.capabilities.includes(capability) && (i.networkKind === "bridge" || i.network));
  const projectProfile = plan?.profile && !String(plan.profile.chain?.[0]?.file ?? "builtin:").startsWith("builtin:") ? String(plan.profile.id) : null;
  const ctx = { profile: projectProfile, onChanged: () => void build() };

  return (
    <div className="stack" data-testid="wizard-step-review">
      <p className="wizard-lead">{t("wizard_review_lead")}</p>
      {choose.error ? <ErrorNotice error={choose.error} onRetry={choose.reload} /> : null}
      <GateTargetChoice request={request} set={set} data={choose.data} git={info?.git ?? null} idPrefix="wizard" onSaved={choose.reload} />

      <section className="stack" aria-labelledby="wizard-review-prep" data-testid="wizard-preparation">
        <h2 id="wizard-review-prep">{t("wizard_review_prep")}</h2>
        <ul className="wizard-plain wizard-phases" aria-live="polite">
          {phase("tools", pullPhase)}
          {phase("dependencies", depsPhase)}
        </ul>
        <PendingPreparations items={preparations} onChanged={() => void build()} onBusy={setBusyPreps} />
        {preparations.length === 0 && !waiting && plan ? <p className="small muted">{t("wizard_review_prep_none")}</p> : null}
        {waitingFor.length > 0 ? (
          <p className="notice" role="status" data-testid="wizard-waiting">
            {t("wizard_review_waiting_for", { items: waitingFor.join(", ") })}
          </p>
        ) : null}
      </section>

      {error ? <ErrorNotice error={error} onRetry={() => void build()} /> : null}
      {problem ? (
        <p className="notice warn" role="status" data-testid="wizard-choice-problem">
          {t(problem === "path" ? "vch_path_required" : "gtc_pr_required")}
        </p>
      ) : null}
      {request.gates === "semantic" ? <p className="notice" data-testid="wizard-semantic-note">{t("wizard_review_semantic_note")}</p> : null}
      {building && !answer ? <p className="spinner-text" role="status">{t("wizard_review_building")}</p> : null}

      {plan && answer && request.gates !== "semantic" && !problem ? (
        <section className="stack" aria-labelledby="wizard-review-plan" data-testid="wizard-plan" data-approvable={approvable ? "true" : "false"} aria-busy={building}>
          <h2 id="wizard-review-plan">{t("wizard_review_plan", { count: total })}</h2>
          <QualityMascotStrip snapshot={answer.mascots as never} />
          <p className="small" data-testid="wizard-network">
            <strong>{t("vrev_network")}:</strong>{" "}
            {networkLine(
              plan,
              preparations.map((p) => ({ name: p.label, network: p.network })),
            )}
          </p>
          {rows.map((group) => (
            <div key={group.id} className="stack tight" data-category={group.id} data-testid="wizard-plan-group">
              <h3>{group.label}</h3>
              <ul className="wizard-plain wizard-steps">
                {group.items.map((item) => (
                  <li key={item.id} className="row wrap" data-capability={item.id} data-testid="wizard-plan-row">
                    <strong>{item.label}</strong>
                    <span className="small muted grow">{item.tools.join(", ")}</span>
                    {needsNetwork(item.id) ? <Pill tone="gold">{t("wizard_review_network")}</Pill> : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {review.notRunning ? <NotRunningList groups={review.notRunning.groups} total={review.notRunning.total} ctx={ctx} headingId="wizard-not-running" level={2} /> : null}
          {hasWaiversToShow(review.waivers) ? <WaiversSection listing={review.waivers as WaiverListing} headingId="wizard-waivers" level={2} /> : null}
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
        busy={busy}
        onSkip={view.configured ? () => void act(async () => {
          const result = await advance("review", { skip: true });
          finished(null);
          return result;
        }) : null}
        skipLabel={t("wizard_review_skip")}
        nextLabel={!running ? t(request.gates === "semantic" ? "wizard_review_go_semantic" : "wizard_review_go_both") : waiting ? t("wizard_review_run_when_ready") : t("wizard_review_run")}
        nextDisabled={running ? (waiting ? armed : !approvable || building) : Boolean(problem)}
        onNext={() => {
          if (!running) goOn();
          else if (waiting) setArmed(true);
          else if (answer) start(answer.planHash);
        }}
        extra={building ? <Spinner /> : null}
      />
    </div>
  );
}

