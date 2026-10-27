import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { formatLocale } from "../../i18n/locale";
import { ApiError, api, documentPath, entryQuery } from "../../api";
import { useShell } from "../../app/shell-context";
import { Dialog, ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { DiffView } from "../../components/DiffView";
import { Editor } from "../../components/Editor";
import { Icon } from "../../components/icons";
import { t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { RulesList } from "../tool-area/rules";
import { Refusal } from "../tools/dialogs";
import type { FileTarget, ToolTabModule } from "../../forms/tab";
import { EditBar } from "../tool-area/editbar";
import { fetchDraft, useDraftSync, type DraftView } from "../tool-area/editbar/drafts";
import { eb } from "../tool-area/editbar/messages";
import { ExecutionPanel, type ExecutionData } from "../tool-area/execution";

// Extra tabs of the tool area: each screens/tool-area/<tab>/index.tsx that exports `tab` and a default component
// (contract in forms/tab.ts). Files is built in (order 20).
const tabModules = Object.values(import.meta.glob<Partial<ToolTabModule>>("../tool-area/*/index.tsx", { eager: true })).filter(
  (m): m is ToolTabModule => typeof m.tab === "object" && m.tab !== null && typeof m.default === "function",
);

export const screen: ScreenMeta = { id: "tool", path: "/tools/:instance", order: 20 };

interface Selection {
  binding: string;
  entry: string | null;
}

interface Conflict {
  base: { revision: string | null; text: string | null };
  local: { revision: string | null; text: string | null };
  current: { revision: string | null; text: string | null; exists: boolean };
  diff: string;
}

const STATE_TONE: Record<string, "green" | "gold" | "blue"> = { editable: "green", "read-only": "gold", governed: "blue", package: "gold" };

function shortRevision(revision: string | null): string {
  return revision ? revision.slice(0, 12) : "-";
}

function ValidationLine({ validation }: { validation: any }) {
  if (!validation) return null;
  if (validation.status === "valid") return <div className="notice ok" role="status"><Icon name="check" /><p>{t("validation_ok")}</p></div>;
  if (validation.status === "invalid") {
    // The service answers `errors: [{message, line, column}]`; the first one is the one to fix.
    const first = (validation.errors as Array<{ message?: string; line?: number | null; column?: number | null }> | undefined)?.[0] ?? validation;
    return (
      <div className="notice error" role="status">
        <Icon name="alert" />
        <p>
          {t("validation_invalid", { message: first.message ?? "" })} {first.line ? t("validation_invalid_at", { line: first.line, column: first.column ?? 1 }) : ""}
        </p>
      </div>
    );
  }
  return <div className="notice" role="status"><p>{t("validation_unavailable")}</p></div>;
}

/** A refusal of the tools routes in the catalog language; any other failure keeps the generic notice. */
function Failure({ error }: { error: unknown }) {
  if (error instanceof ApiError && tOr("tools_err_" + error.code, "") !== "") return <Refusal error={error} />;
  return <ErrorNotice error={error} />;
}

const SUPPORT_TONE: Record<string, "green" | "gold" | "red" | "blue"> = { full: "green", assisted: "blue", "editable-file": "blue", unavailable: "gold", incompatible: "red" };

/** Dialog of "Selecionar arquivo": the workspace path the binding should point at. */
function SelectFileDialog({ instance, binding, current, onClose, onDone }: { instance: string; binding: string; current: string; onClose: () => void; onDone: () => void }) {
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("PUT", "/api/tools/" + encodeURIComponent(instance) + "/bindings/" + encodeURIComponent(binding), { path: value.trim() });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={t("tool_select_title")} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="stack tight">
          <span>{t("tool_select_label")}</span>
          <input className="input" value={value} required autoComplete="off" spellCheck={false} aria-describedby="tool-select-help" onChange={(e) => setValue(e.target.value)} />
          <span className="small muted" id="tool-select-help">
            {t("tool_select_help")}
          </span>
        </label>
        {error ? <Failure error={error} /> : null}
        <div className="row wrap">
          <button type="submit" className="btn primary" disabled={busy || value.trim() === ""}>
            {t("tool_select_action")}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t("tool_cancel")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function FilesTab({ instance, target, onChanged }: { instance: any; target: (FileTarget & { nonce: number }) | null; onChanged: () => void }) {
  const shell = useShell();
  const governedMode = shell.info?.mode === "governed";
  const [selecting, setSelecting] = useState(false);
  const [overrideNote, setOverrideNote] = useState<string | null>(null);
  const bindings: any[] = instance.bindings ?? [];
  // Line to place the cursor on, from the "open at the position in the file" link of another tab.
  const [goLine, setGoLine] = useState<number | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [doc, setDoc] = useState<any | null>(null);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [review, setReview] = useState<{ preview: any; allowInvalid: boolean; mode: "save" | "diff" } | null>(null);
  // Revision the text is typed over: the one of the file as read, or the one a restored draft was typed over.
  const [editBase, setEditBase] = useState<string | null>(null);
  const [restored, setRestored] = useState<DraftView | null>(null);
  // Syntax check of the typed text while it differs from the file, and the answer of the Validate button.
  const [live, setLive] = useState<any | null>(null);
  const [checked, setChecked] = useState<any | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [rulesKey, setRulesKey] = useState(0);

  const dirty = doc !== null && text !== (doc.text ?? "");
  const editable = doc !== null && doc.state === "editable" && (doc.text !== null || !doc.exists);
  const draft = useDraftSync({
    instance: instance.id,
    binding: selection?.binding ?? null,
    entry: selection?.entry ?? null,
    doc: doc ? { text: doc.text, exists: doc.exists } : null,
    baseRevision: editBase,
    text,
    enabled: editable,
    hasDraft: restored !== null,
  });

  /** Shows a document read from the disk, or its draft when one was typed over it and not saved. */
  const show = useCallback(
    async (next: Selection, document: any, useDraft: boolean) => {
      let shown: string = document.text ?? "";
      let base: string | null = document.revision;
      let from: DraftView | null = null;
      if (useDraft && document.state === "editable") {
        const d = await fetchDraft(instance.id, next.binding, next.entry).catch(() => null);
        if (d && d.text !== (document.text ?? "")) {
          shown = d.text;
          base = d.baseRevision;
          from = d;
        }
      }
      setDoc(document);
      setText(shown);
      setEditBase(base);
      setRestored(from);
      setLive(from?.validation ?? null);
      setChecked(null);
    },
    [instance.id],
  );

  const open = useCallback(
    async (next: Selection) => {
      // The typed text is kept as a draft in the data folder, so leaving the file does not lose it.
      if (dirty && draft.state !== "saved" && !window.confirm(t("doc_discard_confirm"))) return;
      setSelection(next);
      setLoading(true);
      setError(null);
      setSaved(null);
      setSaveError(null);
      setDoc(null);
      try {
        const r = await api("GET", documentPath(instance.id, next.binding) + entryQuery(next.entry));
        await show(next, r.document, true);
      } catch (e) {
        setError(e);
      } finally {
        setLoading(false);
      }
    },
    [dirty, draft.state, instance.id, show],
  );

  useEffect(() => {
    if (!target) return;
    setGoLine(null);
    void open({ binding: target.binding, entry: target.entry ?? null }).then(() => setGoLine(target.line ?? null));
    // Only a new request (nonce) opens the file again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.nonce]);

  const base = doc?.text ?? "";

  useEffect(() => {
    if (!doc || !selection || !editable || !dirty) {
      setLive(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      api("POST", documentPath(instance.id, selection.binding, "/validate"), { text, ...(selection.entry ? { entry: selection.entry } : {}) }).then(
        (r) => current && setLive(r.validation),
        () => current && setLive(null),
      );
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // Re-check when the text, the document or the file changes.
  }, [text, doc, selection, editable, dirty, instance.id]);

  useEffect(() => setChecked(null), [text]);

  async function validateNow() {
    if (!selection || !doc) return;
    setBusy(true);
    setSaveError(null);
    try {
      const r = await api("POST", documentPath(instance.id, selection.binding, "/validate"), { text, ...(selection.entry ? { entry: selection.entry } : {}) });
      setChecked(r.validation);
    } catch (e) {
      setSaveError(e);
    } finally {
      setBusy(false);
    }
  }

  async function startReview(mode: "save" | "diff" = "save", proposed?: string) {
    if (!selection || !doc) return;
    setBusy(true);
    setSaveError(null);
    setSaved(null);
    try {
      const r = await api("POST", documentPath(instance.id, selection.binding, "/preview"), { text: proposed ?? text, ...(selection.entry ? { entry: selection.entry } : {}) });
      if (!r.preview.changed) {
        setSaved(t("doc_unchanged"));
        return;
      }
      setReview({ preview: r.preview, allowInvalid: false, mode });
    } catch (e) {
      setSaveError(e);
    } finally {
      setBusy(false);
    }
  }

  async function confirmSave() {
    if (!selection || !doc || !review) return;
    setBusy(true);
    setSaveError(null);
    try {
      const r = await api("PUT", documentPath(instance.id, selection.binding), {
        // A restored draft is saved over the revision it was typed on: a file that moved since is a conflict.
        expectedRevision: editBase,
        text,
        ...(restored ? {} : { baseText: base }),
        ...(review.allowInvalid ? { allowInvalid: true } : {}),
        ...(selection.entry ? { entry: selection.entry } : {}),
      });
      setReview(null);
      await draft.discard();
      const fresh = await api("GET", documentPath(instance.id, selection.binding) + entryQuery(selection.entry));
      await show(selection, fresh.document, false);
      setSaved(t("doc_saved", { revision: shortRevision(r.save.revision ?? fresh.document.revision) }));
      setRulesKey((n) => n + 1);
    } catch (e) {
      setReview(null);
      if (e instanceof ApiError && e.code === "REVISION_CONFLICT") setConflict({ ...(e.body.conflict as Omit<Conflict, "diff">), diff: String(e.body.diff ?? "") });
      else setSaveError(e);
    } finally {
      setBusy(false);
    }
  }

  async function reloadFromDisk() {
    setConflict(null);
    if (!selection) return;
    setLoading(true);
    try {
      // Reloading from the disk is the explicit choice to give up the typed text, so its draft goes too.
      await draft.discard();
      const r = await api("GET", documentPath(instance.id, selection.binding) + entryQuery(selection.entry));
      await show(selection, r.document, false);
      setSaved(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }

  /** "Criar com template": the template goes into the editor and its diff is shown before anything is written. */
  async function createFromTemplate() {
    if (!selection || !doc) return;
    setBusy(true);
    setSaveError(null);
    try {
      const r = await api<{ template: { text: string } }>("GET", "/api/tools/" + encodeURIComponent(instance.id) + "/bindings/" + encodeURIComponent(selection.binding) + "/template");
      setText(r.template.text);
      await startReview("save", r.template.text);
    } catch (e) {
      setSaveError(e);
      setBusy(false);
    }
  }

  /** "Criar override local": copies the read-only file into the project and points the binding at the copy. */
  async function makeOverride() {
    if (!selection) return;
    setBusy(true);
    setSaveError(null);
    try {
      const r = await api<{ override: { path: string } }>("POST", "/api/tools/" + encodeURIComponent(instance.id) + "/bindings/" + encodeURIComponent(selection.binding) + "/override", {});
      setOverrideNote(t("tool_override_done", { path: r.override.path }));
      onChanged();
    } catch (e) {
      setSaveError(e);
    } finally {
      setBusy(false);
    }
  }

  // The binding moved (override or another file selected): read the document again from where it is now.
  const bindingsKey = JSON.stringify(bindings.map((b) => [b.id, b.declared, b.root, b.exists]));
  const firstKey = useRef(bindingsKey);
  useEffect(() => {
    if (firstKey.current === bindingsKey) return;
    firstKey.current = bindingsKey;
    if (selection) void open(selection);
    // Only a change of the bindings re-opens the file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindingsKey]);

  return (
    <div className="files">
      {instance.adapter === "semgrep" ? <RulesList instance={instance.id} current={selection?.entry ?? null} refreshKey={rulesKey} onOpen={(binding, entry) => open({ binding, entry })} onChanged={() => setRulesKey((n) => n + 1)} /> : null}
      <section aria-label={t("tool_files_label")} className="card flat">
        {bindings.length === 0 ? (
          <p>{t("tool_no_files")}</p>
        ) : (
          <ul className="file-list">
            {bindings.map((b) => (
              <li key={b.id}>
                {b.kind === "file" ? (
                  <button type="button" className="file-item" disabled={b.refused} aria-current={selection?.binding === b.id ? "true" : undefined} onClick={() => open({ binding: b.id, entry: null })}>
                    <Icon name="file" />
                    <span className="grow">
                      <strong>{b.relPath ?? b.declared}</strong>
                      <br />
                      <span className="muted small">
                        {tOr(`role_${b.role}`, b.role)}
                        {b.refused ? ` - ${t("tool_binding_refused")}` : !b.exists ? ` - ${t("tool_binding_missing")}` : ""}
                      </span>
                    </span>
                  </button>
                ) : (
                  <>
                    <div className="file-item">
                      <Icon name="folder" />
                      <span className="grow">
                        <strong>{b.relPath ?? b.declared}</strong>
                        <br />
                        <span className="muted small">{tOr(`role_${b.role}`, b.role)}</span>
                      </span>
                    </div>
                    {(b.files as any[]).length === 0 ? (
                      <p className="small file-sub">{t("tool_dir_empty")}</p>
                    ) : (
                      <ul className="file-sub">
                        {(b.files as any[]).map((f) => (
                          <li key={f.path}>
                            <button type="button" className="file-item" aria-current={selection?.binding === b.id && selection?.entry === f.path ? "true" : undefined} onClick={() => open({ binding: b.id, entry: f.path })}>
                              <Icon name="file" />
                              <code>{f.path}</code>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="stack" aria-live="polite">
        {!selection ? <p>{t("tool_pick_file")}</p> : null}
        {loading ? <Loading /> : null}
        {error ? <ErrorNotice error={error} /> : null}
        {doc ? (
          <>
            <div className="card flat stack">
              <div className="between wrap">
                <h2>
                  <code>{doc.relPath ?? doc.path}</code>
                </h2>
                <div className="row wrap">
                  <Pill tone={STATE_TONE[doc.state] ?? "blue"}>
                    {doc.state !== "editable" ? <Icon name="lock" /> : null}
                    {tOr(`doc_state_${doc.state}`, doc.state)}
                  </Pill>
                </div>
              </div>
              <dl className="kv">
                <dt>{t("doc_format")}</dt>
                <dd>{doc.format}</dd>
                <dt>{t("doc_revision")}</dt>
                <dd>
                  <code data-testid="revision">{doc.revision ?? "-"}</code>
                </dd>
                {doc.sharedWith.length > 0 ? (
                  <>
                    <dt>{t("doc_shared_with")}</dt>
                    <dd data-testid="shared-with">
                      <div className="row wrap">
                        {(doc.sharedWith as any[]).map((s) => (
                          <Pill key={`${s.tool}/${s.binding}`} tone="blue">
                            <Icon name="link" />
                            {t("doc_shared_item", { tool: s.tool, binding: s.binding })}
                          </Pill>
                        ))}
                      </div>
                    </dd>
                  </>
                ) : null}
              </dl>
              {(doc.reasons as any[]).map((r) => (
                <p key={r.code} className="small">
                  {r.message}
                </p>
              ))}
              {doc.text === null && doc.exists ? <div className="notice warn"><Icon name="alert" /><p>{t("doc_not_text")}</p></div> : null}
              {!doc.exists ? (
                <div className="notice" data-testid="doc-missing">
                  <Icon name="info" />
                  <div className="stack tight grow">
                    <p>{t("doc_missing")}</p>
                    {editable && !selection?.entry ? (
                      <div className="row wrap">
                        <button type="button" className="btn primary" disabled={busy} onClick={createFromTemplate}>
                          <Icon name="file" />
                          {t("tool_create_template")}
                        </button>
                        <button type="button" className="btn" disabled={busy} onClick={() => setSelecting(true)}>
                          {t("tool_select_file")}
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {doc.state === "package" || doc.state === "governed" ? (
                <div className="notice" data-testid="doc-override">
                  <Icon name="lock" />
                  <div className="stack tight grow">
                    <p>{doc.state === "package" ? t("tool_override_package") : t("tool_override_governed")}</p>
                    <div>
                      <button type="button" className="btn" disabled={busy || governedMode} onClick={makeOverride}>
                        <Icon name="copy" />
                        {t("tool_override_create")}
                      </button>
                    </div>
                    {governedMode ? <p className="small">{t("tool_override_blocked_governed")}</p> : null}
                  </div>
                </div>
              ) : null}
              {overrideNote ? (
                <div className="notice ok" role="status" data-testid="override-note">
                  <Icon name="check" />
                  <p>{overrideNote}</p>
                </div>
              ) : null}
            </div>

            {doc.text !== null || !doc.exists ? (
              <>
                <Editor key={`${doc.identity}:${doc.revision}`} value={text} format={doc.format} readOnly={!editable} label={t("doc_editor_label", { file: doc.relPath ?? doc.path })} onChange={setText} line={goLine} />
                {restored ? (
                  <div className="notice" role="status" data-testid="draft-restored">
                    <Icon name="alert" />
                    <div className="stack tight">
                      <p>{eb("restored", { when: new Date(restored.updatedAt).toLocaleString(formatLocale()) })}</p>
                      {restored.stale ? <p className="small">{eb("restored_stale")}</p> : null}
                    </div>
                  </div>
                ) : null}
                <EditBar
                  dirty={dirty}
                  busy={busy}
                  editable={editable}
                  draftState={draft.state}
                  hasDraft={draft.exists}
                  onValidate={validateNow}
                  onDiff={() => startReview("diff")}
                  onSave={() => startReview("save")}
                  onReload={reloadFromDisk}
                  onDiscardDraft={reloadFromDisk}
                />
                {checked ?? (live?.status === "invalid" ? live : null) ? <ValidationLine validation={checked ?? live} /> : null}
                {dirty && (checked ?? live)?.status === "invalid" ? (
                  <div className="notice warn" role="status" data-testid="visual-suspended">
                    <Icon name="lock" />
                    <p>{eb("visual_suspended")}</p>
                  </div>
                ) : null}
              </>
            ) : null}
            {saved ? <div className="notice ok" role="status"><Icon name="check" /><p>{saved}</p></div> : null}
            {saveError ? <Failure error={saveError} /> : null}
          </>
        ) : null}
      </section>

      {selecting && selection ? (
        <SelectFileDialog
          instance={instance.id}
          binding={selection.binding}
          current={bindings.find((b) => b.id === selection.binding)?.relPath ?? ""}
          onClose={() => setSelecting(false)}
          onDone={() => {
            setSelecting(false);
            onChanged();
          }}
        />
      ) : null}

      {review ? (
        <Dialog title={review.mode === "diff" ? eb("diff_only_title") : t("diff_title")} onClose={() => setReview(null)} wide>
          <DiffView diff={review.preview.diff} />
          <ValidationLine validation={review.preview.validation} />
          {review.mode === "save" && review.preview.validation?.status === "invalid" ? (
            <label className="row">
              <input type="checkbox" checked={review.allowInvalid} onChange={(e) => setReview({ ...review, allowInvalid: e.target.checked })} />
              {t("validation_allow_invalid")}
            </label>
          ) : null}
          <div className="row wrap">
            {review.mode === "save" ? (
              <button type="button" className="btn primary" disabled={busy || (review.preview.validation?.status === "invalid" && !review.allowInvalid)} onClick={confirmSave}>
                {busy ? t("saving") : t("save")}
              </button>
            ) : null}
            <button type="button" className="btn" onClick={() => setReview(null)}>
              {t("back_to_editor")}
            </button>
          </div>
        </Dialog>
      ) : null}

      {conflict ? (
        <Dialog title={t("conflict_title")} onClose={() => setConflict(null)} wide>
          <div className="notice warn" role="alert">
            <Icon name="alert" />
            <p>{t("conflict_lead")}</p>
          </div>
          <div className="three">
            <div className="pane" data-testid="conflict-base">
              <h3>{t("conflict_base")}</h3>
              <span className="muted small">{t("conflict_revision", { revision: shortRevision(conflict.base.revision) })}</span>
              <pre>{conflict.base.text ?? ""}</pre>
            </div>
            <div className="pane" data-testid="conflict-local">
              <h3>{t("conflict_local")}</h3>
              <span className="muted small">{t("conflict_revision", { revision: shortRevision(conflict.local.revision) })}</span>
              <pre>{conflict.local.text ?? ""}</pre>
            </div>
            <div className="pane" data-testid="conflict-current">
              <h3>{t("conflict_current")}</h3>
              <span className="muted small">{conflict.current.exists ? t("conflict_revision", { revision: shortRevision(conflict.current.revision) }) : t("conflict_removed")}</span>
              <pre>{conflict.current.text ?? ""}</pre>
            </div>
          </div>
          <h3>{t("conflict_diff")}</h3>
          <DiffView diff={conflict.diff} />
          <div className="row wrap">
            <button type="button" className="btn primary" onClick={() => setConflict(null)}>
              {t("conflict_keep_editing")}
            </button>
            <button type="button" className="btn danger" onClick={reloadFromDisk}>
              {t("conflict_reload")}
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

export default function ToolScreen({ params }: { params: Record<string, string> }) {
  const id = params.instance as string;
  const tools = useAsync(() => api("GET", "/api/tools/" + encodeURIComponent(id)), "tool:" + id);
  const execution = useAsync(() => api<{ execution: ExecutionData }>("GET", "/api/tools/" + encodeURIComponent(id) + "/execution").catch(() => null), "tool-exec:" + id);
  const failure = tools.error instanceof ApiError && tools.error.status === 404;
  const instance = (tools.data as any)?.instance;
  const reloadAll = () => {
    tools.reload();
    execution.reload();
  };
  return (
    <div className="stack">
      <div>
        <div className="crumbs">
          <a href="#/tools">{t("tool_all_tools")}</a>
        </div>
        <h1>{t("tool_title", { tool: id })}</h1>
      </div>
      {tools.loading && !instance ? <Loading /> : null}
      {failure ? <p>{t("tool_missing", { tool: id })}</p> : tools.error ? <ErrorNotice error={tools.error} onRetry={tools.reload} /> : null}
      {instance ? <ToolHeader instance={instance} execution={execution.data?.execution ?? null} loading={execution.loading} /> : null}
      {instance ? <ToolTabs instance={instance} onChanged={reloadAll} /> : null}
      {execution.data?.execution ? <ExecutionPanel execution={execution.data.execution} /> : null}
    </div>
  );
}

/** Name, component, runtime, version, availability and support level of the instance. */
function ToolHeader({ instance, execution, loading }: { instance: any; execution: ExecutionData | null; loading: boolean }) {
  const availability = execution?.availability;
  const version = execution?.toolVersion ?? null;
  const runtime = execution?.runtime?.name ?? null;
  return (
    <section className="card flat stack" aria-label={t("tool_header_label")} data-testid="tool-header">
      <div className="row wrap">
        <Pill tone={SUPPORT_TONE[instance.supportLevel] ?? "blue"}>
          <span className="sr-only">{t("tool_header_support")}: </span>
          {tOr("support_" + instance.supportLevel, instance.supportLevel)}
        </Pill>
        {availability ? (
          <Pill tone={availability.status === "available" ? "green" : "gold"}>
            <span className="sr-only">{t("tool_header_availability")}: </span>
            {tOr("tools_availability_" + availability.status, availability.status)}
          </Pill>
        ) : loading ? (
          <Pill>{t("tools_availability_checking")}</Pill>
        ) : null}
        <Pill tone={instance.enabled ? "green" : "gold"}>{instance.enabled ? t("tools_enabled") : t("tools_disabled")}</Pill>
      </div>
      <dl className="kv">
        <dt>{t("tool_header_adapter")}</dt>
        <dd>{instance.adapter}</dd>
        <dt>{t("tool_header_component")}</dt>
        <dd>{instance.component ?? t("tools_workspace_wide")}</dd>
        <dt>{t("tool_header_runtime")}</dt>
        <dd>{runtime ? (runtime === "container" ? t("tools_card_runner_container") : t("tool_header_runtime_native")) : instance.runner === "container" ? t("tools_card_runner_container") : t("tools_card_runner_local")}</dd>
        <dt>{t("tool_header_version")}</dt>
        <dd data-testid="tool-version">{version ?? t("tool_header_version_unknown")}</dd>
      </dl>
      {availability?.reason ? <p className="small">{availability.reason}</p> : null}
    </section>
  );
}

/**
 * Tabs of the tool area: Options first (when the tool has a form), then Files and the others found in screens/tool-area
 * that apply to the instance. The first tab is the one the area opens on. Every panel stays mounted (hidden when not
 * selected), so a draft in one tab survives a switch to another.
 */
function ToolTabs({ instance, onChanged }: { instance: any; onChanged: () => void }) {
  const extra = tabModules.filter((m) => m.tab.applies?.(instance) ?? true);
  const tabs = [{ id: "files", label: t("tool_tab_files"), order: 20 }, ...extra.map((m) => m.tab)].sort((a, b) => a.order - b.order);
  const [selected, setSelected] = useState(() => tabs[0]?.id ?? "files");
  const [target, setTarget] = useState<(FileTarget & { nonce: number }) | null>(null);
  const openFile = (next: FileTarget) => {
    setTarget((prev) => ({ ...next, nonce: (prev?.nonce ?? 0) + 1 }));
    setSelected("files");
  };
  const onKey = (e: KeyboardEvent, index: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const next = tabs[(index + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    if (next) {
      setSelected(next.id);
      document.getElementById("tab-" + next.id)?.focus();
    }
  };
  return (
    <>
      <div className="tabs" role="tablist">
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            type="button"
            className="tab"
            role="tab"
            id={"tab-" + tab.id}
            aria-selected={selected === tab.id}
            aria-controls={"panel-" + tab.id}
            tabIndex={selected === tab.id ? 0 : -1}
            onClick={() => setSelected(tab.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="panel-files" aria-labelledby="tab-files" hidden={selected !== "files"}>
        <FilesTab instance={instance} target={target} onChanged={onChanged} />
      </div>
      {extra.map((m) => {
        const Tab = m.default;
        return (
          <div key={m.tab.id} role="tabpanel" id={"panel-" + m.tab.id} aria-labelledby={"tab-" + m.tab.id} hidden={selected !== m.tab.id}>
            <Tab instance={instance} active={selected === m.tab.id} openFile={openFile} />
          </div>
        );
      })}
    </>
  );
}
