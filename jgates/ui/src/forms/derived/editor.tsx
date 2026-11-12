import { useCallback, useRef, useState } from "react";
import { ApiError } from "../../api";
import { Dialog, ErrorNotice, Spinner } from "../../components/common";
import { DiffView } from "../../components/DiffView";
import { Icon } from "../../components/icons";
import { forgetPickers } from "../../components/pickers";
import { ft } from "../i18n";
import { previewKey, readFileText, restoreFile, saveKey } from "./api";
import type { DerivedField, FieldEdit, KeyEditPreview, KeyEditRequest } from "./types";

// The write model of a derived form (ADR-0009, PLAN-config-editing.md section 2): one key at a time. A change is an edit
// of its field until the person asks to save it; the save shows the diff of the file first (POST key/preview) and
// writes only after "Salvar" (PUT key, with the revision the form was read from). A switch saves at once. After every
// save the last change can be undone: the bytes the file had before are written back (only while nobody changed the
// file since), so comments and order come back exactly as they were.

interface Review {
  field: DerivedField;
  title: string;
  request: KeyEditRequest;
  preview: KeyEditPreview | null;
  /** The file before the save (null: it does not exist yet; undefined: still reading). */
  previous: { text: string; revision: string } | null | undefined;
  error: unknown;
  busy: boolean;
}

export interface UndoState {
  file: string;
  title: string;
  diff: string;
  /** The bytes to write back; null when the save created the file (nothing to restore). */
  previous: string | null;
  revision: string;
  state: "saved" | "undoing" | "undone" | "failed";
  error?: unknown;
}

export interface WriteEvent {
  kind: "saved" | "undone";
  file: string;
  revision: string | null;
}

export interface KeyEditor {
  edits: ReadonlyMap<string, FieldEdit>;
  setEdit: (field: DerivedField, edit: FieldEdit | null) => void;
  /** Opens the review of a write (the diff, then "Salvar"). */
  review: (field: DerivedField, title: string, request: KeyEditRequest) => void;
  /** Writes at once (a switch) and offers the undo. */
  saveNow: (field: DerivedField, title: string, request: KeyEditRequest) => Promise<void>;
  /** Fields whose immediate write is in flight. */
  busy: ReadonlySet<string>;
  /** The failure of an immediate write, by field id. */
  failures: ReadonlyMap<string, unknown>;
  undo: UndoState | null;
  undoLast: () => Promise<void>;
  dismissUndo: () => void;
  reviewing: Review | null;
  confirm: () => Promise<void>;
  cancel: () => void;
}

const isConflict = (e: unknown) => e instanceof ApiError && (e.status === 409 || e.code === "REVISION_CONFLICT");

/** The edits, the review dialog and the undo of one form; `reload` reads the form again after a write. */
export function useKeyEditor(reload: () => void, onWrite?: (event: WriteEvent) => void): KeyEditor {
  const [edits, setEdits] = useState<Map<string, FieldEdit>>(new Map());
  const [reviewing, setReviewing] = useState<Review | null>(null);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState<Map<string, unknown>>(new Map());
  const reviewRef = useRef<Review | null>(null);
  reviewRef.current = reviewing;

  const setEdit = useCallback((field: DerivedField, edit: FieldEdit | null) => {
    setEdits((prev) => {
      const next = new Map(prev);
      if (edit === null) next.delete(field.id);
      else next.set(field.id, edit);
      return next;
    });
  }, []);

  const afterSave = (field: DerivedField, title: string, request: KeyEditRequest, previous: { text: string; revision: string } | null, save: Awaited<ReturnType<typeof saveKey>>) => {
    setEdits((prev) => {
      const next = new Map(prev);
      next.delete(field.id);
      return next;
    });
    if (save.status === "saved") {
      setUndo({ file: request.file, title, diff: save.diff, previous: previous && previous.revision === save.previousRevision ? previous.text : null, revision: save.revision, state: "saved" });
      forgetPickers();
      onWrite?.({ kind: "saved", file: request.file, revision: save.revision });
    }
    reload();
  };

  const review = (field: DerivedField, title: string, request: KeyEditRequest) => {
    const opened: Review = { field, title, request, preview: null, previous: undefined, error: null, busy: true };
    setReviewing(opened);
    const mine = () => reviewRef.current?.request === request;
    Promise.all([previewKey(request), request.expectedRevision ? readFileText(request.file) : Promise.resolve(null)]).then(
      ([preview, previous]) => mine() && setReviewing((r) => (r ? { ...r, preview, previous, busy: false } : r)),
      (error) => mine() && setReviewing((r) => (r ? { ...r, error, busy: false } : r)),
    );
  };

  const confirm = async () => {
    const r = reviewRef.current;
    if (!r || !r.preview) return;
    setReviewing({ ...r, busy: true, error: null });
    try {
      const save = await saveKey(r.request);
      setReviewing(null);
      afterSave(r.field, r.title, r.request, r.previous ?? null, save);
    } catch (error) {
      setReviewing((cur) => (cur ? { ...cur, busy: false, error } : cur));
    }
  };

  const saveNow = async (field: DerivedField, title: string, request: KeyEditRequest) => {
    setBusy((s) => new Set(s).add(field.id));
    setFailures((m) => {
      const next = new Map(m);
      next.delete(field.id);
      return next;
    });
    try {
      const previous = request.expectedRevision ? await readFileText(request.file) : null;
      const save = await saveKey(request);
      afterSave(field, title, request, previous, save);
    } catch (error) {
      setFailures((m) => new Map(m).set(field.id, error));
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(field.id);
        return next;
      });
    }
  };

  const undoLast = async () => {
    const u = undo;
    if (!u || u.previous === null || u.state !== "saved") return;
    setUndo({ ...u, state: "undoing" });
    try {
      const restored = await restoreFile(u.file, u.previous, u.revision);
      setUndo({ ...u, state: "undone" });
      forgetPickers();
      onWrite?.({ kind: "undone", file: u.file, revision: restored.revision ?? null });
      reload();
    } catch (error) {
      setUndo({ ...u, state: "failed", error });
    }
  };

  return {
    edits,
    setEdit,
    review,
    saveNow,
    busy,
    failures,
    undo,
    undoLast,
    dismissUndo: () => setUndo(null),
    reviewing,
    confirm,
    cancel: () => setReviewing(null),
  };
}

/** The review of one write: the diff of the file, the problems it would bring, then "Salvar". */
export function ReviewDialog({ editor, onReload }: { editor: KeyEditor; onReload: () => void }) {
  const r = editor.reviewing;
  if (!r) return null;
  const p = r.preview;
  const blocked = p !== null && (p.problems.length > 0 || !p.writable);
  const conflict = isConflict(r.error);
  return (
    <Dialog title={ft("df_review_title", { file: r.request.file })} onClose={editor.cancel} wide>
      <div className="stack df-review" data-testid="df-review">
        <p>
          {ft(r.request.op === "remove" ? "df_review_remove" : "df_review_set", { field: r.title })} <code>{r.field.id}</code>
        </p>
        {r.busy && !p ? (
          <p className="spinner-text" role="status">
            {ft("df_review_loading")}
          </p>
        ) : null}
        {p ? (
          p.changed ? (
            <DiffView diff={p.diff} />
          ) : (
            <p className="notice" role="status">
              {ft("df_review_unchanged")}
            </p>
          )
        ) : null}
        {p && p.pruned.length > 0 ? <p className="small muted">{ft("df_review_pruned", { keys: p.pruned.join(", ") })}</p> : null}
        {p && p.problems.length > 0 ? (
          <div className="notice error" role="alert" data-testid="df-review-problems">
            <Icon name="alert" />
            <div className="stack tight">
              <strong>{ft("df_review_problems", { count: p.problems.length })}</strong>
              <ul className="df-problems">
                {p.problems.map((x, i) => (
                  <li key={`${x.path}-${i}`}>
                    <code>{x.path}</code> {x.message}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
        {p && !p.writable && p.problems.length === 0 ? (
          <p className="notice warn" role="alert">
            {ft("df_review_not_writable")}
          </p>
        ) : null}
        {conflict ? (
          <div className="notice warn" role="alert" data-testid="df-conflict">
            <Icon name="alert" />
            <div className="stack tight">
              <strong>{ft("df_conflict_title")}</strong>
              <p className="small">{ft("df_conflict_lead")}</p>
              <div>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    editor.cancel();
                    onReload();
                  }}
                >
                  <Icon name="refresh" />
                  {ft("df_conflict_reload")}
                </button>
              </div>
            </div>
          </div>
        ) : r.error ? (
          <ErrorNotice error={r.error} />
        ) : null}
        <div className="row wrap">
          <button type="button" className="btn primary" disabled={!p || !p.changed || blocked || r.busy || conflict} onClick={() => void editor.confirm()}>
            {r.busy && p ? <Spinner /> : null}
            {ft("df_save")}
          </button>
          <button type="button" className="btn" onClick={editor.cancel}>
            {ft("df_cancel")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** After a write: what changed, and "Desfazer" while the file is still as the save left it. */
export function UndoBar({ editor }: { editor: KeyEditor }) {
  const u = editor.undo;
  return (
    <div aria-live="polite" className="df-undo-slot">
      {u ? (
        <div className={`notice ${u.state === "failed" ? "error" : "ok"} df-undo`} data-testid="df-undo" data-state={u.state}>
          <Icon name={u.state === "failed" ? "alert" : "check"} />
          <div className="stack tight grow">
            <p>
              {u.state === "undone" ? ft("df_undo_done", { file: u.file }) : ft("df_saved", { field: u.title, file: u.file })}
              {u.state === "saved" && u.previous === null ? ` ${ft("df_saved_created")}` : ""}
            </p>
            {u.state === "failed" ? (
              isConflict(u.error) ? (
                <p className="small">{ft("df_undo_conflict")}</p>
              ) : (
                <ErrorNotice error={u.error} />
              )
            ) : null}
            {u.state !== "undone" && u.diff ? (
              <details className="df-undo-diff">
                <summary>{ft("df_show_change")}</summary>
                <DiffView diff={u.diff} />
              </details>
            ) : null}
            <div className="row wrap">
              {u.previous !== null && (u.state === "saved" || u.state === "undoing") ? (
                <button type="button" className="btn" disabled={u.state === "undoing"} onClick={() => void editor.undoLast()}>
                  {u.state === "undoing" ? <Spinner /> : null}
                  {ft("df_undo")}
                </button>
              ) : null}
              <button type="button" className="btn" onClick={editor.dismissUndo}>
                {ft("df_dismiss")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
