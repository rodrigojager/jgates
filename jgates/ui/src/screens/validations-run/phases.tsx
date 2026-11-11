// The five phases of a run, in order: Sincronizar, Dependências, Serviços, Verificações, Encerrar serviços. Each shows
// its state and its log block (the log the phase wrote into the run folder). Built from the run's events only, so a
// replay from cursor 0 gives the same picture.
import { useEffect, useState } from "react";
import { api } from "../../api";
import { ErrorNotice, Pill, Spinner } from "../../components/common";
import { Icon } from "../../components/icons";
import { t, tOr } from "../../i18n";
import { formatDuration } from "../validations-result/ResultView";
import "./step-log.css";
import "./phases.css";

export const PHASES = ["sync", "deps", "services", "checks", "services-down"] as const;
export type PhaseId = (typeof PHASES)[number];
export type PhaseState = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";

export interface PhaseEvent {
  sequence: number;
  type: string;
  at: string;
  data: Record<string, any>;
}

export interface PhaseView {
  id: PhaseId;
  state: PhaseState;
  durationMs?: number;
  reason?: string;
  details?: Record<string, unknown>;
}

/** The state of each phase from the events; `ended` says the run is over, so a phase that never started was not needed. */
export function phasesFrom(events: PhaseEvent[], ended: boolean): PhaseView[] {
  const views = new Map<PhaseId, PhaseView>(PHASES.map((id) => [id, { id, state: "pending" }]));
  let steps = 0;
  for (const e of events) {
    if (e.type === "step-started") steps += 1;
    const id = e.data.phase as PhaseId | undefined;
    if (!id || !views.has(id)) continue;
    const view = views.get(id) as PhaseView;
    if (e.type === "phase-started") view.state = "running";
    else if (e.type === "phase-finished") {
      const status = String(e.data.status);
      view.state = status === "succeeded" ? "succeeded" : status === "cancelled" ? "cancelled" : "failed";
      if (typeof e.data.durationMs === "number") view.durationMs = e.data.durationMs;
      if (typeof e.data.reason === "string") view.reason = e.data.reason;
      if (e.data.details && typeof e.data.details === "object") view.details = e.data.details as Record<string, unknown>;
    }
  }
  const checks = views.get("checks") as PhaseView;
  const aborted = events.some((e) => e.type === "cancel-requested");
  const failedPhase = PHASES.some((id) => id !== "checks" && views.get(id)?.state === "failed");
  if (steps > 0) checks.state = ended ? "succeeded" : "running";
  else if (ended) checks.state = aborted ? "cancelled" : failedPhase ? "failed" : "skipped";
  if (ended) for (const view of views.values()) if (view.state === "pending") view.state = aborted ? "cancelled" : "skipped";
  return PHASES.map((id) => views.get(id) as PhaseView);
}

const TONE: Record<PhaseState, "green" | "gold" | "red" | "blue" | undefined> = { pending: undefined, running: "blue", succeeded: "green", failed: "red", cancelled: "gold", skipped: undefined };

/** The log files each phase writes (names under logs/ of the run folder). */
const LOG_FILES: Record<PhaseId, (name: string) => boolean> = {
  sync: (n) => n === "sync.log",
  deps: (n) => n.startsWith("deps-") && n.endsWith(".log"),
  services: (n) => n === "services.log",
  checks: () => false,
  "services-down": (n) => n === "services.log",
};

function useFile(runId: string, name: string) {
  const [text, setText] = useState("");
  const [next, setNext] = useState(0);
  const [done, setDone] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function more(from = next) {
    try {
      const r = await api("GET", `/api/results/${runId}/logs/${encodeURIComponent(name)}?offset=${from}`);
      setText((old) => (from === 0 ? r.text : old + r.text));
      setNext(r.next);
      setDone(r.done);
      setLoaded(true);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }
  useEffect(() => {
    void more(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, name]);
  return { text, done, loaded, error, more };
}

function LogFile({ runId, name, label }: { runId: string; name: string; label: string }) {
  const file = useFile(runId, name);
  return (
    <div className="log-stream" data-log-file={name}>
      <strong className="small">{name}</strong>
      {file.error ? <ErrorNotice error={file.error} onRetry={() => void file.more(0)} /> : null}
      {file.loaded ? (
        <pre className="log" tabIndex={0} aria-label={t("vrun_phase_log_of", { phase: label, file: name })}>
          {file.text.trim() === "" ? t("vrun_logs_none") : file.text}
        </pre>
      ) : null}
      {file.loaded && !file.done ? (
        <button type="button" className="btn" onClick={() => void file.more()}>
          {t("vrun_logs_more")}
        </button>
      ) : null}
    </div>
  );
}

/** The log block of a phase: its files (read when the block opens) or, for the checks, where the logs are. */
function PhaseLog({ runId, view, label }: { runId: string | null; view: PhaseView; label: string }) {
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState<string[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  // Read the list of files again when the phase changes state: the log appears once the phase wrote it.
  useEffect(() => {
    if (!open || !runId || view.id === "checks") return;
    let alive = true;
    api("GET", `/api/results/${runId}/logs`).then(
      (r: any) => alive && (setNames(((r.logs ?? []) as Array<{ name: string }>).map((l) => l.name).filter(LOG_FILES[view.id])), setError(null)),
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [open, runId, view.id, view.state]);
  const reasonText = view.reason ? view.reason : null;
  return (
    <details className="log-block" data-testid="phase-log" data-phase-log={view.id} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <span className="log-block-title">{t("vrun_phase_log", { phase: label })}</span>
      </summary>
      {open ? (
        <div className="log-block-body stack">
          {reasonText ? <p className="small" role="note">{reasonText}</p> : null}
          {view.id === "checks" ? <p className="small muted">{t("vrun_phase_checks_logs")}</p> : null}
          {view.id === "services-down" && view.details?.project ? <p className="small muted">{t("vrun_phase_down_project", { project: String(view.details.project) })}</p> : null}
          {error ? <ErrorNotice error={error} /> : null}
          {view.id !== "checks" && names === null && !error ? <p className="spinner-text" role="status">{t("loading")}</p> : null}
          {names !== null && names.length === 0 ? <p className="small muted">{t(view.state === "skipped" ? "vrun_phase_log_skipped" : "vrun_phase_log_empty")}</p> : null}
          {runId && names ? names.map((n) => <LogFile key={`${n}-${view.state}`} runId={runId} name={n} label={label} />) : null}
        </div>
      ) : null}
    </details>
  );
}

/** The five phases of the run as an ordered list, each with its state and its log block. */
export function RunPhases({ events, ended, runId }: { events: PhaseEvent[]; ended: boolean; runId: string | null }) {
  // A stored run opened without its events has no phases to show.
  if (ended && events.length === 0) return null;
  const views = phasesFrom(events, ended);
  const cancel = events.find((e) => e.type === "phase-finished" && e.data.phase === "cancel");
  return (
    <section className="stack" aria-labelledby="vrun-phases" data-testid="run-phases">
      <h2 id="vrun-phases">{t("vrun_phases")}</h2>
      <ol className="stack vrun-phases" style={{ listStyle: "none", margin: 0, padding: 0, gap: 12 }}>
        {views.map((v, i) => {
          const label = t(`vrun_phase_${v.id.replace(/-/g, "_")}`);
          return (
            <li key={v.id} className="card flat stack" data-phase={v.id} data-state={v.state}>
              <div className="between wrap">
                <strong>
                  {i + 1}. {label}
                </strong>
                <Pill tone={TONE[v.state]}>
                  {v.state === "running" ? <Spinner /> : v.state === "succeeded" ? <Icon name="check" /> : v.state === "failed" ? <Icon name="alert" /> : null}
                  {tOr(`vrun_phase_state_${v.state}`, v.state)}
                  {v.durationMs !== undefined ? ` · ${formatDuration(v.durationMs)}` : ""}
                </Pill>
              </div>
              <p className="small muted" style={{ margin: 0 }}>
                {t(`vrun_phase_text_${v.id.replace(/-/g, "_")}`)}
              </p>
              <PhaseLog runId={runId} view={v} label={label} />
            </li>
          );
        })}
      </ol>
      {cancel ? (
        <p className="notice warn" role="status" data-testid="phase-cancel">
          <Icon name="stop" />
          <span>{t("vrun_phase_cancel_done", { killed: Array.isArray(cancel.data.details?.killed) ? cancel.data.details.killed.length : 0 })}</span>
        </p>
      ) : null}
    </section>
  );
}
