// The first-run wizard: six steps, recommended choices preselected, Voltar/Continuar, the state saved on the server (a
// reload resumes at the same step), the downloads going on in the background. It is the overview's content until the
// setup ends (app/states.tsx, SetupGate) and the screen of #/setup ("Refazer a configuração guiada").
import { useCallback, useEffect, useRef, useState } from "react";
import { navigate } from "../../app/route";
import { useShell } from "../../app/shell-context";
import { ErrorNotice, Loading } from "../../components/common";
import { Stepper } from "../../components/Stepper";
import { t } from "../../i18n";
import { STEPS, closeSetup, fetchSetup, gotoStep, type SetupView, type StepId } from "./api";
import { DependenciesStep, ReviewStep } from "./step-finish";
import { DockerStep, ToolsStep } from "./step-machine";
import { ProfileStep, ProjectStep } from "./step-project";
import "./wizard.css";

export interface StepProps {
  view: SetupView;
  /** Runs one action of the step: busy while it runs, its error shown above the step, its answer as the new view. */
  act: (work: () => Promise<SetupView | void>) => Promise<boolean>;
  apply: (next: SetupView) => void;
  busy: boolean;
  back: (() => void) | null;
  /** The setup ended (first run started, or the person finished without one). */
  finished: (runId: string | null) => void;
}

export default function Wizard({ onClosed }: { onClosed?: () => void }) {
  const { reload } = useShell();
  const [view, setView] = useState<SetupView | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef<StepId | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    fetchSetup().then(setView, setLoadError);
  }, []);
  useEffect(load, [load]);

  // A new step takes the focus to its title, so a keyboard user hears where they are and goes on from there.
  const step = view?.setup.step ?? null;
  useEffect(() => {
    if (step === null) return;
    if (shownStep.current !== null && shownStep.current !== step) heading.current?.focus();
    shownStep.current = step;
  }, [step]);

  const act = useCallback(async (work: () => Promise<SetupView | void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const next = await work();
      if (next) setView(next);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const finished = useCallback(
    (runId: string | null) => {
      void reload();
      if (runId) navigate(`/runs/${runId}`);
      else if (onClosed) onClosed();
      else navigate("/overview");
    },
    [reload, onClosed],
  );

  if (!view) return loadError ? <ErrorNotice error={loadError} onRetry={load} /> : <Loading />;

  const current = view.setup.step;
  const index = STEPS.indexOf(current);
  const back = index > 0 ? () => void act(() => gotoStep(STEPS[index - 1] as StepId)) : null;
  const props: StepProps = { view, act, apply: setView, busy, back, finished };
  const close = () =>
    void act(async () => {
      await closeSetup();
      finished(null);
    });

  return (
    <section className="wizard stack" aria-labelledby="wizard-title" data-state="wizard" data-step={current}>
      <div className="between wrap">
        <p className="eyebrow">{t("wizard_eyebrow")}</p>
        {view.configured ? (
          <button type="button" className="btn" onClick={close} disabled={busy}>
            {t("wizard_close")}
          </button>
        ) : null}
      </div>
      <h1 id="wizard-title" ref={heading} tabIndex={-1}>
        {t("wizard_title", { n: index + 1, total: STEPS.length, name: t(`wizard_step_${current}`) })}
      </h1>
      <Stepper
        label={t("wizard_steps_label")}
        current={current}
        steps={view.setup.steps.map((s) => ({ id: s.id, label: t(`wizard_step_${s.id}`), done: s.state === "done" || s.state === "skipped", disabled: !s.reachable || busy }))}
        onSelect={(id) => {
          if (id !== current) void act(() => gotoStep(id as StepId));
        }}
      />
      {error ? <ErrorNotice error={error} /> : null}
      <div className="wizard-body card stack">
        {current === "docker" ? <DockerStep key={current} {...props} /> : null}
        {current === "tools" ? <ToolsStep key={current} {...props} /> : null}
        {current === "project" ? <ProjectStep key={current} {...props} /> : null}
        {current === "profile" ? <ProfileStep key={current} {...props} /> : null}
        {current === "dependencies" ? <DependenciesStep key={current} {...props} /> : null}
        {current === "review" ? <ReviewStep key={current} {...props} /> : null}
      </div>
    </section>
  );
}
