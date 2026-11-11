// Text of the cleanup plan and of what was removed (`jgates clean`, `jgates uninstall`).
import { translator } from "../../i18n/index.js";
import { formatBytes } from "../reasons/index.js";
import type { AppliedLine } from "./apply.js";
import type { CleanItem, CleanupPlan } from "./plan.js";

const t = translator("cleanup");

const resourceName = (item: CleanItem): string => t(`cleanup_resource_${item.resource}`);

function skipReason(item: CleanItem): string {
  if (!item.inUse) return "";
  return t(`cleanup_in_use_${item.inUse.code}`, { detail: item.inUse.detail });
}

/** The lines of a plan: what would go, what is skipped as "in use", and the unlabelled images left alone. */
export function renderPlanLines(plan: CleanupPlan): string[] {
  const lines: string[] = [];
  if (plan.engine.state === "unavailable") lines.push(t("cleanup_engine_unavailable"));
  const stateWidth = Math.max(t("cleanup_in_use").length, 7);
  for (const item of plan.items) {
    const size = formatBytes(item.sizeBytes);
    if (item.action === "remove") lines.push(t("cleanup_line_remove", { resource: resourceName(item), name: item.name, size, why: t(`cleanup_why_${item.why}`) }));
    else lines.push(t("cleanup_line_skip", { state: t("cleanup_in_use").padEnd(stateWidth), resource: resourceName(item), name: item.name, size, reason: skipReason(item) }));
  }
  if (plan.unmanaged.length > 0) {
    lines.push(t("cleanup_unmanaged_header"));
    for (const u of plan.unmanaged) lines.push(t("cleanup_unmanaged_line", { name: u.name, size: formatBytes(u.sizeBytes) }));
    lines.push(t("cleanup_unmanaged_hint"));
  }
  return lines;
}

/** The items for a JSON document: the item, a fixed `reason` ("in-use" for skipped ones) and the localized label ("em uso"). */
export function itemsJson(items: readonly CleanItem[]): Array<CleanItem & { reason: "in-use" | null; label: string | null; message: string | null }> {
  return items.map((i) => ({ ...i, reason: i.inUse ? ("in-use" as const) : null, label: i.inUse ? t("cleanup_in_use") : null, message: i.inUse ? skipReason(i) : null }));
}

export function renderAppliedLine(line: AppliedLine): string {
  const resource = t(`cleanup_resource_${line.item.resource}`);
  if (line.outcome === "removed") return t("cleanup_removed_line", { resource, name: line.item.name, size: formatBytes(line.freedBytes) });
  if (line.outcome === "in-use") return t("cleanup_in_use_line", { resource, name: line.item.name, reason: t("cleanup_in_use_ENGINE") });
  return t("cleanup_failed_line", { resource, name: line.item.name, reason: (line.details ?? "").split(/\r?\n/)[0] ?? "" });
}
