import { useMemo, useState } from "react";
import { formatLocale } from "../../i18n/locale";
import { api } from "../../api";
import { ErrorNotice, Pill } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t, tOr } from "../../i18n";

type Tone = "green" | "gold" | "red" | "blue";

const DECISION_TONE: Record<string, Tone> = { passed: "green", failed: "red", incomplete: "gold", invalid: "red", cancelled: "gold" };
const STATE_TONE: Record<string, Tone> = { completed: "green", error: "red", timeout: "red", blocked: "gold", cancelled: "gold", running: "blue", pending: "blue" };

/** Name of a stage as the catalog has it: the known ids first, then the label the manifest gave, then the id itself. */
export function stageName(stage: { id: string; label?: string }): string {
  return tOr(`vres_stage_${stage.id}`, stage.label ?? stage.id);
}

export function stateText(state: string): string {
  return tOr(`vres_state_${state}`, state);
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1).replace(".", ",")} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(formatLocale());
}

/** Value of a metric with its unit; a metric that was not measured is never shown as zero. */
export function metricText(m: any): string {
  if (m.measured === false || typeof m.value !== "number") return m.reason ? t("vres_not_measured_reason", { reason: m.reason }) : t("vres_not_measured");
  const n = m.value.toLocaleString(formatLocale(), { maximumFractionDigits: 2 });
  const unit = m.unit === "percent" ? "%" : tOr(`vres_unit_${m.unit}`, "");
  return unit === "%" ? `${n}%` : unit ? `${n} ${unit}` : n;
}

function Banner({ result, crashed }: { result: any; crashed: boolean }) {
  const runDisabled: any[] = (result.disabled ?? []).filter((d: any) => d.origin === "run");
  const blocking = result.blockingViolations ?? 0;
  const partial = result.partial === true || result.decision === "cancelled";
  let title: string;
  let text: string;
  let tone: Tone = DECISION_TONE[result.decision] ?? "gold";
  let icon: "check" | "alert" | "stop" = result.decision === "passed" ? "check" : "alert";
  let kind: string = result.decision;
  if (partial) {
    title = result.decision === "cancelled" ? t("vres_banner_cancelled") : t("vres_banner_partial");
    text = crashed ? t("vres_crashed_text") : t("vres_partial_text");
    tone = "gold";
    icon = "stop";
    kind = "partial";
  } else if (result.decision === "passed" && result.reduced) {
    title = runDisabled.length === 1 ? t("vres_banner_reduced_one") : t("vres_banner_reduced", { count: runDisabled.length });
    text = t("vres_banner_reduced_text");
    tone = "gold";
    kind = "passed-reduced";
  } else if (result.decision === "passed") {
    title = t("vres_banner_passed");
    text = t("vres_banner_passed_text");
  } else if (result.decision === "failed") {
    title = t("vres_banner_failed");
    text = blocking === 1 ? t("vres_banner_failed_one") : t("vres_banner_failed_text", { count: blocking });
  } else if (result.decision === "incomplete") {
    title = t("vres_banner_incomplete");
    text = t("vres_banner_incomplete_text");
  } else {
    title = t("vres_banner_invalid");
    text = t("vres_banner_invalid_text");
  }
  return (
    <div className={`notice ${tone === "green" ? "ok" : tone === "red" ? "error" : "warn"}`} role="status" data-testid="result-banner" data-kind={kind}>
      <Icon name={icon} />
      <div className="grow stack" style={{ gap: 6 }}>
        <strong data-testid="result-banner-title">{title}</strong>
        <p>{text}</p>
        {partial || result.decision !== "passed" ? <p>{result.decision === "passed" ? "" : t("vres_no_approval")}</p> : null}
        {result.stopped ? (
          <p className="small">
            {result.stopped.cause === "cancelled"
              ? result.stopped.stepId
                ? t("vres_stopped_cancelled", { step: result.stopped.stepId })
                : t("vres_stopped_cancelled_nostep")
              : t("vres_stopped_fail_fast", { step: result.stopped.stepId ?? "" })}
          </p>
        ) : null}
        {result.decision === "passed" && result.reduced && runDisabled.length > 0 ? (
          <ul data-testid="reduced-list">
            {runDisabled.map((d) => (
              <li key={d.id}>
                <code>{d.id}</code>
                {d.reason ? ` - ${d.reason}` : ""}
              </li>
            ))}
          </ul>
        ) : null}
        {!result.complete && !partial && result.decision !== "incomplete" ? <p className="small">{t("vres_complete_no")}</p> : null}
      </div>
    </div>
  );
}

function Stages({ result }: { result: any }) {
  const stages: any[] = result.stages ?? [];
  if (stages.length === 0) return null;
  return (
    <section className="stack" aria-labelledby="vres-stages">
      <h3 id="vres-stages">{t("vres_stages")}</h3>
      <div className="card flat table-wrap">
        <table aria-label={t("vres_stages")}>
          <thead>
            <tr>
              <th scope="col">{t("vres_col_stage")}</th>
              <th scope="col">{t("vres_col_state")}</th>
              <th scope="col">{t("vres_col_why")}</th>
              <th scope="col">{t("vres_col_findings")}</th>
              <th scope="col">{t("vres_col_duration")}</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((s) => {
              const notRun = s.execution?.notRun;
              const reused = s.cache?.status === "reused";
              return (
                <tr key={s.id}>
                  <th scope="row">{stageName(s)}</th>
                  <td>
                    <Pill tone={STATE_TONE[s.state]}>{stateText(s.state)}</Pill>
                  </td>
                  <td>
                    {notRun ? <div>{tOr(`vres_cause_${notRun.cause}`, notRun.cause)}</div> : null}
                    {s.reason ? <div className="small">{s.reason}</div> : null}
                    {reused ? (
                      <div className="small" data-testid="reused">
                        {s.cache.at ? t("vres_cache_reused", { date: formatDate(s.cache.at), runId: s.cache.runId ?? "" }) : t("vres_cache_reused_nodate", { runId: s.cache.runId ?? "" })} {t("vres_cache_why")}
                      </div>
                    ) : null}
                    {s.cache?.status === "uncacheable" && s.cache.reason ? <div className="small">{t("vres_cache_uncacheable", { reason: s.cache.reason })}</div> : null}
                  </td>
                  <td>{s.findings ?? 0}</td>
                  <td>{formatDuration(s.execution?.durationMs)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Metrics({ result }: { result: any }) {
  const metrics: any[] = (result.metrics ?? []).filter((m: any) => !String(m.id).startsWith("findings."));
  return (
    <section className="stack" aria-labelledby="vres-metrics">
      <h3 id="vres-metrics">{t("vres_metrics")}</h3>
      {metrics.length === 0 ? (
        <p>{t("vres_metrics_empty")}</p>
      ) : (
        <div className="card flat table-wrap">
          <table aria-label={t("vres_metrics")}>
            <thead>
              <tr>
                <th scope="col">{t("vres_col_metric")}</th>
                <th scope="col">{t("vres_col_value")}</th>
                <th scope="col">{t("vres_col_basis")}</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((m, i) => (
                <tr key={`${m.id}:${m.component ?? ""}:${i}`}>
                  <th scope="row">
                    {m.label ?? m.id}
                    {m.component ? <span className="muted"> ({m.component})</span> : null}
                  </th>
                  <td data-testid={`metric-${m.id}`}>
                    {metricText(m)}
                    {m.measured !== false && m.numerator !== undefined && m.denominator !== undefined ? <span className="muted"> ({t("vres_metric_of", { numerator: m.numerator, denominator: m.denominator })})</span> : null}
                  </td>
                  <td>{[m.basis, m.scope].filter(Boolean).join(" / ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Architecture({ result }: { result: any }) {
  const list: any[] = result.architecture ?? [];
  if (list.length === 0) return null;
  return (
    <section className="stack" aria-labelledby="vres-arch">
      <h3 id="vres-arch">{t("vres_architecture")}</h3>
      <p className="muted">{t("vres_architecture_text")}</p>
      {list.map((a) => (
        <div className="card flat stack" key={a.tool} data-testid="architecture-coverage" data-status={a.status} style={{ gap: 8 }}>
          <div className="row">
            <strong>{a.tool}</strong>
            <Pill tone={a.status === "complete" ? "green" : "gold"}>{tOr(`vres_architecture_${a.status}`, a.status)}</Pill>
          </div>
          <p className="small">{t("vres_architecture_counts", { nodes: a.nodes, edges: a.edges, unresolved: a.unresolved })}</p>
          <p className="small">{a.verified ? t("vres_architecture_verified") : t("vres_architecture_unverified")}</p>
          {a.reason ? <p className="small">{a.reason}</p> : null}
          {a.unresolvedSample?.length > 0 ? (
            <div>
              <strong className="small">{t("vres_architecture_unresolved")}</strong>
              <ul>
                {a.unresolvedSample.map((u: any, i: number) => (
                  <li key={i} className="small">
                    {t("vres_architecture_unresolved_item", { from: u.from, specifier: u.specifier })}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function FindingRow({ f }: { f: any }) {
  const loc = f.location?.path ? `${f.location.path}${f.location.line ? `:${f.location.line}` : ""}` : "";
  const hasDetails = f.remediation || f.evidence || f.waived || f.docsUrl;
  return (
    <>
      <tr>
        <td>
          {tOr(`vres_sev_${f.normalizedSeverity}`, String(f.normalizedSeverity))}
          {f.blocking ? (
            <>
              {" "}
              <Pill tone="red">{t("vres_blocking")}</Pill>
            </>
          ) : null}
          {f.waived ? (
            <>
              {" "}
              <Pill tone="blue">{t("vres_waived")}</Pill>
            </>
          ) : null}
          {f.baselineState ? (
            <>
              {" "}
              <Pill>{f.baselineState === "new" ? t("vres_baseline_new") : t("vres_baseline_unchanged")}</Pill>
            </>
          ) : null}
        </td>
        <td>
          <code>{f.ruleId}</code>
        </td>
        <td>
          {f.message}
          {hasDetails ? (
            <details>
              <summary>{t("vres_finding_details")}</summary>
              <dl className="kv">
                <dt>{t("vres_finding_tool")}</dt>
                <dd>{f.tool}</dd>
                {f.remediation ? (
                  <>
                    <dt>{t("vres_finding_remediation")}</dt>
                    <dd>{f.remediation}</dd>
                  </>
                ) : null}
                {f.waived ? (
                  <>
                    <dt>{t("vres_finding_waiver")}</dt>
                    <dd>{[f.waiverId, f.waiverReason].filter(Boolean).join(": ")}</dd>
                  </>
                ) : null}
                {f.evidence ? (
                  <>
                    <dt>{t("vres_finding_evidence")}</dt>
                    <dd>
                      <code>{f.evidence}</code>
                    </dd>
                  </>
                ) : null}
                {f.docsUrl ? (
                  <>
                    <dt>{t("vres_finding_docs")}</dt>
                    <dd>{f.docsUrl}</dd>
                  </>
                ) : null}
              </dl>
            </details>
          ) : null}
        </td>
        <td>
          <code>{loc}</code>
        </td>
        <td>{f.origin ?? f.tool}</td>
      </tr>
    </>
  );
}

function Findings({ result }: { result: any }) {
  const findings: any[] = result.findings ?? [];
  const [severity, setSeverity] = useState("");
  const [category, setCategory] = useState("");
  const [component, setComponent] = useState("");
  const severities = useMemo(() => [...new Set(findings.map((f) => String(f.normalizedSeverity)))], [findings]);
  const categories = useMemo(() => [...new Set(findings.map((f) => String(f.category ?? "")))], [findings]);
  const components = useMemo(() => [...new Set(findings.map((f) => String(f.component ?? "")).filter(Boolean))], [findings]);
  const shown = findings.filter((f) => (!severity || String(f.normalizedSeverity) === severity) && (!category || String(f.category ?? "") === category) && (!component || String(f.component ?? "") === component));
  return (
    <section className="stack" aria-labelledby="vres-findings">
      <h3 id="vres-findings">{t("vres_findings")}</h3>
      {findings.length > 0 ? (
        <div className="row wrap" role="group" aria-label={t("vres_findings")}>
          <label className="row">
            <span className="muted">{t("vres_filter_severity")}</span>
            <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="">{t("vres_filter_all")}</option>
              {severities.map((s) => (
                <option key={s} value={s}>
                  {tOr(`vres_sev_${s}`, s)}
                </option>
              ))}
            </select>
          </label>
          <label className="row">
            <span className="muted">{t("vres_filter_category")}</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{t("vres_filter_all")}</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c || t("vres_category_unknown")}
                </option>
              ))}
            </select>
          </label>
          {components.length > 0 ? (
            <label className="row">
              <span className="muted">{t("vres_filter_component")}</span>
              <select value={component} onChange={(e) => setComponent(e.target.value)}>
                <option value="">{t("vres_filter_all")}</option>
                {components.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <span className="muted" role="status">
            {t("vres_filter_count", { shown: shown.length, total: findings.length })}
          </span>
        </div>
      ) : null}
      {findings.length === 0 ? (
        <p>{t("vres_findings_empty")}</p>
      ) : shown.length === 0 ? (
        <p>{t("vres_findings_none_filtered")}</p>
      ) : (
        <div className="card flat table-wrap">
          <table aria-label={t("vres_findings")}>
            <thead>
              <tr>
                <th scope="col">{t("vres_col_severity")}</th>
                <th scope="col">{t("vres_col_rule")}</th>
                <th scope="col">{t("vres_col_message")}</th>
                <th scope="col">{t("vres_col_location")}</th>
                <th scope="col">{t("vres_col_origin")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((f, i) => (
                <FindingRow key={`${f.fingerprint ?? f.ruleId}:${i}`} f={f} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Disabled({ result }: { result: any }) {
  const disabled: any[] = result.disabled ?? [];
  return (
    <section className="stack" aria-labelledby="vres-disabled">
      <h3 id="vres-disabled">{t("vres_disabled")}</h3>
      {disabled.length === 0 ? (
        <p>{t("vres_disabled_none")}</p>
      ) : (
        <ul>
          {disabled.map((d) => (
            <li key={`${d.origin}:${d.id}`}>
              <code>{d.id}</code>: {tOr(`vres_origin_${d.origin}`, d.origin)}
              {d.reason ? ` - ${d.reason}` : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function WorkspaceFiles({ result }: { result: any }) {
  const ch = result.workspaceChanges;
  if (!ch) return null;
  const entries: Array<{ path: string; change: string; stage: string | null }> =
    ch.entries ?? [...(ch.added ?? []).map((p: string) => ({ path: p, change: "added", stage: null })), ...(ch.modified ?? []).map((p: string) => ({ path: p, change: "modified", stage: null })), ...(ch.removed ?? []).map((p: string) => ({ path: p, change: "removed", stage: null }))];
  return (
    <section className="stack" aria-labelledby="vres-files">
      <h3 id="vres-files">{t("vres_workspace_files")}</h3>
      {!ch.checked ? (
        <p>{t("vres_workspace_files_not_checked")}</p>
      ) : entries.length === 0 ? (
        <p>{t("vres_workspace_files_none")}</p>
      ) : (
        <ul>
          {entries.map((e) => (
            <li key={`${e.change}:${e.path}`}>
              {tOr(`vres_change_${e.change}`, e.change)}: <code>{e.path}</code>
              {e.stage ? ` ${t("vres_change_stage", { stage: e.stage })}` : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Policy({ previous, result }: { previous: any; result: any }) {
  const baseline = result.baseline;
  let text: string;
  if (!previous) text = t("vres_policy_first");
  else if (!previous.comparable) text = t("vres_policy_not_comparable", { runId: previous.runId });
  else if (previous.policyChanged) text = t("vres_policy_changed", { runId: previous.runId });
  else if (previous.changed.length > 0) text = t("vres_policy_other", { runId: previous.runId, parts: previous.changed.map((k: string) => tOr(`vres_policy_part_${k}`, k)).join(", ") });
  else text = t("vres_policy_same", { runId: previous.runId });
  return (
    <section className="stack" aria-labelledby="vres-policy">
      <h3 id="vres-policy">{t("vres_policy_change")}</h3>
      <p data-testid="policy-change">{text}</p>
      {baseline ? (
        <div>
          <strong>{t("vres_baseline")}</strong>
          <p>{baseline.comparable ? t("vres_baseline_summary", { newCount: baseline.new, kept: baseline.kept, resolved: baseline.resolved?.length ?? 0, runId: baseline.runId }) : t("vres_baseline_not_comparable")}</p>
          {(baseline.warnings ?? []).map((w: any) => (
            <p className="small" key={w.code}>
              {tOr(`vres_baseline_warning_${w.code}`, w.message)}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Link({ result }: { result: any }) {
  const a = result.analyzed;
  const p = result.provenance;
  return (
    <details>
      <summary>{t("vres_link_open")}</summary>
      {!a && !p ? (
        <p>{t("vres_link_none")}</p>
      ) : (
        <dl className="kv" aria-label={t("vres_link_title")}>
          {p?.identity ? (
            <>
              <dt>{t("vres_link_identity")}</dt>
              <dd>
                <code>{p.identity}</code>
              </dd>
            </>
          ) : null}
          {p?.plan ? (
            <>
              <dt>{t("vres_link_plan")}</dt>
              <dd>
                <code>{p.plan.hash}</code>
              </dd>
            </>
          ) : null}
          {a?.snapshot ? (
            <>
              <dt>{t("vres_link_snapshot")}</dt>
              <dd>
                <code>{a.snapshot.id}</code>
              </dd>
            </>
          ) : null}
          {p?.sourceCommit ? (
            <>
              <dt>{t("vres_link_commit")}</dt>
              <dd>
                <code>{p.sourceCommit}</code>
              </dd>
            </>
          ) : null}
          {a?.dirty !== undefined && a?.dirty !== null ? (
            <>
              <dt>{t("vres_link_dirty")}</dt>
              <dd>{a.dirty ? t("vres_yes") : t("vres_no")}</dd>
            </>
          ) : null}
          {Object.entries(p?.hashes ?? a?.hashes ?? {}).map(([k, v]) => (
            <span key={k} style={{ display: "contents" }}>
              <dt>{tOr(`vres_link_hash_${k}`, k)}</dt>
              <dd>
                <code>{String(v)}</code>
              </dd>
            </span>
          ))}
        </dl>
      )}
    </details>
  );
}

function download(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function Actions({ runId }: { runId: string }) {
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  const [manual, setManual] = useState<string | null>(null);

  async function copyAgent() {
    setError(null);
    try {
      const r = await api("GET", `/api/results/${runId}/agent-context`);
      const text: string = r.agentContext.text;
      try {
        await navigator.clipboard.writeText(text);
        setManual(null);
        toast(t("vres_copy_agent_done"), "ok");
      } catch {
        setManual(text);
        toast(t("vres_copy_agent_manual"), "warn");
      }
    } catch (e) {
      setError(e);
    }
  }
  async function exportAs(format: "json" | "sarif") {
    setError(null);
    try {
      const r = await api("GET", `/api/results/${runId}/export?format=${format}`);
      download(r.filename, `${JSON.stringify(r.document, null, 2)}\n`);
    } catch (e) {
      setError(e);
    }
  }
  async function openFolder() {
    setError(null);
    try {
      const r = await api("POST", `/api/results/${runId}/open-folder`);
      toast(r.opened ? t("vres_open_folder_done", { path: r.path }) : t("vres_folder_unavailable", { path: r.path }), r.opened ? "ok" : "warn");
    } catch (e) {
      setError(e);
    }
  }
  return (
    <section className="stack" aria-labelledby="vres-actions">
      <h3 id="vres-actions">{t("vres_actions")}</h3>
      <div className="row wrap">
        <button type="button" className="btn primary" onClick={copyAgent}>
          <Icon name="copy" />
          {t("vres_copy_agent")}
        </button>
        <button type="button" className="btn" onClick={() => exportAs("json")}>
          <Icon name="file" />
          {t("vres_export_json")}
        </button>
        <button type="button" className="btn" onClick={() => exportAs("sarif")}>
          <Icon name="file" />
          {t("vres_export_sarif")}
        </button>
        <button type="button" className="btn" onClick={openFolder}>
          <Icon name="folder" />
          {t("vres_open_folder")}
        </button>
      </div>
      <p className="muted small">{t("vres_copy_agent_hint")}</p>
      {error ? <ErrorNotice error={error} /> : null}
      {manual !== null ? (
        <label className="stack" style={{ gap: 6 }}>
          <span>{t("vres_agent_text_label")}</span>
          <textarea readOnly rows={12} value={manual} data-testid="agent-context-text" onFocus={(e) => e.currentTarget.select()} />
        </label>
      ) : null}
    </section>
  );
}

/** The Resultado of a run: the decision, the steps, metrics, findings, what was turned off and what was left behind. */
export function ResultView({ result, previous, crashed = false }: { result: any; previous: any; crashed?: boolean }) {
  const started = Date.parse(result.startedAt ?? "");
  const finished = Date.parse(result.finishedAt ?? "");
  const duration = Number.isFinite(started) && Number.isFinite(finished) ? finished - started : undefined;
  const git = result.analyzed?.git;
  return (
    <section className="stack" aria-labelledby="result-title">
      <h2 id="result-title">{t("vres_title")}</h2>
      <Banner result={result} crashed={crashed} />
      <div className="card flat">
        <dl className="kv">
          <dt>{t("vres_decision")}</dt>
          <dd>
            <Pill tone={DECISION_TONE[result.decision] ?? "gold"}>{tOr(`vres_decision_${result.decision}`, String(result.decision))}</Pill>
          </dd>
          <dt>{t("vres_complete")}</dt>
          <dd>{result.complete ? t("vres_yes") : t("vres_no")}</dd>
          <dt>{t("vres_exit_code")}</dt>
          <dd>{String(result.exitCode)}</dd>
          <dt>{t("vres_run_id")}</dt>
          <dd>
            <code>{result.runId}</code>
          </dd>
          <dt>{t("vres_started")}</dt>
          <dd>{formatDate(result.startedAt)}</dd>
          {duration !== undefined ? (
            <>
              <dt>{t("vres_duration")}</dt>
              <dd>{formatDuration(duration)}</dd>
            </>
          ) : null}
          {result.selection?.profile ? (
            <>
              <dt>{t("vres_profile")}</dt>
              <dd>{result.selection.profile}</dd>
            </>
          ) : null}
          {result.selection?.scope ? (
            <>
              <dt>{t("vres_scope")}</dt>
              <dd>{result.selection.scope}</dd>
            </>
          ) : null}
          {git?.branch ? (
            <>
              <dt>{t("vres_branch")}</dt>
              <dd>{git.branch}</dd>
            </>
          ) : null}
          {result.provenance?.sourceCommit ? (
            <>
              <dt>{t("vres_commit")}</dt>
              <dd>
                <code>{String(result.provenance.sourceCommit).slice(0, 12)}</code>
              </dd>
            </>
          ) : null}
        </dl>
      </div>
      <Actions runId={result.runId} />
      <Stages result={result} />
      <Findings result={result} />
      <Metrics result={result} />
      <Architecture result={result} />
      <Disabled result={result} />
      <WorkspaceFiles result={result} />
      <Policy previous={previous} result={result} />
      <Link result={result} />
    </section>
  );
}
