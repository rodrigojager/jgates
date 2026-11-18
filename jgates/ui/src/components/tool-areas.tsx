// The area of a tool (its descriptor's section and group: PHP, Markdown, secrets...), for the screens that list many tools
// at once (Revisar, Executar): the checks are shown collapsed by area, with a count on each header. A tool of the engine
// carries its place in the catalogue; every other adapter has no area of its own and stays in the plain list.
import { useCallback, useMemo } from "react";
import { api } from "../api";
import { tOr } from "../i18n";
import { useAsync } from "./common";

export interface ToolArea {
  /** The descriptor's group (php, markdown, secrets...). */
  id: string;
  section: string;
}

interface CatalogAnswer {
  adapters: Array<{ adapter: string; place?: { section: string; group: string } }>;
}

/** A lookup from an adapter id to its area (null for an adapter that has none); it answers null until the catalogue arrives. */
export function useToolAreas(): (adapter: string | null | undefined) => ToolArea | null {
  const catalog = useAsync(() => api<CatalogAnswer>("GET", "/api/tool-catalog").catch(() => null), "tool-areas");
  const byAdapter = useMemo(() => {
    const map = new Map<string, ToolArea>();
    for (const a of catalog.data?.adapters ?? []) if (a.place) map.set(a.adapter, { id: a.place.group, section: a.place.section });
    return map;
  }, [catalog.data]);
  return useCallback((adapter: string | null | undefined) => (adapter ? (byAdapter.get(adapter) ?? null) : null), [byAdapter]);
}

/** The readable name of an area: the language or format when the UI names it, else the group id spelled out. */
export function areaLabel(id: string): string {
  return tOr(`lang_${id}`, id.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase()));
}

export interface AreaGroup<T> {
  /** "" for the checks that have no area. */
  id: string;
  section: string;
  items: T[];
}

/** The items by area, the areas in the order of their sections and then by name; the items without an area come last. */
export function groupByArea<T>(items: T[], areaOf: (item: T) => ToolArea | null): Array<AreaGroup<T>> {
  const rank = (section: string): number => {
    const index = ["language", "format", "tooling", "other"].indexOf(section);
    return index < 0 ? 4 : index;
  };
  const map = new Map<string, AreaGroup<T>>();
  for (const item of items) {
    const area = areaOf(item);
    const key = area ? `${area.section}/${area.id}` : "";
    const group = map.get(key) ?? { id: area?.id ?? "", section: area?.section ?? "", items: [] };
    group.items.push(item);
    map.set(key, group);
  }
  return [...map.values()].sort((a, b) => (a.id === "" ? 1 : b.id === "" ? -1 : rank(a.section) - rank(b.section) || areaLabel(a.id).localeCompare(areaLabel(b.id))));
}
