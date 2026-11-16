import { QualityMascotStrip } from "../../components/QualityMascotStrip";
import { formatDateTime } from "../../components/format";
import type { MascotSnapshot } from "../../../../src/core/mascots/index";
import { useMemo, useState } from "react";
import { formatLocale } from "../../i18n/locale";
import { api } from "../../api";
import { ErrorNotice, Pill } from "../../components/common";
import { Icon, type IconName } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t, tOr } from "../../i18n";
import { WaiveBlock, WaiveProvider, WaiveSummary, useReviewedFindings } from "./waive";
import "./result-cards.css";

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

const formatDate = (iso: string | undefined): string => formatDateTime(iso);

/** Value of a metric with its unit; a metric that was not measured is never shown as zero. */
export function metricText(m: any): string {
  if (m.measured === false || typeof m.value !== "number") return m.reason ? t("vres_not_measured_reason", { reason: m.reason }) : t("vres_not_measured");
  const n = m.value.toLocaleString(formatLocale(), { maximumFractionDigits: 2 });
  const unit = m.unit === "percent" ? "%" : tOr(`vres_unit_${m.unit}`, "");
  return unit === "%" ? `${n}%` : unit ? `${n} ${unit}` : n;
}

/** The "approval" the server computed for a result (kind and numbers); a result without it reads as a plain approval. */
export interface Approval {
  kind: "plain" | "with-waivers";
  waivers: number;
  findings: number;
  more: number;
}

export const isApprovedWithWaivers = (approval: Approval | null | undefined): approval is Approval => approval?.kind === "with-waivers" && approval.waivers > 0;

/** "Approved with 2 waivers", with "(4 findings)" when the waivers dismissed more findings than their number. Every screen uses this one. */
export function approvedWithWaiversText(approval: Approval): string {
  return t("vres_approved_waivers", { waivers: approval.waivers }) + (approval.more > 0 ? " " + t("vres_approved_waivers_findings", { findings: approval.findings }) : "");
}

/** A finding a tool reported as informational: it is shown and counted, never blocks and is never waived. */
export const isInformationalFinding = (f: any): boolean => f.informational === true && f.review !== true && f.blocking !== true && f.waived !== true;
export const isReviewFinding = (f: any): boolean => f.review === true && f.blocking !== true && f.waived !== true;

function Banner({ result, crashed, onShowWaived }: { result: any; crashed: boolean; onShowWaived?: () => void }) {
  const findings = useReviewedFindings(result.findings ?? []);
  const review = findings.filter(isReviewFinding).length;
  const runDisabled: any[] = (result.disabled ?? []).filter((d: any) => d.origin === "run");
  const blocking = result.blockingViolations ?? 0;
  const partial = result.partial === true || result.decision === "cancelled";
  let title: string;
  let text: string;
  let tone: Tone = DECISION_TONE[result.decision] ?? "gold";
  let icon: "check" | "alert" | "stop" | "info" = result.decision === "passed" ? "check" : "alert";
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
  } else if (result.decision === "passed" && isApprovedWithWaivers(result.approval)) {
    // Approved, but only because findings were dismissed: its own tone and icon, never the plain green approval.
    title = approvedWithWaiversText(result.approval);
    text = t("vres_banner_passed_waivers_text");
    tone = "blue";
    icon = "info";
    kind = "passed-waivers";
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
  // The verdict counts only the blocking findings; the ones that do not block are added as "and N informational".
  const informational = !partial && (result.decision === "passed" || result.decision === "failed") ? ((result.findings ?? []) as any[]).filter(isInformationalFinding).length : 0;
  return (
    <div className={`notice ${tone === "green" ? "ok" : tone === "red" ? "error" : "warn"}`} role="status" data-testid="result-banner" data-kind={kind}>
      <Icon name={icon} />
      <div className="grow stack" style={{ gap: 6 }}>
        <strong data-testid="result-banner-title">
          {title}
           {informational > 0 ? <span data-testid="result-banner-informational">{` ${t("vres_banner_informational", { count: informational })}`}</span> : null}
           {review > 0 ? <span data-testid="result-banner-review">{` ${t("vres_banner_review", { count: review })}`}</span> : null}
        </strong>
        <p>{text}</p>
        {kind === "passed-waivers" && onShowWaived ? (
          <p>
            <button type="button" className="btn" onClick={onShowWaived} data-testid="banner-waived-link">
              {t("vres_banner_show_waived")}
            </button>
          </p>
        ) : null}
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

export type CardState = "passed" | "failed" | "incomplete" | "blocked" | "not_applicable" | "disabled";

/** What a check card says: the stage state read together with its findings (a completed check with blocking findings failed). */
export function cardState(stage: any, findings: any[]): CardState {
  switch (stage.state) {
    case "completed":
      return (stage.blockingViolations ?? 0) > 0 || findings.some((f) => f.stageId === stage.id && f.blocking && !f.waived) ? "failed" : "passed";
    case "blocked":
      return "blocked";
    case "not_applicable":
      return "not_applicable";
    case "disabled":
      return "disabled";
    default:
      return "incomplete";
  }
}

/** One icon and one word per state, so the state never rests on colour alone. */
const CARD_ICON: Record<CardState, IconName> = { passed: "check", failed: "x", incomplete: "hourglass", blocked: "lock", not_applicable: "info", disabled: "stop" };
const CARD_TONE: Record<CardState, Tone | undefined> = { passed: "green", failed: "red", incomplete: "gold", blocked: "gold", not_applicable: undefined, disabled: undefined };

export function toolOf(stage: { id: string; adapter?: string }): string {
  return stage.adapter && stage.adapter !== "" ? stage.adapter : stage.id.split("#")[0] ?? stage.id;
}

function Stages({ result, domainFilter }: { result: any; domainFilter: DomainFilter | null }) {
  const findings: any[] = result.findings ?? [];
  const stages: any[] = (result.stages ?? []).filter((s: any) => !domainFilter || domainFilter.ids.includes(s.id));
  if ((result.stages ?? []).length === 0) return null;
  return (
    <section className="stack" aria-labelledby="vres-stages">
      <h3 id="vres-stages">{t("vres_stages")}</h3>
      <ul className="res-cards" aria-label={t("vres_stages")} data-testid="check-cards">
        {stages.map((s) => {
          const state = cardState(s, findings);
          const notRun = s.execution?.notRun;
          const reused = s.cache?.status === "reused";
          const count = s.findings ?? 0;
          const duration = formatDuration(s.execution?.durationMs);
          return (
            <li key={s.id} className="res-card res-check" data-testid="check-card" data-stage={s.id} data-state={state} data-stage-state={s.state}>
              <div className="res-card-head">
                <strong className="res-card-title">{stageName(s)}</strong>
                <Pill tone={CARD_TONE[state]}>
                  <Icon name={CARD_ICON[state]} />
                  {state === "blocked" ? stateText("blocked") : t(`vres_card_${state}`)}
                </Pill>
              </div>
              <dl className="res-card-facts">
                <div>
                  <dt>{t("vres_finding_tool")}</dt>
                  <dd data-testid="check-tool">{toolOf(s)}</dd>
                </div>
                <div>
                  <dt>{t("vres_col_duration")}</dt>
                  <dd data-testid="check-duration">{duration || "-"}</dd>
                </div>
                <div>
                  <dt>{t("vres_col_findings")}</dt>
                  <dd data-testid="check-findings">{t("vres_card_findings", { count })}</dd>
                </div>
              </dl>
              {notRun ? <p className="small">{tOr(`vres_cause_${notRun.cause}`, notRun.cause)}</p> : null}
              {s.reason ? <p className="small">{s.reason}</p> : null}
              {reused ? (
                <p className="small" data-testid="reused">
                  {s.cache.at ? t("vres_cache_reused", { date: formatDate(s.cache.at), runId: s.cache.runId ?? "" }) : t("vres_cache_reused_nodate", { runId: s.cache.runId ?? "" })} {t("vres_cache_why")}
                </p>
              ) : null}
              {s.cache?.status === "uncacheable" && s.cache.reason ? <p className="small">{t("vres_cache_uncacheable", { reason: s.cache.reason })}</p> : null}
            </li>
          );
        })}
      </ul>
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

/** The address that opens the file in the person's editor at the line (the product has no file viewer of its own). */
export function editorHref(workspacePath: string | undefined, loc: { path: string; line?: number }): string | null {
  if (!workspacePath || loc.path.startsWith("..")) return null;
  const root = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const file = loc.path.replace(/\\/g, "/").replace(/^\.?\//, "");
  const abs = /^([A-Za-z]:)?\//.test(file) ? file : `${root}/${file}`;
  return `vscode://file/${encodeURI(abs.replace(/^\//, ""))}:${loc.line ?? 1}`;
}

const SEV_TONE: Record<string, Tone | undefined> = { critical: "red", high: "red", medium: "gold", low: "blue", info: undefined, unknown: undefined };
const SEV_ICON: Record<string, IconName> = { critical: "x", high: "alert", medium: "alert", low: "info", info: "info", unknown: "info" };

function FindingCard({ f, workspacePath }: { f: any; workspacePath: string | undefined }) {
  const loc = f.location?.path ? `${f.location.path}${f.location.line ? `:${f.location.line}` : ""}` : "";
  const href = f.location?.path ? editorHref(workspacePath, f.location) : null;
  const hasDetails = f.evidence || f.waived || f.docsUrl;
  const informational = isInformationalFinding(f);
  const requirements: string[] = Array.isArray(f.asvsRequirements) ? f.asvsRequirements.map(String) : [];
  return (
    <li className="res-card res-finding" data-testid="finding-card" data-severity={f.normalizedSeverity} data-tool={f.tool} data-rule={f.ruleId} data-informational={informational ? "true" : "false"}>
      <div className="res-card-head">
        <Pill tone={SEV_TONE[f.normalizedSeverity]}>
          <Icon name={SEV_ICON[f.normalizedSeverity] ?? "info"} />
          <span data-testid="finding-severity">{tOr(`vres_sev_${f.normalizedSeverity}`, String(f.normalizedSeverity))}</span>
        </Pill>
        {f.blocking ? <Pill tone="red">{t("vres_blocking")}</Pill> : null}
        {informational ? <Pill tone="blue">{t("vres_informational_pill")}</Pill> : null}
        {isReviewFinding(f) ? <Pill tone="blue">{t("vres_review_pill")}</Pill> : null}
        {f.waived ? <Pill tone="blue">{t(f.review === true ? "vres_reviewed" : "vres_waived")}</Pill> : null}
        {f.baselineState ? <Pill>{f.baselineState === "new" ? t("vres_baseline_new") : t("vres_baseline_unchanged")}</Pill> : null}
      </div>
      <p className="res-finding-message" data-testid="finding-message">{f.message}</p>
      {informational ? (
        <p className="small" data-testid="finding-informational-note">
          {t("vres_informational_note")}
        </p>
      ) : null}
      {requirements.length > 0 ? (
        <p className="small res-requirements" data-testid="finding-requirements">
          <span className="muted">{t("vres_requirements_intro")}</span>{" "}
          {requirements.map((id) => (
            <a key={id} className="pill" href={`#/validations/coverage/asvs?requirement=${encodeURIComponent(id)}`} data-testid="finding-requirement" data-requirement={id} aria-label={t("vres_requirement_open", { id })}>
              {t("vres_requirement_label", { id })}
            </a>
          ))}
        </p>
      ) : null}
      <dl className="res-card-facts">
        <div>
          <dt>{t("vres_finding_tool")}</dt>
          <dd data-testid="finding-tool">{f.origin ?? f.tool}</dd>
        </div>
        <div>
          <dt>{t("vres_col_rule")}</dt>
          <dd>
            <code data-testid="finding-rule">{f.ruleId}</code>
          </dd>
        </div>
        {loc ? (
          <div>
            <dt>{t("vres_col_location")}</dt>
            <dd>
              {href ? (
                <a href={href} data-testid="finding-location" data-file={f.location.path} data-line={f.location.line ?? ""} aria-label={t("vres_open_at_line", { location: loc })}>
                  <code>{loc}</code>
                </a>
              ) : (
                <code data-testid="finding-location">{loc}</code>
              )}
            </dd>
          </div>
        ) : null}
      </dl>
      {f.waived ? (
        <p className="small" data-testid="finding-waiver">
          <strong>{t(f.review === true ? "vres_reviewed" : "vres_waived")}</strong>
          {f.waiverSource ? ` · ${tOr(`vres_waiver_source_${f.waiverSource}`, String(f.waiverSource))}` : ""}
          {f.waiverReason ? ` · ${t("vres_waiver_reason", { reason: String(f.waiverReason) })}` : ""}
          {f.waiverExpires ? ` · ${t("vres_waiver_until", { date: String(f.waiverExpires) })}` : ` · ${t("vres_waiver_no_date")}`}
        </p>
      ) : null}
      {informational ? null : <WaiveBlock f={f} />}
      {f.remediation ? (
        <p className="small" data-testid="finding-remediation">
          <strong>{t("vres_finding_remediation")}:</strong> {f.remediation}
        </p>
      ) : null}
      {hasDetails ? (
        <details>
          <summary>{t("vres_finding_details")}</summary>
          <dl className="kv">
            {f.waived ? (
              <>
                <dt>{t("vres_finding_waiver")}</dt>
                <dd>{[f.waiverId, f.waiverReason].filter(Boolean).join(": ")}</dd>
                {f.waiverSource ? (
                  <>
                    <dt>{t("vres_waiver_origin")}</dt>
                    <dd>{tOr(`vres_waiver_source_${f.waiverSource}`, String(f.waiverSource))}</dd>
                  </>
                ) : null}
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
    </li>
  );
}

function Findings({ result, domainFilter, onClear, waivedOnly, onWaivedOnly }: { result: any; domainFilter: { domain: string; ids: string[] } | null; onClear: () => void; waivedOnly: boolean; onWaivedOnly: (on: boolean) => void }) {
  const findings = useReviewedFindings(result.findings ?? []);
  const [severity, setSeverity] = useState("");
  const [category, setCategory] = useState("");
  const [component, setComponent] = useState("");
  const [tool, setTool] = useState("");
  const severities = useMemo(() => [...new Set(findings.map((f) => String(f.normalizedSeverity)))], [findings]);
  const categories = useMemo(() => [...new Set(findings.map((f) => String(f.category ?? "")))], [findings]);
  const components = useMemo(() => [...new Set(findings.map((f) => String(f.component ?? "")).filter(Boolean))], [findings]);
  const tools = useMemo(() => [...new Set(findings.map((f) => String(f.origin ?? f.tool)))], [findings]);
  const shown = findings.filter(
    (f) =>
      (!domainFilter || domainFilter.ids.includes(f.stageId)) &&
      (!waivedOnly || f.waived === true) &&
      (!severity || String(f.normalizedSeverity) === severity) &&
      (!category || String(f.category ?? "") === category) &&
      (!component || String(f.component ?? "") === component) &&
      (!tool || String(f.origin ?? f.tool) === tool),
  );
  const blockingShown = shown.filter((f) => !isInformationalFinding(f) && !isReviewFinding(f));
  const informationalShown = shown.filter(isInformationalFinding);
  const reviewShown = shown.filter(isReviewFinding);
  return (
    <section className="stack" aria-labelledby="vres-findings">
      <h3 id="vres-findings">{t("vres_findings")}</h3>
      {domainFilter ? <p>{t(`mascot_domain_${domainFilter.domain}`)} <button className="btn" type="button" onClick={onClear}>{t("mascot_clear_filter")}</button></p> : null}
      {findings.length > 0 ? (
        <div className="row wrap" role="group" aria-label={t("vres_filters")}>
          <label className="row">
            <span className="muted">{t("vres_filter_severity")}</span>
            <select value={severity} onChange={(e) => setSeverity(e.target.value)} data-testid="filter-severity">
              <option value="">{t("vres_filter_all")}</option>
              {severities.map((s) => (
                <option key={s} value={s}>
                  {tOr(`vres_sev_${s}`, s)}
                </option>
              ))}
            </select>
          </label>
          <label className="row">
            <span className="muted">{t("vres_filter_tool")}</span>
            <select value={tool} onChange={(e) => setTool(e.target.value)} data-testid="filter-tool">
              <option value="">{t("vres_filter_all")}</option>
              {tools.map((x) => (
                <option key={x} value={x}>
                  {x}
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
          {findings.some((f) => f.waived === true) ? (
            <label className="row">
              <input type="checkbox" checked={waivedOnly} onChange={(e) => onWaivedOnly(e.target.checked)} data-testid="filter-waived" />
              <span>{t("vres_filter_waived")}</span>
            </label>
          ) : null}
          <span className="muted" role="status" data-testid="filter-count">
            {t("vres_filter_count", { shown: shown.length, total: findings.length })}
          </span>
        </div>
      ) : null}
      {findings.length === 0 ? (
        <p>{t("vres_findings_empty")}</p>
      ) : shown.length === 0 ? (
        <p>{t("vres_findings_none_filtered")}</p>
      ) : (
        <>
          {blockingShown.length > 0 ? (
            <section className="stack">
            <h4>{t("vres_other_findings")}</h4>
            <ul className="res-cards" aria-label={t("vres_findings")} data-testid="finding-cards">
              {blockingShown.map((f, i) => (
                <FindingCard key={`${f.fingerprint ?? f.ruleId}:${i}`} f={f} workspacePath={result.workspace?.path} />
              ))}
            </ul>
            </section>
          ) : null}
          {informationalShown.length > 0 ? (
            <section className="stack" aria-labelledby="vres-informational" data-testid="informational-findings">
              <h4 id="vres-informational">{t("vres_informational_title", { count: informationalShown.length })}</h4>
              <p className="muted small">{t("vres_informational_lead")}</p>
              <ul className="res-cards" aria-label={t("vres_informational_list")} data-testid="informational-cards">
                {informationalShown.map((f, i) => (
                  <FindingCard key={`${f.fingerprint ?? f.ruleId}:${i}`} f={f} workspacePath={result.workspace?.path} />
                ))}
              </ul>
            </section>
          ) : null}
          {reviewShown.length > 0 ? (
            <section className="stack" aria-labelledby="vres-review" data-testid="review-findings">
              <h4 id="vres-review">{t("vres_review_title", { count: reviewShown.length })}</h4>
              <p className="muted small">{t("vres_review_lead")}</p>
              <ul className="res-cards" aria-label={t("vres_review_list")} data-testid="review-cards">
                {reviewShown.map((f, i) => (
                  <FindingCard key={`${f.fingerprint ?? f.ruleId}:${i}`} f={f} workspacePath={result.workspace?.path} />
                ))}
              </ul>
            </section>
          ) : null}
        </>
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
        <ul style={{ overflowWrap: "anywhere" }}>
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

/** Where the result came from besides the project: the tools image, the age of the security data, the dependencies and the services. */
function Provenance({ result }: { result: any }) {
  const p = result.provenance;
  const c = p?.container;
  if (!c) return null;
  const started = Date.parse(result.startedAt ?? "");
  const dataEntries = Object.entries((c.dataTimestamps ?? {}) as Record<string, string | null>);
  const dependencyKeys = Object.entries((c.dependencyKeys ?? {}) as Record<string, string>);
  const extensions = (c.extensionImages ?? []) as Array<{ name: string; digest: string }>;
  const services = (c.services ?? []) as string[];
  const short = (digest: string): string => digest.replace("sha256:", "").slice(0, 12);
  const age = (iso: string | null): string => {
    const at = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(at) || !Number.isFinite(started)) return t("vres_prov_never");
    const days = Math.max(0, Math.floor((started - at) / 86_400_000));
    return days === 0 ? t("vres_prov_today") : t("vres_prov_days", { days });
  };
  return (
    <section className="stack" aria-labelledby="vres-prov" data-testid="provenance">
      <h3 id="vres-prov">{t("vres_prov_title")}</h3>
      <p className="muted small">{t("vres_prov_lead")}</p>
      <dl className="kv">
        <dt>{t("vres_prov_version")}</dt>
        <dd data-testid="prov-version">{p.producerVersion ?? "-"}</dd>
        <dt>{t("vres_prov_image")}</dt>
        <dd data-testid="prov-image">{c.toolsImage ? <code title={c.toolsImage}>{short(c.toolsImage)}</code> : t("vres_prov_none")}</dd>
        {extensions.length > 0 ? (
          <>
            <dt>{t("vres_prov_extension")}</dt>
            <dd data-testid="prov-extension">
              {extensions.map((e) => (
                <div key={e.name}>
                  <code>{e.name}</code> <code title={e.digest}>{short(e.digest)}</code>
                </div>
              ))}
            </dd>
          </>
        ) : null}
        <dt>{t("vres_prov_data")}</dt>
        <dd data-testid="prov-data">
          {dataEntries.length === 0
            ? t("vres_prov_none")
            : dataEntries.map(([name, iso]) => (
                <div key={name} data-database={name}>
                  <code>{name}</code>: {age(iso)}
                </div>
              ))}
        </dd>
        <dt>{t("vres_prov_dependencies")}</dt>
        <dd data-testid="prov-dependencies">
          {dependencyKeys.length === 0
            ? t("vres_prov_none")
            : dependencyKeys.map(([component, key]) => (
                <div key={component} data-component={component}>
                  <strong>{component}</strong>: <code title={key}>{key.replace("sha256:", "").slice(0, 12)}</code>
                </div>
              ))}
        </dd>
        <dt>{t("vres_prov_services")}</dt>
        <dd data-testid="prov-services">{services.length === 0 ? t("vres_prov_none") : services.join(", ")}</dd>
      </dl>
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
        <button type="button" className="btn" onClick={copyAgent}>
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
export type DomainFilter = { domain: string; ids: string[] };
export function ResultView({ result, previous, crashed = false, compact = false, mascots, selectedDomain, onClearDomain }: { result: any; previous: any; crashed?: boolean; /** On the run page, whose own step table lists the checks, they are not listed twice. */ compact?: boolean; mascots?: MascotSnapshot; selectedDomain?: DomainFilter | null; onClearDomain?: () => void }) {
  const [localDomain, setDomainFilter] = useState<DomainFilter | null>(null);
  const [waivedOnly, setWaivedOnly] = useState(false);
  const showWaived = () => {
    setWaivedOnly(true);
    setTimeout(() => document.getElementById("vres-findings")?.scrollIntoView({ block: "start" }), 0);
  };
  const domainFilter = selectedDomain === undefined ? localDomain : selectedDomain;
  const started = Date.parse(result.startedAt ?? "");
  const finished = Date.parse(result.finishedAt ?? "");
  const duration = Number.isFinite(started) && Number.isFinite(finished) ? finished - started : undefined;
  const git = result.analyzed?.git;
  return (
    <WaiveProvider result={result}>
    <section className="stack" aria-labelledby="result-title">
      <h2 id="result-title">{t("vres_title")}</h2>
      <Banner result={result} crashed={crashed} onShowWaived={showWaived} />
      <WaiveSummary result={result} />
      <QualityMascotStrip snapshot={mascots} onSelect={(domain, ids) => setDomainFilter({ domain, ids })} />
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
              <dd>{tOr(`vres_profile_${result.selection.profile.replace(/^builtin:/, "")}`, result.selection.profile.replace(/^builtin:/, ""))}</dd>
            </>
          ) : null}
          {result.selection?.scope ? (
            <>
              <dt>{t("vres_scope")}</dt>
              <dd>{tOr(`scope_${result.selection.scope}`, result.selection.scope)}</dd>
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
      {compact ? null : <Stages result={result} domainFilter={domainFilter} />}
      <Findings result={result} waivedOnly={waivedOnly} onWaivedOnly={setWaivedOnly} domainFilter={domainFilter} onClear={() => { setDomainFilter(null); onClearDomain?.(); }} />
      <Metrics result={result} />
      <Architecture result={result} />
      {compact ? (
        // On the run page what is only occasionally needed stays folded; the provenance and the findings stay in view.
        <details className="res-more" data-testid="result-more">
          <summary>{t("vres_more")}</summary>
          <div className="stack">
            <Disabled result={result} />
            <WorkspaceFiles result={result} />
            <Policy previous={previous} result={result} />
            <Link result={result} />
          </div>
        </details>
      ) : (
        <>
          <Disabled result={result} />
          <WorkspaceFiles result={result} />
          <Policy previous={previous} result={result} />
        </>
      )}
      <Provenance result={result} />
      {compact ? null : <Link result={result} />}
    </section>
    </WaiveProvider>
  );
}
