import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import { ErrorNotice, Pill, Spinner, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t } from "../../i18n";
import { KeyControl } from "../providers/key";
import { providerPath, type ModelsAnswer, type ProviderEntry, type ProvidersData, type SecretsData, type SecretView } from "../providers/model";
import { DetectBar } from "./detect-bar";
import { ModelPicker,type ModelValue } from "./model-picker";
import "./setup.css";
import { apiReadiness, CLI_IDS, cliReadiness, isCli, projectModel, providerChoice, providerLabel, savable, useCliStatus, type CliProvider, type Readiness, type SemanticInfo } from "./provider-model";

const PILL: Record<Readiness, { tone?: "green" | "gold" | "red" | "blue"; key: string }> = {
  ready: { tone: "green", key: "semprov_state_ready" },
  login: { tone: "gold", key: "semprov_state_login" },
  unknown: { tone: "blue", key: "semprov_state_unknown" },
  missing: { key: "semprov_state_missing" },
  checking: { key: "semprov_state_checking" },
  key: { tone: "gold", key: "semprov_state_key" },
  setup: { tone: "gold", key: "semprov_state_setup" },
  local: { tone: "blue", key: "semprov_state_local" },
};

/** Copies a command and says so; the accessible name says which command. */
function CopyCommand({ text, testid }: { text: string; testid: string }) {
  const toast = useToast();
  const copy = () => {
    const done = () => toast(t("semprov_copied"), "ok");
    const failed = () => toast(t("semprov_copy_failed"), "warn");
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, failed);
    else failed();
  };
  return (
    <div className="row wrap semprov-command">
      <code>{text}</code>
      <button type="button" className="btn" aria-label={t("semprov_copy_aria", { command: text })} data-testid={testid} onClick={copy}>
        <Icon name="copy" />
        {t("semprov_copy")}
      </button>
    </div>
  );
}

interface LoginNote {
  opened: boolean;
  display: string;
}

function cliDetail(cli: CliProvider | undefined, readiness: Readiness): string {
  if (!cli) return t("semprov_checking");
  const version = cli.version ? t("semprov_version", { version: cli.version }) : "";
  switch (readiness) {
    case "ready":
      return `${cli.login.method ? t("semprov_ready_method", { method: cli.login.method }) : t("semprov_ready")}${version}`;
    case "login":
      return `${t("semprov_login_needed")}${version}`;
    case "unknown":
      return `${t(cli.login.reason === "TIMEOUT" ? "semprov_unknown_timeout" : cli.id === "gemini-cli" ? "semprov_unknown_gemini" : "semprov_unknown")}${version}`;
    case "missing":
      return t("semprov_missing");
    default:
      return t("semprov_checking");
  }
}

/** One agent CLI: the radio, its live state, and the one action that moves it forward (Entrar, install, check again). */
function CliCard({
  id,
  cli,
  checked,
  checking,
  writable,
  onPick,
  onRecheck,
  onLogin,
  note,
  loginBusy,
}: {
  id: string;
  cli: CliProvider | undefined;
  checked: boolean;
  checking: boolean;
  writable: boolean;
  onPick: () => void;
  onRecheck: () => void;
  onLogin: () => void;
  note: LoginNote | null;
  loginBusy: boolean;
}) {
  const readiness = checking ? "checking" : cliReadiness(cli);
  const pill = PILL[readiness];
  const name = providerLabel(id);
  const detailId = useId();
  return (
    <div className="card flat stack tight semprov-card" data-provider={id} data-state={readiness} data-checked={checked}>
      <label className="row semprov-pick">
        <input type="radio" name="semprov-provider" value={id} checked={checked} onChange={onPick} aria-describedby={detailId} />
        <strong className="grow">{name}</strong>
        <Pill {...(pill.tone ? { tone: pill.tone } : {})}>{checking ? <Spinner /> : null}{t(pill.key)}</Pill>
      </label>
      <p className="small muted" id={detailId}>
        {cliDetail(cli, readiness)}
      </p>
      {cli && readiness === "missing" ? (
        <div className="stack tight">
          <p className="small">{t("semprov_install_how", { name })}</p>
          <CopyCommand text={cli.install} testid={`semprov-install-copy-${id}`} />
        </div>
      ) : null}
      {note ? (
        <div className="notice" role="status" data-testid={`semprov-login-note-${id}`}>
          <Icon name="terminal" />
          <div className="stack tight">
            {note.opened ? <p className="small">{t("semprov_login_opened", { name, command: note.display })}</p> : <p className="small">{t("semprov_login_copy", { name })}</p>}
            {!note.opened ? <CopyCommand text={note.display} testid={`semprov-login-copy-${id}`} /> : null}
          </div>
        </div>
      ) : null}
      {cli && readiness !== "ready" && readiness !== "checking" ? (
        <div className="row wrap">
          {readiness === "login" || readiness === "unknown" ? (
            writable ? (
              <button type="button" className={`btn${readiness === "login" ? " primary" : ""}`} disabled={loginBusy} aria-label={t("semprov_login_aria", { name })} data-testid={`semprov-login-${id}`} onClick={onLogin}>
                {loginBusy ? <Spinner /> : <Icon name="terminal" />}
                {t("semprov_login")}
              </button>
            ) : (
              <CopyCommand text={cli.loginCommand.display} testid={`semprov-login-copy-${id}`} />
            )
          ) : null}
          <button type="button" className="btn" aria-label={t("semprov_recheck_aria", { name })} data-testid={`semprov-recheck-${id}`} onClick={onRecheck}>
            <Icon name="refresh" />
            {t("semprov_recheck")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** One API provider or connection: the radio, whether its key (or base URL) is there, and the key field when chosen. */
function ApiCard({ entry, secret, checked, writable, onPick, onChanged }: { entry: ProviderEntry; secret: SecretView | undefined; checked: boolean; writable: boolean; onPick: () => void; onChanged: () => void }) {
  const readiness = apiReadiness(entry, secret);
  const pill = PILL[readiness];
  const detailId = useId();
  const name = entry.kind === "connection" ? entry.name : providerLabel(entry.name);
  const detail =
    readiness === "setup"
      ? t("semprov_api_setup")
      : !entry.key
        ? t("semprov_api_no_key", { url: entry.baseUrl.value ?? "" })
        : readiness === "ready"
          ? t(secret?.source === "env" ? "semprov_api_key_env" : "semprov_api_key_set", { key: entry.key.name })
          : t("semprov_api_key_missing", { key: entry.key.name });
  return (
    <div className="card flat stack tight semprov-card" data-provider={entry.name} data-state={readiness} data-checked={checked}>
      <label className="row semprov-pick">
        <input type="radio" name="semprov-provider" value={entry.name} checked={checked} onChange={onPick} aria-describedby={detailId} />
        <strong className="grow">{name}</strong>
        <Pill {...(pill.tone ? { tone: pill.tone } : {})}>{t(pill.key)}</Pill>
      </label>
      <p className="small muted" id={detailId}>
        {entry.kind === "connection" ? `${t("semprov_connection")} · ` : ""}
        {detail}
      </p>
      {checked && readiness === "setup" ? (
        <p className="small">
          <a href="#/semantic/providers">{t("semprov_api_setup_link")}</a>
        </p>
      ) : null}
      {checked && entry.key && readiness !== "setup" ? <KeyControl name={entry.key.name} secret={secret} writable={writable} onChanged={onChanged} /> : null}
    </div>
  );
}

export interface ProviderPickerProps {
  semantic: SemanticInfo;
  onSaved: (next: SemanticInfo) => void;
  /** Reloads GET /api/semantic (after a revision conflict). */
  onReload: () => void;
  /** Shown as "Manter o atual" when the project already has a provider. */
  onCancel?: () => void;
  saveLabel: string;
}

/**
 * "Quem vai fazer a revisão por IA?": the agent CLIs (installed, logged in, models) and the API providers (key present
 * or not) as one radio group, then the model, then Save, which writes jgates.yml > extensions.semantic-gate.
 */
export function ProviderPicker({ semantic, onSaved, onReload, onCancel, saveLabel }: ProviderPickerProps) {
  const toast = useToast();
  const titleId = useId();
  const cli = useCliStatus();
  const [tick, setTick] = useState(0);
  const providers = useAsync(() => api<ProvidersData>("GET", "/api/providers"), `semprov-providers:${tick}`);
  const secrets = useAsync(() => api<SecretsData>("GET", "/api/secrets"), `semprov-secrets:${tick}`);
  const [choice, setChoice] = useState<string | null>(semantic.provider);
  const saved = projectModel(semantic);
  const [model, setModel] = useState<ModelValue>(saved);
  const modelTouched = useRef(semantic.provider !== null);
  const [notes, setNotes] = useState<Record<string, LoginNote>>({});
  const [loginBusy, setLoginBusy] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<unknown>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [apiModels, setApiModels] = useState<Record<string, ModelsAnswer>>({});
  const [apiModelsBusy, setApiModelsBusy] = useState<string | null>(null);
  // The APIs are folded unless the project already uses one, or no agent CLI is installed.
  const [apiOpen, setApiOpen] = useState(semantic.provider !== null && !isCli(semantic.provider));
  const noCli = cli.data !== null && !cli.data.providers.some((p) => p.installed);
  useEffect(() => {
    if (noCli) setApiOpen(true);
  }, [noCli]);

  const cliById = useMemo(() => new Map((cli.data?.providers ?? []).map((p) => [p.id, p])), [cli.data]);
  const httpEntries = (providers.data?.providers ?? []).filter((e) => e.type !== "cli");
  const secretByName = useMemo(() => new Map((secrets.data?.secrets ?? []).map((s) => [s.name, s])), [secrets.data]);
  const entry = httpEntries.find((e) => e.name === choice);
  const isCliChoice = choice !== null && (CLI_IDS as readonly string[]).includes(choice);
  const chosenCli = isCliChoice ? cliById.get(choice as string) : undefined;
  const userWritable = providers.data?.writable === true && secrets.data?.writable === true;
  const editable = semantic.form.editable;

  // Nothing chosen yet: the first agent CLI that is ready is preselected (the shortest path).
  useEffect(() => {
    if (choice !== null || !cli.data) return;
    const ready = CLI_IDS.find((id) => cliReadiness(cliById.get(id)) === "ready");
    if (ready) setChoice(ready);
  }, [choice, cli.data, cliById]);

  // The model follows the provider until the person picks one. With a default of the user's own (Provedores e chaves)
  // the default is kept (null: the project follows it); otherwise a CLI preselects the model its own configuration
  // names, or the first it lists.
  const userDefault = (id: string | null): string | null => (id === null ? null : (providers.data?.providers.find((e) => e.name === id)?.model.value ?? null));
  const defaultFor = (id: string | null): ModelValue => (id !== null && isCli(id) && !userDefault(id) ? (cliById.get(id)?.models?.suggestedDefault ?? null) : null);
  const suggested = defaultFor(choice);
  useEffect(() => {
    if (modelTouched.current) return;
    setModel(suggested);
  }, [choice, suggested]);

  // An API provider with its key: list its models once (a listing spends no tokens).
  useEffect(() => {
    if (!entry || apiModels[entry.name] || apiModelsBusy) return;
    if (!savable(apiReadiness(entry, entry.key ? secretByName.get(entry.key.name) : undefined)) || entry.name === "openai-compatible") return;
    setApiModelsBusy(entry.name);
    api<ModelsAnswer>("POST", providerPath(entry.name, "/test")).then(
      (answer) => setApiModels((m) => ({ ...m, [entry.name]: answer })),
      () => setApiModels((m) => ({ ...m, [entry.name]: { name: entry.name, count: 0, models: [], truncated: false, defaultModelListed: null } })),
    ).finally(() => setApiModelsBusy(null));
  }, [entry, apiModels, apiModelsBusy, secretByName]);

  // After Entrar, the CLI is checked again each time this window gets the focus back, until it is logged in.
  const recheck = cli.recheck;
  useEffect(() => {
    if (!waiting) return;
    const onFocus = () => void recheck(waiting);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [waiting, recheck]);
  useEffect(() => {
    if (waiting && cliReadiness(cliById.get(waiting)) === "ready") {
      toast(t("semprov_login_done", { name: providerLabel(waiting) }), "ok");
      setNotes((n) => {
        const { [waiting]: _done, ...rest } = n;
        return rest;
      });
      setWaiting(null);
    }
  }, [waiting, cliById, toast]);

  const pick = (id: string) => {
    if (id === choice) return;
    setChoice(id);
    setError(null);
    modelTouched.current = id === semantic.provider;
    setModel(id === semantic.provider ? saved : defaultFor(id));
  };

  const login = async (id: string) => {
    setLoginBusy(id);
    setLoginError(null);
    try {
      const r = await api<{ opened: boolean; command: { display: string } }>("POST", providerPath(id, "/login"));
      setNotes((n) => ({ ...n, [id]: { opened: r.opened, display: r.command.display } }));
      setWaiting(id);
    } catch (e) {
      setLoginError(e);
    } finally {
      setLoginBusy(null);
    }
  };

  const readiness: Readiness | null = choice === null ? null : isCliChoice ? (cli.checking.has(choice) ? "checking" : cliReadiness(chosenCli)) : entry ? apiReadiness(entry, entry.key ? secretByName.get(entry.key.name) : undefined) : semantic.provider === choice ? "ready" : "checking";
  const modelRequired = !isCliChoice && entry !== undefined && !entry.model.value;
  const modelMissing = modelRequired && (model === null || model.trim() === "");
  const otherEmpty = model !== null && model.trim() === "";
  const blockReason =
    choice === null
      ? t("semprov_why_choose")
      : readiness === "missing"
        ? t("semprov_why_missing", { name: providerLabel(choice) })
        : readiness === "login"
          ? t("semprov_why_login", { name: providerLabel(choice) })
          : readiness === "key"
            ? t("semprov_why_key", { key: entry?.key?.name ?? "" })
            : readiness === "setup"
              ? t("semprov_why_setup")
              : readiness === "checking"
                ? t("semprov_why_checking")
                : modelMissing || otherEmpty
                  ? t("semprov_why_model")
                  : null;
  const canSave = editable && blockReason === null && readiness !== null && savable(readiness) && !busy;

  const save = async () => {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ save: { status: "saved" | "unchanged" }; semantic: SemanticInfo }>("PUT", "/api/config/semantic/provider", { expectedRevision: semantic.form.revision, provider: choice, model: model === null || model.trim() === "" ? null : model.trim() });
      toast(t(r.save.status === "saved" ? "semprov_saved" : "semprov_unchanged", { summary: providerChoice(r.semantic), file: semantic.form.file }), "ok");
      onSaved(r.semantic);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  // The model control of the chosen provider.
  let modelControl = null;
  if (choice !== null && readiness !== "missing" && readiness !== "setup") {
    if (isCliChoice) {
      const m = chosenCli?.models ?? null;
      const name = providerLabel(choice);
      const help = !m
        ? t("semprov_models_loading")
        : [
            m.problem ? t("semprov_models_problem", { name }) : m.source === "cli" ? t("semprov_models_cli", { name, count: m.list.length }) : m.source === "suggested" ? t("semprov_models_suggested", { name }) : t("semprov_models_none", { name }),
            m.configured ? t("semprov_models_configured", { name, model: m.configured }) : "",
          ]
            .filter(Boolean)
            .join(" ");
      modelControl = (
        <ModelPicker
          key={choice}
          models={m?.list ?? []}
          value={model}
          onChange={(v) => {
            modelTouched.current = true;
            setModel(v);
          }}
          defaultLabel={userDefault(choice) ? t("semprov_model_default_user", { model: userDefault(choice) as string }) : m?.configured ? t("semprov_model_default_cli_configured", { name, model: m.configured }) : t("semprov_model_default_cli", { name })}
          help={help}
          loading={!m && cli.modelsLoading}
          disabled={!editable}
        />
      );
    } else if (entry) {
      const answer = apiModels[entry.name];
      const list = [...new Set([...(entry.model.value ? [entry.model.value] : []), ...(answer?.models ?? [])])];
      modelControl = (
        <ModelPicker
          key={choice}
          models={list}
          value={model}
          onChange={(v) => {
            modelTouched.current = true;
            setModel(v);
          }}
          defaultLabel={entry.model.value ? t("semprov_model_default_user", { model: entry.model.value }) : null}
          help={answer && answer.models.length > 0 ? t("semprov_models_api", { count: answer.count }) : t("semprov_models_api_none")}
          loading={apiModelsBusy === entry.name}
          disabled={!editable}
        />
      );
    }
  }

  const cliIds = CLI_IDS as readonly string[];
  const known = choice === null || cliIds.includes(choice) || httpEntries.some((e) => e.name === choice);

  return (
    <section className="card flat stack semprov" aria-labelledby={titleId} data-testid="semprov-step">
      <div>
        <h2 id={titleId}>{t("semprov_title")}</h2>
        <p className="small muted">{t("semprov_lead", { file: semantic.form.file })}</p>
      </div>
      {semantic.form.locked ? (
        <div className="notice warn" role="status" data-testid="semprov-locked">
          <Icon name="lock" />
          <p className="small">{t("semprov_locked", { policy: semantic.form.locked.policy })}</p>
        </div>
      ) : !semantic.form.available && semantic.form.unavailable ? (
        <div className="notice warn" role="status">
          <Icon name="alert" />
          <p className="small">{semantic.form.unavailable.message}</p>
        </div>
      ) : null}
      {cli.error ? <ErrorNotice error={cli.error} onRetry={() => void cli.recheck()} /> : null}
      {providers.error ? <ErrorNotice error={providers.error} onRetry={providers.reload} /> : null}
      {loginError ? <ErrorNotice error={loginError} /> : null}

      <div className="stack tight">
        <h3 id={`${titleId}-cli`}>
          {t("semprov_cli_title")} <Pill tone="green">{t("semprov_recommended")}</Pill>
        </h3>
        <p className="small muted">{t("semprov_cli_lead")}</p>
        <DetectBar data={cli.data} busy={CLI_IDS.some((id) => cli.checking.has(id)) || (!cli.data && !cli.error)} onDetect={() => void cli.recheck()} testId="semprov-detect" />
        <div role="radiogroup" aria-labelledby={`${titleId}-cli`} className="semprov-grid" data-testid="semprov-cli">
          {CLI_IDS.map((id) => (
            <CliCard
              key={id}
              id={id}
              cli={cliById.get(id)}
              checked={choice === id}
              checking={cli.checking.has(id) || (!cli.data && !cli.error)}
              writable={userWritable}
              onPick={() => pick(id)}
              onRecheck={() => void cli.recheck(id)}
              onLogin={() => void login(id)}
              note={notes[id] ?? null}
              loginBusy={loginBusy === id}
            />
          ))}
        </div>
      </div>

      <details className="semprov-api" open={apiOpen} onToggle={(e) => setApiOpen((e.target as HTMLDetailsElement).open)} data-testid="semprov-api-section">
        <summary>
          <span id={`${titleId}-api`} className="semprov-api-title">
            {t("semprov_api_title")}
          </span>{" "}
          <span className="small muted">{t("semprov_api_count", { count: httpEntries.length })}</span>
        </summary>
        <div className="stack tight">
        <p className="small muted">{t("semprov_api_lead")}</p>
        {providers.data && secrets.data ? (
          <div role="radiogroup" aria-labelledby={`${titleId}-api`} className="semprov-grid" data-testid="semprov-api">
            {httpEntries.map((e) => (
              <ApiCard
                key={e.name}
                entry={e}
                secret={e.key ? secretByName.get(e.key.name) : undefined}
                checked={choice === e.name}
                writable={userWritable}
                onPick={() => pick(e.name)}
                onChanged={() => {
                  setApiModels((m) => {
                    const { [e.name]: _old, ...rest } = m;
                    return rest;
                  });
                  setTick((n) => n + 1);
                }}
              />
            ))}
          </div>
        ) : providers.error ? null : (
          <p className="spinner-text small" role="status">
            {t("semprov_api_loading")}
          </p>
        )}
        </div>
      </details>

      {!known ? (
        <p className="small" data-testid="semprov-unknown">
          {t("semprov_current_unknown", { provider: choice ?? "" })}
        </p>
      ) : null}

      {modelControl}

      {error ? <ErrorNotice error={error} {...(error instanceof ApiError && error.code === "REVISION_CONFLICT" ? { onRetry: onReload } : {})} /> : null}

      <div className="stack tight">
        {editable && blockReason ? (
          <p className="small" role="status" data-testid="semprov-why">
            {blockReason}
          </p>
        ) : null}
        <div className="row wrap">
          {editable ? (
            <button type="button" className="btn primary" disabled={!canSave} data-testid="semprov-save" onClick={() => void save()}>
              {busy ? <Spinner /> : <Icon name="check" />}
              {saveLabel}
            </button>
          ) : null}
          {onCancel ? (
            <button type="button" className="btn" disabled={busy} data-testid="semprov-cancel" onClick={onCancel}>
              {t("semprov_keep")}
            </button>
          ) : null}
        </div>
        <p className="small muted">
          {t("semprov_defaults_note")} <a href="#/semantic/providers">{t("semprov_defaults_link")}</a>
        </p>
      </div>
    </section>
  );
}
