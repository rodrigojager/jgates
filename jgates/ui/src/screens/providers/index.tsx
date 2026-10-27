import { useId, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import { ErrorNotice, Loading, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { fieldErrors, ModelList, ProviderCard } from "./card";
import { KeyControl } from "./key";
import { CONNECTION_NAME, insecureHttp, KEY_NAME, parseHeaders, secretPath, type ModelsAnswer, type ProvidersData, type SecretsData, type SecretView } from "./model";
import "./providers.css";

// Preferências > Providers e chaves (D9, D10): the user's provider preferences and the key store, outside every project.
// The screen never shows a stored value: a key is ******** with its date, or the environment, or absent.
export const screen: ScreenMeta = { id: "providers", path: "/preferences/providers", area: "preferences", order: 92, icon: "lock" };

/** Acrescentar conexão: name, base URL, default model, key name and extra headers of an openai-compatible gateway. */
function AddConnection({ revision, reserved, onDone, onCancel }: { revision: string | null; reserved: string[]; onDone: (revision: string | null, name: string) => void; onCancel: () => void }) {
  const id = useId();
  const toast = useToast();
  const [draft, setDraft] = useState({ name: "", baseUrl: "", model: "", apiKeyEnv: "", headers: "", allowInsecureHttp: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);
  const name = draft.name.trim();
  const nameProblem = name === "" ? null : !CONNECTION_NAME.test(name) ? t("pk_add_name_invalid") : reserved.includes(name) ? t("pk_add_name_reserved") : null;
  const derivedKey = name && !nameProblem ? `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`.replace(/^([0-9])/, "_$1") : "NOME_API_KEY";
  const http = insecureHttp(draft.baseUrl);

  const submit = async () => {
    const parsed = parseHeaders(draft.headers);
    if ("bad" in parsed) {
      setError(new ApiError(400, "HEADERS_INVALID", t("pk_headers_invalid", { line: parsed.bad }), null, { errors: [{ field: "headers", code: "INVALID_HEADER_NAME", message: t("pk_headers_invalid", { line: parsed.bad }) }] }));
      return;
    }
    const body: Record<string, unknown> = { expectedRevision: revision, name, type: "openai-compatible", baseUrl: draft.baseUrl.trim() };
    if (draft.model.trim()) body.model = draft.model.trim();
    if (draft.apiKeyEnv.trim()) body.apiKeyEnv = draft.apiKeyEnv.trim();
    if (parsed.headers) body.headers = parsed.headers;
    if (http && draft.allowInsecureHttp) body.allowInsecureHttp = true;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ revision: string | null }>("POST", "/api/providers", body);
      toast(t("pk_add_done", { name }), "ok");
      onDone(r.revision, name);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const text = (key: "name" | "baseUrl" | "model" | "apiKeyEnv", label: string, placeholder: string, help: string, problem: string | null = null) => (
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
        aria-invalid={problem || errors.has(key) ? true : undefined}
        aria-describedby={`${id}-${key}-help`}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
      <p className="small muted" id={`${id}-${key}-help`}>
        {problem || errors.get(key) ? <span className="field-problem">{problem ?? errors.get(key)}</span> : help}
      </p>
    </div>
  );

  return (
    <form
      className="card flat stack tight pk-form"
      aria-labelledby={`${id}-title`}
      data-testid="add-connection-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 id={`${id}-title`}>{t("pk_add_title")}</h3>
      <p className="small muted">{t("pk_add_lead")}</p>
      {text("name", t("pk_add_name"), "litellm-local", t("pk_add_name_help"), nameProblem)}
      {text("baseUrl", t("pk_field_base_url"), "http://localhost:4000/v1", t("pk_help_baseUrl"))}
      {text("model", t("pk_field_model"), "", t("pk_help_model"))}
      {text("apiKeyEnv", t("pk_field_key_name"), derivedKey, t("pk_add_key_help", { name: derivedKey }))}
      <div className="field">
        <label className="field-label" htmlFor={`${id}-headers`}>
          {t("pk_field_headers")}
        </label>
        <textarea id={`${id}-headers`} className="input mono" rows={2} spellCheck={false} value={draft.headers} placeholder="X-Team: qa" aria-describedby={`${id}-headers-help`} onChange={(e) => setDraft({ ...draft, headers: e.target.value })} />
        <p className="small muted" id={`${id}-headers-help`}>
          {errors.get("headers") ? <span className="field-problem">{errors.get("headers")}</span> : t("pk_help_headers")}
        </p>
      </div>
      {http ? (
        <label className="row choice pk-confirm">
          <input type="checkbox" checked={draft.allowInsecureHttp} onChange={(e) => setDraft({ ...draft, allowInsecureHttp: e.target.checked })} />
          {t("pk_allow_http")}
        </label>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
      <div className="row wrap">
        <button type="submit" className="btn primary" disabled={busy || name === "" || nameProblem !== null || draft.baseUrl.trim() === ""}>
          <Icon name="check" />
          {t("pk_add_submit")}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {t("pk_cancel")}
        </button>
      </div>
    </form>
  );
}

/** Acrescentar nome: a key of the user's own (a PII tool's passEnv, a gateway's key) and its value. */
function AddKey({ known, onDone, onCancel }: { known: string[]; onDone: () => void; onCancel: () => void }) {
  const id = useId();
  const toast = useToast();
  const field = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [filled, setFilled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const trimmed = name.trim();
  const problem = trimmed === "" ? null : !KEY_NAME.test(trimmed) ? t("pk_addkey_name_invalid") : known.includes(trimmed) ? t("pk_addkey_name_exists") : null;
  const submit = async () => {
    const value = field.current?.value ?? "";
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ secret: SecretView; environmentWins: boolean }>("PUT", secretPath(trimmed), { value });
      if (field.current) field.current.value = "";
      setFilled(false);
      toast(r.environmentWins ? t("pk_key_saved_env_wins", { name: trimmed, env: r.secret.envName ?? trimmed }) : t("pk_key_saved", { name: trimmed }), r.environmentWins ? "warn" : "ok");
      onDone();
    } catch (e) {
      if (field.current) field.current.value = "";
      setFilled(false);
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="card flat stack tight pk-form"
      aria-labelledby={`${id}-title`}
      data-testid="add-key-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 id={`${id}-title`}>{t("pk_addkey_title")}</h3>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-name`}>
          {t("pk_addkey_name")}
        </label>
        <input id={`${id}-name`} className="input" type="text" spellCheck={false} autoCapitalize="characters" value={name} placeholder="MINHA_CHAVE" aria-invalid={problem ? true : undefined} aria-describedby={`${id}-name-help`} onChange={(e) => setName(e.target.value)} />
        <p className="small muted" id={`${id}-name-help`}>
          {problem ? <span className="field-problem">{problem}</span> : t("pk_addkey_name_help")}
        </p>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-value`}>
          {t("pk_addkey_value")}
        </label>
        <input ref={field} id={`${id}-value`} className="input pk-secret" type="password" autoComplete="off" spellCheck={false} data-testid="add-key-value" onInput={(e) => setFilled((e.target as HTMLInputElement).value.trim() !== "")} />
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="row wrap">
        <button type="submit" className="btn primary" disabled={busy || trimmed === "" || problem !== null || !filled}>
          <Icon name="check" />
          {t("pk_addkey_submit")}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {t("pk_cancel")}
        </button>
      </div>
    </form>
  );
}

/** A key no provider of the list uses (a name of the user's own, a PII tool's key): state, Trocar, Remover, Testar. */
function OtherKey({ secret, writable, onChanged }: { secret: SecretView; writable: boolean; onChanged: () => void }) {
  const [answer, setAnswer] = useState<ModelsAnswer | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const test = async () => {
    setBusy(true);
    setError(null);
    try {
      setAnswer(await api<ModelsAnswer>("POST", secretPath(secret.name, "/test")));
    } catch (e) {
      setAnswer(null);
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="card flat stack tight" data-testid={`other-key-${secret.name}`}>
      <KeyControl name={secret.name} secret={secret} writable={writable} onChanged={onChanged} />
      {secret.testable && secret.state === "set" ? (
        <div>
          <button type="button" className="btn" disabled={busy} aria-label={t("pk_key_test_aria", { name: secret.name })} onClick={() => void test()}>
            <Icon name="refresh" />
            {busy ? t("pk_testing") : t("pk_test")}
          </button>
        </div>
      ) : null}
      {answer ? <ModelList answer={answer} testId={`key-models-${secret.name}`} /> : null}
      {error ? <ErrorNotice error={error} /> : null}
    </li>
  );
}

export default function ProvidersScreen() {
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState<"connection" | "key" | null>(null);
  const providers = useAsync(() => api<ProvidersData>("GET", "/api/providers"), `providers:${tick}`);
  const secrets = useAsync(() => api<SecretsData>("GET", "/api/secrets"), `secrets:${tick}`);
  const refresh = () => setTick((n) => n + 1);

  if (providers.error) return <ErrorNotice error={providers.error} onRetry={providers.reload} />;
  if (secrets.error) return <ErrorNotice error={secrets.error} onRetry={secrets.reload} />;
  if (!providers.data || !secrets.data) return <Loading />;
  const p = providers.data;
  const s = secrets.data;
  const writable = p.writable && s.writable;
  const byName = new Map(s.secrets.map((x) => [x.name, x]));
  const http = p.providers.filter((e) => e.kind === "provider" && e.type === "http");
  const connections = p.providers.filter((e) => e.kind === "connection");
  const cli = p.providers.filter((e) => e.type === "cli");
  const others = s.secrets.filter((x) => x.usedBy.length === 0);
  const reserved = p.providers.filter((e) => e.kind === "provider").map((e) => e.name);
  const card = (e: (typeof p.providers)[number]) => <ProviderCard key={e.name} entry={e} secret={e.key ? byName.get(e.key.name) : undefined} writable={writable} revision={p.revision} onChanged={refresh} />;
  const lockText = p.locked === "governed" ? t("pk_locked_governed", { policy: p.governed?.policy ?? "" }) : p.locked === "policy" ? t("pk_locked_policy") : null;

  return (
    <div className="stack" data-testid="providers-screen">
      <div>
        <h1>{t("pk_title")}</h1>
        <p>{t("pk_lead")}</p>
      </div>
      {lockText ? (
        <div className="notice warn" role="status" data-testid="providers-locked">
          <Icon name="lock" />
          <p className="small">{lockText}</p>
        </div>
      ) : null}
      <div className="notice" data-testid="providers-where">
        <Icon name="info" />
        <div className="stack tight">
          <p className="small">{t("pk_where_keys", { path: s.vault })}</p>
          <p className="small">{t("pk_where_prefs", { path: p.file })}</p>
          <p className="small">{t("pk_where_order")}</p>
        </div>
      </div>
      {p.problems.length > 0 ? (
        <div className="notice warn" role="status">
          <Icon name="alert" />
          <div>
            <strong>{t("pk_problems")}</strong>
            <ul>
              {p.problems.map((x) => (
                <li key={`${x.field}:${x.code}`}>
                  <code>{x.field}</code>: {x.message}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <section className="stack" aria-labelledby="pk-http">
        <div>
          <h2 id="pk-http">{t("pk_http_title")}</h2>
          <p className="small muted">{t("pk_http_lead")}</p>
        </div>
        <div className="pk-grid">{http.map(card)}</div>
      </section>

      <section className="stack" aria-labelledby="pk-connections">
        <div className="between wrap">
          <div>
            <h2 id="pk-connections">{t("pk_connections_title")}</h2>
            <p className="small muted">{t("pk_connections_lead")}</p>
          </div>
          {writable && adding !== "connection" ? (
            <button type="button" className="btn" onClick={() => setAdding("connection")}>
              <Icon name="link" />
              {t("pk_add_open")}
            </button>
          ) : null}
        </div>
        {adding === "connection" ? (
          <AddConnection
            revision={p.revision}
            reserved={reserved}
            onCancel={() => setAdding(null)}
            onDone={() => {
              setAdding(null);
              refresh();
            }}
          />
        ) : null}
        {connections.length > 0 ? <div className="pk-grid">{connections.map(card)}</div> : <p className="small muted" data-testid="no-connections">{t("pk_connections_empty")}</p>}
      </section>

      <section className="stack" aria-labelledby="pk-cli">
        <div>
          <h2 id="pk-cli">{t("pk_cli_title")}</h2>
          <p className="small muted">{t("pk_cli_lead")}</p>
        </div>
        <div className="pk-grid">{cli.map(card)}</div>
      </section>

      <section className="stack" aria-labelledby="pk-other">
        <div className="between wrap">
          <div>
            <h2 id="pk-other">{t("pk_other_title")}</h2>
            <p className="small muted">{t("pk_other_lead")}</p>
          </div>
          {writable && adding !== "key" ? (
            <button type="button" className="btn" onClick={() => setAdding("key")}>
              <Icon name="lock" />
              {t("pk_addkey_open")}
            </button>
          ) : null}
        </div>
        {adding === "key" ? (
          <AddKey
            known={s.secrets.map((x) => x.name)}
            onCancel={() => setAdding(null)}
            onDone={() => {
              setAdding(null);
              refresh();
            }}
          />
        ) : null}
        {others.length > 0 ? (
          <ul className="pk-grid pk-list">
            {others.map((x) => (
              <OtherKey key={x.name} secret={x} writable={writable} onChanged={refresh} />
            ))}
          </ul>
        ) : (
          <p className="small muted">{t("pk_other_empty")}</p>
        )}
      </section>

      <p className="small muted">{t("pk_docs", { pt: "docs/jgates/seguranca.pt-BR.md", en: "docs/jgates/seguranca.en.md" })}</p>
    </div>
  );
}
