import { formatLocale } from "../i18n";

// One formatter for sizes and one for dates, used by every screen (PLAN-consistency.md section 2): sizes in decimal units
// with the separator of the language ("2,4 GB"), dates and times in the local time zone of the browser.

/** Bytes as "2,4 GB": decimal units, one decimal below 100, the separator of the language. */
export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(formatLocale(), { maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
}

/** A moment as "12/11/2026 10:00" in the local time zone and the language of the screen; an unreadable value as it came. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(formatLocale(), { dateStyle: "short", timeStyle: "short" });
}

/** The time of day of a moment in the local time zone. */
export function formatTime(iso: string | number | Date): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleTimeString(formatLocale(), { timeStyle: "medium" });
}

/** The moment a run id names (run_YYYYMMDDTHHMMSSZ is UTC) in the local time zone; any other id as it came. */
export function formatRunWhen(runId: string): string {
  const m = /^run_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(runId);
  return m ? formatDateTime(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : runId;
}
