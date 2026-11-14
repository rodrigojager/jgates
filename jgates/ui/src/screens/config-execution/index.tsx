import { useState } from "react";
import { ApiError, api } from "../../api";
import { Dialog, ErrorNotice, Loading, Pill, Spinner, Updating, useAsync } from "../../components/common";
import { DiffView } from "../../components/DiffView";
import { Icon } from "../../components/icons";
import { LockedField } from "../../components/LockedField";
import { OriginLine, type OriginRef, type SaveTarget } from "../../components/origin";
import { useToast } from "../../components/Toast";
import { t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { ConfigDiagnostics, type ConfigDiagnostic } from "../config-profiles/diagnostics";
import "../../forms/derived/derived.css";
import "./config-execution.css";

// Configuração > Execução. Concurrency, network, fail-fast, advisory data age, extension images, trust and budgets: policy
// of the repository (execution.* in jgates.yml), never a personal preference. Every control edits a draft; one "Revisar e
// salvar" shows the diff of jgates.yml and writes all the changes at once. The retention of runs is per user and lives in
// Armazenamento.
export const screen: ScreenMeta = { id: "config-execution", path: "/config/execution", area: "config", navLabel: "cfe_nav", navPath: "/config/execution", order: 43, icon: "settings" };

type Value = string | number | boolean | null;

interface Field {
  key: string;
  kind: "enum" | "integer" | "boolean";
  options: string[] | null;
  presets: number[] | null;
  unit: "seconds" | "days" | "megabytes" | null;
  applied: boolean;
  value: Value;
  /** The value the engine uses when nothing is set. */
  default: Value;
  explicit: boolean;
  origin: OriginRef;
  saveTo: SaveTarget;
}

interface View {
  mode: "local" | "governed";
  governed: { policy: string } | null;
  revision: string | null;
  fields: Field[];
  /** Problems of the configuration files (file, key, line); the values above are what the files hold. */
  diagnostics?: ConfigDiagnostic[];
}

interface Preview {
  changed: boolean;
  diff: string;
}

const GROUPS: Array<{ id: string; keys: string[] }> = [
  { id: "run", keys: ["concurrency", "network", "failFast", "timeoutSeconds"] },
  { id: "ci", keys: ["dataMaxAgeDays", "extensionImage", "trustSelfReported"] },
  { id: "budgets", keys: ["budgets.totalSeconds", "budgets.memoryMegabytes", "budgets.processes", "budgets.logMegabytes"] },
];

const OTHER = "__other__";
const UNSET = "__unset__";

function amount(field: Field, n: number): string {
  if (field.unit === "seconds") return t("cfe_unit_seconds", { n });
  if (field.unit === "days") return t("cfe_unit_days", { n });
  if (field.unit === "megabytes") return t("cfe_unit_megabytes", { n });
  return String(n);
}

function show(field: Field, value: Value): string {
  if (value === null || value === undefined) return t(field.kind === "integer" ? "cfe_unset" : "cfe_unset_choice");
  if (field.kind === "boolean") return t(value ? "cfe_on" : "cfe_off");
  if (field.kind === "enum") return tOr(`cfe_opt_${field.key}_${value}`, String(value));
  return typeof value === "number" ? amount(field, value) : String(value);
}

function Switch({ id, labelId, helpId, checked, disabled, onChange }: { id: string; labelId: string; helpId: string; checked: boolean; disabled: boolean; onChange: (next: boolean) => void }) {
  return (
    <div className="row df-switch-row">
      <button id={id} type="button" role="switch" className="df-switch" aria-checked={checked} aria-labelledby={labelId} aria-describedby={helpId} disabled={disabled} onClick={() => onChange(!checked)}>
        <span className="df-switch-knob" aria-hidden="true" />
      </button>
      <span className="small" aria-hidden="true">
        {t(checked ? "cfe_on" : "cfe_off")}
      </span>
    </div>
  );
}

/** A duration, size or count: presets plus "Outro valor", and "Sem limite" where the setting has no default. */
function NumberControl({ field, id, labelId, helpId, label, value, disabled, onChange }: { field: Field; id: string; labelId: string; helpId: string; label: string; value: Value; disabled: boolean; onChange: (next: number | null) => void }) {
  const current = typeof value === "number" ? value : null;
  const presets = field.presets ?? [];
  const choices = current !== null && !presets.includes(current) ? [...presets, current].sort((a, b) => a - b) : presets;
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState(current === null ? "" : String(current));
  const problem = typing && text !== "" && !(Number.isInteger(Number(text)) && Number(text) >= 1) ? t("cfe_number_invalid") : null;
  const box = (
    <input
      id={presets.length > 0 ? `${id}-other` : id}
      type="number"
      inputMode="numeric"
      min={1}
      className="input number"
      value={text}
      disabled={disabled}
      autoFocus={presets.length > 0}
      aria-label={presets.length > 0 ? t("cfe_other_of", { name: label }) : undefined}
      aria-labelledby={presets.length > 0 ? undefined : labelId}
      aria-describedby={helpId}
      aria-invalid={problem ? true : undefined}
      data-free-text="number"
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && Number.isInteger(n) && n >= 1) onChange(n);
      }}
    />
  );
  if (presets.length === 0) {
    return (
      <div className="stack tight">
        {box}
        {problem ? (
          <span className="small field-problem" role="alert">
            {problem}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <div className="stack tight">
      <select
        id={id}
        className="input"
        value={typing ? OTHER : current === null ? UNSET : String(current)}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-describedby={helpId}
        onChange={(e) => {
          if (e.target.value === OTHER) {
            setText(current === null ? "" : String(current));
            return setTyping(true);
          }
          setTyping(false);
          onChange(e.target.value === UNSET ? null : Number(e.target.value));
        }}
      >
        {field.default === null ? <option value={UNSET}>{t("cfe_unset")}</option> : null}
        {choices.map((n) => (
          <option key={n} value={String(n)}>
            {amount(field, n)}
          </option>
        ))}
        <option value={OTHER}>{t("cfe_other_value")}</option>
      </select>
      {typing ? (
        <div className="row wrap">
          {box}
          <button type="button" className="btn" onClick={() => setTyping(false)}>
            {t("cfe_back_to_list")}
          </button>
        </div>
      ) : null}
      {problem ? (
        <span className="small field-problem" role="alert">
          {problem}
        </span>
      ) : null}
    </div>
  );
}

function Choice({ field, id, labelId, helpId, value, disabled, onChange }: { field: Field; id: string; labelId: string; helpId: string; value: Value; disabled: boolean; onChange: (next: string | null) => void }) {
  const options = [...(field.default === null ? [UNSET] : []), ...(field.options ?? [])];
  const text = (o: string) => (o === UNSET ? t("cfe_unset_choice") : tOr(`cfe_opt_${field.key}_${o}`, o));
  const chosen = value === null || value === undefined ? UNSET : String(value);
  return (
    <div className="row wrap df-radios" role="radiogroup" id={id} aria-labelledby={labelId} aria-describedby={helpId}>
      {options.map((o) => (
        <label key={o} className="row choice df-choice">
          <input type="radio" name={id} value={o} checked={chosen === o} disabled={disabled} onChange={() => onChange(o === UNSET ? null : o)} />
          {text(o)}
        </label>
      ))}
    </div>
  );
}

function FieldRow({ field, locked, draft, onChange }: { field: Field; locked: string | null; draft: Map<string, Value>; onChange: (field: Field, next: Value) => void }) {
  const label = t(`cfe_f_${field.key}`);
  const id = `cfe-${field.key}`;
  const labelId = `${id}-label`;
  const helpId = `${id}-help`;
  const pending = draft.has(field.key);
  const value = pending ? (draft.get(field.key) as Value) ?? field.default : field.value;
  if (locked) {
    return (
      <div data-field={field.key}>
        <LockedField label={label} value={show(field, field.value)} reason={locked} />
      </div>
    );
  }
  return (
    <div className={`field${pending ? " changed" : ""}`} data-field={field.key} data-pending={pending ? "true" : undefined} {...(field.applied ? {} : { "data-control-unavailable": t("cfe_not_applied") })}>
      <div className="row wrap">
        <label id={labelId} htmlFor={id} className="field-label">
          {label}
        </label>
        {pending ? <Pill tone="gold">{t("cfe_pending")}</Pill> : null}
        {!field.applied ? <Pill>{t("cfe_not_applied")}</Pill> : null}
      </div>
      <p className="small muted" id={helpId}>
        {t(`cfe_h_${field.key}`)}
      </p>
      {field.kind === "boolean" ? (
        <Switch id={id} labelId={labelId} helpId={helpId} checked={value === true} disabled={false} onChange={(next) => onChange(field, next)} />
      ) : field.kind === "enum" ? (
        <Choice field={field} id={id} labelId={labelId} helpId={helpId} value={value} disabled={false} onChange={(next) => onChange(field, next)} />
      ) : (
        <NumberControl key={`${field.key}:${String(field.value)}`} field={field} id={id} labelId={labelId} helpId={helpId} label={label} value={value} disabled={false} onChange={(next) => onChange(field, next)} />
      )}
      <div className="row wrap">
        {field.explicit && !pending && field.value !== field.default ? (
          <button type="button" className="btn" aria-label={t("cfe_reset_aria", { name: label })} onClick={() => onChange(field, null)}>
            {t("cfe_reset")}
          </button>
        ) : null}
      </div>
      <OriginLine origin={field.origin} saveTo={field.saveTo} />
    </div>
  );
}

export default function ConfigExecutionScreen() {
  const toast = useToast();
  const view = useAsync<View>(() => api("GET", "/api/config/execution"), "execution");
  const [draft, setDraft] = useState<Map<string, Value>>(new Map());
  const [review, setReview] = useState<{ preview: Preview | null; error: unknown; busy: boolean } | null>(null);

  if (view.error && !view.data) return <ErrorNotice error={view.error} onRetry={view.reload} />;
  if (!view.data) return <Loading />;
  const v = view.data;
  const locked = v.mode === "governed" ? t("cfe_governed_reason", { policy: v.governed?.policy ?? "" }) : null;

  // A change that brings a field back to what it already holds is no change.
  const change = (field: Field, next: Value) => {
    setDraft((prev) => {
      const map = new Map(prev);
      const same = next === null ? !field.explicit : next === field.value;
      if (same) map.delete(field.key);
      else map.set(field.key, next);
      return map;
    });
  };
  const changes = () => Object.fromEntries(draft);

  const openReview = async () => {
    setReview({ preview: null, error: null, busy: true });
    try {
      const preview = await api<Preview>("POST", "/api/config/execution/preview", { changes: changes() });
      setReview({ preview, error: null, busy: false });
    } catch (error) {
      setReview({ preview: null, error, busy: false });
    }
  };

  const save = async () => {
    setReview((r) => (r ? { ...r, busy: true, error: null } : r));
    try {
      // The answer is the same payload as the GET: the screen takes it instead of asking again.
      const answer = await api<View>("PUT", "/api/config/execution", { expectedRevision: v.revision, changes: changes() });
      toast(t("cfe_saved", { count: draft.size }), "ok");
      setDraft(new Map());
      setReview(null);
      if (answer?.fields) view.prime(answer);
      else view.reload();
    } catch (error) {
      setReview((r) => (r ? { ...r, busy: false, error } : r));
    }
  };

  const conflict = review?.error instanceof ApiError && (review.error.status === 409 || review.error.code === "REVISION_CONFLICT");

  return (
    <div className="stack" aria-busy={view.reloading}>
      <div>
        <h1>{t("cfe_title")}</h1>
        <p>{t("cfe_lead")}</p>
      </div>
      <Updating active={view.reloading} />
      {/* A key written by hand that the schema refuses (in any file): the values are still those the files hold. */}
      {(v.diagnostics ?? []).length > 0 ? <ConfigDiagnostics readable diagnostics={v.diagnostics ?? []} onRetry={view.reload} /> : null}
      {locked ? (
        <div className="notice warn" role="status" data-testid="governed-note">
          <Icon name="lock" />
          <p className="small">{locked}</p>
        </div>
      ) : null}

      {GROUPS.map((group) => (
        <section key={group.id} className="card pad stack" aria-labelledby={`cfe-${group.id}-title`}>
          <h2 id={`cfe-${group.id}-title`}>{t(`cfe_group_${group.id}`)}</h2>
          {group.id === "ci" ? <p className="small muted">{t("cfe_group_ci_lead")}</p> : null}
          {group.keys.map((key) => {
            const field = v.fields.find((f) => f.key === key);
            return field ? <FieldRow key={`${key}:${v.revision}`} field={field} locked={locked} draft={draft} onChange={change} /> : null;
          })}
        </section>
      ))}

      {!locked ? (
        <div className="row wrap cfe-actions" role="group" aria-label={t("cfe_actions")}>
          <button type="button" className="btn primary" disabled={draft.size === 0 || review !== null} title={draft.size === 0 ? t("nothing_changed") : undefined} onClick={() => void openReview()}>
            {t("cfe_review", { count: draft.size })}
          </button>
          <button type="button" className="btn" disabled={draft.size === 0} title={draft.size === 0 ? t("nothing_changed") : undefined} onClick={() => setDraft(new Map())}>
            {t("cfe_discard")}
          </button>
        </div>
      ) : null}

      <div className="notice ok">
        <Icon name="info" />
        <p className="small">
          {t("cfe_retention_note")} <a href="#/preferences/storage">{t("cfe_retention_link")}</a>
        </p>
      </div>

      {review ? (
        <Dialog title={t("cfe_review_title")} onClose={() => setReview(null)} wide>
          <div className="stack" data-testid="cfe-review">
            <p className="small">{t("cfe_review_lead", { file: "jgates.yml" })}</p>
            {review.busy && !review.preview ? <Loading /> : null}
            {review.preview ? review.preview.changed ? <DiffView diff={review.preview.diff} /> : <p className="notice" role="status">{t("cfe_review_unchanged")}</p> : null}
            {conflict ? (
              <div className="notice warn" role="alert">
                <Icon name="alert" />
                <div className="stack tight">
                  <p className="small">{t("cfe_conflict")}</p>
                  <div>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setReview(null);
                        setDraft(new Map());
                        view.reload();
                      }}
                    >
                      <Icon name="refresh" />
                      {t("cfe_conflict_reload")}
                    </button>
                  </div>
                </div>
              </div>
            ) : review.error ? (
              <ErrorNotice error={review.error} />
            ) : null}
            <div className="row wrap">
              <button type="button" className="btn primary" disabled={!review.preview || !review.preview.changed || review.busy || conflict} onClick={() => void save()}>
                {review.busy && review.preview ? <Spinner /> : null}
                {t("save")}
              </button>
              <button type="button" className="btn" onClick={() => setReview(null)}>
                {t("cancel")}
              </button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
