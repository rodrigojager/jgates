import { api } from "../../api";
import { ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { DECISION_TONE, formatWhen } from "../semantic-results/ResultsView";

export const screen: ScreenMeta = { id: "semantic-history", path: "/semantic", area: "semantic", navLabel: "semhist_nav", navPath: "/semantic", order: 50, icon: "plan" };

/** One entry of GET /api/semantic/runs (core/semantic listSemanticRuns): Semantic runs only, never Quality ones. */
interface SemanticRunRow {
  runId: string;
  startedAt: string | null;
  finishedAt: string | null;
  decision: string | null;
  complete: boolean;
  partial: boolean;
  lifecycle: "running" | "settled" | "interrupted";
  cancelRequested: boolean;
  provider: string | null;
  model: string | null;
  reviewState: string | null;
  methods?: string[];
  reproduction?: { reproduces: string | null; counts: { confirmed: number; attempted: number; none: number }; runs: string[] };
}

/** The Semantic history of the workspace: its own runs, apart from the Quality history. */
export default function SemanticHistoryScreen() {
  const history = useAsync(() => api<{ runs: SemanticRunRow[] }>("GET", "/api/semantic/runs"), "semantic-history");
  if (history.loading && !history.data) return <Loading />;
  if (history.error) return <ErrorNotice error={history.error} onRetry={history.reload} />;
  const runs = history.data?.runs ?? [];
  return (
    <div className="stack">
      <div className="between wrap">
        <div>
          <h1>{t("semhist_title")}</h1>
          <p>{t("semhist_lead")}</p>
        </div>
        <div className="row wrap">
          <a className="btn" href="#/semantic/config" data-testid="semhist-config">
            <Icon name="sliders" />
            {t("semhist_config")}
          </a>
          <a className="btn primary" href="#/semantic/setup" data-testid="semhist-new-run">
            <Icon name="play" />
            {t("semhist_new_run")}
          </a>
        </div>
      </div>

      {runs.length === 0 ? (
        <div className="notice" role="status">
          <Icon name="info" />
          <span>{t("semhist_empty")}</span>
        </div>
      ) : (
        <div className="card flat table-wrap">
          <table aria-label={t("semhist_table")}>
            <thead>
              <tr>
                <th scope="col">{t("semhist_col_run")}</th>
                <th scope="col">{t("semhist_col_methods")}</th>
                <th scope="col">{t("semhist_col_result")}</th>
                <th scope="col">{t("semhist_col_backend")}</th>
                <th scope="col">{t("semhist_col_actions")}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const running = r.lifecycle === "running";
                const interrupted = r.lifecycle === "interrupted";
                const label = running ? t("semhist_running") : interrupted ? t("semhist_interrupted") : tOr(`semres_decision_${r.decision}`, r.decision ?? "-");
                return (
                  <tr key={r.runId} data-run={r.runId} data-lifecycle={r.lifecycle}>
                    <th scope="row">
                      <a href={`#/semantic/runs/${encodeURIComponent(r.runId)}`}>{r.runId}</a>
                      <div className="small muted">{formatWhen(r.startedAt)}</div>
                    </th>
                    <td className="small" data-testid="semhist-methods">
                      {r.methods && r.methods.length > 0 ? r.methods.map((m) => tOr(`semres_method_${m}`, m)).join(", ") : "-"}
                    </td>
                    <td>
                      <div className="row wrap" style={{ gap: 6 }}>
                        <Pill tone={running ? "blue" : interrupted ? "gold" : (DECISION_TONE[r.decision ?? ""] ?? "blue")}>{label}</Pill>
                        {!running && !r.complete ? <Pill tone="gold">{t("semres_not_complete")}</Pill> : null}
                        {r.cancelRequested ? <Pill tone="gold">{t("semhist_cancel_requested")}</Pill> : null}
                      </div>
                      {r.reproduction?.reproduces ? (
                        <div className="small" data-testid="semhist-reproduces">
                          {t("semhist_reproduces")} <a href={`#/semantic/results/${encodeURIComponent(r.reproduction.reproduces)}`}>{r.reproduction.reproduces}</a>
                        </div>
                      ) : null}
                      {r.reproduction && r.reproduction.counts.confirmed + r.reproduction.counts.attempted > 0 ? (
                        <div className="small muted" data-testid="semhist-reproduction">
                          {t("semhist_reproduction_counts", { confirmed: r.reproduction.counts.confirmed, attempted: r.reproduction.counts.attempted })}
                        </div>
                      ) : null}
                    </td>
                    <td className="small">{[r.provider, r.model].filter(Boolean).join(" · ") || "-"}</td>
                    <td>
                      {running ? (
                        <a href={`#/semantic/runs/${encodeURIComponent(r.runId)}`}>{t("semhist_follow")}</a>
                      ) : (
                        <a href={`#/semantic/results/${encodeURIComponent(r.runId)}`}>{t("semhist_open_results")}</a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="notice">
        <Icon name="info" />
        <div>
          <strong>{t("semhist_separate_title")}</strong> {t("semhist_separate_body")}
        </div>
      </div>
    </div>
  );
}
