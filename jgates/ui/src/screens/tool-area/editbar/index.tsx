import { Icon } from "../../../components/icons";
import { Pill } from "../../../components/common";
import { t } from "../../../i18n";
import type { DraftState } from "./drafts";
import { eb } from "./messages";

// Edit bar of the Files tab (not a tab itself: the tool screen only loads folders that export `tab`). It shows whether
// the text has unsaved changes and what happens to them (the draft in the data folder), and offers validate, diff and
// save. The bar never writes: each button hands the action back to the tool screen.

export interface EditBarProps {
  dirty: boolean;
  busy: boolean;
  editable: boolean;
  draftState: DraftState;
  hasDraft: boolean;
  onValidate(): void;
  onDiff(): void;
  onSave(): void;
  onReload(): void;
  onDiscardDraft(): void;
}

function draftLine(state: DraftState, hasDraft: boolean, dirty: boolean): string {
  if (state === "saving") return eb("draft_saving");
  if (state === "error") return eb("draft_error");
  if (state === "saved" || (hasDraft && dirty)) return eb("draft_saved");
  return eb("draft_none");
}

export function EditBar({ dirty, busy, editable, draftState, hasDraft, onValidate, onDiff, onSave, onReload, onDiscardDraft }: EditBarProps) {
  return (
    <div className="edit-bar" role="region" aria-label={eb("bar_label")}>
      <div className="row wrap">
        <Pill tone={dirty ? "gold" : undefined}>{dirty ? t("doc_dirty") : t("doc_clean")}</Pill>
        <span className="small muted" data-testid="draft-state" data-state={draftState}>
          {draftLine(draftState, hasDraft, dirty)}
        </span>
      </div>
      <div className="row wrap">
        <button type="button" className="btn" disabled={busy || !editable} onClick={onValidate}>
          <Icon name="check" />
          {eb("validate")}
        </button>
        <button type="button" className="btn" disabled={busy || !editable || !dirty} onClick={onDiff}>
          <Icon name="file" />
          {eb("view_diff")}
        </button>
        <button type="button" className="btn primary" disabled={!editable || !dirty || busy} onClick={onSave}>
          <Icon name="check" />
          {t("doc_review")}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onReload}>
          <Icon name="refresh" />
          {t("doc_reload")}
        </button>
        {hasDraft ? (
          <button type="button" className="btn" disabled={busy} onClick={onDiscardDraft}>
            {eb("discard_draft")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
