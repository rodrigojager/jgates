import { useEffect, useState } from "react";
import { api } from "../api";
import { errorText } from "../components/common";
import { Icon } from "../components/icons";
import { t } from "../i18n";

interface Entry {
  name: string;
  path: string;
  configured: boolean;
  repository: boolean;
}

interface Listing {
  path: string;
  parent: string | null;
  roots: string[];
  home: string;
  configured: boolean;
  entries: Entry[];
  truncated: boolean;
}

/**
 * Folder picker of the workspace dialog. A browser never hands a page the absolute path of a folder the user picks,
 * so the local server lists the folders (names only) and the user walks to the one to open.
 */
export function FolderBrowser({ start, busy, onChoose, onCancel }: { start: string; busy: boolean; onChoose: (path: string) => void; onCancel: () => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; fix: string | null } | null>(null);

  const load = async (target?: string) => {
    setLoading(true);
    setError(null);
    try {
      const query = target && target.trim() !== "" ? `?path=${encodeURIComponent(target.trim())}` : "";
      setListing(await api<Listing>("GET", `/api/workspaces/browse${query}`));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Start where the typed path points when it is a folder; otherwise beside the current workspace.
    void load(start).then(undefined, () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="folder-browser stack" role="group" aria-label={t("ws_browse_title")} data-testid="folder-browser">
      <div className="row wrap">
        <button type="button" className="btn" disabled={loading || !listing?.parent} onClick={() => void load(listing?.parent ?? undefined)}>
          {t("ws_browse_up")}
        </button>
        <button type="button" className="btn" disabled={loading || !listing} onClick={() => void load(listing?.home)}>
          <Icon name="home" />
          {t("ws_browse_home")}
        </button>
        {(listing?.roots ?? []).map((root) => (
          <button key={root} type="button" className="btn" disabled={loading} onClick={() => void load(root)}>
            {root}
          </button>
        ))}
      </div>
      <div className="fb-path mono small" aria-live="polite">
        {loading ? <span className="spinner-text">{t("ws_browse_loading")}</span> : (listing?.path ?? "")}
        {listing?.configured ? <span className="pill green">{t("ws_browse_configured")}</span> : null}
      </div>
      {error ? (
        <div className="notice error" role="alert">
          <Icon name="alert" />
          <div className="grow">
            <p>{error.message}</p>
            {error.fix ? <p className="small">{error.fix}</p> : null}
          </div>
        </div>
      ) : null}
      {listing && listing.entries.length === 0 && !loading ? <p className="small muted">{t("ws_browse_empty")}</p> : null}
      {listing && listing.entries.length > 0 ? (
        <ul className="fb-list" aria-label={t("ws_browse_list")}>
          {listing.entries.map((entry) => (
            <li key={entry.path}>
              <button type="button" className="fb-entry" disabled={loading} onClick={() => void load(entry.path)} title={entry.path}>
                <Icon name="folder" />
                <span className="grow">{entry.name}</span>
                {entry.configured ? <span className="pill green">{t("ws_browse_configured")}</span> : null}
                {entry.repository ? <span className="pill">{t("ws_browse_repo")}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {listing?.truncated ? <p className="small muted">{t("ws_browse_truncated")}</p> : null}
      <div className="row wrap">
        <button type="button" className="btn primary" disabled={!listing || loading || busy} onClick={() => listing && onChoose(listing.path)}>
          <Icon name="folder" />
          {t("ws_browse_choose")}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {t("ws_browse_cancel")}
        </button>
      </div>
    </div>
  );
}
