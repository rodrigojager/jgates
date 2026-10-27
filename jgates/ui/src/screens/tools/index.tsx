import { useMemo, useState } from "react";
import { api } from "../../api";
import { useShell } from "../../app/shell-context";
import { ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { SemanticCard } from "./semantic/card";
import { CreateDialog, RemoveDialog, RenameDialog, type CatalogAdapter } from "./dialogs";

export const screen: ScreenMeta = { id: "tools", path: "/tools", navLabel: "nav_tools", navPath: "/tools", order: 10, icon: "tools" };

const SUPPORT_TONE: Record<string, "green" | "gold" | "red" | "blue"> = {
  full: "green",
  assisted: "blue",
  "editable-file": "blue",
  unavailable: "gold",
  incompatible: "red",
};

interface CatalogEntry extends CatalogAdapter {
  toolName: string;
  languages: string[];
  categories: string[];
  capabilities: string[];
  runners: string[];
  supportLevel: string;
  platformSupported: boolean;
  executesProjectCode: boolean;
}

interface Availability {
  status: string;
  reason: string | null;
  toolVersion: string | null;
}

const AVAILABILITY_TONE: Record<string, "green" | "gold"> = { available: "green", unavailable: "gold" };

function matches(haystack: string[], query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || haystack.some((h) => h.toLowerCase().includes(q));
}

export function AvailabilityPill({ value }: { value: Availability | undefined }) {
  if (!value) return <Pill>{t("tools_availability_checking")}</Pill>;
  return (
    <span className="row wrap">
      <Pill tone={AVAILABILITY_TONE[value.status]}>{t(`tools_availability_${value.status}`)}</Pill>
      {value.toolVersion ? <span className="small muted">{t("tools_availability_version", { version: value.toolVersion })}</span> : null}
    </span>
  );
}

export default function ToolsScreen() {
  const tools = useAsync(() => api("GET", "/api/tools"), "tools");
  const catalog = useAsync(() => api<{ adapters: CatalogEntry[] }>("GET", "/api/tool-catalog"), "tool-catalog");
  const discovery = useAsync(() => api<{ inventory: { classifications: Array<{ id: string }> } }>("GET", "/api/workspace/discovery").catch(() => null), "tools-discovery");
  const availability = useAsync(() => api<{ availability: Record<string, Availability> }>("GET", "/api/tool-availability").catch(() => null), "tool-availability");
  const shell = useShell();
  const governed = shell.info?.mode === "governed";

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [component, setComponent] = useState("");
  const [dialog, setDialog] = useState<{ kind: "create"; adapter: string | null } | { kind: "rename"; id: string } | { kind: "remove"; id: string } | null>(null);
  const [notice, setNotice] = useState<{ text: string; tool: string; references: string[] } | null>(null);

  const instances: any[] = (tools.data as any)?.instances ?? [];
  const adapters = catalog.data?.adapters ?? [];
  const names = useMemo(() => new Map(adapters.map((a) => [a.adapter, a])), [adapters]);
  const components = useMemo(() => {
    const ids = new Set<string>(discovery.data?.inventory.classifications.map((c) => c.id) ?? []);
    for (const i of instances) if (i.component) ids.add(i.component);
    return [...ids].sort();
  }, [discovery.data, instances]);
  const categories = useMemo(() => [...new Set(adapters.flatMap((a) => a.categories))].sort(), [adapters]);

  if (tools.loading || catalog.loading) return <Loading />;
  if (tools.error) return <ErrorNotice error={tools.error} onRetry={tools.reload} />;
  if (catalog.error) return <ErrorNotice error={catalog.error} onRetry={catalog.reload} />;
  const data = tools.data as any;
  const diagnostics: any[] = data.diagnostics ?? [];

  const adapterOf = (instance: any): CatalogEntry | undefined => names.get(instance.adapter);
  const visibleInstances = instances.filter((i) => {
    const entry = adapterOf(i);
    const text = [i.id, i.adapter, entry?.displayName ?? "", ...(entry?.languages ?? []), ...(entry?.categories ?? [])];
    return matches(text, query) && (category === "" || entry?.categories.includes(category)) && (component === "" || i.component === component);
  });
  const visibleCatalog = adapters.filter((a) => matches([a.adapter, a.displayName, a.toolName, ...a.languages, ...a.categories, ...a.capabilities], query) && (category === "" || a.categories.includes(category)));

  const refresh = () => {
    tools.reload();
    availability.reload();
  };
  const done = (text: string, tool: string, references: string[] = []) => {
    setDialog(null);
    setNotice({ text, tool, references });
    refresh();
  };

  return (
    <div className="stack">
      <div className="between wrap">
        <div>
          <h1>{t("tools_title")}</h1>
          <p>{t("tools_lead")}</p>
        </div>
        <button type="button" className="btn primary" disabled={governed} onClick={() => setDialog({ kind: "create", adapter: null })}>
          <Icon name="tools" />
          {t("tools_new")}
        </button>
      </div>

      {governed ? (
        <div className="notice" role="status" data-testid="tools-governed">
          <Icon name="lock" />
          <p>{t("tools_governed")}</p>
        </div>
      ) : null}
      {notice ? (
        <div className="notice ok" role="status" data-testid="tools-notice">
          <Icon name="check" />
          <div className="stack tight">
            <p>{notice.text}</p>
            {notice.references.length > 0 ? <p className="small">{t("tools_dialog_refs", { tool: notice.tool, files: notice.references.join(", ") })}</p> : null}
          </div>
        </div>
      ) : null}
      {diagnostics.length > 0 ? (
        <div className="notice warn" role="status">
          <Icon name="alert" />
          <div>
            <strong>{t("diagnostics_title")}</strong>
            <ul>
              {diagnostics.map((d, i) => (
                <li key={i}>{d.message}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <div className="card flat row wrap" role="search">
        <label className="stack tight grow">
          <span className="small">{t("tools_search_label")}</span>
          <input type="search" className="input search" value={query} placeholder={t("tools_search_placeholder")} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label className="stack tight">
          <span className="small">{t("tools_filter_category")}</span>
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">{t("tools_filter_all")}</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {tOr(`tools_category_${c}`, c)}
              </option>
            ))}
          </select>
        </label>
        <label className="stack tight">
          <span className="small">{t("tools_filter_component")}</span>
          <select className="input" value={component} onChange={(e) => setComponent(e.target.value)}>
            <option value="">{t("tools_filter_all_components")}</option>
            {components.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section className="stack" aria-labelledby="tools-instances-title">
        <h2 id="tools-instances-title">{t("tools_instances_title")}</h2>
        {instances.length === 0 ? <p>{t("tools_empty")}</p> : visibleInstances.length === 0 ? <p>{t("tools_no_match")}</p> : null}
        <ul className="tool-cards stack" style={{ listStyle: "none", padding: 0 }}>
          {visibleInstances.map((i) => {
            const entry = adapterOf(i);
            const a = availability.data?.availability[i.id];
            return (
              <li key={i.id} className="card flat stack" data-testid="tool-card" data-instance={i.id}>
                <div className="between wrap">
                  <h3>
                    <a href={`#/tools/${encodeURIComponent(i.id)}`} aria-label={t("tools_open", { tool: i.id })}>
                      {i.id}
                    </a>
                  </h3>
                  <div className="row wrap">
                    <Pill tone={SUPPORT_TONE[i.supportLevel] ?? "blue"}>{tOr(`support_${i.supportLevel}`, i.supportLevel)}</Pill>
                    <Pill tone={i.enabled ? "green" : "gold"}>{i.enabled ? t("tools_enabled") : t("tools_disabled")}</Pill>
                    {i.required ? <Pill>{t("tools_required")}</Pill> : null}
                  </div>
                </div>
                <dl className="kv">
                  <dt>{t("tools_dialog_adapter")}</dt>
                  <dd>{entry?.displayName ?? i.adapter}</dd>
                  <dt>{t("tools_dialog_component")}</dt>
                  <dd>{i.component ?? t("tools_workspace_wide")}</dd>
                  <dt>{t("tools_card_runner")}</dt>
                  <dd>{i.runner === "container" ? t("tools_card_runner_container") : t("tools_card_runner_local")}</dd>
                  <dt>{t("tools_card_availability")}</dt>
                  <dd data-testid="tool-availability">
                    <AvailabilityPill value={a} />
                  </dd>
                  <dt>{t("tools_card_files")}</dt>
                  <dd>
                    {(i.bindings as any[]).length === 0 ? (
                      <span className="muted">{t("tools_card_no_files")}</span>
                    ) : (
                      <ul className="file-sub">
                        {(i.bindings as any[]).map((b) => (
                          <li key={b.id}>
                            <code>{b.relPath ?? b.declared}</code>
                          </li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </dl>
                <div className="row wrap">
                  <button type="button" className="btn" disabled={governed} aria-label={t("tools_rename_label", { tool: i.id })} onClick={() => setDialog({ kind: "rename", id: i.id })}>
                    {t("tools_rename")}
                  </button>
                  <button type="button" className="btn" disabled={governed} aria-label={t("tools_remove_label", { tool: i.id })} onClick={() => setDialog({ kind: "remove", id: i.id })}>
                    {t("tools_remove")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="stack" aria-labelledby="tools-catalog-title">
        <div>
          <h2 id="tools-catalog-title">{t("tools_catalog_title")}</h2>
          <p className="small">{t("tools_catalog_lead")}</p>
        </div>
        {visibleCatalog.length === 0 ? <p>{t("tools_no_match")}</p> : null}
        <ul className="tool-cards stack" style={{ listStyle: "none", padding: 0 }}>
          {visibleCatalog.map((a) => (
            <li key={a.adapter} className="card flat stack" data-testid="catalog-card" data-adapter={a.adapter}>
              <div className="between wrap">
                <h3>{a.displayName}</h3>
                <div className="row wrap">
                  <Pill tone={SUPPORT_TONE[a.supportLevel] ?? "blue"}>{tOr(`support_${a.supportLevel}`, a.supportLevel)}</Pill>
                  {a.platformSupported ? null : <Pill tone="red">{t("tools_card_platform")}</Pill>}
                  {a.executesProjectCode ? (
                    <Pill tone="gold">
                      <Icon name="alert" />
                      {t("tools_card_runs_code")}
                    </Pill>
                  ) : null}
                </div>
              </div>
              <p className="small">{a.languages.length > 0 ? t("tools_card_languages", { languages: a.languages.join(", ") }) : t("tools_card_languages_none")}</p>
              <p className="small">{a.categories.map((c) => tOr(`tools_category_${c}`, c)).join(", ")}</p>
              <p className="small">{t("tools_card_runners", { runners: a.runners.map((r) => (r === "container" ? t("tools_card_runner_container") : t("tools_card_runner_local"))).join(", ") })}</p>
              {a.instantiable ? (
                <div>
                  <button type="button" className="btn" disabled={governed} aria-label={t("tools_card_use", { tool: a.displayName })} onClick={() => setDialog({ kind: "create", adapter: a.adapter })}>
                    <Icon name="tools" />
                    {t("tools_card_create")}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <SemanticCard />

      {dialog?.kind === "create" ? (
        <CreateDialog
          adapters={adapters}
          components={components}
          initialAdapter={dialog.adapter}
          existing={instances.map((i) => i.id)}
          onClose={() => setDialog(null)}
          onDone={(id) => done(t("tools_done_created", { tool: id }), id)}
        />
      ) : null}
      {dialog?.kind === "rename" ? <RenameDialog id={dialog.id} onClose={() => setDialog(null)} onDone={(to, refs) => done(t("tools_done_renamed", { tool: to }), dialog.id, refs)} /> : null}
      {dialog?.kind === "remove" ? <RemoveDialog id={dialog.id} onClose={() => setDialog(null)} onDone={(refs) => done(t("tools_done_removed", { tool: dialog.id }), dialog.id, refs)} /> : null}
    </div>
  );
}
