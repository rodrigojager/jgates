import { useMemo, useState } from "react";
import { api, ApiError } from "../../../api";
import { ErrorNotice, Loading, Pill, useAsync } from "../../../components/common";
import { Icon } from "../../../components/icons";
import { useToast } from "../../../components/Toast";
import { FormRenderer } from "../../../forms/FormRenderer";
import { intentsOf, withPending, type FieldView, type FormView, type Pending } from "../../../forms/model";
import { t } from "../../../i18n";

type Origin = "project" | "user" | "default" | "unset";
interface FieldValue {
  value: string | null;
  origin: Origin;
}

interface SemanticField {
  id: string;
  path: string[];
  documentPath: string;
  widget: "boolean" | "provider" | "text" | "select" | "number" | "string-list";
  schema: Record<string, any>;
  state: "set" | "inherited" | "unrecognized";
  value?: unknown;
  problems: string[];
}

interface SemanticForm {
  file: string;
  section: string[];
  exists: boolean;
  revision: string | null;
  available: boolean;
  unavailable: { code: string; message: string } | null;
  editable: boolean;
  locked: { reason: "governed"; policy: string } | null;
  fields: SemanticField[];
  providers: Array<{ name: string; kind: "http" | "cli" | "connection" | "other" }>;
  advanced: string[];
  docs: { pt: string; en: string };
}

interface SemanticInfo {
  state: "off" | "configured" | "invalid";
  provider: string | null;
  model: string | null;
  scope: "changed" | "full" | "paths" | null;
  problems: string[];
  effective: { kind: string; baseUrl: FieldValue; model: FieldValue; apiKeyEnv: FieldValue } | null;
  limits: { timeoutSeconds: number; maxContextChars: number; maxCalls: number } | null;
  cost: { reported: boolean; perCall: number | null };
  configFile: string;
  configKey: string;
  requestFlag: string;
  form: SemanticForm;
}

const TONE: Record<SemanticInfo["state"], "green" | "gold" | "red" | undefined> = { off: undefined, configured: "green", invalid: "red" };

/** Where each field of the card sits: the common group (what most projects set) or the advanced one. */
const LAYOUT: Record<string, { group: "common" | "advanced"; section: string; order: number }> = {
  enabled: { group: "common", section: "provider", order: 1 },
  provider: { group: "common", section: "provider", order: 2 },
  model: { group: "common", section: "provider", order: 3 },
  scope: { group: "common", section: "scope", order: 4 },
  paths: { group: "common", section: "scope", order: 5 },
  timeoutSeconds: { group: "common", section: "limits", order: 6 },
  maxCalls: { group: "common", section: "limits", order: 7 },
  maxContextChars: { group: "advanced", section: "limits", order: 8 },
  baseUrl: { group: "advanced", section: "gateway", order: 9 },
};
const DEFAULTS: Record<string, unknown> = { enabled: true, scope: "changed", timeoutSeconds: 120, maxCalls: 4, maxContextChars: 160_000 };
const UNITS: Record<string, string> = { timeoutSeconds: "semantic_unit_seconds", maxContextChars: "semantic_unit_chars" };

/**
 * The fields of the card as the forms engine shows them (FormRenderer): the server sends the state of each field in the
 * file (set, inherited, unrecognized) and the card adds the labels; the provider is a choice among the providers and the
 * connections of the user's preferences. An inherited model or base URL shows the value in effect and where it comes from.
 */
function formViewOf(info: SemanticInfo): FormView {
  const form = info.form;
  const inherited = (v: FieldValue | undefined): string | undefined => (v?.value && v.origin !== "project" ? `${v.value} (${t(`semantic_origin_${v.origin}`)})` : undefined);
  const fields: FieldView[] = form.fields.map((f) => {
    const layout = LAYOUT[f.id] ?? { group: "advanced" as const, section: "gateway", order: 99 };
    const schema = f.widget === "provider" ? { type: "string", enum: form.providers.map((p) => p.name) } : f.schema;
    const effective = f.id === "model" ? inherited(info.effective?.model) : f.id === "baseUrl" ? inherited(info.effective?.baseUrl) : undefined;
    const fallback = DEFAULTS[f.id] ?? effective;
    return {
      id: f.id,
      path: f.path,
      documentPath: f.documentPath,
      label: t(`semantic_f_${f.id}`),
      help: t(`semantic_h_${f.id}`),
      group: layout.group,
      section: layout.section,
      widget: f.widget === "provider" ? "select" : f.widget,
      order: layout.order,
      unit: UNITS[f.id] ? t(UNITS[f.id] as string) : null,
      example: f.id === "paths" ? "src/" : null,
      ordered: false,
      schema,
      state: f.state,
      ...(f.state !== "inherited" ? { value: f.value } : {}),
      ...(fallback !== undefined ? { defaultValue: fallback } : {}),
      problems: f.problems,
      position: null,
    };
  });
  return {
    form: { id: "semantic-gate", adapter: "semantic-gate", title: t("semantic_title") },
    instance: "semantic-gate",
    binding: "jgates.yml",
    document: { relPath: form.file, format: "yaml", exists: form.exists, state: form.editable ? "editable" : "read-only", sharedWith: [] },
    revision: form.revision,
    section: form.section,
    available: form.available,
    unavailable: form.unavailable ? { ...form.unavailable, position: null } : null,
    editable: form.editable,
    sections: ["provider", "scope", "limits", "gateway"].map((id) => ({ id, label: t(`semantic_s_${id}`) })),
    fields,
    unsupported: [],
  };
}

/** The form of the card: the forms engine over jgates.yml > extensions.semantic-gate, saved with the revision read. */
function SemanticForm({ info, onSaved, onClose }: { info: SemanticInfo; onSaved: () => void; onClose: () => void }) {
  const toast = useToast();
  const view = useMemo(() => formViewOf(info), [info]);
  const [pending, setPending] = useState<Map<string, Pending>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const conflict = error instanceof ApiError && error.code === "REVISION_CONFLICT";
  const connections = info.form.providers.filter((p) => p.kind === "connection").map((p) => p.name);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ save: { status: "saved" | "unchanged" } }>("PUT", "/api/config/semantic", { expectedRevision: info.form.revision, intents: intentsOf(pending) });
      toast(r.save.status === "saved" ? t("semantic_saved", { file: info.form.file }) : t("semantic_unchanged"), r.save.status === "saved" ? "ok" : "info");
      setPending(new Map());
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack"
      aria-label={t("semantic_form_label")}
      data-testid="semantic-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="small muted">{t("semantic_form_lead", { file: info.form.file, key: info.form.section.join(".") })}</p>
      <p className="small muted" data-testid="semantic-connections">
        {connections.length > 0 ? t("semantic_connections", { names: connections.join(", ") }) : t("semantic_connections_none")} <a href="#/preferences/providers">{t("semantic_providers_link")}</a>
      </p>
      <FormRenderer view={view} pending={pending} query="" readOnly={busy || conflict} onPending={(field, next) => setPending((p) => withPending(p, field, next))} openAt={() => (window.location.hash = "#/config/yaml")} />
      <div className="notice" data-testid="semantic-advanced">
        <Icon name="info" />
        <p className="small">
          {t("semantic_advanced", { keys: info.form.advanced.length > 0 ? info.form.advanced.join(", ") : t("semantic_advanced_none") })} <code>{info.form.docs.pt}</code> <span className="muted">({info.form.docs.en})</span>
        </p>
      </div>
      {error ? <ErrorNotice error={error} {...(conflict ? { onRetry: onSaved } : {})} /> : null}
      <div className="edit-bar">
        <span className="small" role="status">
          {pending.size === 0 ? t("semantic_pending_none") : t("semantic_pending", { count: pending.size })}
        </span>
        <div className="row wrap">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {t("semantic_close_form")}
          </button>
          <button type="button" className="btn" disabled={busy || pending.size === 0} onClick={() => setPending(new Map())}>
            {t("semantic_discard")}
          </button>
          <button type="submit" className="btn primary" disabled={busy || pending.size === 0 || conflict}>
            <Icon name="check" />
            {busy ? t("semantic_saving") : t("semantic_save", { file: info.form.file })}
          </button>
        </div>
      </div>
    </form>
  );
}

function Effective({ label, field }: { label: string; field: FieldValue | undefined }) {
  if (!field || field.value === null) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <code>{field.value}</code> <span className="muted">({t(`semantic_origin_${field.origin}`)})</span>
      </dd>
    </>
  );
}

/** Card of the optional semantic gate in the Ferramentas tab: off by default; the essential fields are edited in place. */
export function SemanticCard() {
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState(false);
  const info = useAsync(() => api<SemanticInfo>("GET", "/api/semantic"), `semantic-card:${tick}`);
  if (info.loading && !info.data) return <Loading />;
  if (info.error || !info.data) return <ErrorNotice error={info.error} onRetry={info.reload} />;
  const d = info.data;
  const form = d.form;
  return (
    <section className="card stack" aria-labelledby="semantic-title" data-testid="semantic-card">
      <div className="between wrap">
        <h2 id="semantic-title" className="row">
          <Icon name="sliders" />
          {t("semantic_title")}
        </h2>
        <span data-testid="semantic-state">
          <Pill {...(TONE[d.state] ? { tone: TONE[d.state] } : {})}>{t(`semantic_state_${d.state}`)}</Pill>
        </span>
      </div>
      <p className="small">{t("semantic_lead")}</p>
      <p className="small">{d.state === "off" ? t("semantic_off_hint", { key: d.configKey, file: d.configFile }) : t("semantic_configured_hint", { flag: d.requestFlag })}</p>
      {d.problems.length > 0 ? (
        <div className="notice warn" role="status">
          <Icon name="alert" />
          <div>
            <strong>{t("semantic_problems")}</strong>
            <ul>
              {d.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      <dl className="kv">
        <dt>{t("semantic_provider")}</dt>
        <dd data-testid="semantic-provider">{d.provider ?? t("semantic_not_set")}</dd>
        <dt>{t("semantic_model")}</dt>
        <dd data-testid="semantic-model">
          {d.model ?? t("semantic_not_set")} {d.effective?.model.value ? <span className="muted">({t(`semantic_origin_${d.effective.model.origin}`)})</span> : null}
        </dd>
        <Effective label={t("semantic_base_url")} field={d.effective?.baseUrl} />
        <Effective label={t("semantic_key_name")} field={d.effective?.apiKeyEnv} />
        <dt>{t("semantic_scope")}</dt>
        <dd>{d.scope ? t(`semantic_scope_${d.scope}`) : t("semantic_not_set")}</dd>
        {d.limits ? (
          <>
            <dt>{t("semantic_limits")}</dt>
            <dd>{t("semantic_limits_value", { seconds: d.limits.timeoutSeconds, calls: d.limits.maxCalls, chars: d.limits.maxContextChars })}</dd>
          </>
        ) : null}
        <dt>{t("semantic_cost")}</dt>
        <dd>{d.cost.reported ? t("semantic_cost_reported", { value: d.cost.perCall ?? 0 }) : t("semantic_cost_unknown")}</dd>
      </dl>
      {form.locked ? (
        <div className="notice warn" role="status" data-testid="semantic-locked">
          <Icon name="lock" />
          <p className="small">{t("semantic_locked", { policy: form.locked.policy })}</p>
        </div>
      ) : !form.available ? (
        <div className="notice warn" role="status" data-testid="semantic-unavailable">
          <Icon name="alert" />
          <p className="small">{form.unavailable?.message}</p>
        </div>
      ) : editing ? (
        <SemanticForm
          key={form.revision ?? "none"}
          info={d}
          onClose={() => setEditing(false)}
          onSaved={() => setTick((n) => n + 1)}
        />
      ) : (
        <div className="row wrap">
          <button type="button" className="btn" data-testid="semantic-edit" onClick={() => setEditing(true)}>
            <Icon name="settings" />
            {t("semantic_edit")}
          </button>
          <a className="btn" href="#/preferences/providers">
            <Icon name="lock" />
            {t("semantic_providers_link")}
          </a>
        </div>
      )}
    </section>
  );
}
