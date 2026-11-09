import { t, tOr } from "../../i18n";
import type { Rigor, RunChoices } from "../semantic-setup/choices";

/** One selectable method of the catalog (core/semantic semanticMethodCatalog). */
export interface SemanticMethodInfo {
  id: string;
  title: string;
  available: boolean;
  reason: string | null;
  checksApplicability: boolean;
}

/** The applicability preview of a planned method (the run checks it again before any context starts). */
export interface MethodApplicability {
  state: "applicable" | "not-applicable" | "always" | "unchecked" | "error";
  code?: string;
  missing?: string;
  reason?: string;
}

/** The label of a method: the UI catalog's, or the title the server gave. */
export const methodLabel = (m: { id: string; title?: string }): string => tOr(`semcfg_method_${m.id}`, m.title ?? m.id);

/** The methods selector, the one choice of what to run: at least one; each checked one runs as its own semantic run. */
export function MethodsField({ catalog, selected, onChange }: { catalog: SemanticMethodInfo[]; selected: string[]; onChange: (next: string[]) => void }) {
  const toggle = (id: string, on: boolean) => onChange(on ? [...selected.filter((m) => m !== id), id] : selected.filter((m) => m !== id));
  return (
    <fieldset className="stack" style={{ gap: 8, border: 0, padding: 0, margin: 0 }} data-testid="semcfg-methods" {...(selected.length === 0 ? { "aria-describedby": "semcfg-methods-error" } : {})}>
      <legend>
        <strong>{t("semcfg_methods")}</strong>
      </legend>
      {selected.length === 0 ? (
        <div className="notice error" id="semcfg-methods-error" role="alert" data-testid="semcfg-methods-error">
          {t("semcfg_methods_none")}
        </div>
      ) : (
        <p className="small muted">{t("semcfg_methods_selected", { count: selected.length })}</p>
      )}
      {catalog.map((m) => (
        <label key={m.id} className="row" style={{ gap: 8, alignItems: "flex-start" }} data-method={m.id}>
          <input type="checkbox" value={m.id} checked={selected.includes(m.id)} disabled={!m.available && !selected.includes(m.id)} onChange={(e) => toggle(m.id, e.target.checked)} />
          <span>
            <strong>{methodLabel(m)}</strong> <code className="small">{m.id}</code>
            <span className="muted small"> · {tOr(`semcfg_method_${m.id}_hint`, m.title)}</span>
            {m.checksApplicability ? <span className="muted small"> · {t("semcfg_method_checks_applicability")}</span> : null}
            {!m.available ? <span className="small"> · {t("semcfg_method_unavailable", { reason: m.reason ?? "-" })}</span> : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** GET /api/semantic/options (server/routes/semantic-views.ts). */
export interface SemanticOptions {
  rigors: Array<{ id: Rigor; reserve: number; defaultCalls: number }>;
  methods: Array<{ id: string }>;
  /** Every method this build knows, for an explicit selection. */
  catalog: SemanticMethodInfo[];
  settings: {
    state: "off" | "configured" | "invalid";
    provider: string | null;
    model: string | null;
    scope: string | null;
    limits: { timeoutSeconds: number; maxContextChars: number; maxCalls: number } | null;
    costPerCall: number | null;
    problems: string[];
  };
  controls: { context: { limits: { maxFiles: { default: number }; maxDepth: { default: number }; maxBytes: { default: number } } } };
  prerequisites: Array<{ id: string; ok: boolean; required: boolean; message: string }>;
  ready: boolean;
  blockers: Array<{ code: string; message: string }>;
  latestQualityRun: string | null;
}

/** A number field of the run-only choices; empty means "the saved or default limit". */
export function NumberField({ label, hint, value, placeholder, onChange, testId }: { label: string; hint?: string; value: string; placeholder: string; onChange: (v: string) => void; testId?: string }) {
  return (
    <label className="stack" style={{ gap: 4 }}>
      <span>{label}</span>
      <input inputMode="numeric" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} {...(testId ? { "data-testid": testId } : {})} />
      {hint ? <span className="small muted">{hint}</span> : null}
    </label>
  );
}

/** The run-only choices (methods, rigor, budget, context limits), shared by this screen and the setup screen. */
export function RunChoicesForm({ options, choices, onChange }: { options: SemanticOptions; choices: RunChoices; onChange: (next: RunChoices) => void }) {
  const set = (patch: Partial<RunChoices>) => onChange({ ...choices, ...patch });
  const limits = options.controls.context.limits;
  const rigor = options.rigors.find((r) => r.id === choices.rigor);
  return (
    <div className="stack">
      {options.catalog ? <MethodsField catalog={options.catalog} selected={choices.methods} onChange={(methods) => set({ methods })} /> : null}
      <fieldset className="stack" style={{ gap: 8, border: 0, padding: 0, margin: 0 }}>
        <legend>
          <strong>{t("semcfg_rigor")}</strong>
        </legend>
        {options.rigors.map((r) => (
          <label key={r.id} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
            <input type="radio" name="semcfg-rigor" value={r.id} checked={choices.rigor === r.id} onChange={() => set({ rigor: r.id })} />
            <span>
              <strong>{tOr(`semres_rigor_${r.id}`, r.id)}</strong>
              <span className="muted small"> · {t("semcfg_rigor_hint", { reserve: Math.round(r.reserve * 100), calls: r.defaultCalls })}</span>
            </span>
          </label>
        ))}
        <p className="small muted">{t("semcfg_rigor_independent")}</p>
      </fieldset>
      <div className="stack" style={{ gap: 8 }}>
        <strong>{t("semcfg_budget")}</strong>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
          <NumberField label={t("semcfg_max_calls")} value={choices.maxCalls} placeholder={String(rigor?.defaultCalls ?? options.settings.limits?.maxCalls ?? "")} onChange={(maxCalls) => set({ maxCalls })} hint={t("semcfg_max_calls_hint")} testId="semcfg-max-calls" />
          <NumberField label={t("semcfg_max_tokens")} value={choices.maxTokens} placeholder={t("semcfg_no_limit")} onChange={(maxTokens) => set({ maxTokens })} />
        </div>
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <strong>{t("semcfg_context")}</strong>
        <div role="radiogroup" aria-label={t("semcfg_context_policy")} className="row wrap" style={{ gap: 16 }}>
          {(["strict", "bounded"] as const).map((policy) => (
            <label key={policy} className="row" style={{ gap: 8 }}>
              <input type="radio" name="semcfg-policy" value={policy} checked={choices.contextPolicy === policy} onChange={() => set({ contextPolicy: policy })} />
              <span>
                <strong>{t(`semcfg_policy_${policy}`)}</strong>
                <span className="muted small"> · {t(`semcfg_policy_${policy}_hint`)}</span>
              </span>
            </label>
          ))}
        </div>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
          <NumberField label={t("semcfg_max_files")} value={choices.maxFiles} placeholder={String(limits.maxFiles.default)} onChange={(maxFiles) => set({ maxFiles })} />
          <NumberField label={t("semcfg_max_depth")} value={choices.maxDepth} placeholder={String(limits.maxDepth.default)} onChange={(maxDepth) => set({ maxDepth })} />
          <NumberField label={t("semcfg_max_bytes")} value={choices.maxBytes} placeholder={String(limits.maxBytes.default)} onChange={(maxBytes) => set({ maxBytes })} />
        </div>
      </div>
    </div>
  );
}
