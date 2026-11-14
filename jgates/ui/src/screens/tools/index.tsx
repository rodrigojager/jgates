import { useMemo, useState } from "react";
import { categoryRank, sortCategories } from "../../components/categories";
import { api } from "../../api";
import { currentQuery } from "../../app/route";
import { useShell } from "../../app/shell-context";
import { ErrorNotice, Loading, Pill, Updating, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { adapterName, t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { ConfigDiagnostics, type ConfigDiagnostic } from "../config-profiles/diagnostics";
import { SemanticCard } from "./semantic/card";
import { CustomToolDialog } from "./custom-dialog";
import { CreateDialog, RemoveDialog, RenameDialog, type CatalogAdapter } from "./dialogs";
import { EditOwnTool } from "./edit-own";
import { OwnTest } from "./own-test";

export const screen: ScreenMeta = { id: "tools", path: "/tools", area: "config", navLabel: "nav_tools", navPath: "/tools", order: 41.5, icon: "tools" };

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
  /** 0: for a language of the project; 1: for any language; 2: for other languages only. */
  relevance?: number;
}

/** A tool the plan of the project runs (GET /api/tool-effective). */
interface EffectiveTool {
  tool: string;
  adapter: string | null;
  category: string | null;
  capabilities: string[];
  components: string[];
  languages: string[];
  required: boolean;
  via: string;
  declared: boolean;
}

interface EffectiveData {
  ok: boolean;
  languages: string[];
  tools: EffectiveTool[];
  error?: string;
  /** Problems of the configuration files (file, key, line) when there is no plan. */
  diagnostics?: ConfigDiagnostic[];
}

interface Distribution {
  mode: "shipped" | "prepared-from-authorized-source" | "customer-supplied";
  sourceUrl?: string;
  spdx?: string;
  acquisition?: string[];
  setup?: string[];
}

/** What /api/tool-matrix says about how an adapter's tool reaches the customer. */
interface MatrixInfo {
  toolVersionRange: string;
  distribution: Distribution | null;
}

interface Availability {
  status: string;
  reason: string | null;
  toolVersion: string | null;
}

/** What /api/tool-origins says: the version of the tools in the JGates image and the own tools already tested. */
interface Origins {
  image: { version: string | null; tools: Record<string, string> };
  tested: Record<string, string>;
  categories?: Array<{ id: string; label: string }>;
}

/** The origin row of a catalog entry or of an instance: JGates image (with the tool version), own tool or customer supplied. */
export function OriginRow({ kind, version, untested, spdx }: { kind: "shipped" | "own" | "customer" | "prepared"; version?: string | null; untested?: boolean; spdx?: string | null }) {
  const text = kind === "shipped" ? (version ? t("tools_origin_shipped_version", { version }) : t("tools_origin_shipped")) : kind === "own" ? t("tools_origin_own") : kind === "customer" ? t("tools_origin_customer") : t("tools_origin_prepared");
  return (
    <div className="row wrap" data-testid="origin-row" data-origin={kind}>
      <span className="small">{t("tools_origin_label")}</span>
      {/* The text wraps inside the pill: "Incluída nas ferramentas do JGates (versão x)" is wider than a card at 375 px. */}
      <Pill tone={kind === "customer" ? "gold" : kind === "own" ? "blue" : "green"}>
        <span style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{text}</span>
      </Pill>
      {untested ? <Pill tone="gold">{t("tools_origin_untested")}</Pill> : null}
      {spdx ? <span className="small muted">{t("tools_origin_license", { spdx })}</span> : null}
    </div>
  );
}

const AVAILABILITY_TONE: Record<string, "green" | "gold"> = { available: "green", unavailable: "gold" };

function matches(haystack: string[], query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || haystack.some((h) => h.toLowerCase().includes(q));
}

/** How well a catalogue entry answers a search: the name first (exact, prefix, inside), then language, then the rest. */
function rank(a: CatalogEntry, query: string): number {
  const q = query.trim().toLowerCase();
  if (q === "") return 0;
  const names = [adapterName(a.adapter, a.displayName), a.displayName, a.toolName, a.adapter].map((n) => n.toLowerCase());
  if (names.some((n) => n === q)) return 0;
  if (names.some((n) => n.startsWith(q))) return 1;
  if (names.some((n) => n.includes(q))) return 2;
  if (a.languages.some((l) => l.toLowerCase().includes(q))) return 3;
  return 4;
}

/** Only web links are rendered as links; anything else a manifest might carry is shown as text. */
function isWebLink(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function LinkList({ title, links }: { title: string; links: string[] }) {
  if (links.length === 0) return null;
  return (
    <div className="stack tight">
      <span className="small">{title}</span>
      <ul className="file-sub link-list">
        {links.map((link) => (
          <li key={link}>
            {isWebLink(link) ? (
              <a href={link} target="_blank" rel="noopener noreferrer">
                {link}
              </a>
            ) : (
              <code>{link}</code>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Where a catalog tool comes from, said once: the state (with the version of the tool in the JGates image), the licence,
 * the source and, for a customer-supplied one, the official setup guidance.
 */
export function DistributionInfo({ info, version }: { info: MatrixInfo | undefined; version?: string | null }) {
  const d = info?.distribution;
  if (!d) return null;
  return (
    <div className="stack tight" data-testid="catalog-distribution" data-mode={d.mode}>
      <div className="row wrap">
        <span className="small">{t("tools_dist_label")}</span>
        <Pill tone={d.mode === "customer-supplied" ? "gold" : "green"}>
          <span style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{t(`tools_dist_${d.mode}`)}</span>
        </Pill>
        {d.mode === "shipped" && version ? <span className="small muted">{t("tools_availability_version", { version })}</span> : null}
        {d.spdx ? <span className="small muted">{t("tools_dist_license", { spdx: d.spdx })}</span> : null}
        {d.sourceUrl && isWebLink(d.sourceUrl) ? (
          <a className="small" href={d.sourceUrl} target="_blank" rel="noopener noreferrer">
            {t("tools_dist_source")}
          </a>
        ) : null}
      </div>
      {d.mode === "customer-supplied" ? (
        <div className="notice" data-testid="catalog-setup-guidance">
          <Icon name="alert" />
          <div className="stack tight">
            <p className="small">{t("tools_dist_customer_note", { range: info?.toolVersionRange ?? "" })}</p>
            <LinkList title={t("tools_dist_acquire")} links={d.acquisition ?? []} />
            <LinkList title={t("tools_dist_setup")} links={d.setup ?? []} />
          </div>
        </div>
      ) : null}
    </div>
  );
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

function InstanceOrigin({ instance, toolName, entry, origins, onTested }: { instance: any; toolName: string; entry: MatrixInfo | undefined; origins: Origins | null; onTested: () => void }) {
  if (instance.adapter === "generic-command") {
    const untested = origins !== null && !(instance.id in origins.tested);
    return (
      <div className="stack tight">
        <OriginRow kind="own" untested={untested} />
        {untested ? <OwnTest id={instance.id} onTested={onTested} /> : null}
      </div>
    );
  }
  return <CatalogOrigin entry={{ adapter: instance.adapter, toolName }} info={entry} origins={origins} />;
}

function CatalogOrigin({ entry, info, origins }: { entry: { adapter: string; toolName: string }; info: MatrixInfo | undefined; origins: Origins | null }) {
  if (entry.adapter === "generic-command") return <OriginRow kind="own" />;
  const mode = info?.distribution?.mode;
  if (mode === "customer-supplied") return <OriginRow kind="customer" spdx={info?.distribution?.spdx ?? null} />;
  if (mode === "prepared-from-authorized-source") return <OriginRow kind="prepared" spdx={info?.distribution?.spdx ?? null} />;
  return <OriginRow kind="shipped" version={origins?.image.tools[entry.toolName] ?? null} spdx={info?.distribution?.spdx ?? null} />;
}

export default function ToolsScreen() {
  const tools = useAsync(() => api("GET", "/api/tools"), "tools");
  const catalog = useAsync(() => api<{ adapters: CatalogEntry[] }>("GET", "/api/tool-catalog"), "tool-catalog");
  const discovery = useAsync(() => api<{ inventory: { classifications: Array<{ id: string }> } }>("GET", "/api/workspace/discovery").catch(() => null), "tools-discovery");
  const availability = useAsync(() => api<{ availability: Record<string, Availability> }>("GET", "/api/tool-availability").catch(() => null), "tool-availability");
  const matrix = useAsync(() => api<{ matrix: { adapters: Array<{ id: string } & MatrixInfo> } }>("GET", "/api/tool-matrix").catch(() => null), "tool-matrix");
  const origins = useAsync(() => api<Origins>("GET", "/api/tool-origins").catch(() => null), "tool-origins");
  const effective = useAsync(() => api<EffectiveData>("GET", "/api/tool-effective"), "tool-effective");
  const matrixOf = useMemo(() => new Map((matrix.data?.matrix.adapters ?? []).map((m) => [m.id, m])), [matrix.data]);
  const shell = useShell();
  const governed = shell.info?.mode === "governed";

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [component, setComponent] = useState("");
  const [scope, setScope] = useState<"project" | "all">("project");
  // `#/tools?add=<adapter>` (the "Adicionar" action of a check that does not apply yet) opens the creation for that adapter.
  const [dialog, setDialog] = useState<{ kind: "create"; adapter: string | null } | { kind: "custom"; component: string | null } | { kind: "rename"; id: string } | { kind: "remove"; id: string } | { kind: "edit"; id: string } | null>(() => {
    const query = currentQuery();
    // `#/tools?custom=1[&component=<id>]` (the own-tool action of a check without a tool, the unsupported-language offer) opens the own-tool dialog.
    if (query.get("custom")) return { kind: "custom", component: query.get("component") };
    const add = query.get("add");
    return add ? { kind: "create", adapter: add } : null;
  });
  const [notice, setNotice] = useState<{ text: string; tool: string; references: string[] } | null>(null);

  const instances: any[] = (tools.data as any)?.instances ?? [];
  const catalogData = catalog.data as { adapters: CatalogEntry[]; projectLanguages?: string[] } | null;
  // What the plan runs counts as "of this project" whatever the languages say; then the project's languages first.
  const inUse = useMemo(() => new Set((effective.data?.tools ?? []).map((e) => e.adapter).filter((a): a is string => a !== null)), [effective.data]);
  const adapters = useMemo(
    () =>
      (catalogData?.adapters ?? [])
        .map((a) => ({ ...a, relevance: inUse.has(a.adapter) ? 0 : (a.relevance ?? 1) }))
        .sort((a, b) => (a.relevance ?? 1) - (b.relevance ?? 1) || adapterName(a.adapter, a.displayName).localeCompare(adapterName(b.adapter, b.displayName))),
    [catalogData, inUse],
  );
  const projectLanguages = catalogData?.projectLanguages ?? [];
  const names = useMemo(() => new Map(adapters.map((a) => [a.adapter, a])), [adapters]);
  const components = useMemo(() => {
    const ids = new Set<string>(discovery.data?.inventory.classifications.map((c) => c.id) ?? []);
    for (const i of instances) if (i.component) ids.add(i.component);
    return [...ids].sort();
  }, [discovery.data, instances]);
  const categories = useMemo(() => sortCategories([...new Set(adapters.flatMap((a) => a.categories))]), [adapters]);

  // Only the first load replaces the screen: a reload after a change keeps the buttons (and the focus) where they are.
  if ((tools.loading && !tools.data) || (catalog.loading && !catalog.data)) return <Loading />;
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
  const searching = query.trim() !== "";
  const matching = adapters.filter((a) => matches([a.adapter, a.displayName, adapterName(a.adapter, a.displayName), a.toolName, ...a.languages, ...a.categories, ...a.capabilities], query) && (category === "" || a.categories.includes(category)));
  // "Deste projeto" by default; a search looks through everything, best name match first.
  const visibleCatalog = searching
    ? matching.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a, query) - rank(y.a, query) || x.i - y.i).map((x) => x.a)
    : scope === "project"
      ? matching.filter((a) => (a.relevance ?? 1) < 2)
      : matching;
  const hiddenByScope = !searching && scope === "project" ? matching.length - visibleCatalog.length : 0;
  const categoryLabel = (c: string) => tOr(`tools_category_${c}`, origins.data?.categories?.find((x) => x.id === c)?.label ?? c);
  const effectiveTools = (effective.data?.tools ?? []).filter((e) => {
    const entry = e.adapter ? names.get(e.adapter) : undefined;
    const text = [e.tool, e.adapter ?? "", entry?.displayName ?? "", ...e.capabilities, ...e.languages, ...(e.category ? [e.category] : [])];
    return matches(text, query) && (category === "" || (e.category ?? "") === category || (entry?.categories.includes(category) ?? false)) && (component === "" || e.components.includes(component));
  });
  const effectiveGroups = [...new Set(effectiveTools.map((e) => e.category ?? ""))].sort((a, b) => categoryRank(a) - categoryRank(b) || categoryLabel(a).localeCompare(categoryLabel(b))).map((c) => ({ category: c, items: effectiveTools.filter((e) => (e.category ?? "") === c) }));

  const refresh = () => {
    tools.reload();
    origins.reload();
    availability.reload();
    effective.reload();
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

      <Updating active={tools.reloading || catalog.reloading || effective.reloading} />
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
                {categoryLabel(c)}
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

      <section className="stack" aria-labelledby="tools-effective-title" aria-busy={effective.loading ? true : undefined} data-testid="tools-effective">
        <div>
          <h2 id="tools-effective-title">{t("tools_effective_title")}</h2>
          <p className="small">{t("tools_effective_lead")}</p>
        </div>
        {effective.loading && !effective.data ? (
          <p className="spinner-text" role="status">
            {t("tools_effective_loading")}
          </p>
        ) : effective.error ? (
          <ErrorNotice error={effective.error} onRetry={effective.reload} />
        ) : effective.data && !effective.data.ok && effectiveTools.length === 0 ? (
          <>
            <div className="notice warn" role="status">
              <Icon name="alert" />
              <p>{t("tools_effective_failed", { error: effective.data.error ?? "" })}</p>
            </div>
            {(effective.data.diagnostics ?? []).length > 0 ? <ConfigDiagnostics readable diagnostics={effective.data.diagnostics ?? []} onRetry={effective.reload} /> : null}
          </>
        ) : effectiveTools.length === 0 ? (
          <p>{(effective.data?.tools.length ?? 0) === 0 ? t("tools_effective_none") : t("tools_no_match")}</p>
        ) : (
          <>
          {/* No plan (a key written by hand that the schema refuses): the tools are those the files declare. */}
          {effective.data && !effective.data.ok ? (
            <>
              <div className="notice warn" role="status">
                <Icon name="alert" />
                <p>{t("tools_effective_failed", { error: effective.data.error ?? "" })}</p>
              </div>
              {(effective.data.diagnostics ?? []).length > 0 ? <ConfigDiagnostics readable diagnostics={effective.data.diagnostics ?? []} onRetry={effective.reload} /> : null}
            </>
          ) : null}
          {effectiveGroups.map((g) => (
            <div key={g.category} className="stack tight" data-testid="effective-group" data-category={g.category}>
              <h3>
                {g.category ? categoryLabel(g.category) : t("tools_category_other")} <span className="small muted">{t("tools_effective_count", { count: g.items.length })}</span>
              </h3>
              <ul className="tool-cards stack" style={{ listStyle: "none", padding: 0 }}>
                {g.items.map((e) => {
                  const entry = e.adapter ? names.get(e.adapter) : undefined;
                  const label = e.adapter ? adapterName(e.adapter, entry?.displayName ?? e.adapter) : e.tool;
                  return (
                    <li key={e.tool} className="card flat stack tight" data-testid="effective-tool" data-tool={e.tool} data-via={e.declared ? "instance" : e.via}>
                      <div className="between wrap">
                        <h4>
                          <a href={`#/tools/${encodeURIComponent(e.tool)}`} aria-label={t("tools_effective_open", { tool: label })}>
                            {label}
                          </a>{" "}
                          {label !== e.tool ? <code className="small muted">{e.tool}</code> : null}
                        </h4>
                        <div className="row wrap">
                          <Pill tone={e.declared ? "blue" : undefined}>{e.declared ? t("tools_effective_via_instance") : e.via === "template" ? t("tools_effective_via_template") : t("tools_effective_via_default")}</Pill>
                          {e.required ? <Pill>{t("tools_required")}</Pill> : null}
                        </div>
                      </div>
                      {e.capabilities.length > 0 ? <p className="small">{t("tools_effective_caps", { capabilities: e.capabilities.join(", ") })}</p> : null}
                      {e.components.length > 0 ? <p className="small muted">{t("tools_effective_in", { components: e.components.join(", ") })}</p> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          </>
        )}
      </section>

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
                  <dd>{adapterName(i.adapter, entry?.displayName ?? i.adapter)}</dd>
                  <dt>{t("tools_dialog_component")}</dt>
                  <dd>{i.component ?? t("tools_workspace_wide")}</dd>
                  <dt>{t("tools_card_runner")}</dt>
                  <dd>{i.runner === "container" ? t("tools_card_runner_container") : t("tools_card_runner_local")}</dd>
                  <dt>{t("tools_origin_label")}</dt>
                  <dd>
                    <InstanceOrigin instance={i} toolName={entry?.toolName ?? i.adapter} entry={matrixOf.get(i.adapter)} origins={origins.data} onTested={() => origins.reload()} />
                  </dd>
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
                  {i.adapter === "generic-command" ? (
                    <button type="button" className="btn" disabled={governed} aria-label={t("tools_card_edit_own", { tool: i.id })} onClick={() => setDialog({ kind: "edit", id: i.id })}>
                      {t("tools_card_edit")}
                    </button>
                  ) : null}
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
        <fieldset className="row wrap" data-testid="tools-scope">
          <legend className="small">{t("tools_scope_legend")}</legend>
          <label className="row">
            <input type="radio" name="tools-scope" value="project" checked={scope === "project"} onChange={() => setScope("project")} />
            <span>{t("tools_scope_project")}</span>
          </label>
          <label className="row">
            <input type="radio" name="tools-scope" value="all" checked={scope === "all"} onChange={() => setScope("all")} />
            <span>{t("tools_scope_all")}</span>
          </label>
        </fieldset>
        <p className="small muted">{projectLanguages.length > 0 ? t("tools_scope_note", { languages: projectLanguages.join(", ") }) : t("tools_scope_note_none")}</p>
        {visibleCatalog.length === 0 ? <p>{t("tools_no_match")}</p> : null}
        <ul className="tool-cards stack" style={{ listStyle: "none", padding: 0 }}>
          {visibleCatalog.map((a) => (
            <li key={a.adapter} className="card flat stack" data-testid="catalog-card" data-adapter={a.adapter}>
              <div className="between wrap">
                <h3>{adapterName(a.adapter, a.displayName)}</h3>
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
              {/* Where it comes from, said once: the distribution carries the state, version, licence and source. */}
              {matrixOf.get(a.adapter)?.distribution ? <DistributionInfo info={matrixOf.get(a.adapter)} version={origins.data?.image.tools[a.toolName] ?? null} /> : <CatalogOrigin entry={a} info={matrixOf.get(a.adapter)} origins={origins.data} />}
              {a.instantiable ? (
                <div>
                  <button type="button" className="btn" disabled={governed} aria-label={t("tools_card_use", { tool: adapterName(a.adapter, a.displayName) })} onClick={() => setDialog({ kind: "create", adapter: a.adapter })}>
                    <Icon name="tools" />
                    {t("tools_card_create")}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {hiddenByScope > 0 ? (
          <p className="small muted" data-testid="tools-scope-hidden">
            {t("tools_scope_hidden", { count: hiddenByScope })}
          </p>
        ) : null}
      </section>

      <SemanticCard />

      {dialog?.kind === "create" ? (
        <CreateDialog
          adapters={adapters}
          components={components}
          initialAdapter={dialog.adapter}
          existing={instances.map((i) => i.id)}
          onClose={() => setDialog(null)}
          onOwn={() => setDialog({ kind: "custom", component: null })}
          onDone={(id) => {
            // The flow goes on into the new instance's settings; from a "not applicable here" action
            // (#/tools?add=<adapter>&focus=<settings>) with the settings the check still needs focused.
            const focus = currentQuery().get("add") ? currentQuery().get("focus") : null;
            window.location.hash = `#/tools/${encodeURIComponent(id)}${focus ? `?focus=${encodeURIComponent(focus)}` : ""}`;
          }}
        />
      ) : null}
      {dialog?.kind === "custom" ? (
        <CustomToolDialog
          components={components}
          existing={instances.map((i) => i.id)}
          preselect={dialog.component}
          onClose={(saved) => {
            if (saved) done(t("tools_done_created", { tool: saved }), saved);
            else setDialog(null);
          }}
        />
      ) : null}
      {dialog?.kind === "edit" ? <EditOwnTool id={dialog.id} onClose={(saved) => (saved ? done(t("tools_done_updated", { tool: saved }), saved) : setDialog(null))} /> : null}
      {dialog?.kind === "rename" ? <RenameDialog id={dialog.id} onClose={() => setDialog(null)} onDone={(to, refs) => done(t("tools_done_renamed", { tool: to }), dialog.id, refs)} /> : null}
      {dialog?.kind === "remove" ? <RemoveDialog id={dialog.id} onClose={() => setDialog(null)} onDone={(refs) => done(t("tools_done_removed", { tool: dialog.id }), dialog.id, refs)} /> : null}
    </div>
  );
}
