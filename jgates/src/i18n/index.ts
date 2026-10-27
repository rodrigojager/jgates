import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Params = Record<string, string | number>;
export type Translator = (key: string, params?: Params) => string;

export const DEFAULT_LOCALE = "pt-BR";
export const SUPPORTED_LOCALES = ["pt-BR", "en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Environment variable that picks the language of the human text when --locale is not given. */
export const LOCALE_ENV = "JGATES_LOCALE";

/** Maps a user value (en, en-US, pt, pt_BR...) to a supported locale, or null when it is not one. */
export function normalizeLocale(value: string | undefined | null): Locale | null {
  if (!value) return null;
  const lower = value.trim().toLowerCase().replace(/_/g, "-");
  if (lower === "en" || lower.startsWith("en-")) return "en";
  if (lower === "pt" || lower.startsWith("pt-")) return "pt-BR";
  return null;
}

let current: Locale = normalizeLocale(process.env[LOCALE_ENV]) ?? DEFAULT_LOCALE;

/** Locale used by translators that were not bound to one explicitly (the process language). */
export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  current = locale;
}

/** Runs fn with the process language set to locale and restores the previous one afterwards (fn is synchronous). */
export function withLocale<T>(locale: Locale, fn: () => T): T {
  const previous = current;
  current = locale;
  try {
    return fn();
  } finally {
    current = previous;
  }
}

/** Directory that holds the <area>.<locale>.json files (next to this module, in dist). */
export function messagesDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

const cache = new Map<string, Record<string, string>>();

/** Loads the message catalog of one area (file <area>.<locale>.json), cached per process. */
export function loadCatalog(area: string, locale: string = DEFAULT_LOCALE, dir: string = messagesDir()): Record<string, string> {
  let file = path.join(dir, `${area}.${locale}.json`);
  // A locale without its own file falls back to the default one (the catalog test keeps both complete).
  if (!fs.existsSync(file)) file = path.join(dir, `${area}.${DEFAULT_LOCALE}.json`);
  const hit = cache.get(file);
  if (hit) return hit;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
  cache.set(file, parsed);
  return parsed;
}

/** Lists the areas that have a catalog for the locale, found by scanning the folder (no central list). */
export function listAreas(locale: string = DEFAULT_LOCALE, dir: string = messagesDir()): string[] {
  const suffix = `.${locale}.json`;
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => name.slice(0, -suffix.length))
    .sort();
}

export function format(template: string, params: Params = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/**
 * Returns a translator bound to one area; a missing key returns the key itself. Without an explicit locale the
 * translator follows the process language (getLocale) at each call, so a module-level translator honours --locale.
 */
export function translator(area: string, locale?: string, dir: string = messagesDir()): Translator {
  return (key, params) => {
    const template = loadCatalog(area, locale ?? getLocale(), dir)[key];
    return template === undefined ? key : format(template, params);
  };
}
