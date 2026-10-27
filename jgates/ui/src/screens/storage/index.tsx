import { useState } from "react";
import { formatLocale } from "../../i18n/locale";
import { api } from "../../api";
import { Dialog, ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import "./storage.css";

export const screen: ScreenMeta = { id: "storage", path: "/preferences/storage", area: "preferences", order: 91, icon: "folder" };

interface WorkspaceRow {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  current: boolean;
  runs: number;
  marked: number;
  bytes: number;
}

interface StorageData {
  home: string;
  totalBytes: number;
  workspaces: WorkspaceRow[];
  retention: { maxAgeDays: number; maxWorkspaceBytes: number; maxTotalBytes: number; fromEnvironment: string[]; wouldRemoveRuns: number; wouldFreeBytes: number };
  images: { available: boolean; items: Array<{ name: string; size: string }> };
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toLocaleString(formatLocale(), { maximumFractionDigits: 1 })} ${units[i]}`;
}

function RelinkDialog({ workspace, onClose, onDone }: { workspace: WorkspaceRow; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [path, setPath] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/api/storage/relink", { id: workspace.id, path: path.trim() });
      toast(t("storage_relinked", { name: workspace.name }), "ok");
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("storage_relink_title", { name: workspace.name })} onClose={onClose}>
      <div className="stack">
        <p>{t("storage_relink_lead", { path: workspace.path })}</p>
        <label className="storage-field">
          <span>{t("storage_relink_path")}</span>
          <input type="text" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/caminho/novo/do/projeto" spellCheck={false} />
        </label>
        {error ? <ErrorNotice error={error} /> : null}
        <div className="row">
          <button type="button" className="btn primary" disabled={busy || path.trim() === ""} onClick={submit}>
            <Icon name="link" />
            {t("storage_relink_confirm")}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t("close")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

interface DeletePreview {
  preview: { id: string; path: string; runs: number; marked: number; bytes: number; folders: string[] };
}

/** Shows what would go (dry run) and deletes only after the explicit "Apagar" of this dialog. */
function DeleteDialog({ workspace, onClose, onDone }: { workspace: WorkspaceRow; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const preview = useAsync(() => api<DeletePreview>("POST", "/api/storage/delete-artifacts", { id: workspace.id, dryRun: true }), `delete:${workspace.id}`);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const p = preview.data?.preview;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/api/storage/delete-artifacts", { id: workspace.id, dryRun: false, confirm: workspace.id });
      toast(t("storage_deleted", { name: workspace.name }), "ok");
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("storage_delete_title", { name: workspace.name })} onClose={onClose}>
      <div className="stack">
        {preview.loading ? <Loading /> : null}
        {preview.error ? <ErrorNotice error={preview.error} /> : null}
        {p ? (
          <>
            <p data-testid="delete-preview">{t("storage_delete_preview", { runs: p.runs, size: bytes(p.bytes) })}</p>
            {p.marked > 0 ? (
              <div className="notice warn">
                <Icon name="alert" />
                <span>{t("storage_delete_marked", { count: p.marked })}</span>
              </div>
            ) : null}
            <p className="small">{t("storage_delete_scope")}</p>
            <ul className="small">
              {p.folders.map((f) => (
                <li key={f}>
                  <code>{f}</code>
                </li>
              ))}
            </ul>
            <p className="small">{t("storage_delete_project_safe", { path: p.path })}</p>
          </>
        ) : null}
        {error ? <ErrorNotice error={error} /> : null}
        <div className="row">
          <button type="button" className="btn danger" disabled={!p || busy} onClick={run}>
            <Icon name="x" />
            {t("storage_delete_confirm")}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t("storage_delete_cancel")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export default function StorageScreen() {
  const storage = useAsync(() => api<StorageData>("GET", "/api/storage"), "storage");
  const [relink, setRelink] = useState<WorkspaceRow | null>(null);
  const [removing, setRemoving] = useState<WorkspaceRow | null>(null);
  if (storage.loading && !storage.data) return <Loading />;
  if (storage.error) return <ErrorNotice error={storage.error} onRetry={storage.reload} />;
  const d = storage.data as StorageData;
  const finished = () => {
    setRelink(null);
    setRemoving(null);
    storage.reload();
  };

  return (
    <div className="stack">
      <div className="between">
        <div>
          <h1>{t("storage_title")}</h1>
          <p>{t("storage_lead")}</p>
        </div>
        <a className="btn" href="#/preferences">
          {t("storage_back")}
        </a>
      </div>

      <section className="card flat stack" aria-labelledby="storage-home">
        <h2 id="storage-home">{t("storage_home")}</h2>
        <dl className="kv">
          <dt>{t("storage_home_path")}</dt>
          <dd>
            <code data-testid="storage-home">{d.home}</code>
          </dd>
          <dt>{t("storage_home_size")}</dt>
          <dd>{bytes(d.totalBytes)}</dd>
        </dl>
      </section>

      <section className="stack" aria-labelledby="storage-workspaces">
        <h2 id="storage-workspaces">{t("storage_workspaces")}</h2>
        <div className="card flat table-wrap">
          <table aria-label={t("storage_workspaces")}>
            <thead>
              <tr>
                <th scope="col">{t("storage_col_workspace")}</th>
                <th scope="col">{t("storage_col_state")}</th>
                <th scope="col">{t("storage_col_runs")}</th>
                <th scope="col">{t("storage_col_size")}</th>
                <th scope="col">{t("storage_col_actions")}</th>
              </tr>
            </thead>
            <tbody>
              {d.workspaces.map((w) => (
                <tr key={w.id} data-workspace={w.id}>
                  <th scope="row">
                    {w.name}
                    <div className="small muted">
                      <code>{w.path}</code>
                    </div>
                  </th>
                  <td>
                    {w.exists ? <Pill tone="green">{w.current ? t("storage_state_current") : t("storage_state_ok")}</Pill> : <Pill tone="red">{t("storage_state_missing")}</Pill>}
                  </td>
                  <td>{w.marked > 0 ? t("storage_runs_marked", { runs: w.runs, marked: w.marked }) : w.runs}</td>
                  <td>{bytes(w.bytes)}</td>
                  <td>
                    {!w.exists && !w.current ? (
                      <div className="storage-actions">
                        <button type="button" className="btn" onClick={() => setRelink(w)}>
                          <Icon name="link" />
                          {t("storage_relink")}
                          <span className="sr-only"> {w.name}</span>
                        </button>
                        <button type="button" className="btn danger" onClick={() => setRemoving(w)}>
                          {t("storage_delete")}
                          <span className="sr-only"> {w.name}</span>
                        </button>
                      </div>
                    ) : (
                      <span className="muted">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card flat stack" aria-labelledby="storage-retention">
        <h2 id="storage-retention">{t("storage_retention")}</h2>
        <dl className="kv">
          <dt>{t("storage_retention_age")}</dt>
          <dd>{t("storage_retention_days", { days: d.retention.maxAgeDays })}</dd>
          <dt>{t("storage_retention_workspace")}</dt>
          <dd>{bytes(d.retention.maxWorkspaceBytes)}</dd>
          <dt>{t("storage_retention_total")}</dt>
          <dd>{bytes(d.retention.maxTotalBytes)}</dd>
          <dt>{t("storage_retention_next")}</dt>
          <dd>{t("storage_retention_next_value", { runs: d.retention.wouldRemoveRuns, size: bytes(d.retention.wouldFreeBytes) })}</dd>
        </dl>
        <p className="small">{t("storage_retention_protected")}</p>
        <p className="small">
          <code>jgates gc --dry-run</code> {t("storage_retention_cli")}
        </p>
      </section>

      <section className="card flat stack" aria-labelledby="storage-images">
        <h2 id="storage-images">{t("storage_images")}</h2>
        {!d.images.available ? (
          <p>{t("storage_images_unavailable")}</p>
        ) : d.images.items.length === 0 ? (
          <p>{t("storage_images_none")}</p>
        ) : (
          <ul>
            {d.images.items.map((i) => (
              <li key={i.name}>
                <code>{i.name}</code> {i.size}
              </li>
            ))}
          </ul>
        )}
      </section>

      {relink ? <RelinkDialog workspace={relink} onClose={() => setRelink(null)} onDone={finished} /> : null}
      {removing ? <DeleteDialog workspace={removing} onClose={() => setRemoving(null)} onDone={finished} /> : null}
    </div>
  );
}
