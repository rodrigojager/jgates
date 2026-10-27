import { useState } from "react";
import { api } from "../../api";
import { ErrorNotice, Loading, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { t } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { ComponentsTab, type Classification } from "./components-tab";
import { ScopeTab } from "./scope-tab";
import { WorkspaceTabs, rememberedTab, rememberTab, type WorkspaceTab } from "./tabs";
import "./workspace.css";

export const screen: ScreenMeta = { id: "workspace", path: "/workspace", area: "workspace", order: 20, icon: "folder" };

interface Change {
  id: string;
  componentRoot: string;
  language: string | null;
  status: string;
  from?: string;
}
interface Changes {
  baseline: boolean;
  added: Change[];
  removed: Change[];
  changed: Change[];
}

const label = (c: Change): string => `${c.id} (${c.componentRoot})`;

function ChangesNotice({ changes }: { changes: Changes }) {
  const empty = changes.added.length + changes.removed.length + changes.changed.length === 0;
  return (
    <div className={`notice ${changes.baseline || empty ? "info" : "warn"}`} role="status" data-testid="discovery-changes">
      <Icon name={changes.baseline || empty ? "info" : "alert"} />
      <div>
        {changes.baseline ? (
          <span>{t("ws_changes_baseline")}</span>
        ) : empty ? (
          <span>{t("ws_changes_none")}</span>
        ) : (
          <>
            <strong>{t("ws_changes_title")}</strong>
            <ul>
              {changes.added.map((c) => (
                <li key={`a:${c.id}:${c.componentRoot}`}>{t("ws_changes_added", { name: label(c) })}</li>
              ))}
              {changes.removed.map((c) => (
                <li key={`r:${c.id}:${c.componentRoot}`}>{t("ws_changes_removed", { name: label(c) })}</li>
              ))}
              {changes.changed.map((c) => (
                <li key={`c:${c.id}:${c.componentRoot}`}>{t("ws_changes_changed", { name: label(c), from: c.from ?? "?", to: c.status })}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

export default function WorkspaceScreen() {
  const discovery = useAsync(() => api("GET", "/api/workspace/discovery"), "ws-discovery");
  const settings = useAsync(() => api("GET", "/api/workspace/settings"), "ws-settings");
  const info = useAsync(() => api("GET", "/api/workspace"), "ws-info");
  const [tab, setTab] = useState<WorkspaceTab>(rememberedTab);
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState(0);
  const [changes, setChanges] = useState<Changes | null>(null);
  const [runError, setRunError] = useState<unknown>(null);
  // The result of "Detectar novamente" replaces the loaded inventory until the next reload.
  const [fresh, setFresh] = useState<{ inventory: any; templates: Record<string, string[]> } | null>(null);

  const reloadAll = () => {
    setFresh(null);
    discovery.reload();
    settings.reload();
  };

  const detectAgain = async () => {
    setRunning(true);
    setRunError(null);
    try {
      const result = await api("POST", "/api/workspace/discovery/run", {});
      setFresh({ inventory: result.inventory, templates: result.templates });
      setChanges(result.changes as Changes);
      setRuns((n) => n + 1);
    } catch (e) {
      setRunError(e);
    } finally {
      setRunning(false);
    }
  };

  const select = (next: WorkspaceTab) => {
    rememberTab(next);
    setTab(next);
  };

  if ((discovery.loading && !discovery.data) || (settings.loading && !settings.data)) return <Loading />;
  if (discovery.error) return <ErrorNotice error={discovery.error} onRetry={reloadAll} />;
  if (settings.error) return <ErrorNotice error={settings.error} onRetry={reloadAll} />;
  const data = discovery.data as any;
  const inventory = (fresh?.inventory ?? data.inventory) as { mode: string; templatesActive: boolean; languages: string[]; classifications: Classification[] };
  const templates = fresh?.templates ?? (data.templates as Record<string, string[]>);
  const components = inventory.classifications.filter((c) => ["explicit", "detected", "ambiguous"].includes(c.classificationStatus));
  const diagnostics: any[] = data.diagnostics ?? [];
  const s = settings.data as any;

  return (
    <div className="stack">
      <div className="between">
        <div>
          <h1>{t("ws_title")}</h1>
          <p>{t("ws_lead")}</p>
        </div>
        <button type="button" className="btn" onClick={detectAgain} disabled={running}>
          <Icon name="refresh" />
          {running ? t("ws_detecting") : t("ws_detect_again")}
        </button>
      </div>

      <p className="small" data-testid="ws-summary" aria-label={t("ws_overview_aria")}>
        {t("ws_summary", { components: components.length, languages: inventory.languages.length, mode: t(`ws_mode_${inventory.mode}`) })}
        {inventory.templatesActive ? "" : ` ${t("ws_templates_off")}`}
      </p>
      {runError ? <ErrorNotice error={runError} /> : null}
      {changes ? <ChangesNotice changes={changes} /> : null}
      {diagnostics.length > 0 ? (
        <div className="notice warn" role="alert">
          <Icon name="alert" />
          <span>{t("ws_invalid_file", { message: diagnostics[0].message })}</span>
        </div>
      ) : null}

      <WorkspaceTabs selected={tab} onSelect={select} />
      <div role="tabpanel" id="ws-panel-components" aria-labelledby="ws-tab-components" hidden={tab !== "components"}>
        <ComponentsTab
          classifications={inventory.classifications}
          templates={templates}
          settings={{ revision: s.revision, components: s.components }}
          configFile={(info.data as any)?.configFile ?? null}
          onChanged={reloadAll}
        />
      </div>
      <div role="tabpanel" id="ws-panel-scope" aria-labelledby="ws-tab-scope" hidden={tab !== "scope"}>
        <ScopeTab settings={s} refreshKey={runs} onChanged={reloadAll} />
      </div>
    </div>
  );
}
