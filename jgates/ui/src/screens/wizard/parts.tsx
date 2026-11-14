// Pieces every step of the wizard uses: the folded equivalent command, a reason with its one action, the step's
// navigation (Voltar, Pular por agora, Continuar) and a follower of a background job.
import { useEffect, useState, type ReactNode } from "react";
import { followJob, type JobEvent, type JobPage } from "../../api/environment";
import { CopyCommand } from "../../app/states";
import { Spinner } from "../../components/common";
import { Icon } from "../../components/icons";
import { t } from "../../i18n";
import type { Reason } from "./api";

/** "Comando equivalente": the CLI line that does the same, folded. */
export function EquivalentCommand({ command }: { command: string }) {
  return (
    <details className="wizard-command" data-testid="wizard-command">
      <summary>{t("wizard_command")}</summary>
      <CopyCommand command={command} />
    </details>
  );
}

/** One reason of the shared catalogue: the sentence, its one action, the recipe (shown, never run) and the raw details folded. */
export function ReasonNotice({ reason, tone = "warn" }: { reason: Reason; tone?: "warn" | "error" | "info" }) {
  const action = reason.action;
  return (
    <div className={`notice${tone === "info" ? "" : ` ${tone}`}`} data-reason={reason.code}>
      <Icon name={tone === "error" ? "alert" : "info"} />
      <div className="grow stack">
        <p>{reason.message}</p>
        {action.kind === "link" && action.url ? (
          <div>
            <a className="btn primary" href={action.url} target="_blank" rel="noopener noreferrer">
              <Icon name="link" />
              {action.label}
            </a>
          </div>
        ) : null}
        {action.kind === "route" && action.route ? (
          <div>
            <a className="btn" href={`#${action.route}`}>
              {action.label}
            </a>
          </div>
        ) : null}
        {action.kind === "command" && action.command ? <CopyCommand command={action.command} /> : null}
        {reason.recipe && (reason.recipe.commands ?? []).length > 0 ? (
          <details>
            <summary>{t("wizard_recipe")}</summary>
            <p className="small muted">{t("wizard_recipe_hint")}</p>
            {(reason.recipe.commands ?? []).map((command) => (
              <CopyCommand key={command} command={command} />
            ))}
          </details>
        ) : null}
        {reason.details ? (
          <details>
            <summary>{t("wizard_details")}</summary>
            <pre className="wizard-pre">{reason.details}</pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

export interface StepNavProps {
  onBack?: (() => void) | null;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  onSkip?: (() => void) | null;
  skipLabel?: string;
  busy?: boolean;
  extra?: ReactNode;
  /** The step has another primary action (the download) while this is false: Continuar steps back. */
  nextPrimary?: boolean;
}

/** Voltar, Pular por agora (only where skipping leaves a working path) and the primary action of the step. */
export function StepNav({ onBack, onNext, nextLabel, nextDisabled, onSkip, skipLabel, busy, extra, nextPrimary = true }: StepNavProps) {
  return (
    <div className="wizard-nav" data-testid="wizard-nav">
      {onBack ? (
        <button type="button" className="btn" onClick={onBack} disabled={busy}>
          {t("wizard_back")}
        </button>
      ) : null}
      <span className="grow" />
      {extra}
      {onSkip ? (
        <button type="button" className="btn" onClick={onSkip} disabled={busy}>
          {skipLabel ?? t("wizard_skip")}
        </button>
      ) : null}
      <button type="button" className={`btn${nextPrimary ? " primary" : ""}`} onClick={onNext} disabled={busy || nextDisabled}>
        {busy ? <Spinner /> : <Icon name="chevron" />}
        {nextLabel ?? t("wizard_next")}
      </button>
    </div>
  );
}

export interface FollowedJob {
  state: JobPage["job"]["state"] | "unknown";
  events: JobEvent[];
}

/** Follows an environment job by id (long polling) for as long as the step is on screen. */
export function useJob(id: string | null, known = true): FollowedJob | null {
  const [job, setJob] = useState<FollowedJob | null>(null);
  useEffect(() => {
    setJob(null);
    if (!id) return;
    if (!known) {
      setJob({ state: "unknown", events: [] });
      return;
    }
    const abort = new AbortController();
    let events: JobEvent[] = [];
    setJob({ state: "running", events });
    followJob(
      id,
      (batch, page) => {
        events = [...events, ...batch];
        setJob({ state: page.state, events });
      },
      abort.signal,
    )
      .then((page) => setJob({ state: page.state, events }))
      .catch(() => {
        if (!abort.signal.aborted) setJob({ state: "unknown", events });
      });
    return () => abort.abort();
  }, [id, known]);
  return job;
}
