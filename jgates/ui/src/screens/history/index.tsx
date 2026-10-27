import { useMemo, useState } from "react";
import { formatLocale } from "../../i18n/locale";
import { api } from "../../api";
import { ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { Comparison } from "./comparison";
import "./history.css";

export const screen: ScreenMeta = { id: "history", path: "/validations", area: "validations", navLabel: "history_nav", navPath: "/validations", order: 5, icon: "check-circle" };

export interface RunRow {
  runId: string;
  startedAt: string | null;
  durationMs: number | null;
  decision: string | null;
  complete: boolean;
  partial: boolean;
  reduced: boolean;
  unfinished: boolean;
  baseline: boolean;
  preserved: boolean;
  profile: string | null;
  scope: string | null;
  commit: string | null;
  findings: { total: number; active: number; blocking: number };
  severities: string[];
  categories: string[];
  components: string[];
}

interface HistoryData {
  runs: RunRow[];
  filters: { severities: string[]; categories: string[]; components: string[] };
}

type ResultFilter = "all" | "pending" | "passed";
const RESULT_FILTERS: ResultFilter[] = ["all", "pending", "passed"];
const TONE: Record<string, "green" | "gold" | "red" | "blue"> = { passed: "green", failed: "red", incomplete: "gold", invalid: "red", cancelled: "gold" };

export function formatWhen(iso: string | null): string {
  if (!iso) return "-";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(formatLocale(), { dateStyle: "short", timeStyle: "short" });
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "-";
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export default function HistoryScreen() {
  const history = useAsync(() => api<HistoryData>("GET", "/api/history"), "history");
  const toast = useToast();
  const [result, setResult] = useState<ResultFilter>("all");
  const [severity, setSeverity] = useState("");
  const [category, setCategory] = useState("");
  const [component, setComponent] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [comparing, setComparing] = useState<{ base: string; head: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const rows = useMemo(() => {
    const all = history.data?.runs ?? [];
    return all.filter((r) => {
      if (result === "passed" && r.decision !== "passed") return false;
      if (result === "pending" && r.decision === "passed") return false;
      if (severity && !r.severities.includes(severity)) return false;
      if (category && !r.categories.includes(category)) return false;
      if (component && !r.components.includes(component)) return false;
      return true;
    });
  }, [history.data, result, severity, category, component]);

  if (history.loading && !history.data) return <Loading />;
  if (history.error) return <ErrorNotice error={history.error} onRetry={history.reload} />;
  const data = history.data as HistoryData;

  const mark = async (run: RunRow, patch: { baseline?: boolean; preserved?: boolean }, done: string) => {
    setBusy(run.runId);
    try {
      await api("POST", `/api/history/${encodeURIComponent(run.runId)}/marks`, patch);
      toast(t(done, { runId: run.runId }), "ok");
      history.reload();
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const toggle = (runId: string) => {
    setComparing(null);
    setPicked((current) => (current.includes(runId) ? current.filter((id) => id !== runId) : [...current, runId].slice(-2)));
  };

  const compare = () => {
    const [a, b] = picked.map((id) => data.runs.find((r) => r.runId === id) as RunRow);
    if (!a || !b) return;
    // The older run is the "before": the comparison always reads from old to new.
    const [base, head] = (a.startedAt ?? "") <= (b.startedAt ?? "") ? [a, b] : [b, a];
    setComparing({ base: base.runId, head: head.runId });
  };

  const select = (label: string, value: string, set: (v: string) => void, options: string[], translate: (v: string) => string) =>
    options.length === 0 ? null : (
      <label className="history-filter">
        <span>{label}</span>
        <select value={value} onChange={(e) => set(e.target.value)}>
          <option value="">{t("history_filter_any")}</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {translate(o)}
            </option>
          ))}
        </select>
      </label>
    );

  return (
    <div className="stack">
      <div>
        <h1>{t("history_title")}</h1>
        <p>{t("history_lead")}</p>
      </div>

      <div className="history-toolbar">
        <div className="history-segmented" role="group" aria-label={t("history_filter_result")}>
          {RESULT_FILTERS.map((f) => (
            <button key={f} type="button" aria-pressed={result === f} className={result === f ? "active" : ""} onClick={() => setResult(f)}>
              {t(`history_result_${f}`)}
            </button>
          ))}
        </div>
        {select(t("history_filter_severity"), severity, setSeverity, data.filters.severities, (v) => tOr(`history_severity_${v}`, v))}
        {select(t("history_filter_category"), category, setCategory, data.filters.categories, (v) => v)}
        {select(t("history_filter_component"), component, setComponent, data.filters.components, (v) => v)}
        <span className="small muted grow" role="status">
          {t("history_count", { count: rows.length })}
        </span>
        <button type="button" className="btn primary" disabled={picked.length !== 2} onClick={compare}>
          <Icon name="copy" />
          {t("history_compare")}
        </button>
      </div>
      {picked.length === 1 ? <p className="small muted">{t("history_pick_second")}</p> : null}

      {comparing ? <Comparison base={comparing.base} head={comparing.head} onClose={() => setComparing(null)} /> : null}

      {data.runs.length === 0 ? (
        <div className="notice" role="status">
          <Icon name="info" />
          <span>{t("history_empty")}</span>
        </div>
      ) : (
        <div className="card flat table-wrap">
          <table aria-label={t("history_table")}>
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">{t("history_col_pick")}</span>
                </th>
                <th scope="col">{t("history_col_run")}</th>
                <th scope="col">{t("history_col_result")}</th>
                <th scope="col">{t("history_col_profile")}</th>
                <th scope="col">{t("history_col_findings")}</th>
                <th scope="col">{t("history_col_duration")}</th>
                <th scope="col">{t("history_col_actions")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.runId} data-run={r.runId}>
                  <td>
                    <input type="checkbox" aria-label={t("history_pick", { runId: r.runId })} checked={picked.includes(r.runId)} disabled={r.unfinished} onChange={() => toggle(r.runId)} />
                  </td>
                  <th scope="row">
                    <a href={`#/runs/${encodeURIComponent(r.runId)}`}>{r.runId}</a>
                    <div className="small muted">
                      {formatWhen(r.startedAt)}
                      {r.commit ? (
                        <>
                          {" · "}
                          <code>{r.commit.slice(0, 7)}</code>
                        </>
                      ) : null}
                    </div>
                  </th>
                  <td>
                    <div className="history-pills">
                      <Pill tone={TONE[r.decision ?? ""] ?? "blue"}>{r.unfinished ? t("history_unfinished") : tOr(`history_decision_${r.decision}`, r.decision ?? "-")}</Pill>
                      {r.partial && !r.unfinished ? <Pill tone="gold">{t("history_partial")}</Pill> : null}
                      {r.baseline ? <Pill tone="blue">{t("history_baseline")}</Pill> : null}
                      {r.preserved ? <Pill tone="green">{t("history_preserved")}</Pill> : null}
                    </div>
                  </td>
                  <td>{r.profile ?? "-"}</td>
                  <td>{t("history_findings", { active: r.findings.active, blocking: r.findings.blocking })}</td>
                  <td className="muted">{formatDuration(r.durationMs)}</td>
                  <td>
                    <div className="history-actions">
                      <button type="button" className="btn" disabled={busy === r.runId || r.unfinished} aria-pressed={r.baseline} onClick={() => mark(r, { baseline: !r.baseline }, r.baseline ? "history_baseline_cleared" : "history_baseline_set")}>
                        {r.baseline ? t("history_baseline_remove", { runId: r.runId }) : t("history_baseline_make", { runId: r.runId })}
                      </button>
                      <button type="button" className="btn" disabled={busy === r.runId} aria-pressed={r.preserved} onClick={() => mark(r, { preserved: !r.preserved }, r.preserved ? "history_preserve_cleared" : "history_preserve_set")}>
                        {r.preserved ? t("history_preserve_remove", { runId: r.runId }) : t("history_preserve_make", { runId: r.runId })}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="notice">
        <Icon name="info" />
        <div>
          <strong>{t("history_context_title")}</strong> {t("history_context_body")}
        </div>
      </div>
    </div>
  );
}
