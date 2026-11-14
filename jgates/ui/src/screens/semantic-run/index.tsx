import { useEffect, useState } from "react";
import { ApiError, api } from "../../api";
import { ErrorNotice, Loading } from "../../components/common";
import { Heartbeat } from "../../components/Heartbeat";
import { Icon } from "../../components/icons";
import { t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { SemanticResultsView, type SemanticReport } from "../semantic-results/ResultsView";
import { SemanticMascotStrip, stageLabel, type SemanticMascotSnapshot } from "./SemanticMascotStrip";

export const screen: ScreenMeta = { id: "semantic-run", path: "/semantic/runs/:id", area: "semantic", order: 53 };

interface RunEvent {
  sequence: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

interface RunState {
  runId: string;
  lifecycle: "running" | "settled" | "interrupted";
  decision?: string | null;
  cancelRequested?: boolean;
  startedAt?: string | null;
}

/** How long the screen waits before asking a server it lost contact with again. */
const RETRY_MS = 3000;

function eventText(e: RunEvent): string {
  const d = e.data;
  const rawStage = String(d.stageId ?? d.stage ?? d.step ?? "");
  const stage = rawStage ? stageLabel(rawStage) : "";
  const state = typeof d.state === "string" ? tOr(`semrun_mascot_state_${d.state}`, d.state) : "";
  const base = tOr(`semrun_event_${e.type}`, e.type);
  return [base, stage, state].filter(Boolean).join(" · ");
}

/** An active (or finished) Semantic run: its phases through the AI mascots, its events, cancel, and its results at the end. */
export default function SemanticRunScreen({ params }: { params: Record<string, string> }) {
  const id = params.id as string;
  const [run, setRun] = useState<RunState | null>(null);
  const [mascots, setMascots] = useState<SemanticMascotSnapshot | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [report, setReport] = useState<SemanticReport | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notFound, setNotFound] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let stopped = false;
    const abort = new AbortController();
    setRun(null);
    setMascots(null);
    setEvents([]);
    setReport(null);
    setError(null);
    setNotFound(false);
    setCancelling(false);
    let cursor = 0;
    async function follow() {
      try {
        for (;;) {
          let page: { events: RunEvent[]; cursor: number; live: boolean; done: boolean };
          let state: { run: RunState };
          let snapshot: { lifecycle: RunState["lifecycle"]; mascots: SemanticMascotSnapshot } | null = null;
          try {
            // A short wait, so the mascots refresh every few seconds even when no event comes.
            page = await api("GET", `/api/semantic/runs/${encodeURIComponent(id)}/events?cursor=${cursor}&wait=4000`, undefined, abort.signal);
            state = await api("GET", `/api/semantic/runs/${encodeURIComponent(id)}`, undefined, abort.signal);
            snapshot = await api<{ lifecycle: RunState["lifecycle"]; mascots: SemanticMascotSnapshot }>("GET", `/api/semantic/runs/${encodeURIComponent(id)}/mascots`, undefined, abort.signal).catch((e: unknown) => {
              // The child has not written its folder yet: no mascots until it has.
              if (e instanceof ApiError && e.status === 404) return null;
              throw e;
            });
          } catch (e) {
            if (stopped) return;
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
          cursor = page.cursor;
          // The mascots route says "running" too in the moment between the run's plan and its first checkpoint.
          const lifecycle = snapshot?.lifecycle ?? state.run.lifecycle;
          setRun({ ...state.run, lifecycle });
          if (snapshot) setMascots(snapshot.mascots);
          if (page.events.length > 0) {
            setEvents((old) => {
              const seen = new Set(old.map((e) => e.sequence));
              const fresh = page.events.filter((e) => !seen.has(e.sequence));
              return fresh.length === 0 ? old : [...old, ...fresh].sort((a, b) => a.sequence - b.sequence);
            });
          }
          if (lifecycle === "running" && !page.live) await new Promise((resolve) => setTimeout(resolve, 1000));
          if (lifecycle !== "running") {
            // The run settled after this page was read: take the events written since, until the server says done.
            for (let more = !page.done; more && !stopped; ) {
              const rest: { events: RunEvent[]; cursor: number; done: boolean } = await api("GET", `/api/semantic/runs/${encodeURIComponent(id)}/events?cursor=${cursor}`, undefined, abort.signal);
              cursor = rest.cursor;
              if (rest.events.length > 0) {
                setEvents((old) => {
                  const seen = new Set(old.map((e) => e.sequence));
                  const fresh = rest.events.filter((e) => !seen.has(e.sequence));
                  return [...old, ...fresh].sort((a, b) => a.sequence - b.sequence);
                });
              }
              more = !rest.done;
            }
            const full = await api<{ report: SemanticReport; mascots: SemanticMascotSnapshot }>("GET", `/api/semantic/runs/${encodeURIComponent(id)}/report`, undefined, abort.signal);
            if (stopped) return;
            setReport(full.report);
            setMascots(full.mascots);
            return;
          }
        }
      } catch (e) {
        if (stopped) return;
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else setError(e);
      }
    }
    void follow();
    return () => {
      stopped = true;
      abort.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, version]);

  async function cancel() {
    setCancelling(true);
    try {
      await api("POST", `/api/semantic/runs/${encodeURIComponent(id)}/cancel`);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "RUN_NOT_ACTIVE")) setError(e);
    }
  }

  const running = run?.lifecycle === "running";
  const uiState = running ? "running" : run?.lifecycle === "interrupted" ? "interrupted" : report?.decision === "cancelled" ? "cancelled" : "finished";
  const stages = mascots?.mascots.flatMap((m) => m.stages) ?? [];
  const closed = stages.filter((s) => s.state !== "waiting" && s.state !== "working").length;
  const current = stages.find((s) => s.state === "working");

  return (
    <div className="stack">
      <div>
        <div className="crumbs">
          <a href="#/semantic">{t("semrun_back")}</a>
        </div>
        <h1>{t("semrun_title")}</h1>
        <p className="muted small">
          <code>{id}</code>
        </p>
      </div>
      {notFound ? <p>{t("semrun_not_found")}</p> : null}
      {error ? <ErrorNotice error={error} onRetry={() => setVersion((n) => n + 1)} /> : null}
      {!run && !notFound && !error ? <Loading /> : null}
      {run ? (
        <section className="card flat stack" data-running={running} aria-label={t("semrun_summary")}>
          <div className="between wrap">
            <div className="row" role="status">
              <Icon name={running ? "hourglass" : uiState === "finished" ? "check" : uiState === "cancelled" ? "stop" : "alert"} />
              <strong data-testid="semantic-run-state" data-state={uiState}>
                {t(`semrun_state_${uiState}`)}
              </strong>
            </div>
            {running ? (
              <button type="button" className="btn" onClick={cancel} disabled={cancelling || run.cancelRequested === true}>
                <Icon name="stop" />
                {t("semrun_cancel")}
              </button>
            ) : null}
          </div>
          {running || uiState === "interrupted" ? <Heartbeat state={running && !connectionLost ? "alive" : "dead"} detail={connectionLost ? t("pulse_connection_lost") : running ? t("semrun_alive") : t("semrun_interrupted_detail")} /> : null}
          {stages.length > 0 ? (
            <div className="stack" style={{ gap: 4 }}>
              <span className="small muted" data-testid="semantic-run-progress">
                {current ? t("semrun_current", { stage: stageLabel(current.id) }) : t("semrun_phases_done", { done: closed, total: stages.length })}
              </span>
              <progress max={stages.length} value={closed} aria-label={t("semrun_progress_label")} aria-valuetext={t("semrun_phases_done", { done: closed, total: stages.length })} />
            </div>
          ) : running ? (
            <span className="small muted">{t("semrun_preparing")}</span>
          ) : null}
          {running ? <p className="muted small">{cancelling || run.cancelRequested ? t("semrun_cancelling") : t("semrun_cancel_hint")}</p> : null}
        </section>
      ) : null}
      {connectionLost ? (
        <div className="notice warn" role="status">
          <Icon name="refresh" />
          <p>{t("semrun_connection_lost")}</p>
        </div>
      ) : null}
      <SemanticMascotStrip snapshot={mascots} />
      {run ? (
        <section aria-labelledby="semrun-events" className="stack">
          <h2 id="semrun-events">{t("semrun_events")}</h2>
          {events.length === 0 ? (
            <p>{t("semrun_events_empty")}</p>
          ) : (
            <div className="log" role="log" aria-live="off" aria-label={t("semrun_events")} tabIndex={0}>
              <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {events.map((e) => (
                  <li key={e.sequence} data-seq={e.sequence} data-type={e.type}>
                    {eventText(e)}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      ) : null}
      {report ? (
        <>
          <p>
            <a href={`#/semantic/results/${encodeURIComponent(id)}`}>{t("semrun_open_results")}</a>
          </p>
          <SemanticResultsView report={report} />
        </>
      ) : null}
    </div>
  );
}
