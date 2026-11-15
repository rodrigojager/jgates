// "Dispensas do projeto" (PLAN-waivers.md section 8): the waivers of the project's `.jgates/waivers.json` that the next
// Quality validation will read, one row each, with "Remover" (one click, no dialog) and "Desfazer" right after. The data
// is `review.waivers` of POST /api/plans; removal and undo are the routes of the waiver file (DELETE /api/waivers/<id>,
// POST /api/waivers/undo), which call the same functions as `jgates waivers`. The list is its own control, not a derived
// form: it never edits the file any other way.
import { useEffect, useState } from "react";
import { api } from "../../api";
import { ErrorNotice, Pill } from "../../components/common";
import { Icon } from "../../components/icons";
import { t } from "../../i18n";

export interface WaiverRow {
  id: string;
  kind: "occurrence" | "handwritten";
  tool?: string;
  rule?: string;
  path?: string;
  line?: number;
  reason?: string;
  created?: string;
  expires?: string;
  state: "live" | "expired" | "stale";
  cause?: string;
  matched: boolean | null;
  matchedFindings: number;
}

export interface WaiverListing {
  file: string;
  exists: boolean;
  revision: string;
  problem?: { message: string; line?: number; column?: number };
  runId: string | null;
  waivers: WaiverRow[];
}

interface UndoData {
  file: string;
  expectedRevision: string;
  previous: string | null;
}

/** The waivers the next run will apply: the live ones. */
export const applyingWaivers = (listing: WaiverListing | null | undefined): number => (listing?.waivers ?? []).filter((w) => w.state === "live").length;

/** Whether the section has anything to show: an entry, or a file that cannot be read. */
export const hasWaiversToShow = (listing: WaiverListing | null | undefined): boolean => Boolean(listing) && ((listing?.waivers.length ?? 0) > 0 || Boolean(listing?.problem));

function fileHref(listing: WaiverListing): string {
  const line = listing.problem?.line;
  return `#/config/yaml?file=${encodeURIComponent(listing.file)}${line ? `&line=${line}` : ""}`;
}

function place(w: WaiverRow): string {
  if (!w.path) return "";
  return w.line !== undefined && w.kind === "occurrence" ? `${w.path}:${w.line}` : w.path;
}

function Row({ w, busy, onRemove }: { w: WaiverRow; busy: boolean; onRemove: (w: WaiverRow) => void }) {
  const name = [w.tool, w.rule].filter(Boolean).join(" · ") || w.id;
  const applies = w.state === "live";
  return (
    <li className="capst-row" data-testid="waiver-row" data-waiver={w.id} data-state={w.state} data-applies={applies ? "true" : "false"} data-kind={w.kind}>
      <div className="capst-main">
        <strong className="capst-name" data-testid="waiver-rule">
          {name}
        </strong>
        {w.path ? (
          <code className="small" style={{ overflowWrap: "anywhere" }} data-testid="waiver-place">
            {place(w)}
          </code>
        ) : null}
        {w.state === "expired" ? <Pill tone="gold">{t("wvr_expired", { date: w.expires ?? "" })}</Pill> : null}
        {w.state === "stale" ? <Pill tone="gold">{t("wvr_stale")}</Pill> : null}
        {!applies ? <Pill>{t("wvr_not_applying")}</Pill> : null}
      </div>
      {w.reason ? (
        <p className="small capst-sub" style={{ overflowWrap: "anywhere" }} data-testid="waiver-reason">
          {w.reason}
        </p>
      ) : null}
      <p className="small muted capst-sub" data-testid="waiver-meta">
        {w.expires && w.state !== "expired" ? `${t("wvr_until", { date: w.expires })} · ` : ""}
        <span data-testid="waiver-matched">{w.matched === null ? t("wvr_matched_unknown") : w.matched ? t("wvr_matched", { count: w.matchedFindings }) : t("wvr_unmatched")}</span>
      </p>
      <div className="capst-action">
        <button type="button" className="btn capst-btn" disabled={busy} onClick={() => onRemove(w)} aria-label={`${t("wvr_remove")}: ${name}${place(w) ? ` ${place(w)}` : ""}`}>
          <Icon name="x" />
          {t("wvr_remove")}
        </button>
      </div>
    </li>
  );
}

/**
 * The section. `listing` comes from the plan; the section keeps the listing the server answers after a removal or an
 * undo, and tells the screen (`onListing`) so the summary counts what will apply.
 */
export function WaiversSection({ listing, onListing, headingId, level = 2 }: { listing: WaiverListing; onListing?: (next: WaiverListing) => void; headingId: string; level?: 2 | 3 }) {
  const [current, setCurrent] = useState<WaiverListing>(listing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [undo, setUndo] = useState<{ data: UndoData; label: string } | null>(null);
  const [announce, setAnnounce] = useState("");
  // A new plan carries a fresh listing: it replaces the local one.
  useEffect(() => setCurrent(listing), [listing]);
  const Heading = level === 2 ? "h2" : "h3";

  const adopt = (next: WaiverListing) => {
    setCurrent(next);
    onListing?.(next);
  };

  async function remove(w: WaiverRow) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ undo: UndoData; waivers: WaiverListing }>("DELETE", `/api/waivers/${encodeURIComponent(w.id)}?expectedRevision=${encodeURIComponent(current.revision)}`);
      const label = [w.tool, w.rule].filter(Boolean).join(" · ") || w.id;
      adopt(r.waivers);
      setUndo({ data: r.undo, label });
      setAnnounce(t("wvr_removed", { name: label }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!undo) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ waivers: WaiverListing }>("POST", "/api/waivers/undo", { undo: undo.data });
      adopt(r.waivers);
      setUndo(null);
      setAnnounce(t("wvr_restored", { name: undo.label }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const applying = applyingWaivers(current);
  return (
    <section className="card flat stack capst" aria-labelledby={headingId} data-testid="waivers-review" data-count={current.waivers.length} data-applying={applying}>
      <div>
        <Heading id={headingId}>{t("wvr_title")}</Heading>
        <p className="muted small">{t("wvr_lead")}</p>
      </div>
      {current.problem ? (
        <div className="notice warn" role="alert" data-testid="waivers-problem">
          <Icon name="alert" />
          <div className="stack tight">
            <span>{t("wvr_problem", { file: current.file, detail: current.problem.message })}</span>
            <a href={fileHref(current)}>{t("wvr_open_file", { file: current.file })}</a>
          </div>
        </div>
      ) : null}
      {current.waivers.length > 0 ? (
        <>
          <p className="small" data-testid="waivers-applying">
            {t("wvr_applying", { count: applying })}
          </p>
          <ul className="capst-list" aria-label={t("wvr_list_label")}>
            {current.waivers.map((w) => (
              <Row key={w.id} w={w} busy={busy} onRemove={(x) => void remove(x)} />
            ))}
          </ul>
        </>
      ) : null}
      {undo ? (
        <div className="notice" data-testid="waivers-undo">
          <Icon name="info" />
          <span className="grow">{t("wvr_removed", { name: undo.label })}</span>
          <button type="button" className="btn" disabled={busy} onClick={() => void restore()}>
            {t("wvr_undo")}
          </button>
        </div>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      {error ? <ErrorNotice error={error} /> : null}
    </section>
  );
}
