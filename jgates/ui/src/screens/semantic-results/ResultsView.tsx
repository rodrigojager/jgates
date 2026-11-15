import { Pill } from "../../components/common";
import { formatDateTime } from "../../components/format";
import { Icon } from "../../components/icons";
import { formatLocale, t, tOr } from "../../i18n";
import { useReproduction, type ReproFinding, type ReproReport } from "./Reproduction";

/** The report of GET /api/semantic/runs/:id/report (server/routes/semantic-views.ts). */
export interface SemanticReport {
  runId: string;
  lifecycle: string;
  decision: string | null;
  complete: boolean;
  partial: boolean;
  reviewState: string | null;
  reason: string | null;
  summary: string | null;
  rigor: string | null;
  methods: string[];
  provider: string | null;
  model: string | null;
  mode: string | null;
  units: {
    examinedNow: string[];
    reused: string[];
    unresolved: Array<{ id: string; reason: string }>;
    outOfScope: Array<{ id: string; reason: string }>;
    withFindings: string[];
  };
  scope: { subjects: number; toExamine: number; covered: number; repositoryFiles: number; claim: string | null; completion: number | null; repositoryCoverage: number | null; inheritedCoverage: string | null };
  investigation: { basis: string | null; subjects: number; examined: number; notExamined: number; gaps: Array<Record<string, unknown>> } | null;
  findings: Array<{ severity: string; confirmation: string; category: string; message: string; path: string | null; line: number | null } & ReproFinding>;
  /** The run's methods read source code, so its needs-validation findings can be reproduced. */
  reproducible?: boolean;
  /** The reproduction state of the findings (and, for a reproduction run, the run it reproduces). */
  reproduction?: ReproReport["reproduction"];
  confirmation: Record<string, number>;
  severity: Record<string, number>;
  usage: {
    calls: number;
    durationMs: number | null;
    cost: { reported: boolean; perCall: number | null; total: number | null } | null;
    tokens: { input: number; output: number; reported: boolean } | null;
    budget: { limits: Record<string, unknown> | null; reserve: Record<string, unknown> | null; exhausted: { dimension?: string; stage?: string; message?: string } | null } | null;
  };
}

export const DECISION_TONE: Record<string, "green" | "gold" | "red" | "blue"> = { passed: "green", failed: "red", incomplete: "gold", invalid: "red", cancelled: "gold" };
const CONFIRMATION_TONE: Record<string, "green" | "gold" | "red" | "blue"> = { confirmed: "red", "needs-validation": "gold", rejected: "blue" };

export function formatWhen(iso: string | null): string {
  return iso ? formatDateTime(iso) : "-";
}

const percent =(value: number | null): string => (value === null ? "-" : `${Math.round(value * 100)}%`);

function UnitList({ id, title, hint, items, testId }: { id: string; title: string; hint: string; items: Array<{ id: string; reason?: string }>; testId: string }) {
  return (
    <section className="card flat stack" aria-labelledby={id} data-testid={testId} data-count={items.length}>
      <div className="between">
        <h3 id={id}>{title}</h3>
        <strong>{items.length}</strong>
      </div>
      <p className="muted small">{hint}</p>
      {items.length > 0 ? (
        <details>
          <summary>{t("semres_units_show")}</summary>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {items.slice(0, 300).map((u) => (
              <li key={u.id}>
                <code>{u.id}</code>
                {u.reason ? <span className="muted"> · {u.reason}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/** Results of a Semantic run: the four unit groups, scope completion apart from repository coverage, confirmation apart from severity, and usage. */
export function SemanticResultsView({ report }: { report: SemanticReport }) {
  const decision = report.decision ?? "-";
  const u = report.units;
  const exhausted = report.usage.budget?.exhausted ?? null;
  const repro = useReproduction(report);
  const showReproduction = repro.offered || report.findings.some((f) => f.reproduction && f.reproduction.state !== "none");
  return (
    <div className="stack" data-testid="semantic-results" data-decision={decision}>
      <section className="card flat stack" aria-labelledby="semres-outcome">
        <div className="between wrap">
          <h2 id="semres-outcome">{t("semres_outcome_title")}</h2>
          <div className="row wrap" style={{ gap: 6 }}>
            <Pill tone={report.lifecycle === "running" ? "blue" : (DECISION_TONE[decision] ?? "blue")}>{report.lifecycle === "running" ? t("semres_running") : tOr(`semres_decision_${decision}`, decision)}</Pill>
            {!report.complete && report.lifecycle !== "running" ? <Pill tone="gold">{t("semres_not_complete")}</Pill> : null}
            <Pill tone="blue">{t("semres_advisory")}</Pill>
          </div>
        </div>
        {report.summary ? <p>{report.summary}</p> : null}
        {report.reason ? <p className="small muted">{report.reason}</p> : null}
        <dl className="kv">
          <dt>{t("semres_rigor")}</dt>
          <dd>{report.rigor ? tOr(`semres_rigor_${report.rigor}`, report.rigor) : "-"}</dd>
          <dt>{t("semres_methods")}</dt>
          <dd data-testid="semres-methods">{report.methods.length > 0 ? report.methods.map((m) => tOr(`semres_method_${m}`, m)).join(", ") : "-"}</dd>
          <dt>{t("semres_backend")}</dt>
          <dd>{[report.provider, report.model].filter(Boolean).join(" · ") || "-"}</dd>
          <dt>{t("semres_mode")}</dt>
          <dd>{report.mode ? tOr(`semres_mode_${report.mode}`, report.mode) : "-"}</dd>
        </dl>
      </section>

      <section className="stack" aria-labelledby="semres-units">
        <h2 id="semres-units">{t("semres_units_title")}</h2>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <UnitList id="semres-examined" testId="semres-examined" title={t("semres_examined")} hint={t("semres_examined_hint")} items={u.examinedNow.map((id) => ({ id }))} />
          <UnitList id="semres-reused" testId="semres-reused" title={t("semres_reused")} hint={t("semres_reused_hint")} items={u.reused.map((id) => ({ id }))} />
          <UnitList id="semres-unresolved" testId="semres-unresolved" title={t("semres_unresolved")} hint={t("semres_unresolved_hint")} items={u.unresolved} />
          <UnitList id="semres-out" testId="semres-out" title={t("semres_out_of_scope")} hint={t("semres_out_of_scope_hint")} items={u.outOfScope} />
        </div>
      </section>

      <section className="card flat stack" aria-labelledby="semres-coverage">
        <h2 id="semres-coverage">{t("semres_coverage_title")}</h2>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <div className="stack" style={{ gap: 4 }} data-testid="semres-scope-completion">
            <span className="small muted">{t("semres_scope_completion")}</span>
            <strong>{percent(report.scope.completion)}</strong>
            <progress max={1} value={report.scope.completion ?? 0} aria-label={t("semres_scope_completion")} />
            <span className="small">{t("semres_scope_completion_detail", { covered: report.scope.covered, subjects: report.scope.subjects })}</span>
          </div>
          <div className="stack" style={{ gap: 4 }} data-testid="semres-repository-coverage">
            <span className="small muted">{t("semres_repository_coverage")}</span>
            <strong>{percent(report.scope.repositoryCoverage)}</strong>
            <progress max={1} value={report.scope.repositoryCoverage ?? 0} aria-label={t("semres_repository_coverage")} />
            <span className="small">{t("semres_repository_coverage_detail", { covered: report.scope.covered, files: report.scope.repositoryFiles })}</span>
          </div>
        </div>
        {report.scope.claim === "scope-only" ? (
          <div className="notice" role="note">
            <Icon name="info" />
            <span>{t("semres_claim_scope_only")}</span>
          </div>
        ) : null}
        {report.investigation ? (
          <p className="small muted">{t("semres_investigation_coverage", { examined: report.investigation.examined, subjects: report.investigation.subjects, gaps: report.investigation.gaps.length })}</p>
        ) : null}
      </section>

      <section className="card flat stack" aria-labelledby="semres-findings">
        <h2 id="semres-findings">{t("semres_findings_title")}</h2>
        <p className="muted small">{t("semres_findings_lead")}</p>
        {repro.note}
        {repro.all}
        {repro.panel}
        <div className="row wrap" style={{ gap: 6 }} data-testid="semres-confirmation">
          {(["confirmed", "needs-validation", "rejected"] as const).map((c) => (
            <Pill key={c} tone={CONFIRMATION_TONE[c]}>
              {t(`semres_confirmation_${c}`)}: {report.confirmation[c] ?? 0}
            </Pill>
          ))}
        </div>
        {report.findings.length === 0 ? (
          <p>{report.lifecycle === "running" ? t("semres_findings_pending") : t("semres_findings_none")}</p>
        ) : (
          <div className="table-wrap">
            <table aria-label={t("semres_findings_title")}>
              <thead>
                <tr>
                  <th scope="col">{t("semres_col_finding")}</th>
                  <th scope="col">{t("semres_col_severity")}</th>
                  <th scope="col">{t("semres_col_confirmation")}</th>
                  <th scope="col">{t("semres_col_location")}</th>
                  {showReproduction ? <th scope="col">{t("semres_col_reproduction")}</th> : null}
                </tr>
              </thead>
              <tbody>
                {report.findings.map((f, i) => (
                  <tr key={`${f.path}:${f.line}:${i}`} data-severity={f.severity} data-confirmation={f.confirmation}>
                    <th scope="row">
                      {f.message}
                      <div className="small muted">{f.category}</div>
                    </th>
                    <td>{tOr(`history_severity_${f.severity}`, f.severity)}</td>
                    <td>
                      <Pill tone={CONFIRMATION_TONE[f.confirmation] ?? "blue"}>{tOr(`semres_confirmation_${f.confirmation}`, f.confirmation)}</Pill>
                    </td>
                    <td>{f.path ? <code>{f.line !== null ? `${f.path}:${f.line}` : f.path}</code> : "-"}</td>
                    {showReproduction ? <td>{repro.cell(f)}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card flat stack" aria-labelledby="semres-usage">
        <h2 id="semres-usage">{t("semres_usage_title")}</h2>
        <dl className="kv" data-testid="semres-usage">
          <dt>{t("semres_usage_calls")}</dt>
          <dd>{report.usage.calls}</dd>
          <dt>{t("semres_usage_tokens")}</dt>
          <dd>{report.usage.tokens ? t(report.usage.tokens.reported ? "semres_usage_tokens_value" : "semres_usage_tokens_estimated", { input: report.usage.tokens.input, output: report.usage.tokens.output }) : "-"}</dd>
          <dt>{t("semres_usage_cost")}</dt>
          <dd>{report.usage.cost?.reported && report.usage.cost.total !== null ? String(report.usage.cost.total) : t("semres_usage_cost_unreported")}</dd>
          <dt>{t("semres_usage_duration")}</dt>
          <dd>{report.usage.durationMs !== null ? `${Math.round(report.usage.durationMs / 1000)} s` : "-"}</dd>
        </dl>
        {exhausted ? (
          <div className="notice warn" role="status">
            <Icon name="alert" />
            <span>{t("semres_budget_exhausted", { detail: exhausted.message ?? exhausted.dimension ?? "-" })}</span>
          </div>
        ) : null}
      </section>
    </div>
  );
}
