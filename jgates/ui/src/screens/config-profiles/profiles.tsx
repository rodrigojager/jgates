import { useState, type FormEvent } from "react";
import { api } from "../../api";
import { Dialog, ErrorNotice, Pill } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t } from "../../i18n";

interface Change {
  selector: string;
  value: boolean | string;
  parentValue: boolean | null;
}

export interface Card {
  id: string;
  ref: string;
  label: string | null;
  description: string | null;
  extends: string | null;
  isDefault: boolean;
  usedBy: string[];
  changes: Change[];
  estimate: { state: "not-estimated" | "estimated"; ms?: number; runs: number };
}

export interface Starter {
  id: string;
  ref: string;
  label: string | null;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function Estimate({ estimate }: { estimate: Card["estimate"] }) {
  if (estimate.state === "not-estimated") {
    return <span data-testid="estimate">{t("cfgp_estimate_none")}</span>;
  }
  const seconds = Math.max(1, Math.round((estimate.ms as number) / 1000));
  return <span data-testid="estimate">{t("cfgp_estimate_value", { time: seconds >= 90 ? `${Math.round(seconds / 60)} min` : `${seconds} s`, runs: estimate.runs })}</span>;
}

const nameOf = (card: { id: string; label: string | null }): string => card.label ?? card.id;

function CreateDialog({ cards, starters, from, onClose, onCreated }: { cards: Card[]; starters: Starter[]; from: string; onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const [id, setId] = useState("");
  const [source, setSource] = useState(from);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const idOk = ID_RE.test(id);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/api/profiles", { id, from: source, ...(label.trim() ? { label: label.trim() } : {}) });
      toast(t("cfgp_created", { id }), "ok");
      onCreated(id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={t("cfgp_create_title")} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span className="field-label">{t("cfgp_create_from")}</span>
          <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
            <optgroup label={t("cfgp_group_project")}>
              {cards.map((c) => (
                <option key={c.ref} value={c.ref}>
                  {nameOf(c)} ({c.id})
                </option>
              ))}
            </optgroup>
            <optgroup label={t("cfgp_group_starters")}>
              {starters.map((s) => (
                <option key={s.ref} value={s.ref}>
                  {s.label ?? s.id} ({s.ref})
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t("cfgp_create_id")}</span>
          <input className="input" value={id} onChange={(e) => setId(e.target.value)} aria-invalid={id !== "" && !idOk} aria-describedby="cfgp-id-help" autoComplete="off" spellCheck={false} />
          <span className="small muted" id="cfgp-id-help">
            {t("cfgp_create_id_help")}
          </span>
        </label>
        <label className="field">
          <span className="field-label">{t("cfgp_create_label")}</span>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} />
        </label>
        {error ? <ErrorNotice error={error} /> : null}
        <div className="row">
          <button type="submit" className="btn primary" disabled={!idOk || busy}>
            {t("cfgp_create_confirm")}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function RenameDialog({ card, onClose, onDone }: { card: Card; onClose: () => void; onDone: (id: string) => void }) {
  const toast = useToast();
  const [to, setTo] = useState(card.id);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const ok = ID_RE.test(to) && to !== card.id;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("PUT", `/api/profiles/${encodeURIComponent(card.id)}/rename`, { to });
      toast(t("cfgp_renamed", { id: card.id, to }), "ok");
      onDone(to);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("cfgp_rename_title", { id: card.id })} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span className="field-label">{t("cfgp_rename_new")}</span>
          <input className="input" value={to} onChange={(e) => setTo(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <p className="small muted">{t("cfgp_rename_note")}</p>
        {error ? <ErrorNotice error={error} /> : null}
        <div className="row">
          <button type="submit" className="btn primary" disabled={!ok || busy}>
            {t("cfgp_rename_confirm")}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ card, onClose, onDone }: { card: Card; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("DELETE", `/api/profiles/${encodeURIComponent(card.id)}`);
      toast(t("cfgp_deleted", { id: card.id }), "ok");
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("cfgp_delete_title", { id: card.id })} onClose={onClose}>
      <div className="stack">
        <p>{t("cfgp_delete_text")}</p>
        {error ? (
          <div data-testid="delete-refusal">
            <ErrorNotice error={error} />
          </div>
        ) : null}
        <div className="row">
          <button type="button" className="btn danger" disabled={busy} onClick={confirm}>
            {t("cfgp_delete_confirm")}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t("close")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

type Dialogs = { kind: "create"; from: string } | { kind: "rename"; card: Card } | { kind: "delete"; card: Card } | null;

/** One card per profile of .jgates/profiles.yml, with the actions: edit, duplicate, rename, make default, delete. */
export function ProfileCards({ cards, starters, selected, onSelect, onChanged }: { cards: Card[]; starters: Starter[]; selected: string; onSelect: (id: string) => void; onChanged: () => void }) {
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [error, setError] = useState<unknown>(null);

  const makeDefault = async (card: Card) => {
    setError(null);
    try {
      await api("PUT", `/api/profiles/${encodeURIComponent(card.id)}/default`, {});
      toast(t("cfgp_default_set", { id: card.id }), "ok");
      onChanged();
    } catch (e) {
      setError(e);
    }
  };

  const standardRef = cards.find((c) => c.id === "standard")?.ref ?? cards[0]?.ref ?? "builtin:standard";

  return (
    <section className="stack" aria-labelledby="cfgp-profiles-title">
      <div className="between wrap">
        <div>
          <h2 id="cfgp-profiles-title">{t("cfgp_profiles_title")}</h2>
          <p className="small muted">{t("cfgp_profiles_lead")}</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setDialog({ kind: "create", from: standardRef })}>
          {t("cfgp_create_button")}
        </button>
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="profile-grid" role="list">
        {cards.map((card) => (
          <article key={card.ref} className={`card pad profile-card${selected === card.ref ? " selected" : ""}`} data-profile={card.id} data-testid="profile-card" role="listitem" aria-label={nameOf(card)}>
            <div className="between wrap">
              <h3>{nameOf(card)}</h3>
              <span className="row wrap">
                {card.isDefault ? <Pill tone="green">{t("cfgp_default_badge")}</Pill> : null}
                {selected === card.ref ? <Pill tone="blue">{t("cfgp_editing_badge")}</Pill> : null}
              </span>
            </div>
            <p className="small mono-id">
              <code>{card.id}</code>
              {card.extends ? (
                <>
                  {" "}
                  {t("cfgp_extends")} <code data-testid="extends">{card.extends}</code>
                </>
              ) : null}
            </p>
            {card.description ? <p className="small">{card.description}</p> : null}
            <p className="small muted">
              {t("cfgp_estimate_label")}: <Estimate estimate={card.estimate} />
            </p>
            <details className="profile-changes">
              <summary>{t("cfgp_changes_summary", { count: card.changes.length, parent: card.extends ?? "-" })}</summary>
              {card.changes.length === 0 ? (
                <p className="small muted">{t("cfgp_changes_none")}</p>
              ) : (
                <ul className="small" data-testid="changes">
                  {card.changes.map((c) => (
                    <li key={c.selector}>
                      <code>{c.selector}</code>: {c.parentValue === null ? "-" : c.parentValue ? t("cfgp_on") : t("cfgp_off")} {t("cfgp_arrow")} <strong>{typeof c.value === "boolean" ? (c.value ? t("cfgp_on") : t("cfgp_off")) : c.value}</strong>
                      {c.parentValue !== null && c.parentValue === c.value ? <span className="muted"> ({t("cfgp_same_as_parent")})</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </details>
            <div className="row wrap profile-actions">
              <button type="button" className="btn" aria-pressed={selected === card.ref} aria-label={t("cfgp_edit_aria", { name: nameOf(card) })} onClick={() => onSelect(card.ref)}>
                <Icon name="sliders" />
                {t("cfgp_edit")}
              </button>
              <button type="button" className="btn" aria-label={t("cfgp_duplicate_aria", { name: nameOf(card) })} onClick={() => setDialog({ kind: "create", from: card.ref })}>
                {t("cfgp_duplicate")}
              </button>
              <button type="button" className="btn" aria-label={t("cfgp_rename_aria", { name: nameOf(card) })} onClick={() => setDialog({ kind: "rename", card })}>
                {t("cfgp_rename")}
              </button>
              <button type="button" className="btn" disabled={card.isDefault} aria-label={t("cfgp_make_default_aria", { name: nameOf(card) })} onClick={() => makeDefault(card)}>
                {t("cfgp_make_default")}
              </button>
              <button type="button" className="btn danger" aria-label={t("cfgp_delete_aria", { name: nameOf(card) })} onClick={() => setDialog({ kind: "delete", card })}>
                {t("cfgp_delete")}
              </button>
            </div>
          </article>
        ))}
      </div>
      {dialog?.kind === "create" ? (
        <CreateDialog
          cards={cards}
          starters={starters}
          from={dialog.from}
          onClose={() => setDialog(null)}
          onCreated={(id) => {
            setDialog(null);
            onSelect(id);
            onChanged();
          }}
        />
      ) : null}
      {dialog?.kind === "rename" ? (
        <RenameDialog
          card={dialog.card}
          onClose={() => setDialog(null)}
          onDone={(id) => {
            setDialog(null);
            if (selected === dialog.card.ref) onSelect(id);
            onChanged();
          }}
        />
      ) : null}
      {dialog?.kind === "delete" ? (
        <DeleteDialog
          card={dialog.card}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            onChanged();
          }}
        />
      ) : null}
    </section>
  );
}
