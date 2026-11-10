// Human text of the lifecycle reports (setup and status). The JSON forms are the report objects themselves.
import { formatBytes, formatMegabytes } from "../reasons/index.js";
import { translator } from "../../i18n/index.js";
import type { LifecycleReason, StatusReport } from "./status.js";
import type { SetupResult } from "./setup.js";

function reasonLines(reason: LifecycleReason, t: ReturnType<typeof translator>, indent = "  "): string[] {
  const lines = [`${indent}${reason.code}: ${reason.message}`];
  const action = reason.action;
  const how = action.command ? `${action.label} (${action.command})` : action.url ? `${action.label} (${action.url})` : action.label;
  lines.push(`${indent}  ${t("lifecycle_action", { action: how })}`);
  if (reason.recipe) {
    if (reason.recipe.available) lines.push(`${indent}  ${t("lifecycle_recipe", { commands: reason.recipe.commands.join(" && ") })}`);
    else if (reason.recipe.reason) lines.push(`${indent}  ${reason.recipe.reason}`);
  }
  return lines;
}

export function renderStatus(report: StatusReport, locale?: string): string {
  const t = translator("lifecycle", locale);
  const lines: string[] = [report.ready ? t("lifecycle_status_ready") : t("lifecycle_status_not_ready")];
  if (report.mode === "in-image") {
    lines.push(t("lifecycle_status_in_image"));
    return lines.join("\n") + "\n";
  }
  const e = report.engine;
  lines.push(
    e.state === "ready" || e.state === "low-memory"
      ? t("lifecycle_status_engine", { state: t(`lifecycle_state_${e.state}`), version: e.serverVersion ?? "?", platform: `${e.os ?? "?"}/${e.arch ?? "?"}`, memory: formatMegabytes(e.memoryMb ?? 0, locale), cpus: e.cpus ?? 0 })
      : t("lifecycle_status_engine_down", { state: t(`lifecycle_state_${e.state}`) }),
  );
  lines.push(t("lifecycle_status_image", { image: report.image.reference, state: t(`lifecycle_state_image_${report.image.state}`), version: report.image.version ?? "-" }));
  lines.push(report.extension.images.length === 0 ? t("lifecycle_status_extension_none") : t("lifecycle_status_extension", { count: report.extension.images.length, names: report.extension.images.map((i) => i.name).join(", ") }));
  lines.push(t("lifecycle_status_data_header", { max: report.data.maxAgeDays }));
  for (const d of report.data.databases) {
    lines.push(`  ${d.id.padEnd(10)}${d.state === "missing" ? t("lifecycle_data_missing") : t("lifecycle_data_age", { days: d.ageDays ?? 0, state: t(`lifecycle_data_${d.state}`) })}`);
  }
  if (report.workspace) {
    lines.push(t("lifecycle_status_workspace", { id: report.workspace.id, path: report.workspace.path }));
    if (report.workspace.dependencies.length === 0) lines.push(`  ${t("lifecycle_status_no_dependencies")}`);
    for (const dep of report.workspace.dependencies) lines.push(`  ${dep.unit} (${dep.components.join(", ")}): ${t(`lifecycle_dep_${dep.state}`)}`);
    lines.push(`  ${t("lifecycle_status_services", { count: report.workspace.services.running })}`);
  }
  lines.push(
    t("lifecycle_status_disk", {
      used: report.disk.managedBytes === null ? "-" : formatBytes(report.disk.managedBytes, locale),
      free: report.disk.freeMb === null ? "-" : formatMegabytes(report.disk.freeMb, locale),
    }),
  );
  for (const v of report.disk.volumes) lines.push(`  ${v.name.padEnd(28)}${formatBytes(v.sizeBytes, locale)}`);
  for (const i of report.disk.images) lines.push(`  ${i.name.padEnd(28)}${formatBytes(i.sizeBytes, locale)}`);
  if (report.reasons.length > 0) {
    lines.push(t("lifecycle_status_problems"));
    for (const r of report.reasons) lines.push(...reasonLines(r, t));
  }
  if (report.warnings.length > 0) {
    lines.push(t("lifecycle_status_warnings"));
    for (const w of report.warnings) lines.push(...reasonLines(w, t));
  }
  return lines.join("\n") + "\n";
}

export function renderSetup(result: SetupResult, locale?: string): string {
  const t = translator("lifecycle", locale);
  const lines: string[] = [];
  for (const s of result.steps) lines.push(`${t(`lifecycle_step_${s.id}`).padEnd(12)}${t(`lifecycle_step_state_${s.state}`).padEnd(10)}${s.message}`);
  lines.push(result.ready ? t("lifecycle_setup_ready") : t("lifecycle_setup_not_ready"));
  const shown = new Set<string>();
  for (const r of [...result.reasons, ...result.status.reasons]) {
    const key = `${r.code}|${r.message}`;
    if (shown.has(key)) continue;
    shown.add(key);
    lines.push(...reasonLines(r, t));
  }
  return lines.join("\n") + "\n";
}

/** The progress line of a pull (stderr, text mode). */
export function pullLine(downloaded: number, total: number, locale?: string): string {
  const t = translator("lifecycle", locale);
  return total > 0 ? t("lifecycle_pull_progress", { done: formatBytes(downloaded, locale), total: formatBytes(total, locale), percent: Math.min(100, Math.floor((downloaded / total) * 100)) }) : t("lifecycle_pull_progress_unknown", { done: formatBytes(downloaded, locale) });
}
