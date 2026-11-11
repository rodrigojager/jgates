// The sections of the Ambiente screen. Each one is a card with a state pill, one primary action and a "Detalhes" fold;
// the raw engine text never leads, it sits in the details under the translated sentence.
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../api";
import type { EnvironmentReason, EnvironmentSection, JobEvent } from "../../api/environment";
import { CopyCommand } from "../../app/states";
import { ErrorNotice, Pill, Spinner } from "../../components/common";
import { Icon } from "../../components/icons";
import { getLocale, t, tOr } from "../../i18n";
import { useJob } from "../wizard/parts";
import { formatBytes } from "../wizard/api";

export type SectionId = "engine" | "image" | "data" | "dependencies" | "extension" | "services" | "codeql";

type Tone = "green" | "gold" | "red" | "blue" | undefined;

const TONE: Record<string, Tone> = {
  ready: "green",
  fresh: "green",
  prepared: "green",
  present: "green",
  running: "blue",
  stale: "gold",
  outdated: "gold",
  "version-mismatch": "gold",
  "low-memory": "gold",
  "not-ready": "gold",
  "not-prepared": "gold",
  missing: "red",
  failed: "red",
  stopped: "red",
  "not-installed": "red",
  unsupported: "red",
};

/** A section of the screen: heading, pill, the sentence, the primary action and the details. */
export function SectionCard({ id, state, summary, action, children, notices }: { id: SectionId; state: string; summary: string; action: ReactNode; children?: ReactNode; notices?: ReactNode }) {
  const headingId = `env-h-${id}`;
  return (
    <section className="card flat stack env-section" aria-labelledby={headingId} data-section={id} data-state={state}>
      <div className="between wrap">
        <h2 id={headingId}>{t(`env_sec_${id}`)}</h2>
        <Pill tone={TONE[state]}>{tOr(`env_state_${id}_${state}`, tOr(`env_state_${state}`, state))}</Pill>
      </div>
      <p data-testid={`env-summary-${id}`}>{summary}</p>
      {notices}
      <div className="row wrap env-action" data-testid={`env-action-${id}`}>
        {action}
      </div>
      {children ? (
        <details className="env-details">
          <summary>{t("env_details")}</summary>
          <div className="stack">{children}</div>
        </details>
      ) : null}
    </section>
  );
}

/** The action of a reason of the catalogue: a link, a route, or a command to copy; nothing for kind none. */
export function ReasonAction({ reason, primary = true }: { reason: EnvironmentReason; primary?: boolean }) {
  const a = reason.action;
  const cls = `btn${primary ? " primary" : ""}`;
  if (a.kind === "link" && a.url)
    return (
      <a className={cls} href={a.url} target="_blank" rel="noopener noreferrer">
        <Icon name="link" />
        {a.label}
      </a>
    );
  if (a.kind === "route" && a.route)
    return (
      <a className={cls} href={`#/${a.route.replace(/^\/+/, "")}`}>
        {a.label}
      </a>
    );
  if (a.kind === "command" && a.command)
    return (
      <div className="stack grow">
        <span className="small">{a.label}</span>
        <CopyCommand command={a.command} />
      </div>
    );
  return null;
}

/** The reasons of a section as sentences, the raw engine text folded under each. */
export function Reasons({ reasons }: { reasons: EnvironmentReason[] }) {
  if (reasons.length === 0) return null;
  return (
    <div className="stack tight">
      {reasons.map((r) => (
        <div className="notice warn" key={r.code} data-reason={r.code}>
          <Icon name="info" />
          <div className="grow stack tight">
            <p>{r.message}</p>
            {r.details ? (
              <details>
                <summary className="small">{t("env_raw_details")}</summary>
                <pre className="env-pre" tabIndex={0}>{r.details}</pre>
              </details>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The commands that fix an engine problem (install or start Docker): shown to copy, never run by the screen. */
export function RecipeCommands({ reason }: { reason: EnvironmentReason & { recipe?: { commands?: string[] } } }) {
  const commands = reason.recipe?.commands ?? [];
  if (commands.length === 0) return null;
  return (
    <div className="stack grow" data-testid="recipe">
      {reason.action.label ? <span className="small">{reason.action.label}</span> : null}
      <p className="small muted">{t("env_recipe_hint")}</p>
      {commands.map((c) => (
        <CopyCommand key={c} command={c} />
      ))}
    </div>
  );
}

export const firstActionable = (reasons: EnvironmentReason[]): EnvironmentReason | null => reasons.find((r) => r.action.kind !== "none") ?? null;

// ---- a job started from a section -------------------------------------------------------------------------------------

export type JobKindName = "pull" | "data" | "dependencies" | "codeql";

export interface SectionJob {
  state: "idle" | "starting" | "running" | "done" | "failed";
  events: JobEvent[];
  error: unknown;
  start: () => void;
}

/** Starts one environment job and follows it; `onEnd` runs when it ends, so the screen reads the state again. */
export function useSectionJob(kind: JobKindName, onEnd: () => void, extra: Record<string, unknown> = {}): SectionJob {
  const [id, setId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const followed = useJob(id);
  const finished = followed?.state === "done" || followed?.state === "failed" || followed?.state === "unknown";
  useEffect(() => {
    if (id && finished) onEnd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, finished]);
  const start = () => {
    setStarting(true);
    setError(null);
    api("POST", "/api/environment/jobs", { kind, locale: getLocale(), ...extra })
      .then((r: any) => setId(r.job.id as string))
      .catch(setError)
      .finally(() => setStarting(false));
  };
  const state: SectionJob["state"] = starting ? "starting" : !id ? "idle" : followed?.state === "done" ? "done" : followed?.state === "running" || !followed ? "running" : "failed";
  return { state, events: followed?.events ?? [], error, start };
}

/** The button that starts a job, with its progress line while it runs and its outcome after. */
export function JobButton({ job, label, running, disabled, primary = true, children }: { job: SectionJob; label: string; running: string; disabled?: boolean; primary?: boolean; children?: ReactNode }) {
  const busy = job.state === "starting" || job.state === "running";
  return (
    <>
      <button type="button" className={`btn${primary ? " primary" : ""}`} onClick={job.start} disabled={busy || disabled}>
        {busy ? <Spinner /> : <Icon name="refresh" />}
        {busy ? running : label}
      </button>
      {children}
      {job.error ? <ErrorNotice error={job.error} /> : null}
    </>
  );
}

/** "9 dias" / "nunca": the age of a database. */
export function ageText(days: number | null): string {
  return days === null ? t("env_age_never") : days === 0 ? t("env_age_today") : t("env_age_days", { days });
}

/** The last progress event of a pull as bytes. */
export function pullProgress(events: JobEvent[]): { downloaded: number; total: number } | null {
  const last = [...events].reverse().find((e) => e.type === "image-pull") as { downloaded?: number; total?: number } | undefined;
  return last ? { downloaded: Number(last.downloaded ?? 0), total: Number(last.total ?? 0) } : null;
}

export function PullProgress({ events }: { events: JobEvent[] }) {
  const p = pullProgress(events);
  if (!p) return <p className="small muted" role="status">{t("env_pull_starting")}</p>;
  return (
    <div className="stack tight grow" role="status">
      <progress max={p.total > 0 ? p.total : undefined} value={p.total > 0 ? p.downloaded : undefined} aria-label={t("env_pull_progress_label")} />
      <span className="small">{p.total > 0 ? t("env_pull_progress", { done: formatBytes(p.downloaded), total: formatBytes(p.total) }) : t("env_pull_starting")}</span>
    </div>
  );
}

export const mb = (value: number | null | undefined): string => (value === null || value === undefined ? t("env_unknown") : formatBytes(value * 1024 * 1024));

export type Sections = Record<SectionId, EnvironmentSection & Record<string, any>>;
