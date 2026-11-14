import { useState } from "react";
import { formatSize } from "../../components/format";
import { api } from "../../api";
import { Dialog, ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t } from "../../i18n";
import { formatLocale } from "../../i18n/locale";

export interface CleanScope {
  images?: boolean;
  data?: boolean;
  toolchains?: boolean;
  caches?: boolean;
  workspace?: string;
  orphans?: boolean;
  runs?: boolean;
}

export interface CleanupRequest {
  mode: "clean" | "uninstall";
  scope?: CleanScope;
  /** Dialog title. */
  title: string;
}

interface PreviewItem {
  key: string;
  resource: string;
  name: string;
  sizeBytes: number;
  action: "remove" | "skip";
  why: string;
  inUse: { code: string; detail: string } | null;
}

interface Preview {
  engine: { state: string };
  items: PreviewItem[];
  totals: { remove: number; skipped: number; removeBytes: number };
  home?: { path: string; sizeBytes: number; removable: boolean };
  keyStore?: { path: string; exists: boolean };
  applied?: { removed: number; inUse: number; failed: number; freedBytes: number; homeRemoved: boolean };
}

/** "2,4 GB": decimal units with the comma of the language. */
export const sizeText = formatSize;

/**
 * Shows the exact list (and the sizes) of what a clean or an uninstall would remove, from a dry run, and removes only
 * those objects after the explicit button; the uninstall also needs the typed word. Esc closes it and the focus goes back
 * to the button that opened it (Dialog does that).
 */
export function CleanupDialog({ request, onClose, onDone }: { request: CleanupRequest; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const uninstall = request.mode === "uninstall";
  const preview = useAsync(() => api<Preview>("POST", "/api/storage/cleanup", { mode: request.mode, ...(request.scope ? { scope: request.scope } : {}), dryRun: true }), `cleanup:${request.mode}:${JSON.stringify(request.scope ?? {})}`);
  const [word, setWord] = useState("");
  const [keepNotes, setKeepNotes] = useState(false);
  const [keys, setKeys] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Preview["applied"] | null>(null);
  const data = preview.data;
  const removable = data?.items.filter((i) => i.action === "remove") ?? [];
  const skipped = data?.items.filter((i) => i.action === "skip") ?? [];
  const expected = t("storage_uninstall_word");
  const typed = !uninstall || word.trim().toLowerCase() === expected.toLowerCase();

  const run = async () => {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<Preview>("POST", "/api/storage/cleanup", {
        mode: request.mode,
        ...(request.scope ? { scope: request.scope } : {}),
        dryRun: false,
        items: removable.map((i) => i.key),
        confirm: uninstall ? word.trim() : "clean",
        ...(uninstall ? { keepConfigNotes: keepNotes, includeKeyStore: keys } : {}),
      });
      setResult(r.applied ?? null);
      toast(t("storage_cleanup_done", { count: r.applied?.removed ?? 0, size: sizeText(r.applied?.freedBytes ?? 0) }), "ok");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={request.title} onClose={result ? onDone : onClose}>
      <div className="stack">
        {preview.loading ? <Loading /> : null}
        {preview.error ? <ErrorNotice error={preview.error} /> : null}
        {data && !result ? (
          <>
            {data.engine.state === "unavailable" ? <p className="small">{t("storage_cleanup_engine_off")}</p> : null}
            <p data-testid="cleanup-summary" aria-live="polite">
              {removable.length === 0 ? t("storage_cleanup_nothing") : t("storage_cleanup_summary", { count: removable.length, size: sizeText(data.totals.removeBytes) })}
            </p>
            {removable.length > 0 ? (
              <ul className="storage-list" data-testid="cleanup-list" aria-label={t("storage_cleanup_list")} tabIndex={0}>
                {removable.map((i) => (
                  <li key={i.key} data-key={i.key}>
                    <span className="small muted">{t(`storage_res_${i.resource}`)}</span> <code>{i.name}</code> <span>{sizeText(i.sizeBytes)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {skipped.length > 0 ? (
              <div>
                <h3>{t("storage_cleanup_skipped")}</h3>
                <ul className="storage-list" data-testid="cleanup-skipped">
                  {skipped.map((i) => (
                    <li key={i.key}>
                      <Pill tone="gold">{t("storage_in_use")}</Pill> <code>{i.name}</code> <span>{sizeText(i.sizeBytes)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {uninstall && data.home ? (
              <div className="stack tight">
                <p className="small">{t("storage_uninstall_home", { path: data.home.path, size: sizeText(data.home.sizeBytes) })}</p>
                <label className="row">
                  <input type="checkbox" checked={keepNotes} onChange={(e) => setKeepNotes(e.target.checked)} />
                  <span>{t("storage_uninstall_keep_notes")}</span>
                </label>
                {data.keyStore?.exists ? (
                  <label className="row">
                    <input type="checkbox" checked={keys} onChange={(e) => setKeys(e.target.checked)} />
                    <span>{t("storage_uninstall_keys")}</span>
                  </label>
                ) : null}
                <p className="small">{t("storage_uninstall_cli_note")}</p>
                <label className="storage-field">
                  <span>{t("storage_uninstall_type", { word: expected })}</span>
                  <input type="text" value={word} onChange={(e) => setWord(e.target.value)} autoComplete="off" spellCheck={false} data-testid="uninstall-word" data-free-text="identifier" />
                </label>
              </div>
            ) : null}
          </>
        ) : null}
        {result ? (
          <p role="status" data-testid="cleanup-result">
            {t("storage_cleanup_done", { count: result.removed, size: sizeText(result.freedBytes) })}
            {result.inUse + result.failed > 0 ? ` ${t("storage_cleanup_left", { count: result.inUse + result.failed })}` : ""}
          </p>
        ) : null}
        {error ? <ErrorNotice error={error} /> : null}
        <div className="row">
          {!result ? (
            <button type="button" className="btn danger" disabled={!data || busy || (removable.length === 0 && !uninstall) || !typed} onClick={run} data-testid="cleanup-confirm">
              <Icon name="x" />
              {uninstall ? t("storage_uninstall_confirm") : t("storage_cleanup_confirm", { count: removable.length })}
            </button>
          ) : null}
          <button type="button" className="btn" onClick={result ? onDone : onClose}>
            {result ? t("close") : t("storage_delete_cancel")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
