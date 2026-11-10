// Install units: what one dependency volume holds. A unit is an install root of one ecosystem: usually one component,
// but a Node workspace root (or a uv/Cargo workspace) installs once for every component that resolves to it
// (PLAN-dependencies.md section 4: "a Node workspace root with several packages is one component for installs and
// several components for checks").
import type { Classification } from "../discovery/types.js";
import type { DependencyInfo } from "../discovery/dependencies.js";

export interface InstallUnit {
  /** Volume suffix: the id of the component at the install root, otherwise a slug of the root. */
  id: string;
  /** Project-relative directory where the install runs ("." for the project root). */
  installRoot: string;
  /** Components whose checks use this unit, sorted. */
  components: string[];
  /** The dependencies block of the component at the install root (or of the first component). */
  info: DependencyInfo;
}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);

/**
 * The install units of a set of components (only those with a dependencies block). Components of the same ecosystem
 * and install root share one unit. `unitOf` maps each component id to its unit id.
 */
export function installUnits(classifications: readonly Classification[]): { units: InstallUnit[]; unitOf: Map<string, string> } {
  const groups = new Map<string, Classification[]>();
  for (const c of classifications) {
    if (!c.dependencies) continue;
    const key = `${c.dependencies.ecosystem}\0${c.dependencies.installRoot}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const used = new Set<string>();
  const units: InstallUnit[] = [];
  const unitOf = new Map<string, string>();
  const sortedKeys = [...groups.keys()].sort();
  for (const key of sortedKeys) {
    const members = groups.get(key) as Classification[];
    const first = members[0] as Classification;
    const info = first.dependencies as DependencyInfo;
    const atRoot = members.find((m) => m.componentRoot === info.installRoot);
    const base = slug(atRoot?.id ?? (info.installRoot === "." ? `root-${info.ecosystem}` : `${info.installRoot}-${info.ecosystem}`)) || info.ecosystem;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    const unit: InstallUnit = { id, installRoot: info.installRoot, components: members.map((m) => m.id).sort(), info: (atRoot ?? first).dependencies as DependencyInfo };
    units.push(unit);
    for (const m of members) unitOf.set(m.id, id);
  }
  return { units, unitOf };
}
