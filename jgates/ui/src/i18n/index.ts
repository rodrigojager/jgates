import appEn from "./ui.en.json";
import app from "./ui.pt-BR.json";
import { getLocale, type Locale } from "./locale";

export { getLocale, formatLocale, LOCALES, type Locale } from "./locale";

type Catalog = Record<string, string>;

// Where the messages live (nothing here lists a screen):
//  - ui.<locale>.json (this folder): only what belongs to the application itself (shell, navigation, states of the UI);
//  - screens/<screen>/messages.<locale>.json, next to the screen's index.tsx: the messages of that screen, found by folder;
//  - components/messages.<locale>.json: the messages of the shared components (editor, diff, conflict dialog).
// A new screen brings its own messages.pt-BR.json and messages.en.json and edits no shared file. Keys are global, so a screen
// prefixes its keys with its own name (plan_title, run_state...); a repeated key is reported by duplicateKeys() and fails the
// i18n test. Both languages are bundled; the language is picked at each call (see locale.ts).
const folderCatalogs = import.meta.glob<Catalog>(["../screens/**/messages.{pt-BR,en}.json", "../components/messages.{pt-BR,en}.json"], {
  eager: true,
  import: "default",
});

interface Source {
  file: string;
  messages: Catalog;
}

const sourcesBy: Record<Locale, Source[]> = {
  "pt-BR": [{ file: "i18n/ui.pt-BR.json", messages: app as Catalog }],
  en: [{ file: "i18n/ui.en.json", messages: appEn as Catalog }],
};
for (const [file, messages] of Object.entries(folderCatalogs).sort(([a], [b]) => (a < b ? -1 : 1))) {
  const locale: Locale = file.endsWith(".en.json") ? "en" : "pt-BR";
  sourcesBy[locale].push({ file: file.replace(/^\.\.\//, ""), messages });
}

const catalogs: Record<Locale, Catalog> = { "pt-BR": {}, en: {} };
const duplicatesBy: Record<Locale, Array<{ key: string; files: string[] }>> = { "pt-BR": [], en: [] };
for (const locale of Object.keys(sourcesBy) as Locale[]) {
  const owners = new Map<string, string>();
  for (const { file, messages: catalog } of sourcesBy[locale]) {
    for (const [key, value] of Object.entries(catalog)) {
      const first = owners.get(key);
      if (first !== undefined) {
        duplicatesBy[locale].push({ key, files: [first, file] });
        continue;
      }
      owners.set(key, file);
      catalogs[locale][key] = value;
    }
  }
}

function lookup(key: string): string | undefined {
  return catalogs[getLocale()][key] ?? catalogs["pt-BR"][key];
}

/** Message of the UI catalog in the chosen language; a missing key shows the key itself so the gap is visible. */
export function t(key: string, params: Record<string, string | number> = {}): string {
  const template = lookup(key);
  if (template === undefined) return key;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** Catalog text for a dynamic key with a fallback to the raw value (for example an enum the catalog does not know). */
export function tOr(key: string, fallback: string): string {
  return lookup(key) ?? fallback;
}

/** The catalog files that were loaded and how many keys each brought (for the i18n test and for debugging). */
export function messageSources(locale: Locale = "pt-BR"): Array<{ file: string; keys: number }> {
  return sourcesBy[locale].map(({ file, messages: catalog }) => ({ file, keys: Object.keys(catalog).length }));
}

/** The keys of one language, to compare the languages with each other. */
export function catalogKeys(locale: Locale): string[] {
  return Object.keys(catalogs[locale]);
}

/** Keys defined by more than one file; empty when the catalogs are consistent. */
export function duplicateKeys(locale: Locale = "pt-BR"): Array<{ key: string; files: string[] }> {
  return duplicatesBy[locale];
}
