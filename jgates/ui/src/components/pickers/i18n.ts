import catalogEn from "./messages.en.json";
import catalogPt from "./messages.pt-BR.json";
import { getLocale } from "../../i18n/locale";
import { resolvePlurals } from "../../i18n/plural";

// The pickers' own catalog (the application catalog loads only the screens' folders and components/messages).
const pt = catalogPt as Record<string, string>;
const catalogs: Record<string, Record<string, string>> = { "pt-BR": pt, en: catalogEn as Record<string, string> };

/** Message of the pickers catalog; a missing key shows the key itself so the gap is visible. */
export function pk(key: string, params: Record<string, string | number> = {}): string {
  const template = catalogs[getLocale()]?.[key] ?? pt[key];
  if (template === undefined) return key;
  return resolvePlurals(template, params).replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}
