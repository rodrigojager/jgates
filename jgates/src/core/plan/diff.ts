import { canonicalJson } from "../ids/index.js";
import type { Plan, PlanBody, PlanChanges, PlanItem } from "./types.js";

type Comparable = Pick<Plan, "planHash"> & Partial<Pick<Plan, "createdAt">> & PlanBody;

const GROUPS = ["willRun", "notApplicableOrDisabled"] as const;

function itemsById(plan: PlanBody): Map<string, { item: PlanItem; group: string }> {
  const out = new Map<string, { item: PlanItem; group: string }>();
  for (const group of GROUPS) for (const item of plan.groups?.[group] ?? []) out.set(item.id, { item, group });
  return out;
}

const same = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** Fields of an item a reviewer cares about when it changes between two plans. */
const ITEM_FIELDS: Array<[string, (i: PlanItem) => unknown]> = [
  ["state.enabled", (i) => i.state.enabled],
  ["state.origin", (i) => i.state.origin],
  ["state.decision", (i) => (i.state.decision ? { selector: i.state.decision.selector, value: i.state.decision.value, layer: i.state.decision.layer, source: i.state.decision.source, file: i.state.decision.file } : null)],
  ["requirement", (i) => i.requirement],
  ["command", (i) => i.command],
  ["versions", (i) => i.versions],
  ["configFiles", (i) => i.configFiles],
  ["network", (i) => i.network],
  ["availability", (i) => i.availability.status],
  ["components", (i) => i.components.map((c) => c.id)],
];

/**
 * What changed from one plan to the next: items added, removed or changed (state, origin, command, versions,
 * configuration files, network), configuration files added, removed or edited, versions and the profile.
 */
export function diffPlans(previous: Comparable, next: Comparable): PlanChanges {
  const before = itemsById(previous);
  const after = itemsById(next);
  const added = [...after.keys()].filter((id) => !before.has(id)).sort();
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort();
  const changed: PlanChanges["items"]["changed"] = [];
  for (const [id, now] of after) {
    const was = before.get(id);
    if (!was) continue;
    const fields: Array<{ field: string; from: unknown; to: unknown }> = [];
    if (was.group !== now.group) fields.push({ field: "group", from: was.group, to: now.group });
    for (const [field, get] of ITEM_FIELDS) {
      const from = get(was.item);
      const to = get(now.item);
      if (!same(from, to)) fields.push({ field, from, to });
    }
    if (fields.length > 0) changed.push({ id, fields });
  }
  changed.sort((a, b) => a.id.localeCompare(b.id));

  const filesBefore = new Map((previous.inputs?.configFiles ?? []).map((f) => [f.file, f.sha256]));
  const filesAfter = new Map((next.inputs?.configFiles ?? []).map((f) => [f.file, f.sha256]));
  const configFiles = {
    added: [...filesAfter.keys()].filter((f) => !filesBefore.has(f)).sort(),
    removed: [...filesBefore.keys()].filter((f) => !filesAfter.has(f)).sort(),
    changed: [...filesAfter.keys()].filter((f) => filesBefore.has(f) && filesBefore.get(f) !== filesAfter.get(f)).sort(),
  };

  const versions: PlanChanges["versions"] = [];
  const flat = (v: PlanBody["versions"] | undefined): Record<string, unknown> => {
    const out: Record<string, unknown> = { jgates: v?.jgates, detector: v?.detector };
    for (const [k, x] of Object.entries(v?.adapters ?? {})) out[`adapters.${k}`] = x;
    for (const [k, x] of Object.entries(v?.tools ?? {})) out[`tools.${k}`] = x;
    return out;
  };
  const vb = flat(previous.versions);
  const va = flat(next.versions);
  for (const key of [...new Set([...Object.keys(vb), ...Object.keys(va)])].sort()) {
    if (!same(vb[key], va[key])) versions.push({ field: key, from: vb[key] ?? null, to: va[key] ?? null });
  }

  const profileFrom = previous.profile?.id ?? null;
  const profileTo = next.profile?.id ?? null;
  const networkFrom = previous.network?.required ?? false;
  const networkTo = next.network?.required ?? false;
  return {
    previousHash: previous.planHash,
    previousCreatedAt: previous.createdAt ?? null,
    same: previous.planHash === next.planHash,
    profile: profileFrom !== profileTo ? { from: profileFrom, to: profileTo } : null,
    items: { added, removed, changed },
    configFiles,
    versions,
    network: networkFrom !== networkTo ? { from: networkFrom, to: networkTo } : null,
  };
}
