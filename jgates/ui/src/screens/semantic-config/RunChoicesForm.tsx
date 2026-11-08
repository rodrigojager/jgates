import { t, tOr } from "../../i18n";
import type { Purpose, Rigor, RunChoices } from "../semantic-setup/choices";

/** GET /api/semantic/options (server/routes/semantic-views.ts). */
export interface SemanticOptions {
  purpose: Purpose;
  purposes: Purpose[];
  rigors: Array<{ id: Rigor; reserve: number; defaultCalls: number }>;
  methods: Array<{ id: string }>;
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

/** The run-only choices (purpose, rigor, budget, context limits), shared by this screen and the setup screen. */
export function RunChoicesForm({ options, choices, onChange }: { options: SemanticOptions; choices: RunChoices; onChange: (next: RunChoices) => void }) {
  const set = (patch: Partial<RunChoices>) => onChange({ ...choices, ...patch });
  const limits = options.controls.context.limits;
  const rigor = options.rigors.find((r) => r.id === choices.rigor);
  return (
    <div className="stack">
      <fieldset className="stack" style={{ gap: 8, border: 0, padding: 0, margin: 0 }}>
        <legend>
          <strong>{t("semcfg_purpose")}</strong>
        </legend>
        {options.purposes.map((p) => (
          <label key={p} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
            <input type="radio" name="semcfg-purpose" value={p} checked={choices.purpose === p} onChange={() => set({ purpose: p })} />
            <span>
              <strong>{tOr(`semres_purpose_${p}`, p)}</strong>
              <span className="muted small"> · {t(`semcfg_purpose_${p}_hint`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
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
