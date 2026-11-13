import { useCallback, useEffect, useRef, useState } from "react";
import { yamlHref } from "../../../forms/derived/api";
import { formatLocale } from "../../../i18n/locale";
import { ApiError, api } from "../../../api";
import { Dialog, ErrorNotice, Pill, Spinner } from "../../../components/common";
import { DiffView } from "../../../components/DiffView";
import { Icon } from "../../../components/icons";
import { FormRenderer } from "../../../forms/FormRenderer";
import { ft } from "../../../forms/i18n";
import { intentsOf, withPending, type FieldView, type FormView, type Pending } from "../../../forms/model";
import type { ToolTabMeta, ToolTabProps } from "../../../forms/tab";
import { DerivedForm } from "../../../forms/derived/DerivedForm";
import type { DerivedField } from "../../../forms/derived/types";
import { OpenAtLine } from "../../../forms/widgets";
import { t } from "../../../i18n";
import { fetchDraft, type DraftView } from "../editbar/drafts";
import { currentQuery } from "../../../app/route";
import { SettingsForm, type SettingsView } from "./settings-form";

/** Adapters whose settings live in tools.<id> of tools.yml and have a guided form (scope "instance" on the server). */
const SETTINGS_ADAPTERS = new Set(["zap", "schemathesis", "oasdiff", "migration-drift", "performance", "playwright"]);

// Options tab of the tool area: the schema-driven form of the instance (Ruff, pytest...). Each change is an intent per
// field; the server turns the intents into a minimal patch, the user reviews the diff and saves with the revision the
// form was read from. A moved revision opens the reconciliation dialog.

export const tab: ToolTabMeta = {
  id: "options",
  label: ft("tab_options"),
  // Before Files (20) and the tab the area opens on: the options are what most people come for.
  order: 10,
  // The server decides: every instance of an adapter has a derived settings form (hasForm), so the tab is always there.
  applies: (instance) => instance?.hasForm === true || instance?.supportLevel === "assisted" || instance?.supportLevel === "full" || SETTINGS_ADAPTERS.has(instance?.adapter),
};

/** The errors that only say this tool has no hand-written form: the derived settings form is then the whole tab. */
const NO_NATIVE_FORM = new Set(["FORM_NOT_FOUND", "FORM_NO_DOCUMENT", "INSTANCE_NOT_FOUND"]);
/** Keys every tool instance has; next to a hand-written settings form these are what is left to show. */
const GENERAL_KEYS = new Set(["enabled", "required", "timeoutSeconds", "capabilities"]);

interface Proposal {
  changes: string[];
  changed: boolean;
  diff: string;
  validation: { status: string; errors: Array<{ message: string; line: number | null }> };
}

interface Conflict {
  expectedRevision: string | null;
  current: { revision: string | null; exists: boolean };
  rebased: ({ ok: true; revision: string | null } & Proposal) | { ok: false; code: string; message: string };
}

const formPath = (instance: string, suffix = "") => `/api/forms/${encodeURIComponent(instance)}${suffix}`;
const short = (revision: string | null | undefined) => (revision ? revision.slice(0, 12) : "-");

export default function OptionsTab(props: ToolTabProps) {
  const id = props.instance.id as string;
  // What the hand-written form is: a form over the tool's own documents, one over tools.<id> (a settings form), or none.
  const [kind, setKind] = useState<"documents" | "instance" | "none" | null>(null);
  return (
    <div className="stack" data-testid="tool-options">
      <NativeOptions {...props} onKind={setKind} />
      {kind !== null ? (
        <section className="stack" aria-labelledby="tool-settings-title" data-testid="tool-settings">
          <div>
            <h2 id="tool-settings-title">{kind === "instance" ? t("tools_settings_general") : t("tools_settings_title")}</h2>
            <p className="small">{t("tools_settings_lead", { tool: id })}</p>
          </div>
          <DerivedForm key={id} source={{ instance: id }} headingLevel={3} {...(kind === "instance" ? { include: (f: DerivedField) => GENERAL_KEYS.has(String(f.path[2])) } : {})} />
        </section>
      ) : null}
    </div>
  );
}

function NativeOptions({ instance, active, openFile, onKind }: ToolTabProps & { onKind: (kind: "documents" | "instance" | "none") => void }) {
  const id = instance.id as string;
  const [view, setView] = useState<FormView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Map<string, Pending>>(new Map());
  const [query, setQuery] = useState("");
  const [review, setReview] = useState<Proposal | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  // A draft of the document typed in the Files tab and not saved: the form shows the file on disk, not the draft.
  const [draft, setDraft] = useState<DraftView | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  // Settings forms: the fields a "not applicable here" action named (#/tools/<id>?focus=target), and the saved notice
  // kept across the reload that follows a save.
  const [focus] = useState(() => (currentQuery().get("focus") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const [settingsSaved, setSettingsSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ form: FormView }>("GET", formPath(id));
      setView(r.form);
      setPending(new Map());
      onKind((r.form as unknown as SettingsView).scope === "instance" ? "instance" : "documents");
      setDraft(await fetchDraft(id, r.form.binding, null).catch(() => null));
    } catch (e) {
      if (e instanceof ApiError && NO_NATIVE_FORM.has(e.code)) {
        setView(null);
        onKind("none");
      } else {
        setError(e);
        onKind("none");
      }
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Reload when the tab is shown again with nothing pending: another tab or editor may have saved the file.
  useEffect(() => {
    if (active && pendingRef.current.size === 0) void load();
  }, [active, load]);

  const intents = intentsOf(pending);
  const dirty = intents.length > 0;

  async function startReview() {
    if (!view || !dirty) return;
    setBusy(true);
    setSaveError(null);
    setNotice(null);
    try {
      const r = await api<{ preview: Proposal & { status: string } }>("POST", formPath(id, "/preview"), { expectedRevision: view.revision, intents });
      if (!r.preview.changed) setNotice(ft("unchanged"));
      else setReview(r.preview);
    } catch (e) {
      if (e instanceof ApiError && e.code === "REVISION_CONFLICT") setConflict(e.body.conflict as Conflict);
      else setSaveError(e);
    } finally {
      setBusy(false);
    }
  }

  async function save(expectedRevision: string | null) {
    setBusy(true);
    setSaveError(null);
    try {
      const r = await api<{ save: { status: string; revision: string | null } }>("PUT", formPath(id), { expectedRevision, intents });
      setReview(null);
      setConflict(null);
      await load();
      setNotice(r.save.status === "saved" ? ft("saved", { revision: short(r.save.revision) }) : ft("unchanged"));
    } catch (e) {
      setReview(null);
      if (e instanceof ApiError && e.code === "REVISION_CONFLICT") setConflict(e.body.conflict as Conflict);
      else setSaveError(e);
    } finally {
      setBusy(false);
    }
  }

  function onPending(field: FieldView, next: Pending) {
    setNotice(null);
    setPending((p) => withPending(p, field, next));
  }

  const openAt = (line: number | null) => {
    if (view) openFile({ binding: view.binding, line });
  };

  if (loading && !view) {
    return (
      <p className="spinner-text" role="status" data-testid="form-loading">
        {ft("loading")}
      </p>
    );
  }
  if (error) return <ErrorNotice error={error} onRetry={load} />;
  // A tool without a hand-written form: the derived settings form below is the tab.
  if (!view) return null;

  const settings = view as unknown as SettingsView;
  if (settings.scope === "instance") {
    if (!view.available) {
      return (
        <div className="notice warn" role="status">
          <Icon name="alert" />
          <div className="stack tight grow">
            <strong>{ft("unavailable_title")}</strong>
            <p>{view.unavailable?.message}</p>
            <p className="small">
              <a href={yamlHref(settings.document.relPath ?? ".jgates/tools.yml", settings.section.join("."))}>{t("rtf_open_yaml")}</a>
            </p>
          </div>
        </div>
      );
    }
    return (
      <SettingsForm
        key={view.revision ?? "none"}
        view={settings}
        focus={focus}
        justSaved={settingsSaved}
        onSaved={(ok) => {
          setSettingsSaved(ok);
          void load();
        }}
      />
    );
  }

  const readOnly = !view.editable || !view.available;
  const fileLabel = view.document.relPath ?? view.binding;

  return (
    <div
      className="options"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          void startReview();
        }
      }}
    >
      <div className="stack">
        <div className="card flat stack">
          <div className="between wrap">
            <h2>{view.form.title}</h2>
            <Pill tone={dirty ? "gold" : undefined}>{dirty ? ft(intents.length === 1 ? "pending_count_one" : "pending_count", { count: intents.length }) : ft("pending_none")}</Pill>
          </div>
          <label className="stack tight">
            <span className="small">{ft("search_label")}</span>
            <input type="search" className="input search" value={query} placeholder={ft("search_placeholder")} onChange={(e) => setQuery(e.target.value)} />
          </label>
        </div>

        {draft ? (
          <div className="notice warn" role="status" data-testid="options-draft">
            <Icon name="alert" />
            <div className="stack tight grow">
              <p>{t("options_draft", { when: new Date(draft.updatedAt).toLocaleString(formatLocale()) })}</p>
              <div>
                <button type="button" className="btn" onClick={() => openFile({ binding: view.binding })}>
                  <Icon name="file" />
                  {t("options_draft_open")}
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {!view.available && view.unavailable ? (
          <div className="notice warn" role="status">
            <Icon name="alert" />
            <div className="stack tight grow">
              <strong>{ft("unavailable_title")}</strong>
              <p>{view.unavailable.message}</p>
              <p className="small">{ft("unavailable_fix")}</p>
              {view.document.exists ? (
                <div>
                  <OpenAtLine line={view.unavailable.position?.line ?? null} onOpen={() => openAt(view.unavailable?.position?.line ?? null)} />
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {view.available && !view.editable ? (
          <div className="notice" role="status">
            <Icon name="lock" />
            <p>{ft("read_only")}</p>
          </div>
        ) : null}

        {view.available ? <FormRenderer view={view} pending={pending} query={query} readOnly={readOnly} onPending={onPending} openAt={openAt} /> : null}

        {notice ? (
          <div className="notice ok" role="status">
            <Icon name="check" />
            <p>{notice}</p>
          </div>
        ) : null}
        {saveError ? <ErrorNotice error={saveError} /> : null}

        {view.available ? (
          <div className="edit-bar" role="region" aria-label={ft("review")}>
            <span className="small">{dirty ? ft(intents.length === 1 ? "pending_count_one" : "pending_count", { count: intents.length }) : ft("pending_none")}</span>
            <div className="row wrap">
              <button type="button" className="btn" disabled={!dirty || busy} onClick={() => setPending(new Map())}>
                {ft("discard")}
              </button>
              <button type="button" className="btn primary" disabled={!dirty || busy || readOnly} onClick={startReview}>
                <Icon name="check" />
                {ft("review")}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <aside className="options-side stack">
        <div className="card flat stack tight">
          <p className="small">{ft("document", { file: fileLabel, section: view.section.join(".") || "-" })}</p>
          <p className="small">
            <code data-testid="form-revision">{short(view.revision)}</code>
          </p>
          {view.document.sharedWith.length > 0 ? (
            <p className="small" data-testid="form-shared">
              <Icon name="link" /> {ft("shared_with", { tools: [...new Set(view.document.sharedWith.map((s) => s.tool))].join(", ") })}
            </p>
          ) : null}
        </div>
        {view.unsupported.length > 0 ? (
          <section className="card flat stack tight" aria-labelledby="unsupported-title" data-testid="unsupported">
            <h3 id="unsupported-title">{ft("unsupported_title")}</h3>
            <p className="small">{ft("unsupported_lead")}</p>
            <ul className="unsupported-list">
              {view.unsupported.map((u) => (
                <li key={u.documentPath}>
                  <code>{u.documentPath}</code>
                  <OpenAtLine line={u.position?.line ?? null} onOpen={() => openAt(u.position?.line ?? null)} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </aside>

      {review ? (
        <Dialog title={ft("diff_title")} onClose={() => setReview(null)} wide>
          <p className="small">{fileLabel}</p>
          <DiffView diff={review.diff} />
          <div className="row wrap">
            <button type="button" className="btn primary" disabled={busy} onClick={() => save(view.revision)}>
              {busy ? <Spinner /> : null}
              {busy ? ft("saving") : ft("save")}
            </button>
            <button type="button" className="btn" onClick={() => setReview(null)}>
              {ft("back")}
            </button>
          </div>
        </Dialog>
      ) : null}

      {conflict ? (
        <Dialog title={ft("conflict_title")} onClose={() => setConflict(null)} wide>
          <div className="notice warn" role="alert">
            <Icon name="alert" />
            <p>{ft("conflict_lead")}</p>
          </div>
          <p className="small">
            {ft("conflict_read_revision")} <code>{short(conflict.expectedRevision)}</code>; {ft("conflict_current_revision")} <code data-testid="conflict-current-revision">{short(conflict.current.revision)}</code>
          </p>
          {conflict.rebased.ok ? (
            <>
              <h3>{ft("conflict_rebased")}</h3>
              <DiffView diff={conflict.rebased.diff} />
            </>
          ) : (
            <p className="small">{ft("conflict_rebase_failed", { message: conflict.rebased.message })}</p>
          )}
          <div className="row wrap">
            {conflict.rebased.ok ? (
              <button type="button" className="btn primary" disabled={busy} onClick={() => save(conflict.current.revision)}>
                {ft("conflict_reapply")}
              </button>
            ) : null}
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              onClick={() => {
                setConflict(null);
                void load();
              }}
            >
              {ft("conflict_discard")}
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
