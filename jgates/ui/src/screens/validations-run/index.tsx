import { SequenceBanner } from "../sequence/SequenceBanner";
import { QualityMascotStrip } from "../../components/QualityMascotStrip";
import type { MascotSnapshot } from "../../../../src/core/mascots/index";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../../api";
import { ErrorNotice, Loading, Pill } from "../../components/common";
import { Heartbeat } from "../../components/Heartbeat";
import { Icon } from "../../components/icons";
import { t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { ResultView, approvedWithWaiversText, isApprovedWithWaivers, formatDuration, stageName, stateText, type DomainFilter } from "../validations-result/ResultView";
import { RunPhases } from "./phases";
import { StepLogPanel } from "./step-log";
import "./run-summary.css";

// Runs are opened by the id the server gave (job_...) or by the id of a stored run (run_...); the route stays /runs/:id.
export const screen: ScreenMeta = { id: "validations-run", path: "/runs/:id", area: "validations", order: 40 };

interface StepEvent {
  sequence: number;
  type: string;
  at: string;
  data: Record<string, any>;
}

interface Row {
  id: string;
  label: string;
  state: "pending" | "running" | "completed" | "blocked" | "error" | "timeout" | "cancelled";
  cause?: string;
  reasons: string[];
  /** Why parts of the step were switched off (a superseded subcheck): shown folded, they are not a problem. */
  offReasons?: string[];
  durationMs?: number;
}

const ORDER = ["error", "timeout", "blocked", "cancelled", "completed"] as const;

/** Without a new file for this long while the process still beats, the screen says the step is slow, not dead. */
const STALL_MS = 3 * 60 * 1000;
/** How long the screen waits before asking a server it lost contact with again. */
const RETRY_MS = 3000;

interface Liveness {
  alive: boolean;
  beatAt: string | null;
}

interface Activity {
  file: string | null;
  at: string | null;
}

const since = (iso: string | null | undefined, now: number): number | undefined => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? Math.max(0, now - at) : undefined;
};

const lastPart = (file: string): string => file.split("/").slice(-1)[0] ?? file;

/** Rows of the steps from the events, in plan order; pure, so a replay from cursor 0 gives the same rows. */
function rowsFrom(steps: Array<{ id: string; label: string }>, events: StepEvent[]): Row[] {
  const rows = new Map<string, Row>();
  const states = new Map<string, string[]>();
  for (const s of steps) rows.set(s.id, { id: s.id, label: s.label, state: "pending", reasons: [] });
  const row = (id: string): Row => {
    let r = rows.get(id);
    if (!r) {
      r = { id, label: id, state: "pending", reasons: [] };
      rows.set(id, r);
    }
    return r;
  };
  for (const e of events) {
    const id = typeof e.data.step === "string" ? e.data.step : null;
    if (!id) continue;
    const r = row(id);
    if (e.type === "step-started") {
      r.state = "running";
      if (typeof e.data.label === "string") r.label = e.data.label;
    } else if (e.type === "stage") {
      const list = states.get(id) ?? [];
      list.push(String(e.data.state));
      states.set(id, list);
      if (typeof e.data.reason === "string" && e.data.reason !== "") {
        const into = e.data.state === "disabled" ? (r.offReasons ??= []) : r.reasons;
        if (!into.includes(e.data.reason)) into.push(e.data.reason);
      }
    } else if (e.type === "step-skipped") {
      r.state = "blocked";
      r.cause = typeof e.data.cause === "string" ? e.data.cause : "skipped";
    } else if (e.type === "step-finished") {
      r.durationMs = typeof e.data.durationMs === "number" ? e.data.durationMs : undefined;
      const list = states.get(id) ?? [];
      const worst = ORDER.find((s) => list.includes(s));
      r.state = (worst ?? (e.data.status === "failed" ? "error" : "completed")) as Row["state"];
    }
  }
  return [...rows.values()];
}

function eventText(e: StepEvent): string {
  const d = e.data;
  const step = String(d.step ?? "");
  switch (e.type) {
    case "step-finished":
      return t("vrun_event_step-finished", { step, status: tOr(`vrun_step_status_${d.status}`, String(d.status)), duration: formatDuration(typeof d.durationMs === "number" ? d.durationMs : undefined) });
    case "stage":
      return t("vrun_event_stage", { stage: stageName({ id: String(d.stageId ?? "") }), step, state: stateText(String(d.state)) });
    case "step-skipped":
      return t("vrun_event_step-skipped", { step, cause: tOr(`vrun_why_${d.cause}`, String(d.cause)) });
    case "phase-started":
      return t("vrun_event_phase-started", { phase: tOr(`vrun_phase_${String(d.phase).replace(/-/g, "_")}`, String(d.phase)) });
    case "phase-finished":
      return t("vrun_event_phase-finished", { phase: tOr(`vrun_phase_${String(d.phase).replace(/-/g, "_")}`, String(d.phase)), status: tOr(`vrun_phase_state_${d.status}`, String(d.status)) });
    case "run-finished":
      return t("vrun_event_run-finished", { decision: tOr(`vres_decision_${d.decision}`, String(d.decision)) });
    default:
      return tOr(`vrun_event_${e.type}`, e.type).replace("{step}", step);
  }
}

const COLUMNS = 5;

/**
 * One step of the table and, under it when asked, its logs across the whole width of the table. Logs stay closed until
 * the person opens them, also for a step that failed (its state says so; the log is one key press away).
 */
function StepRow({ row: r, runId }: { row: Row; runId: string | null }) {
  const failed = r.state === "error" || r.state === "timeout";
  const [open, setOpen] = useState(false);
  const name = stageName(r);
  const hasLog = runId !== null && r.state !== "pending" && !r.cause;
  const panelId = `step-log-${r.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  return (
    <>
      <tr data-step={r.id} data-state={r.state}>
        <th scope="row">{name}</th>
        <td data-label={t("vrun_col_state")}>
          <Pill tone={r.state === "completed" ? "green" : failed ? "red" : r.state === "pending" || r.state === "running" ? "blue" : "gold"}>
            {r.state === "pending" ? t("vrun_step_pending") : r.state === "running" ? t("vrun_step_running") : stateText(r.state)}
          </Pill>
        </td>
        <td data-label={t("vrun_col_why")}>
          {r.cause ? <div>{tOr(`vrun_why_${r.cause}`, t("vrun_why_skipped"))}</div> : null}
          {r.reasons.map((reason) => (
            <div className="small" key={reason}>
              {reason}
            </div>
          ))}
          {r.offReasons && r.offReasons.length > 0 ? (
            <details className="small muted" data-testid="step-off-parts">
              <summary>{t(r.offReasons.length === 1 ? "vrun_step_off_parts_one" : "vrun_step_off_parts", { count: r.offReasons.length })}</summary>
              {r.offReasons.map((reason) => (
                <div key={reason}>{reason}</div>
              ))}
            </details>
          ) : null}
        </td>
        <td data-label={t("vrun_col_duration")}>{formatDuration(r.durationMs)}</td>
        <td data-label={hasLog ? t("vrun_col_log") : undefined}>
          {hasLog ? (
            <button
              type="button"
              className="btn step-log-toggle"
              aria-expanded={open}
              aria-controls={open ? panelId : undefined}
              aria-label={t(open ? "vrun_logs_hide_of" : "vrun_logs_show_of", { step: name })}
              onClick={() => setOpen((v) => !v)}
            >
              <Icon name="terminal" />
              {t(open ? "vrun_logs_hide" : "vrun_logs_show")}
            </button>
          ) : null}
        </td>
      </tr>
      {hasLog && open ? (
        <tr className="step-log-row" data-log-for={r.id}>
          <td colSpan={COLUMNS}>
            <StepLogPanel runId={runId} stepId={r.id} label={name} failed={failed} id={panelId} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

export default function RunScreen({ params }: { params: Record<string, string> }) {
  const id = params.id as string;
  const [job, setJob] = useState<any | null>(null);
  const [runId, setRunId] = useState<string | null>(id.startsWith("run_") ? id : null);
  const [steps, setSteps] = useState<Array<{ id: string; label: string }>>([]);
  const [events, setEvents] = useState<StepEvent[]>([]);
  const [final, setFinal] = useState<{ result: any; previous: any; crashed: boolean } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notFound, setNotFound] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [followVersion, setFollowVersion] = useState(0);
  const followedId = useRef<string | null>(null);
  const [mascots, setMascots] = useState<MascotSnapshot | null>(null);
  const [selectedDomain, setSelectedDomain] = useState<DomainFilter | null>(null);
  const [liveness, setLiveness] = useState<Liveness | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let stopped = false;
    const abort = new AbortController();
    if (followedId.current !== id) {
      setJob(null); setRunId(id.startsWith("run_") ? id : null); setSteps([]); setEvents([]);
      setFinal(null); setCancelling(false); setMascots(null); setSelectedDomain(null); followedId.current = id;
    }
    setError(null); setNotFound(false);
    let cursor = 0;
    let knownRunId: string | null = id.startsWith("run_") ? id : null;
    async function follow() {
      try {
        for (;;) {
          let r: any;
          try {
            // A short wait, so the pulse and the last activity refresh every few seconds even when no event comes.
            r = await api("GET", `/api/runs/${id}/progress?cursor=${cursor}&wait=${id.startsWith("job_") ? 5000 : 0}`, undefined, abort.signal);
          } catch (e) {
            if (stopped) return;
            // The server that started this job is gone (restarted): the run itself may still be running, so follow
            // it by its run id, whose heartbeat says whether it is alive.
            if (e instanceof ApiError && e.status === 404 && id.startsWith("job_") && knownRunId) {
              location.hash = `#/runs/${knownRunId}`;
              return;
            }
            // No answer at all: keep trying, and say so, instead of leaving a frozen screen.
            if (!(e instanceof ApiError)) {
              setConnectionLost(true);
              await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
              if (stopped) return;
              continue;
            }
            throw e;
          }
          if (stopped) return;
          setConnectionLost(false);
          if (r.runId) knownRunId = r.runId;
          setLiveness(r.liveness ?? null);
          setActivity(r.activity ?? null);
          cursor = r.cursor;
          if (r.mascots) setMascots(r.mascots);
          if (r.runId) setRunId(r.runId);
          if (r.run) setJob(r.run);
          else if (!id.startsWith("job_")) setJob({ id, state: r.orphan ? "crashed" : r.done ? "finished" : "running" });
          if (r.steps?.length) setSteps(r.steps);
          // Events are kept by sequence: a replay or an overlapping page never adds a line twice.
          if (r.events.length > 0) {
            setEvents((old) => {
              const seen = new Set(old.map((e) => e.sequence));
              const fresh = (r.events as StepEvent[]).filter((e) => !seen.has(e.sequence));
              return fresh.length === 0 ? old : [...old, ...fresh].sort((a, b) => a.sequence - b.sequence);
            });
          }
          if (r.done || r.orphan) {
            let result = r.result;
            let previous: any = null;
            if (r.runId) {
              try {
                const full = await api("GET", `/api/results/${r.runId}`, undefined, abort.signal);
                result = full.result;
                previous = full.previous;
                if (!stopped && full.mascots) setMascots(full.mascots);
              } catch {
                // The progress copy of the result is enough.
              }
            }
            if (stopped) return;
            if (r.run) setJob(r.run);
            if (result) setFinal({ result, previous, crashed: r.orphan === true });
            return;
          }
          if (!id.startsWith("job_")) await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (e) {
        if (stopped) return;
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else setError(e);
      }
    }
    follow();
    return () => {
      stopped = true;
      abort.abort();
    };
  }, [id, followVersion]);

  async function cancel() {
    setCancelling(true);
    try {
      await api("POST", `/api/runs/${id}/cancel`);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "RUN_NOT_ACTIVE")) setError(e);
    }
  }

  const rows = useMemo(() => rowsFrom(steps, events), [steps, events]);
  const running = job?.state === "running";

  // A clock for the elapsed times while the run is running.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const total = rows.length;
  const closed = rows.filter((r) => r.state !== "pending" && r.state !== "running").length;
  const current = rows.find((r) => r.state === "running");
  const uiState = job?.state === "crashed" ? "crashed" : final?.result && job?.state === "running" ? "finished" : (job?.state ?? "running");
  // A run that ended with a decision other than "passed" never reads as a bare "Finished": it names the decision.
  const decision = typeof final?.result?.decision === "string" ? (final.result.decision as string) : null;
  // A run that passed with waivers says so in the ended state too, with its own icon colour, never a plain "Finished".
  const withWaivers = uiState === "finished" && decision === "passed" && isApprovedWithWaivers(final?.result?.approval);
  const endedLabel = withWaivers
    ? approvedWithWaiversText(final?.result?.approval)
    : uiState === "finished" && decision && decision !== "passed" ? tOr(`vres_decision_${decision}`, decision) : tOr(`vrun_state_${uiState}`, uiState);
  const startedAt: string | undefined = job?.startedAt ?? events[0]?.at;
  const elapsed = since(startedAt, now);
  const currentStart = current ? [...events].reverse().find((e) => e.type === "step-started" && e.data.step === current.id)?.at : undefined;
  const stepElapsed = since(currentStart, now);
  const activityAge = since(activity?.at, now);
  const stalled = running && liveness?.alive === true && activityAge !== undefined && activityAge > STALL_MS;
  const pulseDetail = running
    ? [
        elapsed !== undefined ? t("pulse_elapsed", { time: formatDuration(elapsed) }) : null,
        activity?.file && activityAge !== undefined ? t("pulse_activity", { file: lastPart(activity.file), ago: formatDuration(activityAge) }) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : t("pulse_dead_detail");

  return (
    <div className="stack">
      <div>
        <div className="crumbs">
          <a href="#/plan">{t("vrun_to_plan")}</a>
        </div>
        <h1>{t("vrun_title")}</h1>
      </div>
      {notFound ? <p>{t("vrun_not_found")}</p> : null}
      {error ? <ErrorNotice error={error} onRetry={() => setFollowVersion((n) => n + 1)} /> : null}
      {!job && !notFound && !error ? <Loading /> : null}
      {job ? (
        <section className="run-summary" data-running={running} aria-label={t("vrun_summary")}>
          <div className="run-summary-header">
            <div className="run-summary-state" role="status">
              <span className={running ? "run-summary-spinner" : "run-summary-icon"} data-state={withWaivers ? "waivers" : uiState} aria-hidden="true">
                {running ? null : <Icon name={withWaivers ? "info" : uiState === "finished" ? "check" : uiState === "cancelled" ? "stop" : "alert"} />}
              </span>
              <strong data-testid="run-state" data-state={uiState}>
                {endedLabel}
              </strong>
              {runId && final && !running ? (
                <a className="btn primary" href={`#/validations/result/${encodeURIComponent(runId)}`} data-testid="run-open-result">
                  {t("vrun_open_result")}
                </a>
              ) : null}
            </div>
          {running ? (
              <button type="button" className="btn" onClick={cancel} disabled={cancelling}>
                <Icon name="stop" />
                {t("vrun_cancel")}
              </button>
          ) : null}
          </div>
          {running || uiState === "crashed" ? (
            <Heartbeat state={running && !connectionLost && liveness?.alive !== false ? "alive" : "dead"} detail={connectionLost ? t("pulse_connection_lost") : pulseDetail} />
          ) : null}
          {running ? <div className="run-summary-current">
            <span className="small muted" data-testid="run-progress">{total > 0 ? t("vrun_current_idle", { current: Math.min(closed + 1, total), total }) : t("vrun_preparing")}</span>
            <strong>
              {current ? stageName(current) : t("vrun_waiting_step")}
              {current && stepElapsed !== undefined ? <span className="muted small"> · {formatDuration(stepElapsed)}</span> : null}
            </strong>
          </div> : null}
          {total > 0 ? <div className="run-summary-progress">
            <div className="run-summary-count"><span>{t("vrun_closed_label")}</span><strong>{closed}<span className="muted"> / {total}</span></strong></div>
            <progress max={total} value={closed} aria-label={t("vrun_progress_label")} aria-valuetext={t("vrun_progress_done", { done: closed, total })} />
            <span className="sr-only" {...(!running ? { "data-testid": "run-progress" } : {})}>{t("vrun_progress_done", { done: closed, total })}</span>
          </div> : null}
        </section>
      ) : null}
      {connectionLost ? (
        <div className="notice warn" role="status" data-testid="run-connection-lost">
          <Icon name="refresh" />
          <p>{t("vrun_connection_lost")}</p>
        </div>
      ) : null}
      {stalled && !connectionLost ? (
        <div className="notice warn" role="status" data-testid="run-stalled">
          <Icon name="info" />
          <p>{t("vrun_stalled", { time: formatDuration(activityAge) })}</p>
        </div>
      ) : null}
      {running && cancelling ? (
        <p role="status" className="spinner-text">
          {t("vrun_cancelling")}
        </p>
      ) : running ? (
        <p className="muted small">{t("vrun_cancel_hint")}</p>
      ) : null}
      {job?.error ? (
        <div className="notice error" role="alert">
          <Icon name="alert" />
          <div className="grow stack" style={{ gap: 4 }}>
            <strong>{t("vrun_error_title")}</strong>
            <p>{typeof job.error === "string" ? job.error : (job.error.message ?? job.error.code)}</p>
          </div>
        </div>
      ) : null}
      {runId ? <SequenceBanner runId={runId} /> : null}
      <QualityMascotStrip snapshot={mascots} onSelect={(domain, ids) => setSelectedDomain({ domain, ids })} />
      {job ? <RunPhases events={events} ended={!running} runId={runId} /> : null}
      {job && rows.length > 0 ? (
        <section className="stack" aria-labelledby="vrun-steps">
          <h2 id="vrun-steps">{t("vrun_steps")}</h2>
          <div className="card flat table-wrap vrun-steps-card">
            <table className="stack-table" aria-label={t("vrun_progress_label")}>
              <thead>
                <tr>
                  <th scope="col">{t("vrun_col_step")}</th>
                  <th scope="col">{t("vrun_col_state")}</th>
                  <th scope="col">{t("vrun_col_why")}</th>
                  <th scope="col">{t("vrun_col_duration")}</th>
                  <th scope="col">{t("vrun_col_log")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <StepRow key={r.id} row={r} runId={runId} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {job ? (
        <details className="stack" open={running || undefined} data-testid="run-events">
          <summary>
            <h2 id="vrun-events" style={{ display: "inline" }}>{t("vrun_events")}</h2>
          </summary>
          {events.length === 0 ? (
            <p>{t("vrun_events_empty")}</p>
          ) : (
            <div className="log" role="log" aria-live="off" aria-label={t("vrun_events")} tabIndex={0}>
              <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {events.map((e) => (
                  <li key={e.sequence} data-seq={e.sequence} data-type={e.type}>
                    {eventText(e)}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </details>
      ) : null}
      {final ? <ResultView compact result={final.result} previous={final.previous} crashed={final.crashed} selectedDomain={selectedDomain} onClearDomain={() => setSelectedDomain(null)} /> : null}
    </div>
  );
}
