import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";
import { ApiError, api } from "../../../api";
import { ErrorNotice, Spinner } from "../../../components/common";
import { Icon } from "../../../components/icons";
import type { FieldView, FormIntent, FormView } from "../../../forms/model";
import { t } from "../../../i18n";
import "./settings-form.css";

// Guided form of an instance whose settings live in tools.<id> of .jgates/tools.yml (ZAP, Schemathesis, oasdiff):
// radios, selects and checkboxes where the values are known, a select of the project's OpenAPI files with "Other...",
// the client's own check of each value before saving (the server checks again with the schema), and the fields a
// "not applicable here" action named (`focus`) focused and highlighted. Only the keys the person changed are written;
// everything else in tools.yml (comments, auth, other tools) stays as it is.

export interface SettingsField extends FieldView {
  options?: Array<{ value: string; label: string; help: string | null }>;
  suggestions?: string[];
  required?: boolean;
  showWhen?: { field: string; equals: unknown };
  format?: "http-url" | "git-ref" | "relative-path" | "image-ref";
  prefill?: unknown;
}

export interface SettingsView extends Omit<FormView, "fields"> {
  scope?: "documents" | "instance";
  fields: SettingsField[];
  choices?: Array<{ id: string; label: string; help: string; required: boolean; options: Array<{ field: string; label: string; help: string }> }>;
  rules?: Array<{ when: { field: string; equals: unknown }; require: { field: string; equals: unknown }; message: string }>;
}

const OTHER = "__other__";
const GIT_REF = /^[A-Za-z0-9_][A-Za-z0-9._/~^@-]*$/;
const IMAGE = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?(?:@sha256:[0-9a-f]{64})?$/;
const domId = (field: string) => `rtf-${field.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Whether the text is a base URL the runtime checks accept (checkTarget): http(s), a host, no credentials, query or fragment. */
export function urlProblem(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return t("rtf_err_url");
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.hostname === "" || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "" || /\s/.test(value)) return t("rtf_err_url");
  return null;
}

function pathProblem(value: string): string | null {
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value) || value.replace(/\\/g, "/").split("/").some((p) => p === ".." || p === "")) return t("rtf_err_path");
  return null;
}

/** The problem of one value, or null; `value` is what the field will hold (undefined: absent). */
function problemOf(field: SettingsField, value: unknown): string | null {
  if (empty(value)) return field.required ? t("rtf_err_required") : null;
  const s = field.schema ?? {};
  if (field.widget === "number") {
    const n = Number(value);
    if (!Number.isInteger(n)) return t("rtf_err_integer");
    if ((typeof s.minimum === "number" && n < s.minimum) || (typeof s.maximum === "number" && n > s.maximum)) return t("rtf_err_range", { min: s.minimum ?? "-", max: s.maximum ?? "-" });
    return null;
  }
  if (typeof value !== "string") return null;
  if (field.format === "http-url") return urlProblem(value);
  if (field.format === "relative-path") return pathProblem(value);
  if (field.format === "git-ref") return GIT_REF.test(value) ? null : t("rtf_err_ref");
  if (field.format === "image-ref") return IMAGE.test(value) ? null : t("rtf_err_image");
  return null;
}

/** `onSaved(true)` after a save (the parent reloads the view and keeps the notice); `onSaved(false)` only reloads. */
export function SettingsForm({ view, focus, justSaved, onSaved }: { view: SettingsView; focus: string[]; justSaved: boolean; onSaved: (saved: boolean) => void }) {
  const fields = view.fields;
  const choices = view.choices ?? [];
  const inChoice = useMemo(() => new Map(choices.flatMap((c) => c.options.map((o) => [o.field, c.id] as const))), [choices]);
  const original = useMemo(() => new Map(fields.map((f) => [f.id, f.state === "set" ? f.value : undefined])), [fields]);
  // An absent key with a proposed value (prefill) starts as a visible pending change; nothing is written until Save.
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map((f) => [f.id, f.state === "set" ? f.value : f.state === "inherited" ? f.prefill : undefined])));
  // The option of each choice: the one already set, else the one the action named, else the first.
  const [picked, setPicked] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      choices.map((c) => {
        const set = c.options.find((o) => fields.find((f) => f.id === o.field)?.state === "set");
        const named = c.options.find((o) => focus.includes(o.field));
        return [c.id, (set ?? named ?? c.options[0])?.field ?? ""];
      }),
    ),
  );
  // A path field shows a free text box when its value is not one of the suggestions (or the person chose "Other").
  const [other, setOther] = useState<Record<string, boolean>>(() => Object.fromEntries(fields.map((f) => [f.id, f.state === "set" && typeof f.value === "string" && !(f.suggestions ?? []).includes(f.value)])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(justSaved);
  const [failure, setFailure] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const focusedOnce = useRef(false);

  const shownValue = (f: SettingsField) => (values[f.id] === undefined ? f.defaultValue : values[f.id]);
  const visible = (f: SettingsField) => !f.showWhen || same(shownValue(fields.find((x) => x.id === f.showWhen?.field) as SettingsField) ?? undefined, f.showWhen.equals);
  const missing = (f: SettingsField) => focus.includes(f.id) && empty(values[f.id]);

  useEffect(() => {
    if (focusedOnce.current || focus.length === 0) return;
    focusedOnce.current = true;
    const first = fields.find((f) => focus.includes(f.id));
    if (!first) return;
    const el = document.getElementById(domId(first.id));
    el?.scrollIntoView({ block: "center" });
    el?.focus();
  }, [focus, fields]);

  const set = (id: string, value: unknown) => {
    setSaved(false);
    setValues((v) => ({ ...v, [id]: value }));
    setErrors((e) => {
      const { [id]: _drop, ...rest } = e;
      return rest;
    });
  };

  /** The value each field will have after saving: hidden fields and the options not picked in a choice are removed. */
  function finalValues(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const choice = inChoice.get(f.id);
      if (choice && picked[choice] !== f.id) out[f.id] = undefined;
      else if (!visible(f)) out[f.id] = undefined;
      else out[f.id] = empty(values[f.id]) ? undefined : values[f.id];
    }
    return out;
  }

  function validate(next: Record<string, unknown>): Record<string, string> {
    const found: Record<string, string> = {};
    for (const f of fields) {
      const choice = inChoice.get(f.id);
      if (choice && picked[choice] !== f.id) continue;
      if (!visible(f)) continue;
      const problem = problemOf(f, next[f.id]);
      if (problem) found[f.id] = problem;
    }
    for (const c of choices) {
      const chosen = picked[c.id] as string;
      if (c.required && empty(next[chosen]) && !found[chosen]) found[chosen] = t("rtf_err_required");
    }
    for (const r of view.rules ?? []) {
      const when = fields.find((f) => f.id === r.when.field);
      const whenValue = next[r.when.field] ?? when?.defaultValue;
      if (same(whenValue, r.when.equals) && !same(next[r.require.field], r.require.equals) && !found[r.require.field]) found[r.require.field] = r.message;
    }
    return found;
  }

  function intentsFor(next: Record<string, unknown>): FormIntent[] {
    const out: FormIntent[] = [];
    for (const f of fields) {
      if (f.state === "unrecognized") continue;
      const before = original.get(f.id);
      const after = next[f.id];
      if (after === undefined) {
        if (before !== undefined) out.push({ field: f.id, op: "inherit" });
        continue;
      }
      // Choosing the default on a field that was absent writes nothing: the tool already uses it.
      if (before === undefined && f.defaultValue !== undefined && same(after, f.defaultValue)) continue;
      if (!same(before, after)) out.push({ field: f.id, op: "set", value: after });
    }
    return out;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFailure(null);
    setConflict(false);
    const next = finalValues();
    const found = validate(next);
    setErrors(found);
    const firstBad = fields.find((f) => found[f.id]);
    if (firstBad) {
      document.getElementById(domId(firstBad.id))?.focus();
      return;
    }
    const intents = intentsFor(next);
    if (intents.length === 0) {
      setSaved(true);
      return;
    }
    setBusy(true);
    try {
      await api("PUT", `/api/forms/${encodeURIComponent(view.instance)}`, { expectedRevision: view.revision, intents });
      setSaved(true);
      onSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === "REVISION_CONFLICT") setConflict(true);
      else if (err instanceof ApiError && err.code === "FORM_VALUE_INVALID" && typeof err.body?.details?.field === "string") {
        setErrors({ [err.body.details.field as string]: err.message });
        document.getElementById(domId(err.body.details.field as string))?.focus();
      } else setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  const named = focus.map((id) => fields.find((f) => f.id === id)).filter((f): f is SettingsField => Boolean(f));
  const pendingMissing = named.filter((f) => empty(values[f.id]));
  const file = view.document.relPath ?? ".jgates/tools.yml";

  const control = (f: SettingsField) => {
    const id = domId(f.id);
    const describedBy = `${id}-help${errors[f.id] ? ` ${id}-error` : ""}`;
    const common = { id, "aria-describedby": describedBy, "aria-invalid": errors[f.id] ? true : undefined, disabled: !view.editable || busy } as const;
    const value = values[f.id];
    if (f.widget === "radio" && f.options) {
      const current = shownValue(f);
      return (
        <div className="rtf-radios" role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={describedBy}>
          {f.options.map((o, i) => (
            <label key={o.value} className={`rtf-radio${o.value === "active" ? " rtf-danger" : ""}`}>
              <input type="radio" name={id} id={i === 0 ? id : undefined} value={o.value} checked={current === o.value} disabled={common.disabled} onChange={() => set(f.id, o.value)} />
              <span className="stack tight">
                <strong>{o.label}</strong>
                {o.help ? <span className="small muted">{o.help}</span> : null}
              </span>
            </label>
          ))}
        </div>
      );
    }
    if (f.widget === "select" && f.options) {
      const current = (value ?? "") as string;
      return (
        <select className="input" {...common} value={current} onChange={(e) => set(f.id, e.target.value === "" ? undefined : e.target.value)}>
          <option value="">{t("rtf_default_option", { value: f.options.find((o) => o.value === f.defaultValue)?.label ?? String(f.defaultValue ?? "-") })}</option>
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    if (f.widget === "boolean") {
      return (
        <label className="row choice rtf-check">
          <input type="checkbox" {...common} checked={value === true} onChange={(e) => set(f.id, e.target.checked ? true : undefined)} />
          {f.label}
        </label>
      );
    }
    if (f.widget === "string-list" && f.options) {
      const list = (Array.isArray(value) ? value : Array.isArray(f.defaultValue) ? f.defaultValue : []) as string[];
      return (
        <div className="rtf-checks" role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy}>
          {f.options.map((o, i) => (
            <label key={o.value} className="row choice">
              <input
                type="checkbox"
                id={i === 0 ? id : undefined}
                checked={list.includes(o.value)}
                disabled={common.disabled}
                onChange={(e) => set(f.id, e.target.checked ? [...list, o.value] : list.filter((x) => x !== o.value))}
              />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    if (f.widget === "number") {
      return (
        <span className="row">
          <input
            type="number"
            className="input number"
            {...common}
            min={f.schema?.minimum}
            max={f.schema?.maximum}
            step={1}
            placeholder={f.defaultValue !== undefined ? String(f.defaultValue) : ""}
            value={value === undefined ? "" : String(value)}
            onChange={(e) => set(f.id, e.target.value === "" ? undefined : Number(e.target.value))}
          />
          {f.unit ? <span className="small muted">{f.unit}</span> : null}
        </span>
      );
    }
    const text = (
      <input
        type={f.format === "http-url" ? "url" : "text"}
        inputMode={f.format === "http-url" ? "url" : undefined}
        className="input rtf-text"
        {...(other[f.id] || !(f.suggestions && f.suggestions.length > 0) ? common : { ...common, id: `${id}-other` })}
        placeholder={f.example ?? (typeof f.defaultValue === "string" ? f.defaultValue : "")}
        value={(value ?? "") as string}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => set(f.id, e.target.value)}
        onBlur={(e) => {
          const p = problemOf(f, e.target.value === "" ? undefined : e.target.value);
          if (p && e.target.value !== "") setErrors((x) => ({ ...x, [f.id]: p }));
        }}
      />
    );
    if (f.suggestions && f.suggestions.length > 0) {
      const selectValue = other[f.id] ? OTHER : ((value ?? "") as string);
      return (
        <div className="stack tight">
          <select
            className="input"
            {...(other[f.id] ? { ...common, id: `${id}-pick` } : common)}
            value={selectValue}
            onChange={(e) => {
              if (e.target.value === OTHER) {
                setOther((o) => ({ ...o, [f.id]: true }));
                set(f.id, "");
                setTimeout(() => document.getElementById(domId(f.id))?.focus(), 0);
              } else {
                setOther((o) => ({ ...o, [f.id]: false }));
                set(f.id, e.target.value === "" ? undefined : e.target.value);
              }
            }}
          >
            <option value="">{f.required ? t("rtf_pick") : t("rtf_auto")}</option>
            {f.suggestions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
            <option value={OTHER}>{t("rtf_other")}</option>
          </select>
          {other[f.id] ? text : null}
        </div>
      );
    }
    return text;
  };

  const row = (f: SettingsField) => {
    const id = domId(f.id);
    return (
      <div key={f.id} className={`rtf-field${missing(f) ? " rtf-missing" : ""}${errors[f.id] ? " rtf-invalid" : ""}`} data-field={f.id} data-missing={missing(f) ? "true" : undefined}>
        {f.widget === "boolean" ? null : (
          <div className="field-head">
            {/* A radio group or a list of checkboxes is named by aria-labelledby; a <label for> would rename its first item. */}
            {f.widget === "radio" || (f.widget === "string-list" && f.options) ? (
              <span className="field-label" id={`${id}-label`}>
                {f.label}
                {f.required ? <span className="rtf-required"> {t("rtf_required_mark")}</span> : null}
              </span>
            ) : (
              <label className="field-label" id={`${id}-label`} htmlFor={id}>
                {f.label}
                {f.required ? <span className="rtf-required"> {t("rtf_required_mark")}</span> : null}
              </label>
            )}
            <code className="muted small">{f.documentPath}</code>
          </div>
        )}
        {missing(f) ? (
          <p className="small rtf-missing-note">
            <Icon name="alert" /> {t("rtf_missing_note")}
          </p>
        ) : null}
        {control(f)}
        <p className="small muted" id={`${id}-help`}>
          {f.help}
        </p>
        {errors[f.id] ? (
          <p className="small field-problem" id={`${id}-error`} role="alert" data-testid="rtf-error">
            {errors[f.id]}
          </p>
        ) : null}
      </div>
    );
  };

  const choiceBlock = (c: NonNullable<SettingsView["choices"]>[number]) => {
    const chosen = fields.find((f) => f.id === picked[c.id]);
    const focusHere = c.options.some((o) => focus.includes(o.field)) && c.options.every((o) => empty(values[o.field]));
    return (
      <fieldset key={c.id} className={`rtf-field rtf-choice${focusHere ? " rtf-missing" : ""}`} data-choice={c.id} data-missing={focusHere ? "true" : undefined}>
        <legend className="field-label">
          {c.label}
          {c.required ? <span className="rtf-required"> {t("rtf_required_mark")}</span> : null}
        </legend>
        <p className="small muted">{c.help}</p>
        {focusHere ? (
          <p className="small rtf-missing-note">
            <Icon name="alert" /> {t("rtf_missing_note")}
          </p>
        ) : null}
        <div className="rtf-radios">
          {c.options.map((o) => (
            <label key={o.field} className="rtf-radio">
              <input
                type="radio"
                name={`rtf-choice-${c.id}`}
                value={o.field}
                checked={picked[c.id] === o.field}
                disabled={!view.editable || busy}
                onChange={() => {
                  setSaved(false);
                  setPicked((p) => ({ ...p, [c.id]: o.field }));
                }}
              />
              <span className="stack tight">
                <strong>{o.label}</strong>
                <span className="small muted">{o.help}</span>
              </span>
            </label>
          ))}
        </div>
        {chosen ? row(chosen) : null}
      </fieldset>
    );
  };

  /** Fields in order; a choice takes the place of its first option. */
  const blocks = (list: SettingsField[]) => {
    const out: ReactElement[] = [];
    const done = new Set<string>();
    for (const f of list) {
      const choice = inChoice.get(f.id);
      if (choice) {
        if (done.has(choice)) continue;
        done.add(choice);
        const c = choices.find((x) => x.id === choice);
        if (c) out.push(choiceBlock(c));
        continue;
      }
      if (!visible(f)) continue;
      out.push(row(f));
    }
    return out;
  };

  const common = fields.filter((f) => f.group === "common");
  const advanced = fields.filter((f) => f.group === "advanced");
  const advancedOpen = advanced.some((f) => focus.includes(f.id) || errors[f.id] || f.state === "unrecognized");

  return (
    <form className="stack rtf" onSubmit={submit} noValidate data-testid="settings-form">
      <div className="card flat stack">
        <h2>{view.form.title}</h2>
        <p className="small">{t("rtf_lead", { file, section: view.section.join(".") })}</p>
        {pendingMissing.length > 0 ? (
          <div className="notice warn" role="status" data-testid="rtf-needed">
            <Icon name="alert" />
            <p>{t("rtf_needed", { fields: pendingMissing.map((f) => f.label).join(", ") })}</p>
          </div>
        ) : null}
        {fields.some((f) => f.format === "http-url") ? (
          <div className="notice" role="note">
            <Icon name="info" />
            <p className="small">{t("rtf_no_start")}</p>
          </div>
        ) : null}
        <div className="stack">{blocks(common)}</div>
      </div>
      {advanced.length > 0 ? (
        <details className="card flat form-group" open={advancedOpen || undefined}>
          <summary>
            <h2>{t("rtf_advanced")}</h2>
          </summary>
          <div className="stack">{blocks(advanced)}</div>
        </details>
      ) : null}
      {view.unsupported.length > 0 ? (
        <p className="small muted" data-testid="rtf-kept">
          {t("rtf_kept", { keys: view.unsupported.map((u) => u.documentPath).join(", ") })}{" "}
          <a href="#/config/yaml">{t("rtf_open_yaml")}</a>
        </p>
      ) : (
        <p className="small muted">
          <a href="#/config/yaml">{t("rtf_open_yaml")}</a>
        </p>
      )}
      {conflict ? (
        <div className="notice warn" role="alert">
          <Icon name="alert" />
          <div className="stack tight">
            <p>{t("rtf_conflict")}</p>
            <div>
              <button type="button" className="btn" onClick={() => onSaved(false)}>
                {t("rtf_reload")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {failure ? <ErrorNotice error={failure} /> : null}
      {saved ? (
        <div className="notice ok" role="status" data-testid="rtf-saved">
          <Icon name="check" />
          <div className="stack tight">
            <p>{t("rtf_saved", { file })}</p>
            <p className="small">
              <a href="#/validations/review">{t("rtf_back_review")}</a>
            </p>
          </div>
        </div>
      ) : null}
      <div className="edit-bar">
        <span className="small muted">{t("rtf_save_note", { file })}</span>
        <button type="submit" className="btn primary" disabled={!view.editable || busy}>
          {busy ? <Spinner /> : <Icon name="check" />}
          {t("rtf_save")}
        </button>
      </div>
    </form>
  );
}
