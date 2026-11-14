import { useEffect, useState } from "react";
import { formatTime } from "../../components/format";
import { ApiError, api } from "../../api";
import { ErrorNotice, Loading, Pill } from "../../components/common";
import { Icon } from "../../components/icons";
import { t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { SemanticMascotStrip, type SemanticMascotSnapshot } from "../semantic-run/SemanticMascotStrip";
import { gateState, type GateView, type SequenceDto } from "./model";

export const screen: ScreenMeta = { id: "sequence", path: "/sequence/:id", area: "validations", order: 43 };

const RETRY_MS = 3000;
const TONE: Record<string, "green" | "gold" | "red" | "blue" | undefined> = { passed: "green", failed: "red", invalid: "red", incomplete: "gold", cancelled: "gold", running: "blue", waiting: "blue", "not-started": undefined };

function GateCard({ gate, view, children }: { gate: "quality" | "semantic"; view: GateView; children?: React.ReactNode }) {
  const href = view.runId ? (gate === "quality" ? `#/validations/result/${view.runId}` : `#/semantic/results/${view.runId}`) : null;
  const followHref = view.runId ? (gate === "quality" ? `#/runs/${view.runId}` : `#/semantic/runs/${view.runId}`) : null;
  return (
    <section className="card flat stack" aria-labelledby={`seq-${gate}`} data-testid={`sequence-${gate}`} data-gate={gate} data-state={view.state} data-run={view.runId ?? ""}>
      <div className="between wrap">
        <h2 id={`seq-${gate}`}>{t(`seq_gate_${gate}`)}</h2>
        <Pill tone={TONE[view.state]}>{t(`seq_state_${view.state.replace(/-/g, "_")}`)}</Pill>
      </div>
      <p className="muted small">{t(`seq_gate_${gate}_lead`)}</p>
      {view.runId ? (
        <dl className="kv">
          <dt>{t("seq_run")}</dt>
          <dd>
            <code>{view.runId}</code>
          </dd>
          {view.complete !== null ? (
            <>
              <dt>{t("seq_complete")}</dt>
              <dd>{view.complete ? t("seq_yes") : t("seq_no")}</dd>
            </>
          ) : null}
          {view.reduced ? (
            <>
              <dt>{t("seq_reduced")}</dt>
              <dd>{t("seq_yes")}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {view.runId ? (
        <div className="row wrap">
          {view.state === "running" && followHref ? (
            <a className="btn" href={followHref}>
              <Icon name="play" />
              {t("seq_follow")}
            </a>
          ) : href ? (
            <a className="btn" href={href}>
              <Icon name="check" />
              {t("seq_open_result")}
            </a>
          ) : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** The overview of one sequence: its Quality run and its Semantic run side by side, never merged. */
export default function SequenceScreen({ params }: { params: Record<string, string> }) {
  const id = params.id as string;
  const [sequence, setSequence] = useState<SequenceDto | null>(null);
  const [semanticMascots, setSemanticMascots] = useState<SemanticMascotSnapshot | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let stopped = false;
    const abort = new AbortController();
    setSequence(null);
    setSemanticMascots(null);
    setError(null);
    setNotFound(false);
    let missing = 0;
    async function follow() {
      for (;;) {
        try {
          const r = await api<{ sequence: SequenceDto }>("GET", `/api/sequences/${encodeURIComponent(id)}`, undefined, abort.signal);
          if (stopped) return;
          setSequence(r.sequence);
          setError(null);
          const m = await api<{ semantic: { mascots: SemanticMascotSnapshot } | null }>("GET", `/api/sequences/${encodeURIComponent(id)}/mascots`, undefined, abort.signal).catch(() => null);
          if (stopped) return;
          setSemanticMascots(m?.semantic?.mascots ?? null);
          // A sequence waiting for the user's advance keeps being followed: the advance starts Semantic from another request.
          if (r.sequence.lifecycle !== "running" && r.sequence.lifecycle !== "waiting") return;
        } catch (e) {
          if (stopped) return;
          // A sequence that was just created may not be on disk yet: only a repeated 404 means it does not exist.
          if (e instanceof ApiError && e.status === 404 && ++missing > 5) {
            setNotFound(true);
            return;
          }
          if (e instanceof ApiError && e.status !== 404) {
            setError(e);
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        if (stopped) return;
      }
    }
    void follow();
    return () => {
      stopped = true;
      abort.abort();
    };
  }, [id, version]);

  async function act(path: "advance" | "cancel") {
    setBusy(true);
    setActionError(null);
    try {
      await api("POST", `/api/sequences/${encodeURIComponent(id)}/${path}`);
      setVersion((n) => n + 1);
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  if (notFound) {
    return (
      <div className="stack">
        <h1>{t("seq_title")}</h1>
        <div className="notice error" role="alert">
          <Icon name="alert" />
          <span>{t("seq_not_found")}</span>
        </div>
      </div>
    );
  }
  // A sequence whose process has not written its record yet (the server answers `record: null`) is still starting.
  if (!sequence || !sequence.record) return error ? <ErrorNotice error={error} onRetry={() => setVersion((n) => n + 1)} /> : <Loading />;

  const quality = gateState(sequence, "quality");
  const semantic = gateState(sequence, "semantic");
  const record = sequence.record;
  const assessment = sequence.details?.assessment ?? null;
  const coverage = sequence.details?.coverage ?? null;
  const timeline = sequence.details?.timeline ?? [];
  const awaiting = record.status === "awaiting-advancement";
  const running = sequence.lifecycle === "running";

  return (
    <div className="stack" data-testid="sequence-overview" data-sequence={sequence.sequenceId} data-status={record.status} data-lifecycle={sequence.lifecycle}>
      <div className="between wrap">
        <div>
          <h1>{t("seq_title")}</h1>
          <p>
            <code>{sequence.sequenceId}</code> · {tOr(`seq_status_${record.status.replace(/-/g, "_")}`, record.status)}
          </p>
        </div>
        <div className="row wrap">
          <a className="btn" href="#/validations/choose">
            <Icon name="sliders" />
            {t("seq_new")}
          </a>
          {running ? (
            <button type="button" className="btn" disabled={busy} onClick={() => act("cancel")}>
              <Icon name="stop" />
              {t("seq_cancel")}
            </button>
          ) : null}
        </div>
      </div>
      <p className="muted">{t("seq_lead")}</p>
      {actionError ? <ErrorNotice error={actionError} /> : null}
      {sequence.lifecycle === "interrupted" ? (
        <div className="notice warn" role="status">
          <Icon name="alert" />
          <span>{t("seq_interrupted")}</span>
        </div>
      ) : null}

      <div className="grid" style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        <GateCard gate="quality" view={quality} />
        <GateCard gate="semantic" view={semantic}>
          {semantic.state === "not-started" ? (
            <div className="stack" style={{ gap: 8 }} data-testid="semantic-not-started">
              <p>{record.reason?.message ?? (running ? t("seq_semantic_waiting") : t("seq_semantic_not_started_note"))}</p>
              {record.reason?.code ? <code className="small">{record.reason.code}</code> : null}
              <div className="row wrap">
                {awaiting ? (
                  <button type="button" className="btn primary" disabled={busy} onClick={() => act("advance")}>
                    <Icon name="play" />
                    {t("seq_advance")}
                  </button>
                ) : null}
                {!running ? (
                  <a className="btn" href="#/semantic/setup">
                    <Icon name="plan" />
                    {t("seq_semantic_only")}
                  </a>
                ) : null}
              </div>
              {!running && !awaiting ? <p className="muted small">{t("seq_semantic_only_hint")}</p> : null}
            </div>
          ) : null}
        </GateCard>
      </div>

      {assessment ? (
        <section className="card flat stack" aria-labelledby="seq-transition" data-testid="sequence-transition" data-code={assessment.code}>
          <h2 id="seq-transition">{t("seq_transition_title")}</h2>
          <p>
            <Pill tone={assessment.approved ? "green" : "gold"}>{assessment.approved ? t("seq_transition_approved") : t("seq_transition_refused")}</Pill> <code>{assessment.code}</code>
          </p>
          <p>{assessment.message}</p>
          {assessment.reasons.length > 1 ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {assessment.reasons.map((r) => (
                <li key={r.code}>
                  <code>{r.code}</code> · {r.message}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="muted small">{t("seq_transition_note")}</p>
        </section>
      ) : null}

      {coverage ? (
        <section className="card flat stack" aria-labelledby="seq-coverage" data-testid="sequence-coverage">
          <h2 id="seq-coverage">{t("seq_coverage_title")}</h2>
          <p>{coverage.message}</p>
        </section>
      ) : null}

      <SemanticMascotStrip snapshot={semanticMascots} />

      {timeline.length > 0 ? (
        <section className="card flat stack" aria-labelledby="seq-timeline">
          <h2 id="seq-timeline">{t("seq_timeline_title")}</h2>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {timeline.map((e, i) => (
              <li key={`${e.at}-${i}`} data-event={e.event}>
                <span className="muted small">{formatTime(e.at)}</span> · {tOr(`seq_event_${e.event.replace(/-/g, "_")}`, e.event)}
                {e.code ? <code className="small"> {e.code}</code> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
