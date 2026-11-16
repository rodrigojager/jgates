// "Dispensar" on a finding of the result (PLAN-waivers.md section 7): the dialog (until when, why, the entry shown before
// saving), the card states after a write (dismissed until a date with "Desfazer", "Remover dispensa") and the line at the
// top of the result that offers "Validar de novo". Every write goes through the routes of the project's waiver file
// (POST /api/waivers with `preview: true` first, DELETE /api/waivers/:id, POST /api/waivers/undo). The stored result is
// never rewritten: the card says what was done here, and the dismissal counts from the next validation.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../../api";
import { useShell } from "../../app/shell-context";
import { DiffView } from "../../components/DiffView";
import { Dialog, ErrorNotice, Spinner } from "../../components/common";
import { Icon } from "../../components/icons";
import { t } from "../../i18n";
import { EMPTY_REQUEST, writeRequest, type TargetKind } from "../validations-review/request";

const FILE = ".jgates/waivers.json";
const PRESET_DAYS = [30, 90, 180] as const;
const REASONS = ["false_positive", "legacy", "test_code", "accepted_risk"] as const;
const REASON_MIN = 3;
const REASON_MAX = 300;

interface UndoData {
  file: string;
  expectedRevision: string;
  previous: string | null;
}

interface WaiverListing {
  file: string;
  exists: boolean;
  revision: string;
  problem?: { message: string };
  runId: string | null;
  waivers: Array<{ id: string; tool?: string; rule?: string; path?: string; line?: number; state: string }>;
}

interface Added {
  until: string;
  undo: UndoData;
}

interface WaiveApi {
  /** Why "Dispensar" is disabled for this finding, or null when it is offered. */
  blockedReason(f: any): string | null;
  addedOf(f: any): Added | null;
  removedOf(f: any): UndoData | null;
  /** The id of the entry of the project's file that waived this finding in the run, when it still exists. */
  removableId(f: any): string | null;
  dismissed: number;
  runId: string;
  revision: string | undefined;
  stageState(f: any): string | null;
  save(f: any, until: string, reason: string): Promise<void>;
  undoAdd(f: any): Promise<void>;
  remove(f: any, id: string): Promise<void>;
  undoRemove(f: any): Promise<void>;
  error: unknown;
  busy: boolean;
  preview(f: any, until: string, reason: string): Promise<{ diff: string; created: boolean }>;
}

const WaiveContext = createContext<WaiveApi | null>(null);
const useWaive = (): WaiveApi | null => useContext(WaiveContext);

/** Reflect reviews made here without rewriting the historical result. Undo restores the stored occurrence. */
export function useReviewedFindings(findings: any[]): any[] {
  const waive = useWaive();
  return findings.map((f) => {
    const added = f.review === true ? waive?.addedOf(f) : null;
    return added ? { ...f, waived: true, waiverExpires: added.until } : f;
  });
}

const pad = (n: number): string => String(n).padStart(2, "0");
const dateKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayKey = (): string => dateKey(new Date());
export function inDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return dateKey(d);
}
const REAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isRealDate(value: string): boolean {
  const m = REAL_DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCDate() === Number(m[3]);
}

const fingerprintOf = (f: any): string | null => (typeof f.fingerprint === "string" && f.fingerprint !== "" ? f.fingerprint : null);
/** What a card remembers its session state under: the fingerprint, or where the finding is for one without. */
const keyOf = (f: any): string => fingerprintOf(f) ?? `${f.tool}:${f.ruleId}@${f.location?.path ?? ""}:${f.location?.line ?? ""}`;

/** The request that opens the review again with the gate, the target and the profile of the result. */
function requestOf(result: any) {
  const scope = String(result.selection?.scope ?? "full");
  const target: TargetKind = scope === "changed" ? "changed" : scope === "paths" ? "paths" : "full";
  const base = target === "changed" && typeof result.analyzed?.git?.base === "string" ? result.analyzed.git.base : "";
  const profile = typeof result.selection?.profile === "string" && result.selection.profile !== "" ? result.selection.profile : null;
  return { ...EMPTY_REQUEST, gates: "quality" as const, profile, target, base };
}

export function WaiveProvider({ result, children }: { result: any; children: ReactNode }) {
  const shell = useShell();
  const governed = shell.info?.mode === "governed";
  const runId = String(result.runId);
  const [listing, setListing] = useState<WaiverListing | null>(null);
  const [added, setAdded] = useState<Record<string, Added>>({});
  const [removed, setRemoved] = useState<Record<string, UndoData>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api("GET", "/api/waivers").then(
      (r) => live && setListing(r as WaiverListing),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [runId]);

  const stageStates = useMemo(() => new Map<string, string>((result.stages ?? []).map((s: any) => [String(s.id), String(s.state)])), [result]);

  const guarded = async <T,>(work: () => Promise<T>): Promise<T> => {
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const value: WaiveApi = {
    blockedReason(f) {
      if (governed) return t("vres_waive_blocked_governed");
      if (fingerprintOf(f) === null) return t("vres_waive_blocked_no_fingerprint");
      return null;
    },
    addedOf: (f) => added[fingerprintOf(f) ?? ""] ?? null,
    removedOf: (f) => removed[keyOf(f)] ?? null,
    removableId(f) {
      // The finding carries the waiver's key (a fingerprint, an anchor or rule@path), not the entry's id: the entry is found
      // by what it points at, and only when exactly one live entry does.
      const at = f.location?.path;
      if (!f.waived || f.waiverSource !== "project" || !at || !listing) return null;
      const same = listing.waivers.filter((w) => w.state === "live" && w.rule === f.ruleId && w.path === at && (w.tool === undefined || w.tool === f.tool) && (w.line === undefined || w.line === f.location?.line));
      return same.length === 1 ? same[0]!.id : null;
    },
    dismissed: Object.keys(added).length,
    runId,
    revision: listing?.revision,
    stageState: (f) => stageStates.get(String(f.stageId)) ?? null,
    async preview(f, until, reason) {
      const r = await api("POST", "/api/waivers", { runId, fingerprints: [fingerprintOf(f)], until, reason, ...(listing ? { expectedRevision: listing.revision } : {}), preview: true });
      return { diff: String(r.diff ?? ""), created: r.created === true };
    },
    async save(f, until, reason) {
      const fp = fingerprintOf(f);
      if (!fp) return;
      const r = await guarded(() => api("POST", "/api/waivers", { runId, fingerprints: [fp], until, reason, ...(listing ? { expectedRevision: listing.revision } : {}) }));
      setListing(r.waivers as WaiverListing);
      setAdded((a) => ({ ...a, [fp]: { until, undo: r.undo as UndoData } }));
      setRemoved(({ [fp]: _gone, ...rest }) => rest);
    },
    async undoAdd(f) {
      const fp = fingerprintOf(f);
      const entry = fp ? added[fp] : undefined;
      if (!fp || !entry) return;
      const r = await guarded(() => api("POST", "/api/waivers/undo", { undo: entry.undo }));
      setListing(r.waivers as WaiverListing);
      setAdded(({ [fp]: _gone, ...rest }) => rest);
    },
    async remove(f, id) {
      const fp = keyOf(f);
      const query = listing ? `?expectedRevision=${encodeURIComponent(listing.revision)}` : "";
      const r = await guarded(() => api("DELETE", `/api/waivers/${encodeURIComponent(id)}${query}`));
      setListing(r.waivers as WaiverListing);
      setRemoved((x) => ({ ...x, [fp]: r.undo as UndoData }));
    },
    async undoRemove(f) {
      const fp = keyOf(f);
      const undo = removed[fp];
      if (!undo) return;
      const r = await guarded(() => api("POST", "/api/waivers/undo", { undo }));
      setListing(r.waivers as WaiverListing);
      setRemoved(({ [fp]: _gone, ...rest }) => rest);
    },
    error,
    busy,
  };
  return <WaiveContext.Provider value={value}>{children}</WaiveContext.Provider>;
}

/** The line at the top of the result: how many findings were dismissed here, and "Validar de novo". */
export function WaiveSummary({ result }: { result: any }) {
  const waive = useWaive();
  if (!waive || waive.dismissed === 0) return null;
  const again = () => {
    writeRequest(requestOf(result));
    window.location.hash = "#/validations/review";
  };
  return (
    <div className="notice" role="status" data-testid="waive-summary">
      <Icon name="info" />
      <div className="grow stack" style={{ gap: 6 }}>
        <strong data-testid="waive-summary-text">{t("vres_waive_summary", { count: waive.dismissed })}</strong>
        <p className="small">{t("vres_waive_summary_text")}</p>
        <p>
          <button type="button" className="btn primary" onClick={again} data-testid="waive-validate-again">
            {t("vres_waive_validate_again")}
          </button>
        </p>
      </div>
    </div>
  );
}

/** What a card of a finding adds: "Dispensar", or what was done to it here, or "Remover dispensa". */
export function WaiveBlock({ f }: { f: any }) {
  const waive = useWaive();
  const [open, setOpen] = useState(false);
  if (!waive) return null;
  const added = waive.addedOf(f);
  const removed = waive.removedOf(f);
  const removableId = waive.removableId(f);
  const governed = waive.blockedReason(f);
  const asked = (work: Promise<void>) => work.catch(() => undefined);
  if (added) {
    return (
      <div className="stack" style={{ gap: 6 }} data-testid="waive-state" data-state="added">
        <p className="small">
          <strong>{t(f.review === true ? "vres_reviewed_until" : "vres_waive_added_until", { date: added.until })}</strong> · {t("vres_waive_counts_next")}
        </p>
        <div className="row wrap">
          <button type="button" className="btn" disabled={waive.busy} onClick={() => asked(waive.undoAdd(f))} data-testid="waive-undo">
            {t("vres_waive_undo")}
          </button>
        </div>
        {waive.error ? <ErrorNotice error={waive.error} /> : null}
      </div>
    );
  }
  if (removed) {
    return (
      <div className="stack" style={{ gap: 6 }} data-testid="waive-state" data-state="removed">
        <p className="small">
          <strong>{t("vres_waive_removed")}</strong> · {t("vres_waive_counts_next")}
        </p>
        <div className="row wrap">
          <button type="button" className="btn" disabled={waive.busy} onClick={() => asked(waive.undoRemove(f))} data-testid="waive-undo-remove">
            {t("vres_waive_undo")}
          </button>
        </div>
        {waive.error ? <ErrorNotice error={waive.error} /> : null}
      </div>
    );
  }
  if (f.waived) {
    if (!removableId) return null;
    return (
      <div className="stack" style={{ gap: 6 }}>
        <div className="row wrap">
          <button type="button" className="btn" disabled={waive.busy || governed !== null} onClick={() => asked(waive.remove(f, removableId))} data-testid="waive-remove">
            {t("vres_waive_remove")}
          </button>
          {governed ? <span className="small muted">{governed}</span> : null}
        </div>
        {waive.error ? <ErrorNotice error={waive.error} /> : null}
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row wrap">
        <button type="button" className="btn" disabled={governed !== null} onClick={() => setOpen(true)} data-testid="waive-button">
          {t(f.review === true ? "vres_review_action" : "vres_waive")}
        </button>
        {governed ? (
          <span className="small muted" data-testid="waive-blocked">
            {governed}
          </span>
        ) : null}
      </div>
      {open ? <WaiveDialog f={f} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function WaiveDialog({ f, onClose }: { f: any; onClose: () => void }) {
  const waive = useWaive() as WaiveApi;
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<{ diff: string; created: boolean } | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);

  const today = todayKey();
  const trimmed = reason.trim();
  const untilProblem = until === "" ? "required" : !isRealDate(until) ? "invalid" : until < today ? "past" : null;
  const reasonProblem = trimmed.length < REASON_MIN ? "short" : null;
  const valid = untilProblem === null && reasonProblem === null;
  const loc = f.location?.path ? `${f.location.path}${f.location.line ? `:${f.location.line}` : ""}` : "";
  const stageState = waive.stageState(f);
  const incomplete = stageState !== null && stageState !== "completed";

  // Typed content is not thrown away without asking: Escape, Close and Cancel all ask first.
  const dirty = trimmed !== "";
  const guard = useRef(false);
  guard.current = dirty;
  const requestClose = () => {
    if (!dirty) onClose();
    else setConfirmDiscard(true);
  };
  useEffect(() => {
    if (confirmDiscard) keepEditing.current?.focus();
  }, [confirmDiscard]);
  useEffect(() => {
    const dialog = () => root.current?.closest("dialog") ?? null;
    const onCancel = (e: Event) => {
      if (guard.current && e.target === dialog()) e.preventDefault();
    };
    const onClosed = (e: Event) => {
      const d = dialog();
      if (guard.current && d && e.target === d && !d.open) d.showModal();
    };
    document.addEventListener("cancel", onCancel, true);
    document.addEventListener("close", onClosed, true);
    return () => {
      document.removeEventListener("cancel", onCancel, true);
      document.removeEventListener("close", onClosed, true);
    };
  }, []);

  // The entry that will be written, from the same code as the write: asked again when the date or the reason changes.
  const previewFn = useRef(waive.preview);
  previewFn.current = waive.preview;
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
      previewFn.current(f, until, trimmed).then(
        (p) => {
          if (!live) return;
          setPreview(p);
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
  }, [valid, until, trimmed, f]);

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await waive.save(f, until, trimmed);
      onClose();
    } catch (e) {
      setSaveError(e);
      setSaving(false);
    }
  };

  return (
    <Dialog title={t(f.review === true ? "vres_review_action" : "vres_waive_title")} onClose={requestClose} wide>
      <div className="stack" data-testid="waive-dialog" ref={root}>
        {confirmDiscard ? (
          <div className="notice warn" role="alert" data-testid="waive-discard">
            <Icon name="alert" />
            <div className="stack tight grow">
              <strong>{t("vres_waive_discard_title")}</strong>
              <p className="small">{t("vres_waive_discard_lead")}</p>
              <div className="row wrap">
                <button type="button" className="btn primary" ref={keepEditing} data-testid="waive-keep" onClick={() => setConfirmDiscard(false)}>
                  {t("vres_waive_discard_keep")}
                </button>
                <button type="button" className="btn danger" data-testid="waive-discard-yes" onClick={onClose}>
                  {t("vres_waive_discard_yes")}
                </button>
              </div>
            </div>
          </div>
        ) : null}
        <dl className="kv" data-testid="waive-finding">
          <dt>{t("vres_finding_tool")}</dt>
          <dd data-testid="waive-finding-tool">{f.origin ?? f.tool}</dd>
          <dt>{t("vres_col_rule")}</dt>
          <dd>
            <code data-testid="waive-finding-rule">{f.ruleId}</code>
          </dd>
          <dt>{t("vres_waive_message")}</dt>
          <dd data-testid="waive-finding-message">{f.message}</dd>
          {loc ? (
            <>
              <dt>{t("vres_col_location")}</dt>
              <dd>
                <code data-testid="waive-finding-location">{loc}</code>
              </dd>
            </>
          ) : null}
        </dl>
        {incomplete ? (
          <div className="notice warn" data-testid="waive-incomplete">
            <Icon name="alert" />
            <p>{t("vres_waive_incomplete")}</p>
          </div>
        ) : null}

        <fieldset className="stack" style={{ gap: 8 }} data-testid="waive-until">
          <legend>
            <strong>{t("vres_waive_until_title")}</strong>
          </legend>
          <div className="row wrap" role="group" aria-label={t("vres_waive_presets")}>
            {PRESET_DAYS.map((days) => (
              <button type="button" className="btn" key={days} data-testid={`waive-preset-${days}`} aria-pressed={until === inDays(days)} onClick={() => setUntil(inDays(days))}>
                {t("vres_waive_preset_days", { days })}
              </button>
            ))}
          </div>
          <label className="stack" style={{ gap: 4 }}>
            <span>{t("vres_waive_date")}</span>
            <input type="date" value={until} min={today} required aria-invalid={until !== "" && untilProblem !== null} onChange={(e) => setUntil(e.target.value)} data-testid="waive-date" />
          </label>
          {untilProblem === "past" ? (
            <p className="small" role="alert" data-testid="waive-date-problem">
              {t("vres_waive_date_past")}
            </p>
          ) : untilProblem === "invalid" ? (
            <p className="small" role="alert" data-testid="waive-date-problem">
              {t("vres_waive_date_invalid")}
            </p>
          ) : null}
        </fieldset>

        <fieldset className="stack" style={{ gap: 8 }} data-testid="waive-reason-group">
          <legend>
            <strong>{t("vres_waive_reason_title")}</strong>
          </legend>
          <div className="row wrap" role="group" aria-label={t("vres_waive_reasons")}>
            {REASONS.map((key) => (
              <button type="button" className="btn" key={key} data-testid={`waive-reason-${key}`} onClick={() => setReason(t(`vres_waive_reason_${key}`))}>
                {t(`vres_waive_reason_${key}`)}
              </button>
            ))}
          </div>
          <label className="stack" style={{ gap: 4 }}>
            <span>{t("vres_waive_reason_field")}</span>
            <input type="text" value={reason} maxLength={REASON_MAX} required aria-describedby="waive-reason-hint" onChange={(e) => setReason(e.target.value)} data-testid="waive-reason" />
          </label>
          <p className="small muted" id="waive-reason-hint">
            {t("vres_waive_reason_hint", { min: REASON_MIN })}
          </p>
        </fieldset>

        <section className="stack" style={{ gap: 6 }} aria-labelledby="waive-entry-title" data-testid="waive-entry">
          <strong id="waive-entry-title">{t("vres_waive_entry_title", { file: FILE })}</strong>
          {!valid ? (
            <p className="small muted" data-testid="waive-entry-wait">
              {t("vres_waive_entry_wait")}
            </p>
          ) : loadingPreview ? (
            <p className="small">
              <Spinner /> {t("vres_waive_entry_loading")}
            </p>
          ) : previewError ? (
            <ErrorNotice error={previewError} />
          ) : preview ? (
            <>
              <p className="small">{preview.created ? t("vres_waive_entry_created", { file: FILE }) : t("vres_waive_entry_added", { file: FILE })}</p>
              <div data-testid="waive-entry-diff">
                <DiffView diff={preview.diff} />
              </div>
            </>
          ) : null}
        </section>

        {saveError ? <ErrorNotice error={saveError} /> : null}
        <div className="row wrap">
          <button type="button" className="btn primary" disabled={!valid || saving || loadingPreview || previewError !== null} onClick={submit} data-testid="waive-save">
            {t(f.review === true ? "vres_review_action" : "vres_waive")}
          </button>
          <button type="button" className="btn" onClick={requestClose} data-testid="waive-cancel">
            {t("cancel")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
