import { useEffect, useState } from "react";
import { navigate } from "../../app/route";
import { ErrorNotice, Loading, Spinner } from "../../components/common";
import { Icon } from "../../components/icons";
import { t } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { STEPS, fetchSetup, reopenSetup, type SetupView, type StepId } from "./api";
import Wizard from "./Wizard";
import "./wizard.css";

// #/setup: "Refazer a configuração guiada". A wizard that has not ended (the first one, or one reopened earlier) is
// shown where it was. Once the setup ended, opening the screen changes nothing (D13): the person chooses the step to
// start at and opens the wizard explicitly. A reopened wizard lives here only; the overview stays the overview.
export const screen: ScreenMeta = { id: "wizard", path: "/setup", area: "overview", order: 2 };

export default function WizardScreen() {
  const [view, setView] = useState<SetupView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [opening, setOpening] = useState(false);
  const [step, setStep] = useState<StepId>("docker");
  useEffect(() => {
    let alive = true;
    fetchSetup().then(
      (next) => alive && setView(next),
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, []);
  if (!view) return error ? <ErrorNotice error={error} /> : <Loading />;
  if (view.open || (view.started && !view.setup.completed)) return <Wizard />;

  const reachable = view.setup.steps.filter((s) => s.reachable).map((s) => s.id);
  const open = async () => {
    setOpening(true);
    setError(null);
    try {
      setView(await reopenSetup(step));
    } catch (e) {
      setError(e);
    } finally {
      setOpening(false);
    }
  };
  return (
    <section className="wizard stack" aria-labelledby="wizard-reopen-title" data-state="wizard-reopen">
      <p className="eyebrow">{t("wizard_eyebrow")}</p>
      <h1 id="wizard-reopen-title">{t("wizard_redo")}</h1>
      <div className="card stack">
        <p>{t("wizard_reopen_lead")}</p>
        <label className="stack wizard-reopen-step">
          <span>{t("wizard_reopen_step")}</span>
          <select value={step} onChange={(e) => setStep(e.target.value as StepId)} data-testid="wizard-reopen-step">
            {STEPS.filter((s) => reachable.includes(s)).map((s) => (
              <option key={s} value={s}>
                {`${STEPS.indexOf(s) + 1} · ${t(`wizard_step_${s}`)}`}
              </option>
            ))}
          </select>
        </label>
        {error ? <ErrorNotice error={error} /> : null}
        <div className="row wrap">
          <button type="button" className="btn primary" onClick={() => void open()} aria-busy={opening}>
            {opening ? <Spinner /> : <Icon name="play" />}
            {t("wizard_reopen_open")}
          </button>
          <button type="button" className="btn" onClick={() => navigate("/overview")}>
            {t("wizard_reopen_overview")}
          </button>
        </div>
      </div>
    </section>
  );
}
