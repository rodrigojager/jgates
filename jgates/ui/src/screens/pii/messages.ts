import catalogEn from "./pii.en.json";
import catalogPt from "./pii.pt-BR.json";
import { getLocale } from "../../i18n/locale";

const pt = catalogPt as Record<string, string>;
const catalogs: Record<string, Record<string, string>> = { "pt-BR": pt, en: catalogEn as Record<string, string> };
const lookup = (key: string): string | undefined => catalogs[getLocale()]?.[key] ?? pt[key];

/** Message of the PII screen catalog; a missing key shows the key itself so the gap is visible. */
export function tp(key: string, params: Record<string, string | number> = {}): string {
  const template = lookup(key);
  if (template === undefined) return key;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

export function tpOr(key: string, fallback: string): string {
  return lookup(key) ?? fallback;
}
