import { useState, type FormEvent } from "react";
import { ApiError, api } from "../../api";
import { Dialog } from "../../components/common";
import { Icon } from "../../components/icons";
import { t, tOr } from "../../i18n";

// Dialogs of the Tools tab that change .jgates/tools.yml: create, rename and remove an instance. The server patches the
// YAML text at the instance key only; a file that moved meanwhile is a conflict the dialog reports.

export interface CatalogAdapter {
  adapter: string;
  displayName: string;
  instantiable: boolean;
}

/** Message of a refusal of the instance routes, by code; any other failure shows the server text. */
export function Refusal({ error }: { error: unknown }) {
  const text = error instanceof ApiError ? tOr(`tools_err_${error.code}`, error.message) : t("error_network");
  return (
    <div className="notice error" role="alert">
      <Icon name="alert" />
      <p>{text}</p>
    </div>
  );
}

export function CreateDialog({ adapters, components, initialAdapter, existing, onClose, onDone }: { adapters: CatalogAdapter[]; components: string[]; initialAdapter: string | null; existing: string[]; onClose: () => void; onDone: (id: string) => void }) {
  const choices = adapters.filter((a) => a.instantiable);
  const [adapter, setAdapter] = useState(initialAdapter && choices.some((a) => a.adapter === initialAdapter) ? initialAdapter : (choices[0]?.adapter ?? ""));
  const [component, setComponent] = useState("");
  const suggest = (a: string, c: string) => {
    const base = `${a}${c ? `-${c}` : ""}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
    if (!existing.includes(base)) return base;
    for (let n = 2; n < 100; n++) if (!existing.includes(`${base}-${n}`)) return `${base}-${n}`;
    return base;
  };
  const [id, setId] = useState(() => suggest(adapter, ""));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const pick = (nextAdapter: string, nextComponent: string) => {
    setAdapter(nextAdapter);
    setComponent(nextComponent);
    if (!touched) setId(suggest(nextAdapter, nextComponent));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/api/tools", { id, adapter, component: component || null });
      onDone(id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const name = choices.find((a) => a.adapter === adapter)?.displayName ?? adapter;
  return (
    <Dialog title={initialAdapter ? t("tools_dialog_create_for", { tool: name }) : t("tools_dialog_create")} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="stack tight">
          <span>{t("tools_dialog_adapter")}</span>
          <select className="input" value={adapter} onChange={(e) => pick(e.target.value, component)}>
            {choices.map((a) => (
              <option key={a.adapter} value={a.adapter}>
                {a.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="stack tight">
          <span>{t("tools_dialog_component")}</span>
          <select className="input" value={component} onChange={(e) => pick(adapter, e.target.value)}>
            <option value="">{t("tools_dialog_component_none")}</option>
            {components.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="stack tight">
          <span>{t("tools_dialog_id")}</span>
          <input
            className="input"
            value={id}
            required
            autoComplete="off"
            spellCheck={false}
            aria-describedby="tools-dialog-id-help"
            onChange={(e) => {
              setTouched(true);
              setId(e.target.value);
            }}
          />
          <span className="small muted" id="tools-dialog-id-help">
            {t("tools_dialog_id_help")}
          </span>
        </label>
        <p className="small">{t("tools_dialog_config_note")}</p>
        {error ? <Refusal error={error} /> : null}
        <div className="row wrap">
          <button type="submit" className="btn primary" disabled={busy || !adapter || !id}>
            <Icon name="check" />
            {busy ? t("tools_dialog_creating") : t("tools_dialog_create_action")}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t("tools_dialog_cancel")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function RenameDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: (to: string, references: string[]) => void }) {
  const [name, setName] = useState(id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ renamed: { id: string; references: string[] } }>("PUT", `/api/tools/${encodeURIComponent(id)}`, { name });
      onDone(r.renamed.id, r.renamed.references);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={t("tools_dialog_rename_title", { tool: id })} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="stack tight">
          <span>{t("tools_dialog_id")}</span>
          <input className="input" value={name} required autoComplete="off" spellCheck={false} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="small">{t("tools_dialog_rename_note", { tool: id })}</p>
        {error ? <Refusal error={error} /> : null}
        <div className="row wrap">
          <button type="submit" className="btn primary" disabled={busy || name === id || !name}>
            {t("tools_dialog_rename_action")}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t("tools_dialog_cancel")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function RemoveDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: (references: string[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ removed: { references: string[] } }>("DELETE", `/api/tools/${encodeURIComponent(id)}`);
      onDone(r.removed.references);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={t("tools_dialog_remove_title", { tool: id })} onClose={onClose}>
      <div className="stack">
        <p>{t("tools_dialog_remove_lead")}</p>
        {error ? <Refusal error={error} /> : null}
        <div className="row wrap">
          <button type="button" className="btn danger" disabled={busy} onClick={remove}>
            {t("tools_dialog_remove_action")}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t("tools_dialog_cancel")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
