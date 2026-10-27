import { useEffect, useId, useState } from "react";
import { api, ApiError } from "../../api";
import { Dialog, ErrorNotice, Pill } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t } from "../../i18n";
import { KeyControl } from "./key";
import { headersText, insecureHttp, parseHeaders, providerPath, type FieldErrorView, type FieldValue, type ModelsAnswer, type ProviderEntry, type SecretView } from "./model";

export const originText = (v: FieldValue): string => t(`pk_origin_${v.origin}`);

export function typeLabel(entry: ProviderEntry): string {
  return t(entry.kind === "connection" ? "pk_type_connection" : entry.type === "cli" ? "pk_type_cli" : "pk_type_http");
}

/** The errors of the fields the server refused (field paths like baseUrl or headers.X-Api-Key), by field. */
export function fieldErrors(error: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (error instanceof ApiError && Array.isArray(error.body.errors)) {
    for (const e of error.body.errors as FieldErrorView[]) {
      const field = e.field.startsWith("headers") ? "headers" : e.field;
      if (!out.has(field)) out.set(field, e.message);
    }
  }
  return out;
}

/** Testar, and the list of models that feeds the choice of the default model. */
export function useModels(name: string): { answer: ModelsAnswer | null; error: unknown; busy: boolean; run: () => Promise<void> } {
  const [answer, setAnswer] = useState<ModelsAnswer | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setAnswer(await api<ModelsAnswer>("POST", providerPath(name, "/test")));
    } catch (e) {
      setAnswer(null);
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { answer, error, busy, run };
}

export function ModelList({ answer, testId }: { answer: ModelsAnswer; testId: string }) {
  const shown = answer.models.slice(0, 50);
  return (
    <div className="notice ok" role="status" data-testid={testId}>
      <Icon name="check-circle" />
      <div className="stack tight grow">
        <strong>{t("pk_test_ok", { name: answer.name, count: answer.count })}</strong>
        {shown.length > 0 ? (
          <ul className="chips pk-models" aria-label={t("pk_test_models", { name: answer.name })}>
            {shown.map((m) => (
              <li key={m} className="chip">
                <code>{m}</code>
              </li>
            ))}
          </ul>
        ) : null}
        {answer.models.length > shown.length ? <p className="small muted">{t("pk_test_more", { count: answer.count - shown.length })}</p> : null}
        {answer.defaultModelListed === false ? <p className="small">{t("pk_test_model_missing")}</p> : null}
        <p className="small muted">{t("pk_test_no_tokens")}</p>
      </div>
    </div>
  );
}

interface Draft {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  headers: string;
  allowInsecureHttp: boolean;
}

const userText = (v: FieldValue): string => (v.origin === "user" && v.value ? v.value : "");

/** Configurar: base URL, default model (with the provider's models when the key is set), key name and extra headers. */
function PrefsForm({ entry, revision, models, onSaved, onCancel }: { entry: ProviderEntry; revision: string | null; models: ReturnType<typeof useModels>; onSaved: (revision: string | null) => void; onCancel: () => void }) {
  const id = useId();
  const toast = useToast();
  const initial: Draft = { baseUrl: userText(entry.baseUrl), model: userText(entry.model), apiKeyEnv: userText(entry.apiKeyEnv), headers: headersText(entry.headers), allowInsecureHttp: entry.allowInsecureHttp };
  const [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const has = (f: "baseUrl" | "apiKeyEnv") => entry.fields.includes(f);
  const connection = entry.kind === "connection";
  const keySet = entry.key?.state === "set";

  // With the key set, the provider's models are listed once when the form opens (no prompt, no token).
  useEffect(() => {
    if (keySet && !models.answer && !models.busy) void models.run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const errors = fieldErrors(error);
  const http = has("baseUrl") && insecureHttp(draft.baseUrl);
  const save = async () => {
    const patch: Record<string, unknown> = { expectedRevision: revision };
    const text = (key: "baseUrl" | "model" | "apiKeyEnv") => {
      if (draft[key].trim() !== initial[key].trim()) patch[key] = draft[key].trim() === "" ? null : draft[key].trim();
    };
    if (has("baseUrl")) text("baseUrl");
    text("model");
    if (has("apiKeyEnv")) text("apiKeyEnv");
    if (connection && draft.headers !== initial.headers) {
      const parsed = parseHeaders(draft.headers);
      if ("bad" in parsed) {
        setError(new ApiError(400, "HEADERS_INVALID", t("pk_headers_invalid", { line: parsed.bad }), null, { errors: [{ field: "headers", code: "INVALID_HEADER_NAME", message: t("pk_headers_invalid", { line: parsed.bad }) }] }));
        return;
      }
      patch.headers = parsed.headers;
    }
    // A new base URL drops the confirmation given for the old one, so it is sent again with the URL.
    if (http && (draft.allowInsecureHttp !== initial.allowInsecureHttp || patch.baseUrl !== undefined)) patch.allowInsecureHttp = draft.allowInsecureHttp ? true : null;
    if (Object.keys(patch).length === 1) {
      onCancel();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ revision: string | null }>("PUT", providerPath(entry.name), patch);
      toast(t("pk_saved", { name: entry.name }), "ok");
      onSaved(r.revision);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const input = (key: "baseUrl" | "model" | "apiKeyEnv", label: string, placeholder: string, extra: Record<string, string> = {}) => (
    <div className="field">
      <label className="field-label" htmlFor={`${id}-${key}`}>
        {label}
      </label>
      <input
        id={`${id}-${key}`}
        className="input"
        type="text"
        spellCheck={false}
        value={draft[key]}
        placeholder={placeholder}
        aria-invalid={errors.has(key) ? true : undefined}
        aria-describedby={`${id}-${key}-help`}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
        {...extra}
      />
      <p className="small muted" id={`${id}-${key}-help`}>
        {errors.get(key) ? <span className="field-problem">{errors.get(key)}</span> : t(`pk_help_${key}`)}
      </p>
    </div>
  );

  return (
    <form
      className="stack tight pk-form"
      aria-label={t("pk_configure_form", { name: entry.name })}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {has("baseUrl") ? input("baseUrl", t("pk_field_base_url"), entry.baseUrl.origin === "default" ? (entry.baseUrl.value ?? "") : "https://") : null}
      {input("model", t("pk_field_model"), "", models.answer ? { list: `${id}-models` } : {})}
      {models.answer ? (
        <datalist id={`${id}-models`}>
          {models.answer.models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      ) : null}
      {models.busy ? (
        <p className="small muted" role="status">
          {t("pk_models_loading")}
        </p>
      ) : models.answer ? (
        <p className="small muted" role="status" data-testid={`models-count-${entry.name}`}>
          {t("pk_models_available", { count: models.answer.count })}
        </p>
      ) : null}
      {has("apiKeyEnv") ? input("apiKeyEnv", t("pk_field_key_name"), entry.apiKeyEnv.value ?? "") : null}
      {connection ? (
        <div className="field">
          <label className="field-label" htmlFor={`${id}-headers`}>
            {t("pk_field_headers")}
          </label>
          <textarea
            id={`${id}-headers`}
            className="input mono"
            rows={2}
            spellCheck={false}
            value={draft.headers}
            placeholder="X-Team: qa"
            aria-invalid={errors.has("headers") ? true : undefined}
            aria-describedby={`${id}-headers-help`}
            onChange={(e) => setDraft({ ...draft, headers: e.target.value })}
          />
          <p className="small muted" id={`${id}-headers-help`}>
            {errors.get("headers") ? <span className="field-problem">{errors.get("headers")}</span> : t("pk_help_headers")}
          </p>
        </div>
      ) : null}
      {http ? (
        <label className="row choice pk-confirm">
          <input type="checkbox" checked={draft.allowInsecureHttp} onChange={(e) => setDraft({ ...draft, allowInsecureHttp: e.target.checked })} />
          {t("pk_allow_http")}
        </label>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
      <div className="row wrap">
        <button type="submit" className="btn primary" disabled={busy} aria-label={t("pk_save_aria", { name: entry.name })}>
          <Icon name="check" />
          {t("pk_save")}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {t("pk_cancel")}
        </button>
      </div>
    </form>
  );
}

function RemoveConnectionDialog({ entry, revision, onClose, onDone }: { entry: ProviderEntry; revision: string | null; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const connection = entry.kind === "connection";
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("DELETE", `${providerPath(entry.name)}?expectedRevision=${revision ?? "none"}`);
      onDone();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Dialog title={t(connection ? "pk_remove_connection_title" : "pk_reset_title", { name: entry.name })} onClose={onClose}>
      <div className="stack">
        <p>{t(connection ? "pk_remove_connection_lead" : "pk_reset_lead", { name: entry.name, key: entry.apiKeyEnv.value ?? "" })}</p>
        {error ? <ErrorNotice error={error} /> : null}
        <div className="row wrap">
          <button type="button" className="btn danger" disabled={busy} onClick={() => void remove()}>
            <Icon name="x" />
            {t(connection ? "pk_remove_connection_confirm" : "pk_reset_confirm")}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t("pk_cancel")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** One provider or connection: what is in effect (with the origin), Configurar, Testar, Remover, and its key. */
export function ProviderCard({ entry, secret, writable, revision, onChanged }: { entry: ProviderEntry; secret: SecretView | undefined; writable: boolean; revision: string | null; onChanged: (revision?: string | null) => void }) {
  const toast = useToast();
  const titleId = useId();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const models = useModels(entry.name);
  const connection = entry.kind === "connection";
  const userValues = entry.baseUrl.origin === "user" || entry.model.origin === "user" || entry.apiKeyEnv.origin === "user";
  const testable = entry.type !== "cli";
  const value = (v: FieldValue) => (v.value ? <code>{v.value}</code> : <span className="muted">{t("pk_not_set")}</span>);

  return (
    <article className="card flat stack pk-card" aria-labelledby={titleId} data-testid={`provider-${entry.name}`}>
      <div className="between wrap">
        <h3 id={titleId}>{entry.name}</h3>
        <Pill {...(connection ? { tone: "blue" as const } : {})}>{typeLabel(entry)}</Pill>
      </div>
      <dl className="kv">
        {entry.fields.includes("baseUrl") ? (
          <>
            <dt>{t("pk_field_base_url")}</dt>
            <dd data-testid={`base-url-${entry.name}`}>
              {value(entry.baseUrl)} {entry.baseUrl.value ? <span className="muted">({originText(entry.baseUrl)})</span> : null}
            </dd>
          </>
        ) : null}
        <dt>{t("pk_field_model")}</dt>
        <dd data-testid={`model-${entry.name}`}>
          {value(entry.model)} {entry.model.value ? <span className="muted">({originText(entry.model)})</span> : null}
        </dd>
        {connection && Object.keys(entry.headers).length > 0 ? (
          <>
            <dt>{t("pk_field_headers")}</dt>
            <dd>
              <code>{Object.keys(entry.headers).join(", ")}</code>
            </dd>
          </>
        ) : null}
        {entry.type === "cli" ? (
          <>
            <dt>{t("pk_field_login")}</dt>
            <dd>{t("pk_cli_login")}</dd>
          </>
        ) : null}
      </dl>
      {editing ? (
        <PrefsForm
          entry={entry}
          revision={revision}
          models={models}
          onCancel={() => setEditing(false)}
          onSaved={(next) => {
            setEditing(false);
            onChanged(next);
          }}
        />
      ) : (
        <div className="row wrap">
          {writable ? (
            <button type="button" className="btn" aria-label={t("pk_configure_aria", { name: entry.name })} onClick={() => setEditing(true)}>
              <Icon name="settings" />
              {t("pk_configure")}
            </button>
          ) : null}
          {testable ? (
            <button type="button" className="btn" disabled={models.busy} aria-label={t("pk_test_aria", { name: entry.name })} onClick={() => void models.run()}>
              <Icon name="refresh" />
              {models.busy ? t("pk_testing") : t("pk_test")}
            </button>
          ) : null}
          {writable && (connection || userValues) ? (
            <button type="button" className="btn danger" aria-label={t(connection ? "pk_remove_connection_aria" : "pk_reset_aria", { name: entry.name })} onClick={() => setRemoving(true)}>
              <Icon name="x" />
              {t(connection ? "pk_remove_connection" : "pk_reset")}
            </button>
          ) : null}
        </div>
      )}
      {models.answer && !editing ? <ModelList answer={models.answer} testId={`models-${entry.name}`} /> : null}
      {models.error ? <ErrorNotice error={models.error} /> : null}
      {entry.key ? <KeyControl name={entry.key.name} secret={secret} writable={writable} onChanged={() => onChanged()} /> : null}
      {removing ? (
        <RemoveConnectionDialog
          entry={entry}
          revision={revision}
          onClose={() => setRemoving(false)}
          onDone={() => {
            setRemoving(false);
            toast(t(connection ? "pk_connection_removed" : "pk_reset_done", { name: entry.name }), "ok");
            onChanged();
          }}
        />
      ) : null}
    </article>
  );
}
