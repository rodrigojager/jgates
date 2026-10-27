import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../../api";
import { ErrorNotice, Loading, Pill } from "../../components/common";
import { Icon } from "../../components/icons";
import { t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { ResultView, formatDuration, stageName, stateText } from "../validations-result/ResultView";

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
  durationMs?: number;
}

const ORDER = ["error", "timeout", "blocked", "cancelled", "completed"] as const;

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
      if (typeof e.data.reason === "string" && e.data.reason !== "" && !r.reasons.includes(e.data.reason)) r.reasons.push(e.data.reason);
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
    case "run-finished":
      return t("vrun_event_run-finished", { decision: tOr(`vres_decision_${d.decision}`, String(d.decision)) });
    default:
      return tOr(`vrun_event_${e.type}`, e.type).replace("{step}", step);
  }
}

function StepLog({ runId, stepId }: { runId: string; stepId: string }) {
  const [files, setFiles] = useState<Array<{ name: string; bytes: number }> | null>(null);
  const [error, setError] = useState<unknown>(null);
  async function load() {
    if (files !== null) return;
    try {
      const r = await api("GET", `/api/results/${runId}/logs`);
      setFiles((r.logs as any[]).filter((f) => f.name.startsWith(`${stepId}.`)));
    } catch (e) {
      setError(e);
    }
  }
  return (
    <details onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && load()}>
      <summary>{t("vrun_logs")}</summary>
      {error ? <ErrorNotice error={error} /> : null}
      {files && files.length === 0 ? <p className="small">{t("vrun_logs_empty")}</p> : null}
      {files?.map((f) => <LogPage key={f.name} runId={runId} name={f.name} />)}
    </details>
  );
}

function LogPage({ runId, name }: { runId: string; name: string }) {
  const [text, setText] = useState("");
  const [next, setNext] = useState(0);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false);
  async function more() {
    try {
      const r = await api("GET", `/api/results/${runId}/logs/${encodeURIComponent(name)}?offset=${next}`);
      setText((old) => old + r.text);
      setNext(r.next);
      setDone(r.done);
    } catch (e) {
      setError(e);
    }
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void more();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <strong className="small">{name.endsWith(".stderr.log") ? t("vrun_logs_stderr") : t("vrun_logs_stdout")}</strong>
      {error ? <ErrorNotice error={error} /> : null}
      <pre className="log" tabIndex={0} aria-label={name}>
        {text === "" && done ? t("vrun_logs_empty_file") : text}
      </pre>
      {!done ? (
        <div>
          <button type="button" className="btn" onClick={more}>
            {t("vrun_logs_more")}
          </button>
        </div>
      ) : null}
    </div>
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
  const stop = useRef(false);

  useEffect(() => {
    stop.current = false;
    let cursor = 0;
    async function follow() {
      try {
        for (;;) {
          const r = await api("GET", `/api/runs/${id}/progress?cursor=${cursor}&wait=${id.startsWith("job_") ? 20000 : 0}`);
          if (stop.current) return;
          cursor = r.cursor;
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
                const full = await api("GET", `/api/results/${r.runId}`);
                result = full.result;
                previous = full.previous;
              } catch {
                // The progress copy of the result is enough.
              }
            }
            if (stop.current) return;
            if (r.run) setJob(r.run);
            if (result) setFinal({ result, previous, crashed: r.orphan === true });
            return;
          }
          if (!id.startsWith("job_")) await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (e) {
        if (stop.current) return;
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else setError(e);
      }
    }
    follow();
    return () => {
      stop.current = true;
    };
  }, [id]);

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
  const total = rows.length;
  const closed = rows.filter((r) => r.state !== "pending" && r.state !== "running").length;
  const current = rows.find((r) => r.state === "running");
  const uiState = job?.state === "crashed" ? "crashed" : final?.result && job?.state === "running" ? "finished" : (job?.state ?? "running");

  return (
    <div className="stack">
      <div>
        <div className="crumbs">
          <a href="#/plan">{t("vrun_to_plan")}</a>
        </div>
        <h1>{t("vrun_title")}</h1>
      </div>
      {notFound ? <p>{t("vrun_not_found")}</p> : null}
      {error ? <ErrorNotice error={error} /> : null}
      {!job && !notFound && !error ? <Loading /> : null}
      {job ? (
        <div className="between wrap">
          <div className="row wrap">
            <span className="muted">{t("vrun_state")}</span>
            <Pill tone={running ? "blue" : uiState === "finished" ? "green" : "gold"}>
              <span data-testid="run-state" data-state={uiState}>
                {tOr(`vrun_state_${uiState}`, uiState)}
              </span>
            </Pill>
            {running && total > 0 ? (
              <span data-testid="run-progress">
                {current ? t("vrun_current", { current: Math.min(closed + 1, total), total, name: current.label }) : t("vrun_current_idle", { current: Math.min(closed + 1, total), total })}
              </span>
            ) : total > 0 ? (
              <span data-testid="run-progress">{t("vrun_progress_done", { done: closed, total })}</span>
            ) : null}
          </div>
          {running ? (
            <div className="row wrap">
              <button type="button" className="btn danger" onClick={cancel} disabled={cancelling}>
                <Icon name="stop" />
                {t("vrun_cancel")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {running && cancelling ? (
        <p role="status" className="muted">
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
      {job && rows.length > 0 ? (
        <section className="stack" aria-labelledby="vrun-steps">
          <h2 id="vrun-steps">{t("vrun_steps")}</h2>
          <div className="card flat table-wrap">
            <table aria-label={t("vrun_progress_label")}>
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
                  <tr key={r.id} data-step={r.id} data-state={r.state}>
                    <th scope="row">{stageName(r)}</th>
                    <td>
                      <Pill tone={r.state === "completed" ? "green" : r.state === "error" || r.state === "timeout" ? "red" : r.state === "pending" || r.state === "running" ? "blue" : "gold"}>
                        {r.state === "pending" ? t("vrun_step_pending") : r.state === "running" ? t("vrun_step_running") : stateText(r.state)}
                      </Pill>
                    </td>
                    <td>
                      {r.cause ? <div>{tOr(`vrun_why_${r.cause}`, t("vrun_why_skipped"))}</div> : null}
                      {r.reasons.map((reason) => (
                        <div className="small" key={reason}>
                          {reason}
                        </div>
                      ))}
                    </td>
                    <td>{formatDuration(r.durationMs)}</td>
                    <td>{runId && r.state !== "pending" && !r.cause ? <StepLog runId={runId} stepId={r.id} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {job ? (
        <section aria-labelledby="vrun-events" className="stack">
          <h2 id="vrun-events">{t("vrun_events")}</h2>
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
        </section>
      ) : null}
      {final ? <ResultView result={final.result} previous={final.previous} crashed={final.crashed} /> : null}
    </div>
  );
}
