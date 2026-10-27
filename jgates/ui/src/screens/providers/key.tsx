import { useId, useRef, useState } from "react";
import { api } from "../../api";
import { Dialog, ErrorNotice } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t } from "../../i18n";
import { formatDate, secretPath, type SecretView } from "./model";

/** The mask a set key shows: fixed length, nothing of the value (the server never sends one). */
export const MASK = "********";

/** The state of a key as text: the mask and the date, the variable of the environment, or absent. */
export function keyStateText(secret: Pick<SecretView, "state" | "source" | "envName" | "updatedAt" | "inVault"> | undefined): string {
  if (!secret || secret.state === "unset") return t("pk_key_unset");
  if (secret.source === "env") return t("pk_key_env", { name: secret.envName ?? "" });
  const date = formatDate(secret.updatedAt);
  return date ? t("pk_key_vault_dated", { mask: MASK, date }) : t("pk_key_vault", { mask: MASK });
}

function RemoveDialog({ name, onClose, onDone }: { name: string; onClose: () => void; onDone: (secret: SecretView, envWins: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ secret: SecretView; environmentWins: boolean }>("DELETE", secretPath(name));
      onDone(r.secret, r.environmentWins);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("pk_key_remove_title", { name })} onClose={onClose}>
      <div className="stack">
        <p>{t("pk_key_remove_lead", { name })}</p>
        {error ? <ErrorNotice error={error} /> : null}
        <div className="row wrap">
          <button type="button" className="btn danger" disabled={busy} onClick={() => void remove()}>
            <Icon name="x" />
            {t("pk_key_remove_confirm")}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t("pk_cancel")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * A key of the store: the state (******** and the date, the environment, or absent) and the actions Gravar/Trocar
 * and Remover. The value is typed in a password field that is not a controlled input, so it never becomes an
 * attribute of the page; it is sent once and the field is emptied. Nothing of it goes to the browser storage.
 */
export function KeyControl({ name, secret, writable, onChanged }: { name: string; secret: SecretView | undefined; writable: boolean; onChanged: () => void }) {
  const toast = useToast();
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [filled, setFilled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [removing, setRemoving] = useState(false);
  const set = secret?.state === "set";
  const fromEnv = secret?.source === "env";

  const clear = () => {
    if (field.current) field.current.value = "";
    setFilled(false);
  };
  const close = () => {
    clear();
    setEditing(false);
    setError(null);
  };
  const save = async () => {
    const value = field.current?.value ?? "";
    if (value.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ secret: SecretView; environmentWins: boolean }>("PUT", secretPath(name), { value });
      close();
      if (r.environmentWins) toast(t("pk_key_saved_env_wins", { name, env: r.secret.envName ?? name }), "warn");
      else toast(t("pk_key_saved", { name }), "ok");
      onChanged();
    } catch (e) {
      // The field keeps nothing typed after a refusal either: the value is never kept around.
      clear();
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pk-key stack tight" data-testid={`key-${name}`}>
      <div className="between wrap">
        <span className="row wrap">
          <Icon name="lock" />
          <span className="field-label">{t("pk_key_label")}</span>
          <code>{name}</code>
        </span>
        <span className="pk-key-state" data-testid={`key-state-${name}`} data-state={secret?.state ?? "unset"} data-source={secret?.source ?? "none"}>
          {keyStateText(secret)}
        </span>
      </div>
      {fromEnv ? (
        <div className="notice warn" role="note">
          <Icon name="alert" />
          <p className="small">{secret?.inVault ? t("pk_key_env_wins_stored", { env: secret?.envName ?? name }) : t("pk_key_env_wins", { env: secret?.envName ?? name })}</p>
        </div>
      ) : null}
      {editing ? (
        <form
          className="stack tight"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="field-label" htmlFor={`${id}-value`}>
            {set ? t("pk_key_new_value", { name }) : t("pk_key_value", { name })}
          </label>
          <div className="row wrap">
            <input
              ref={field}
              id={`${id}-value`}
              className="input grow pk-secret"
              type="password"
              name={`secret-${name}`}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              data-testid={`key-input-${name}`}
              aria-describedby={`${id}-hint`}
              onInput={(e) => setFilled((e.target as HTMLInputElement).value.trim() !== "")}
            />
            <button type="submit" className="btn primary" disabled={busy || !filled} aria-label={t("pk_key_save_aria", { name })}>
              <Icon name="check" />
              {t("pk_key_save")}
            </button>
            <button type="button" className="btn" onClick={close}>
              {t("pk_cancel")}
            </button>
          </div>
          <p className="small muted" id={`${id}-hint`}>
            {fromEnv ? t("pk_key_hint_env", { env: secret?.envName ?? name }) : t("pk_key_hint")}
          </p>
        </form>
      ) : writable ? (
        <div className="row wrap">
          <button type="button" className="btn" aria-label={t(set && !fromEnv ? "pk_key_change_aria" : "pk_key_set_aria", { name })} onClick={() => setEditing(true)}>
            <Icon name="lock" />
            {set && !fromEnv ? t("pk_key_change") : t("pk_key_set")}
          </button>
          {secret?.inVault ? (
            <button type="button" className="btn danger" aria-label={t("pk_key_remove_aria", { name })} onClick={() => setRemoving(true)}>
              <Icon name="x" />
              {t("pk_key_remove")}
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
      {removing ? (
        <RemoveDialog
          name={name}
          onClose={() => setRemoving(false)}
          onDone={(after, envWins) => {
            setRemoving(false);
            toast(envWins ? t("pk_key_removed_env", { name, env: after.envName ?? name }) : t("pk_key_removed", { name }), envWins ? "warn" : "ok");
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}
