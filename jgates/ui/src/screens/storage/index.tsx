import { useState } from "react";
import { formatSize } from "../../components/format";
import { formatLocale } from "../../i18n/locale";
import { api } from "../../api";
import { Dialog, ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { CleanupDialog, sizeText, type CleanupRequest } from "./cleanup-dialog";
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
  engine?: { bytes: number; volumes: Array<{ name: string; sizeBytes: number }> };
}

interface Categories {
  engine: { state: string };
  tools: Array<{ version: string; bytes: number; images: Array<{ name: string; pinned: boolean }> }>;
  extensions: { bytes: number };
  data: { bytes: number };
  toolchains: { bytes: number };
  caches: { bytes: number };
}

interface StorageData {
  categories?: Categories;
  home: string;
  totalBytes: number;
  workspaces: WorkspaceRow[];
  retention: { maxAgeDays: number; maxWorkspaceBytes: number; maxTotalBytes: number; fromEnvironment: string[]; wouldRemoveRuns: number; wouldFreeBytes: number };
  images: { available: boolean; items: Array<{ name: string; size: string }> };
}

const bytes = formatSize;

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
  const [cleanup, setCleanup] = useState<CleanupRequest | null>(null);
  if (storage.loading && !storage.data) return <Loading />;
  if (storage.error) return <ErrorNotice error={storage.error} onRetry={storage.reload} />;
  const d = storage.data as StorageData;
  const finished = () => {
    setRelink(null);
    setRemoving(null);
    setCleanup(null);
    storage.reload();
  };
  const cat = d.categories;
  const engineUp = cat?.engine.state === "ready";
  const row = (key: string, label: string, detail: string | null, size: number, action?: { text: string; request: CleanupRequest } | { text: string; href: string }) => (
    <tr key={key} data-category={key}>
      <th scope="row">
        {label}
        {detail ? <div className="small muted">{detail}</div> : null}
      </th>
      <td>{sizeText(size)}</td>
      <td>
        {action && "request" in action ? (
          <button type="button" className="btn" onClick={() => setCleanup(action.request)} disabled={!engineUp}>
            {action.text}
            <span className="sr-only"> {label}</span>
          </button>
        ) : action ? (
          <a className="btn" href={action.href}>
            {action.text}
            <span className="sr-only"> {label}</span>
          </a>
        ) : (
          <span className="muted">-</span>
        )}
      </td>
    </tr>
  );

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

      <section className="stack" aria-labelledby="storage-engine">
        <h2 id="storage-engine">{t("storage_engine")}</h2>
        {!cat || !engineUp ? (
          <p data-testid="storage-engine-off">{t("storage_engine_off")}</p>
        ) : (
          <div className="card flat table-wrap">
            <table aria-label={t("storage_engine")} data-testid="storage-categories">
              <thead>
                <tr>
                  <th scope="col">{t("storage_col_category")}</th>
                  <th scope="col">{t("storage_col_size")}</th>
                  <th scope="col">{t("storage_col_actions")}</th>
                </tr>
              </thead>
              <tbody>
                {cat.tools.map((tool) => {
                  const inUse = tool.images.some((i) => i.pinned);
                  return row(
                    `tools-${tool.version}`,
                    t("storage_cat_tools", { version: tool.version }),
                    inUse ? t("storage_cat_tools_current") : t("storage_cat_tools_previous"),
                    tool.bytes,
                    inUse ? undefined : { text: t("storage_remove"), request: { mode: "clean", scope: { images: true }, title: t("storage_cleanup_title_images") } },
                  );
                })}
                {row("data", t("storage_cat_data"), null, cat.data.bytes, { text: t("storage_update"), href: "#/environment" })}
                {row("toolchains", t("storage_cat_toolchains"), null, cat.toolchains.bytes, { text: t("storage_clean"), request: { mode: "clean", scope: { toolchains: true }, title: t("storage_cleanup_title_toolchains") } })}
                {row("caches", t("storage_cat_caches"), null, cat.caches.bytes, { text: t("storage_clean"), request: { mode: "clean", scope: { caches: true }, title: t("storage_cleanup_title_caches") } })}
                {cat.extensions.bytes > 0 ? row("extensions", t("storage_cat_extensions"), null, cat.extensions.bytes) : null}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted">{t("storage_shared_note")}</p>
        <div className="row wrap">
          <button type="button" className="btn primary" disabled={!engineUp} title={!engineUp ? t("storage_engine_off") : undefined} onClick={() => setCleanup({ mode: "clean", title: t("storage_cleanup_title_all") })} data-testid="clean-unused">
            {t("storage_clean_unused")}
          </button>
          <button type="button" className="btn danger" onClick={() => setCleanup({ mode: "uninstall", title: t("storage_uninstall_title") })} data-testid="uninstall-open">
            {t("storage_uninstall")}
          </button>
        </div>
      </section>

      <section className="stack" aria-labelledby="storage-workspaces">
        <h2 id="storage-workspaces">{t("storage_workspaces")}</h2>
        <div className="card flat table-wrap">
          <table className="stack-table" aria-label={t("storage_workspaces")}>
            <thead>
              <tr>
                <th scope="col">{t("storage_col_workspace")}</th>
                <th scope="col">{t("storage_col_state")}</th>
                <th scope="col">{t("storage_col_runs")}</th>
                <th scope="col">{t("storage_col_size")}</th>
                <th scope="col">{t("storage_col_engine")}</th>
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
                  <td data-label={t("storage_col_state")}>
                    {w.exists ? <Pill tone="green">{w.current ? t("storage_state_current") : t("storage_state_ok")}</Pill> : <Pill tone="red">{t("storage_state_missing")}</Pill>}
                  </td>
                  <td data-label={t("storage_col_runs")}>{w.marked > 0 ? t("storage_runs_marked", { runs: w.runs, marked: w.marked }) : w.runs}</td>
                  <td data-label={t("storage_col_size")}>{bytes(w.bytes)}</td>
                  <td data-label={t("storage_col_engine")}>{w.engine && w.engine.bytes > 0 ? sizeText(w.engine.bytes) : <span className="muted">-</span>}</td>
                  <td data-label={t("storage_col_actions")}>
                    {(w.engine?.bytes ?? 0) > 0 || (!w.exists && !w.current) ? (
                      <div className="storage-actions">
                        {(w.engine?.bytes ?? 0) > 0 ? (
                          <button type="button" className="btn" onClick={() => setCleanup({ mode: "clean", scope: { workspace: w.id }, title: t("storage_cleanup_title_workspace", { name: w.name }) })}>
                            {t("storage_clean")}
                            <span className="sr-only"> {w.name}</span>
                          </button>
                        ) : null}
                        {!w.exists && !w.current ? (
                          <>
                            <button type="button" className="btn" onClick={() => setRelink(w)}>
                              <Icon name="link" />
                              {t("storage_relink")}
                              <span className="sr-only"> {w.name}</span>
                            </button>
                            <button type="button" className="btn danger" onClick={() => setRemoving(w)}>
                              {t("storage_delete")}
                              <span className="sr-only"> {w.name}</span>
                            </button>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                    {(w.engine?.bytes ?? 0) > 0 || (!w.exists && !w.current) ? null : <span className="muted">-</span>}
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
      {cleanup ? <CleanupDialog request={cleanup} onClose={() => setCleanup(null)} onDone={finished} /> : null}
      {removing ? <DeleteDialog workspace={removing} onClose={() => setRemoving(null)} onDone={finished} /> : null}
    </div>
  );
}
