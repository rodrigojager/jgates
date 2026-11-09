import { useState, type ReactNode } from "react";
import { api } from "../../api";
import { navigate } from "../../app/route";
import { ErrorNotice, Loading, Pill, Spinner, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { RunChoicesForm, methodLabel, type MethodApplicability, type SemanticOptions } from "../semantic-config/RunChoicesForm";
import { problemsOf, readChoices, readScope, requestBody, writeChoices, writeScope, type RunChoices, type ScopeChoices, type ScopeMode } from "./choices";
import "./setup.css";

export const screen: ScreenMeta = { id: "semantic-setup", path: "/semantic/setup", area: "semantic", navLabel: "semsetup_nav", navPath: "/semantic/setup", order: 52, icon: "play" };

type Step = "scope" | "choices" | "preview";
const STEPS: Step[] = ["scope", "choices", "preview"];
const MODES: ScopeMode[] = ["full", "selected", "incremental"];

interface Reason {
  code: string;
  message: string;
  via?: string;
}

/** POST /api/semantic/scope/preview: the plan a run with these choices would get, nothing started. */
interface Preview {
  methods?: Array<{ id: string; title: string; available: boolean; selectedBy: "purpose" | "explicit"; applicability: MethodApplicability }>;
  methodSelection?: "purpose" | "explicit";
  rigor: string;
  budget: { maxCalls?: number | null; maxTokens?: number | null } | null;
  resolution: {
    mode: ScopeMode;
    subjects: Array<{ path: string; change: string; disposition: "examine" | "reused"; reasons: Reason[] }>;
    context: Array<{ path: string; relation: string; depth: number; bytes: number; reasons: Reason[] }>;
    impact: { unknowns: Array<{ code: string; path: string; message: string }>; recommendedExpansion: Array<{ path: string; reasons: Reason[] }> };
    exclusions: { patterns: string[]; excluded: Array<{ path: string; reason: Reason }> };
    reuse: { baselineRunId: string | null; reused: Array<{ id: string; reasons: Reason[] }>; invalidated: Array<{ id: string; reasons: Reason[] }>; notCarried: Array<{ id: string; reasons: Reason[] }> };
    inheritedCoverage: { state: string; message: string };
    completion: { repositoryFiles: number; subjects: number; toExamine: number; reused: number; context: number; excluded: number; claim: string };
    warnings: Array<{ code: string; message: string }>;
  };
  ready: boolean;
  blockers: Array<{ code: string; message: string }>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="stack" style={{ gap: 4 }}>
      <span>{label}</span>
      {children}
      {hint ? <span className="small muted">{hint}</span> : null}
    </label>
  );
}

function PreviewList({ id, title, count, children }: { id: string; title: string; count: number; children: ReactNode }) {
  return (
    <section className="card flat stack" aria-labelledby={id} data-testid={id} data-count={count}>
      <div className="between">
        <h3 id={id}>{title}</h3>
        <strong>{count}</strong>
      </div>
      {children}
    </section>
  );
}

const reasonText = (reasons: Reason[]): string => reasons.map((r) => (r.via ? `${r.message} (${r.via})` : r.message)).join("; ");

function ScopeStep({ scope, onChange }: { scope: ScopeChoices; onChange: (next: ScopeChoices) => void }) {
  const set = (patch: Partial<ScopeChoices>) => onChange({ ...scope, ...patch });
  return (
    <section className="card flat stack" aria-labelledby="semsetup-scope">
      <h2 id="semsetup-scope">{t("semsetup_scope_title")}</h2>
      <div role="radiogroup" aria-labelledby="semsetup-scope" className="stack" style={{ gap: 8 }}>
        {MODES.map((mode) => (
          <label key={mode} className="row" style={{ gap: 8, alignItems: "flex-start" }} data-mode={mode}>
            <input type="radio" name="semsetup-mode" value={mode} checked={scope.mode === mode} onChange={() => set({ mode })} />
            <span>
              <strong>{t(`semsetup_mode_${mode}`)}</strong>
              {mode === "full" ? (
                <>
                  {" "}
                  <Pill tone="green">{t("semsetup_recommended")}</Pill>
                </>
              ) : null}
              <span className="muted small"> · {t(`semsetup_mode_${mode}_hint`)}</span>
            </span>
          </label>
        ))}
      </div>
      {scope.mode === "selected" ? (
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <Field label={t("semsetup_subjects")} hint={t("semsetup_one_per_line")}>
            <textarea rows={4} value={scope.subjects} onChange={(e) => set({ subjects: e.target.value })} placeholder="src/core" />
          </Field>
          <Field label={t("semsetup_subsystems")} hint={t("semsetup_subsystems_hint")}>
            <textarea rows={4} value={scope.subsystems} onChange={(e) => set({ subsystems: e.target.value })} />
          </Field>
        </div>
      ) : null}
      {scope.mode === "incremental" ? (
        <div className="stack" style={{ gap: 8 }}>
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
            <Field label={t("semsetup_base")} hint={t("semsetup_base_hint")}>
              <input value={scope.base} onChange={(e) => set({ base: e.target.value })} placeholder="main" />
            </Field>
            <Field label={t("semsetup_target")} hint={t("semsetup_target_hint")}>
              <input value={scope.target} onChange={(e) => set({ target: e.target.value })} placeholder="HEAD" />
            </Field>
          </div>
          <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
            <legend>{t("semsetup_dirty")}</legend>
            {(["none", "all", "paths"] as const).map((d) => (
              <label key={d} className="row" style={{ gap: 8 }}>
                <input type="radio" name="semsetup-dirty" value={d} checked={scope.dirty === d} onChange={() => set({ dirty: d })} />
                <span>{t(`semsetup_dirty_${d}`)}</span>
              </label>
            ))}
            {scope.dirty === "paths" ? <textarea rows={3} aria-label={t("semsetup_dirty_paths")} value={scope.dirtyPaths} onChange={(e) => set({ dirtyPaths: e.target.value })} /> : null}
          </fieldset>
        </div>
      ) : null}
      <Field label={t("semsetup_exclusions")} hint={t("semsetup_exclusions_hint")}>
        <textarea rows={2} value={scope.exclusions} onChange={(e) => set({ exclusions: e.target.value })} placeholder="**/fixtures/**" />
      </Field>
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={scope.baseline} onChange={(e) => set({ baseline: e.target.checked })} />
        <span>
          {t("semsetup_baseline")}
          <span className="muted small"> · {t("semsetup_baseline_hint")}</span>
        </span>
      </label>
    </section>
  );
}

function PreviewStep({ preview, options, choices }: { preview: Preview; options: SemanticOptions; choices: RunChoices }) {
  const r = preview.resolution;
  const rigor = options.rigors.find((x) => x.id === choices.rigor);
  const calls = preview.budget?.maxCalls ?? rigor?.defaultCalls ?? options.settings.limits?.maxCalls ?? 0;
  const reserved = rigor ? Math.ceil(calls * rigor.reserve) : 0;
  const cost = options.settings.costPerCall !== null ? calls * options.settings.costPerCall : null;
  const contextBytes = r.context.reduce((sum, c) => sum + c.bytes, 0);
  const gaps = r.impact.unknowns.length + r.impact.recommendedExpansion.length + r.warnings.length;
  return (
    <div className="stack" data-testid="semsetup-preview">
      {preview.blockers.length > 0 ? (
        <div className="notice error" role="alert" data-testid="semsetup-blockers">
          <Icon name="alert" />
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {preview.blockers.map((b) => (
              <li key={b.code}>{b.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <section className="card flat stack" aria-labelledby="semsetup-estimates">
        <h2 id="semsetup-estimates">{t("semsetup_estimates_title")}</h2>
        <dl className="kv" data-testid="semsetup-estimates">
          <dt>{t("semsetup_est_to_examine")}</dt>
          <dd>{t("semsetup_est_to_examine_value", { examine: r.completion.toExamine, subjects: r.completion.subjects, files: r.completion.repositoryFiles })}</dd>
          <dt>{t("semsetup_est_context")}</dt>
          <dd>{t("semsetup_est_context_value", { files: r.context.length, kb: Math.round(contextBytes / 1024) })}</dd>
          <dt>{t("semsetup_est_calls")}</dt>
          <dd>{calls}</dd>
          <dt>{t("semsetup_est_reserve")}</dt>
          <dd data-testid="semsetup-reserve">{rigor ? t("semsetup_est_reserve_value", { calls: reserved, percent: Math.round(rigor.reserve * 100) }) : "-"}</dd>
          <dt>{t("semsetup_est_cost")}</dt>
          <dd>{cost !== null ? String(cost) : t("semres_usage_cost_unreported")}</dd>
        </dl>
        {r.completion.claim === "scope-only" ? <p className="small muted">{t("semres_claim_scope_only")}</p> : null}
      </section>
      {preview.methods && preview.methods.length > 0 ? (
        <section className="card flat stack" aria-labelledby="semsetup-methods" data-testid="semsetup-methods">
          <h2 id="semsetup-methods">{t("semsetup_pv_methods")}</h2>
          {preview.methods.length > 1 ? <p className="small muted">{t("semsetup_pv_methods_separate")}</p> : null}
          <ul className="small sem-method-list">
            {preview.methods.map((m) => (
              <li key={m.id} data-method={m.id} data-applicability={m.applicability.state}>
                <strong>{methodLabel(m)}</strong> <code>{m.id}</code>{" "}
                <Pill tone={m.applicability.state === "not-applicable" || m.applicability.state === "error" ? "gold" : m.applicability.state === "unchecked" ? "blue" : "green"}>{t(`semsetup_applicability_${m.applicability.state}`)}</Pill>
                {m.applicability.reason ? <span className="muted"> · {m.applicability.reason}</span> : null}
              </li>
            ))}
          </ul>
          {preview.methods.some((m) => m.applicability.state === "not-applicable") ? <p className="small muted">{t("semsetup_pv_not_applicable_hint")}</p> : null}
        </section>
      ) : null}
      <div className="sem-preview-grid">
        <PreviewList id="semsetup-subjects" title={t("semsetup_pv_subjects")} count={r.subjects.length}>
          <ul className="small">
            {r.subjects.slice(0, 200).map((s) => (
              <li key={s.path} data-disposition={s.disposition}>
                <code>{s.path}</code> <span className="muted">· {tOr(`semsetup_disposition_${s.disposition}`, s.disposition)}{s.change !== "unchanged" ? ` · ${s.change}` : ""}</span>
              </li>
            ))}
          </ul>
        </PreviewList>
        <PreviewList id="semsetup-context" title={t("semsetup_pv_context")} count={r.context.length}>
          {r.context.length === 0 ? <p className="small muted">{t("semsetup_pv_none")}</p> : null}
          <ul className="small">
            {r.context.slice(0, 200).map((c) => (
              <li key={c.path}>
                <code>{c.path}</code> <span className="muted">· {reasonText(c.reasons) || c.relation}</span>
              </li>
            ))}
          </ul>
        </PreviewList>
        <PreviewList id="semsetup-exclusions" title={t("semsetup_pv_exclusions")} count={r.exclusions.excluded.length}>
          {r.exclusions.excluded.length === 0 ? <p className="small muted">{t("semsetup_pv_none")}</p> : null}
          <ul className="small">
            {r.exclusions.excluded.slice(0, 200).map((e) => (
              <li key={e.path}>
                <code>{e.path}</code> <span className="muted">· {e.reason.message}</span>
              </li>
            ))}
          </ul>
        </PreviewList>
        <PreviewList id="semsetup-reuse" title={t("semsetup_pv_reuse")} count={r.reuse.reused.length}>
          <p className="small">{t("semsetup_pv_reuse_value", { reused: r.reuse.reused.length, invalidated: r.reuse.invalidated.length, notCarried: r.reuse.notCarried.length })}</p>
          <p className="small muted">{r.inheritedCoverage.message}</p>
        </PreviewList>
        <PreviewList id="semsetup-gaps" title={t("semsetup_pv_gaps")} count={gaps}>
          {gaps === 0 ? <p className="small muted">{t("semsetup_pv_none")}</p> : null}
          <ul className="small">
            {r.impact.unknowns.slice(0, 100).map((u) => (
              <li key={`${u.code}:${u.path}`}>
                <code>{u.path}</code> <span className="muted">· {u.message}</span>
              </li>
            ))}
            {r.impact.recommendedExpansion.slice(0, 100).map((x) => (
              <li key={`exp:${x.path}`}>
                {t("semsetup_pv_recommended")} <code>{x.path}</code> <span className="muted">· {reasonText(x.reasons)}</span>
              </li>
            ))}
            {r.warnings.map((w) => (
              <li key={`w:${w.code}`}>{w.message}</li>
            ))}
          </ul>
        </PreviewList>
      </div>
    </div>
  );
}

/** Setup of a Semantic run: the scope, the run-only choices, then the impact and context preview before starting. */
export default function SemanticSetupScreen() {
  const [step, setStep] = useState<Step>("scope");
  const [scope, setScope] = useState<ScopeChoices>(() => readScope());
  const [choices, setChoices] = useState<RunChoices>(() => readChoices());
  const [attachQuality, setAttachQuality] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<"preview" | "start" | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const options = useAsync(() => api<SemanticOptions>("GET", "/api/semantic/options"), "semantic-options");
  const problems = problemsOf(choices, scope);

  async function showPreview() {
    setBusy("preview");
    setFailure(null);
    try {
      writeScope(scope);
      writeChoices(choices);
      setPreview(await api<Preview>("POST", "/api/semantic/scope/preview", requestBody(choices, scope)));
      setStep("preview");
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(null);
    }
  }

  async function start() {
    setBusy("start");
    setFailure(null);
    try {
      const body = { ...requestBody(choices, scope), ...(attachQuality ? { quality: "latest" } : {}) };
      const started = await api<{ run: { runId: string } }>("POST", "/api/semantic/runs", body);
      navigate(`/semantic/runs/${encodeURIComponent(started.run.runId)}`);
    } catch (e) {
      setFailure(e);
      setBusy(null);
    }
  }

  const go = (next: Step) => {
    if (next === "preview") void showPreview();
    else setStep(next);
  };

  return (
    <div className="stack">
      <div>
        <div className="crumbs">
          <a href="#/semantic">{t("semsetup_back")}</a>
        </div>
        <h1>{t("semsetup_title")}</h1>
        <p>{t("semsetup_lead")}</p>
      </div>
      <nav aria-label={t("semsetup_steps")}>
        <ol className="sem-steps">
          {STEPS.map((s) => (
            <li key={s}>
              <button type="button" onClick={() => go(s)} disabled={busy !== null || (s === "preview" && problems.length > 0)} {...(step === s ? { "aria-current": "step" as const } : {})}>
                {t(`semsetup_step_${s}`)}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      {options.loading && !options.data ? <Loading /> : null}
      {options.error ? <ErrorNotice error={options.error} onRetry={options.reload} /> : null}
      {failure ? <ErrorNotice error={failure} /> : null}
      {problems.filter((p) => !(step === "choices" && p === "semsetup_problem_methods")).length > 0 && step !== "preview" ? (
        <div className="notice warn" role="status">
          <Icon name="alert" />
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {problems.filter((p) => !(step === "choices" && p === "semsetup_problem_methods")).map((p) => (
              <li key={p}>{t(p)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {step === "scope" ? <ScopeStep scope={scope} onChange={(next) => { setScope(next); setPreview(null); }} /> : null}
      {step === "choices" && options.data ? (
        <section className="card flat stack" aria-labelledby="semsetup-choices">
          <div className="between wrap">
            <h2 id="semsetup-choices">{t("semsetup_choices_title")}</h2>
            <Pill tone="blue">{t("semcfg_run_badge")}</Pill>
          </div>
          <RunChoicesForm options={options.data} choices={choices} onChange={(next) => { setChoices(next); setPreview(null); }} />
          {options.data.latestQualityRun ? (
            <label className="row" style={{ gap: 8 }}>
              <input type="checkbox" checked={attachQuality} onChange={(e) => setAttachQuality(e.target.checked)} />
              <span>
                {t("semsetup_attach_quality", { runId: options.data.latestQualityRun })}
                <span className="muted small"> · {t("semsetup_attach_quality_hint")}</span>
              </span>
            </label>
          ) : null}
        </section>
      ) : null}
      {step === "preview" && preview && options.data ? <PreviewStep preview={preview} options={options.data} choices={choices} /> : null}
      <div className="row wrap">
        {step !== "scope" ? (
          <button type="button" className="btn" onClick={() => setStep(step === "preview" ? "choices" : "scope")} disabled={busy !== null}>
            {t("semsetup_previous")}
          </button>
        ) : null}
        {step === "scope" ? (
          <button type="button" className="btn primary" onClick={() => setStep("choices")}>
            {t("semsetup_next")}
          </button>
        ) : null}
        {step === "choices" ? (
          <button type="button" className="btn primary" onClick={() => void showPreview()} disabled={busy !== null || problems.length > 0} data-testid="semsetup-show-preview">
            {busy === "preview" ? <Spinner /> : <Icon name="plan" />}
            {t("semsetup_show_preview")}
          </button>
        ) : null}
        {step === "preview" && preview ? (
          <button type="button" className="btn primary" onClick={() => void start()} disabled={busy !== null || !preview.ready} data-testid="semsetup-start">
            {busy === "start" ? <Spinner /> : <Icon name="play" />}
            {t("semsetup_start")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
