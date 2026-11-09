import { useEffect, useId, useMemo, useState } from "react";
import { api } from "../../api";
import { ErrorNotice, Pill, Spinner } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t } from "../../i18n";
import { ModelPicker, type ModelValue } from "../semantic-setup/model-picker";
import { cliReadiness, providerLabel, useCliStatus, type CliProvider, type Readiness } from "../semantic-setup/provider-model";
import { fieldErrors, originText, RemoveConnectionDialog, typeLabel } from "./card";
import { providerPath, type ProviderEntry } from "./model";
// The cards share the look of the provider step (command rows, model picker).
import "../semantic-setup/setup.css";

// The agent CLIs on Provedores e chaves: the same live state the provider step of the Semantic setup shows (installed,
// logged in, version, path), the one action that moves each forward (Entrar, install, Verificar de novo), and the
// default model for every project, chosen from the models the CLI itself lists. JGates never reads a credential.

const PILL: Partial<Record<Readiness, { tone?: "green" | "gold" | "blue"; key: string }>> = {
  ready: { tone: "green", key: "semprov_state_ready" },
  login: { tone: "gold", key: "semprov_state_login" },
  unknown: { tone: "blue", key: "semprov_state_unknown" },
  missing: { key: "semprov_state_missing" },
  checking: { key: "semprov_state_checking" },
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

/** "Instalado e com login feito (método) · versão 1.2": the line under the name. */
export function cliDetail(cli: CliProvider | undefined, readiness: Readiness): string {
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

/** The model a CLI uses when nothing else names one: its own default, with the one its configuration names. */
function followText(name: string, cli: CliProvider | undefined): string {
  const configured = cli?.models?.configured ?? null;
  return configured ? t("pk_cli_model_follow_configured", { name, model: configured }) : t("pk_cli_model_follow", { name });
}

function modelsHelp(name: string, cli: CliProvider | undefined): string {
  const m = cli?.models ?? null;
  const source = !m
    ? ""
    : m.problem
      ? t("semprov_models_problem", { name })
      : m.source === "cli"
        ? t("semprov_models_cli", { name, count: m.list.length })
        : m.source === "suggested"
          ? t("semprov_models_suggested", { name })
          : t("semprov_models_none", { name });
  return [t("pk_cli_model_help", { name }), source].filter(Boolean).join(" ");
}

/** Configurar of a CLI: only the default model, from the CLI's own list (or "Outro…"). Empty follows the CLI. */
function CliPrefsForm({ entry, cli, modelsLoading, revision, onSaved, onCancel }: { entry: ProviderEntry; cli: CliProvider | undefined; modelsLoading: boolean; revision: string | null; onSaved: (revision: string | null) => void; onCancel: () => void }) {
  const toast = useToast();
  const name = providerLabel(entry.name);
  const initial: ModelValue = entry.model.origin === "user" && entry.model.value ? entry.model.value : null;
  const [model, setModel] = useState<ModelValue>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const list = useMemo(() => [...new Set([...(cli?.models?.list ?? []), ...(initial ? [initial] : [])])], [cli, initial]);
  const problem = fieldErrors(error).get("model");
  const save = async () => {
    const next = model === null || model.trim() === "" ? null : model.trim();
    if (next === initial) {
      onCancel();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ revision: string | null }>("PUT", providerPath(entry.name), { expectedRevision: revision, model: next });
      toast(t("pk_saved", { name: entry.name }), "ok");
      onSaved(r.revision);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="stack tight pk-form"
      aria-label={t("pk_configure_form", { name: entry.name })}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <ModelPicker
        models={list}
        value={model}
        onChange={setModel}
        defaultLabel={followText(name, cli)}
        help={problem ?? modelsHelp(name, cli)}
        loading={!cli?.models && modelsLoading}
        disabled={busy}
        label={t("pk_field_model")}
        testId={`pk-cli-model-${entry.name}`}
      />
      {error && !problem ? <ErrorNotice error={error} /> : null}
      <div className="row wrap">
        <button type="submit" className="btn primary" disabled={busy} aria-label={t("pk_save_aria", { name: entry.name })}>
          {busy ? <Spinner /> : <Icon name="check" />}
          {t("pk_save")}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {t("pk_cancel")}
        </button>
      </div>
    </form>
  );
}

interface LoginNote {
  opened: boolean;
  display: string;
}

/** One agent CLI: its live state, the action that moves it forward, and its default model for every project. */
function CliCard({
  entry,
  cli,
  checking,
  modelsLoading,
  writable,
  revision,
  note,
  loginBusy,
  onLogin,
  onRecheck,
  onChanged,
}: {
  entry: ProviderEntry;
  cli: CliProvider | undefined;
  checking: boolean;
  modelsLoading: boolean;
  writable: boolean;
  revision: string | null;
  note: LoginNote | null;
  loginBusy: boolean;
  onLogin: () => void;
  onRecheck: () => void;
  onChanged: (revision?: string | null) => void;
}) {
  const toast = useToast();
  const titleId = useId();
  const [editing, setEditing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const id = entry.name;
  const name = providerLabel(id);
  const readiness: Readiness = checking ? "checking" : cliReadiness(cli);
  const pill = PILL[readiness] ?? { key: "semprov_state_checking" };
  const userModel = entry.model.origin === "user" && entry.model.value !== null;

  return (
    <article className="card flat stack pk-card pk-cli-card" aria-labelledby={titleId} data-testid={`provider-${id}`} data-state={readiness}>
      <div className="between wrap">
        <h3 id={titleId}>{name}</h3>
        <div className="row wrap pk-pills">
          <Pill>{typeLabel(entry)}</Pill>
          <Pill {...(pill.tone ? { tone: pill.tone } : {})}>
            {readiness === "checking" ? <Spinner /> : null}
            {t(pill.key)}
          </Pill>
        </div>
      </div>
      <div className="stack tight">
        <p className="small" data-testid={`pk-cli-detail-${id}`}>
          {cliDetail(cli, readiness)}
        </p>
        {cli?.path ? (
          <p className="small muted pk-cli-path" data-testid={`pk-cli-path-${id}`}>
            {t("pk_cli_path")} <code>{cli.path}</code>
          </p>
        ) : null}
      </div>

      {cli && readiness === "missing" ? (
        <div className="stack tight">
          <p className="small">{t("semprov_install_how", { name })}</p>
          <CopyCommand text={cli.install} testid={`pk-cli-install-copy-${id}`} />
        </div>
      ) : null}
      {note ? (
        <div className="notice" role="status" data-testid={`pk-cli-login-note-${id}`}>
          <Icon name="terminal" />
          <div className="stack tight">
            {note.opened ? <p className="small">{t("semprov_login_opened", { name, command: note.display })}</p> : <p className="small">{t("semprov_login_copy", { name })}</p>}
            {!note.opened ? <CopyCommand text={note.display} testid={`pk-cli-login-copy-${id}`} /> : null}
          </div>
        </div>
      ) : null}
      {cli && readiness !== "ready" && readiness !== "checking" ? (
        <div className="row wrap">
          {readiness === "login" || readiness === "unknown" ? (
            writable ? (
              <button type="button" className={`btn${readiness === "login" ? " primary" : ""}`} disabled={loginBusy} aria-label={t("semprov_login_aria", { name })} data-testid={`pk-cli-login-${id}`} onClick={onLogin}>
                {loginBusy ? <Spinner /> : <Icon name="terminal" />}
                {t("semprov_login")}
              </button>
            ) : (
              <CopyCommand text={cli.loginCommand.display} testid={`pk-cli-login-copy-${id}`} />
            )
          ) : null}
          <button type="button" className="btn" aria-label={t("semprov_recheck_aria", { name })} data-testid={`pk-cli-recheck-${id}`} onClick={onRecheck}>
            <Icon name="refresh" />
            {t("semprov_recheck")}
          </button>
        </div>
      ) : null}

      <dl className="kv">
        <dt>{t("pk_field_model")}</dt>
        <dd data-testid={`model-${id}`}>
          {entry.model.value ? (
            <>
              <code>{entry.model.value}</code> <span className="muted">({originText(entry.model)})</span>
            </>
          ) : (
            <span className="muted">{followText(name, cli)}</span>
          )}
        </dd>
      </dl>
      {editing ? (
        <CliPrefsForm
          entry={entry}
          cli={cli}
          modelsLoading={modelsLoading}
          revision={revision}
          onCancel={() => setEditing(false)}
          onSaved={(next) => {
            setEditing(false);
            onChanged(next);
          }}
        />
      ) : writable ? (
        <div className="row wrap">
          <button type="button" className="btn" aria-label={t("pk_configure_aria", { name: id })} onClick={() => setEditing(true)}>
            <Icon name="settings" />
            {t("pk_configure")}
          </button>
          {userModel ? (
            <button type="button" className="btn danger" aria-label={t("pk_reset_aria", { name: id })} onClick={() => setResetting(true)}>
              <Icon name="x" />
              {t("pk_reset")}
            </button>
          ) : null}
        </div>
      ) : null}
      {resetting ? (
        <RemoveConnectionDialog
          entry={entry}
          revision={revision}
          onClose={() => setResetting(false)}
          onDone={() => {
            setResetting(false);
            toast(t("pk_reset_done", { name: id }), "ok");
            onChanged();
          }}
        />
      ) : null}
    </article>
  );
}

/**
 * The four agent CLIs with their live state. After Entrar the CLI is checked again each time this window gets the
 * focus back, until it is logged in.
 */
export function CliProviders({ entries, writable, revision, onChanged }: { entries: ProviderEntry[]; writable: boolean; revision: string | null; onChanged: (revision?: string | null) => void }) {
  const toast = useToast();
  const status = useCliStatus();
  const [notes, setNotes] = useState<Record<string, LoginNote>>({});
  const [loginBusy, setLoginBusy] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<unknown>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  const byId = useMemo(() => new Map((status.data?.providers ?? []).map((p) => [p.id, p])), [status.data]);

  const recheck = status.recheck;
  useEffect(() => {
    if (!waiting) return;
    const onFocus = () => void recheck(waiting);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [waiting, recheck]);
  useEffect(() => {
    if (waiting && cliReadiness(byId.get(waiting)) === "ready") {
      toast(t("semprov_login_done", { name: providerLabel(waiting) }), "ok");
      setNotes((n) => {
        const { [waiting]: _done, ...rest } = n;
        return rest;
      });
      setWaiting(null);
    }
  }, [waiting, byId, toast]);

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

  return (
    <>
      {status.error ? <ErrorNotice error={status.error} onRetry={() => void status.recheck()} /> : null}
      {loginError ? <ErrorNotice error={loginError} /> : null}
      <div className="pk-grid" data-testid="pk-cli-cards">
        {entries.map((e) => (
          <CliCard
            key={e.name}
            entry={e}
            cli={byId.get(e.name)}
            checking={status.checking.has(e.name) || (!status.data && !status.error)}
            modelsLoading={status.modelsLoading}
            writable={writable}
            revision={revision}
            note={notes[e.name] ?? null}
            loginBusy={loginBusy === e.name}
            onLogin={() => void login(e.name)}
            onRecheck={() => void status.recheck(e.name)}
            onChanged={onChanged}
          />
        ))}
      </div>
    </>
  );
}
