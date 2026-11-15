// "Não se aplica" on a requirement, a section or a chapter: the required reason (3 to 300 characters), the entry that will
// be written to .jgates/asvs.json shown before saving (from the same code as the write: a preview request), then the write.
// The undo is offered by the screen after the write.
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { DiffView } from "../../components/DiffView";
import { Dialog, ErrorNotice, Spinner } from "../../components/common";
import { t } from "../../i18n";

const FILE = ".jgates/asvs.json";
const REASON_MIN = 3;
const REASON_MAX = 300;

export interface Target {
  id: string;
  label: string;
  kind: "requirement" | "section" | "chapter";
}

interface Preview {
  diff: string;
  created: boolean;
}

export interface Written {
  undo: { file: string; expectedRevision: string; previous: string | null };
}

export function NotApplicableDialog({ target, revision, lang, onClose, onWritten }: { target: Target; revision: string; lang: string; onClose: () => void; onWritten: (info: Written) => void }) {
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const keepEditing = useRef<HTMLButtonElement>(null);

  const trimmed = reason.trim();
  const valid = trimmed.length >= REASON_MIN && trimmed.length <= REASON_MAX;
  const dirty = trimmed !== "";
  const requestClose = (): void => {
    if (!dirty) onClose();
    else setConfirmDiscard(true);
  };
  useEffect(() => {
    if (confirmDiscard) keepEditing.current?.focus();
  }, [confirmDiscard]);

  // The entry that will be written: asked again when the reason changes.
  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (!valid) {
      setLoadingPreview(false);
      return;
    }
    let live = true;
    setLoadingPreview(true);
    const timer = setTimeout(() => {
      api("POST", `/api/coverage/asvs/decisions?lang=${lang}`, { action: "not-applicable", id: target.id, reason: trimmed, expectedRevision: revision, preview: true }).then(
        (r) => {
          if (!live) return;
          setPreview({ diff: String(r.diff ?? ""), created: r.created === true });
          setLoadingPreview(false);
        },
        (e) => {
          if (!live) return;
          setPreviewError(e);
          setLoadingPreview(false);
        },
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [valid, trimmed, target.id, revision, lang]);

  const submit = async (): Promise<void> => {
    if (!valid || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await api("POST", `/api/coverage/asvs/decisions?lang=${lang}`, { action: "not-applicable", id: target.id, reason: trimmed, expectedRevision: revision });
      onWritten({ undo: r.undo });
    } catch (e) {
      setSaveError(e);
      setSaving(false);
    }
  };

  return (
    <Dialog title={t("asvs_na_title", { id: target.id })} onClose={requestClose} wide>
      <div className="stack" data-testid="asvs-na-dialog">
        {confirmDiscard ? (
          <div className="notice warn" role="alert" data-testid="asvs-na-discard">
            <div className="stack tight grow">
              <strong>{t("asvs_na_discard_title")}</strong>
              <div className="row wrap">
                <button type="button" className="btn primary" ref={keepEditing} onClick={() => setConfirmDiscard(false)} data-testid="asvs-na-keep">
                  {t("asvs_na_discard_keep")}
                </button>
                <button type="button" className="btn danger" onClick={onClose} data-testid="asvs-na-discard-yes">
                  {t("asvs_na_discard_yes")}
                </button>
              </div>
            </div>
          </div>
        ) : null}
        <p>{t(`asvs_na_lead_${target.kind}`, { target: target.label })}</p>
        <label className="stack" style={{ gap: 4 }}>
          <span>{t("asvs_na_reason_field")}</span>
          <input type="text" value={reason} maxLength={REASON_MAX} required aria-describedby="asvs-na-reason-hint" onChange={(e) => setReason(e.target.value)} data-testid="asvs-na-reason" />
        </label>
        <p className="small muted" id="asvs-na-reason-hint">
          {t("asvs_na_reason_hint", { min: REASON_MIN, max: REASON_MAX })}
        </p>
        <section className="stack" style={{ gap: 6 }} aria-labelledby="asvs-na-entry-title" data-testid="asvs-na-entry">
          <strong id="asvs-na-entry-title">{t("asvs_na_entry_title", { file: FILE })}</strong>
          {!valid ? (
            <p className="small muted" data-testid="asvs-na-entry-wait">
              {t("asvs_na_entry_wait")}
            </p>
          ) : loadingPreview ? (
            <p className="small">
              <Spinner /> {t("asvs_na_entry_loading")}
            </p>
          ) : previewError ? (
            <ErrorNotice error={previewError} />
          ) : preview ? (
            <>
              <p className="small">{preview.created ? t("asvs_na_entry_created", { file: FILE }) : t("asvs_na_entry_added", { file: FILE })}</p>
              <div data-testid="asvs-na-diff">
                <DiffView diff={preview.diff} />
              </div>
            </>
          ) : null}
        </section>
        {saveError ? <ErrorNotice error={saveError} /> : null}
        <div className="row wrap">
          <button type="button" className="btn primary" disabled={!valid || saving || loadingPreview || previewError !== null} onClick={() => void submit()} data-testid="asvs-na-save">
            {t("asvs_na")}
          </button>
          <button type="button" className="btn" onClick={requestClose} data-testid="asvs-na-cancel">
            {t("cancel")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
