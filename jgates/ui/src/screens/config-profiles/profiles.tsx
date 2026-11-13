import { useState, type FormEvent } from "react";
import { api } from "../../api";
import { Dialog, ErrorNotice, Pill, Spinner } from "../../components/common";
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

/** The identifier a profile name suggests: lower case, no accents, anything else turned into a hyphen. */
export function deriveId(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[-._]+$/g, "")
    .slice(0, 60);
}

const nameOf = (card: { id: string; label: string | null }): string => card.label ?? card.id;

/** What a profile write answers besides its own result: the updated list and the updated view (null: the screen asks again). */
export interface WriteAnswer {
  profiles?: unknown;
  view?: unknown;
}

/** The label of a button whose action is in flight: the turning ring beside it, and aria-busy on the button itself. */
const busyProps = (busy: boolean) => (busy ? ({ "aria-busy": true, "data-pending": "true" } as const) : {});

/** The body of "Criar perfil": the profile it extends, its name (the identifier follows it) and a description. */
export interface CreateBody {
  id: string;
  from: string;
  label?: string;
  description?: string;
}

/**
 * "Criar perfil": name first, the identifier derived from it. `draft` creates the profile in the first-run wizard's draft
 * instead of .jgates/profiles.yml (ADR-0008).
 */
export function CreateDialog({ cards, starters, from, onClose, onCreated, draft }: { cards: Array<Pick<Card, "id" | "ref" | "label">>; starters: Starter[]; from: string; onClose: () => void; onCreated: (id: string, answer: WriteAnswer) => void; draft?: { create: (body: CreateBody) => Promise<WriteAnswer> } }) {
  const toast = useToast();
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [source, setSource] = useState(from);
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const idOk = ID_RE.test(id);
  // The name comes first and the identifier follows it until the person writes one; a name is needed unless they did.
  const ready = idOk && (label.trim() !== "" || idTouched);
  const taken = cards.some((c) => c.id === id);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || taken) return;
    setBusy(true);
    setError(null);
    try {
      const body: CreateBody = { id, from: source, ...(label.trim() ? { label: label.trim() } : {}), ...(description.trim() ? { description: description.trim() } : {}) };
      const answer = draft ? await draft.create(body) : await api<WriteAnswer>("POST", "/api/profiles", body);
      toast(t(draft ? "cfgp_created_draft" : "cfgp_created", { id }), "ok");
      onCreated(id, answer);
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
            {starters.length > 0 ? (
              <optgroup label={t("cfgp_group_starters")}>
                {starters.map((s) => (
                  <option key={s.ref} value={s.ref}>
                    {s.label ?? s.id} ({s.ref})
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t("cfgp_create_label")}</span>
          <input
            className="input"
            value={label}
            maxLength={120}
            data-free-text="identifier"
            autoComplete="off"
            onChange={(e) => {
              setLabel(e.target.value);
              if (!idTouched) setId(deriveId(e.target.value));
            }}
          />
        </label>
        <label className="field">
          <span className="field-label">{t("cfgp_create_id")}</span>
          <input
            className="input"
            value={id}
            data-free-text="identifier"
            onChange={(e) => {
              setId(e.target.value);
              setIdTouched(true);
            }}
            aria-invalid={(id !== "" && !idOk) || taken}
            aria-describedby="cfgp-id-help"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="small muted" id="cfgp-id-help">
            {taken ? t("cfgp_create_id_taken", { id }) : t("cfgp_create_id_help")}
          </span>
        </label>
        <label className="field">
          <span className="field-label">{t("cfgp_create_description")}</span>
          <textarea className="input" rows={2} value={description} maxLength={400} data-free-text="open-text" onChange={(e) => setDescription(e.target.value)} />
        </label>
        {error ? <ErrorNotice error={error} /> : null}
        <div className="row">
          <button type="submit" className="btn primary" disabled={!ready || taken || busy} {...busyProps(busy)}>
            {busy ? <Spinner /> : null}
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

function RenameDialog({ card, viewQuery, onClose, onDone }: { card: Card; viewQuery: string; onClose: () => void; onDone: (id: string, answer: WriteAnswer) => void }) {
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
      const answer = await api<WriteAnswer>("PUT", `/api/profiles/${encodeURIComponent(card.id)}/rename${viewQuery}`, { to });
      toast(t("cfgp_renamed", { id: card.id, to }), "ok");
      onDone(to, answer);
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
          <button type="submit" className="btn primary" disabled={!ok || busy} {...busyProps(busy)}>
            {busy ? <Spinner /> : null}
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

function DeleteDialog({ card, viewQuery, onClose, onDone }: { card: Card; viewQuery: string; onClose: () => void; onDone: (answer: WriteAnswer) => void }) {
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = await api<WriteAnswer>("DELETE", `/api/profiles/${encodeURIComponent(card.id)}${viewQuery}`);
      toast(t("cfgp_deleted", { id: card.id }), "ok");
      onDone(answer);
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
          <button type="button" className="btn danger" disabled={busy} onClick={confirm} {...busyProps(busy)}>
            {busy ? <Spinner /> : null}
            {t("cfgp_delete_confirm")}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

type Dialogs = { kind: "create"; from: string } | { kind: "rename"; card: Card } | { kind: "delete"; card: Card } | null;

/** One card per profile of .jgates/profiles.yml, with the actions: edit, duplicate, rename, make default, delete. */
export function ProfileCards({
  cards,
  starters,
  selected,
  followsDefault,
  onSelect,
  onChanged,
}: {
  cards: Card[];
  starters: Starter[];
  selected: string;
  /** The screen shows whichever profile is the default (no profile picked by hand). */
  followsDefault: boolean;
  onSelect: (id: string) => void;
  /** A write went through: its answer (list and view), and the profile to show next (undefined: the same; null: the default). */
  onChanged: (answer: WriteAnswer | null, next?: string | null) => void;
}) {
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [error, setError] = useState<unknown>(null);
  const [defaulting, setDefaulting] = useState<string | null>(null);
  // The view the answer of a write carries: the profile on screen (when the write does not move the screen elsewhere).
  const keepView = `?view=${encodeURIComponent(selected)}`;

  const makeDefault = async (card: Card) => {
    setError(null);
    setDefaulting(card.id);
    try {
      const answer = await api<WriteAnswer>("PUT", `/api/profiles/${encodeURIComponent(card.id)}/default${followsDefault ? "" : keepView}`, {});
      toast(t("cfgp_default_set", { id: card.id }), "ok");
      onChanged(answer);
    } catch (e) {
      setError(e);
    } finally {
      setDefaulting(null);
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
              <button type="button" className="btn" disabled={card.isDefault || defaulting !== null} aria-label={t("cfgp_make_default_aria", { name: nameOf(card) })} onClick={() => makeDefault(card)} {...busyProps(defaulting === card.id)}>
                {defaulting === card.id ? <Spinner /> : null}
                {t("cfgp_make_default")}
              </button>
              {(() => {
                const reason = card.isDefault ? t("cfgp_delete_default_reason") : null;
                const reasonId = `cfgp-delete-reason-${card.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
                return (
                  <>
                    <button
                      type="button"
                      className="btn danger"
                      disabled={reason !== null}
                      title={reason ?? undefined}
                      aria-describedby={reason ? reasonId : undefined}
                      aria-label={t("cfgp_delete_aria", { name: nameOf(card) })}
                      onClick={() => setDialog({ kind: "delete", card })}
                    >
                      {t("cfgp_delete")}
                    </button>
                    {reason ? (
                      <span id={reasonId} className="small muted" data-testid="delete-disabled-reason">
                        {reason}
                      </span>
                    ) : null}
                  </>
                );
              })()}
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
          onCreated={(id, answer) => {
            setDialog(null);
            onChanged(answer, id);
          }}
        />
      ) : null}
      {dialog?.kind === "rename" ? (
        <RenameDialog
          card={dialog.card}
          viewQuery={selected === dialog.card.ref ? "" : keepView}
          onClose={() => setDialog(null)}
          onDone={(id, answer) => {
            setDialog(null);
            onChanged(answer, selected === dialog.card.ref ? id : undefined);
          }}
        />
      ) : null}
      {dialog?.kind === "delete" ? (
        <DeleteDialog
          card={dialog.card}
          viewQuery={selected === dialog.card.ref ? "" : keepView}
          onClose={() => setDialog(null)}
          onDone={(answer) => {
            setDialog(null);
            onChanged(answer, selected === dialog.card.ref ? null : undefined);
          }}
        />
      ) : null}
    </section>
  );
}
