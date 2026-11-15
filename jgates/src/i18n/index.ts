import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { localizeTechnical } from "./technical.js";

export type Params = Record<string, string | number>;

/** Parameters that carry the English parse problem of an adapter; in Portuguese the known ones are translated (technical.ts). */
const TECHNICAL_PARAMS = new Set(["problem", "detail", "reason", "cause"]);
function localizeParams(params: Params | undefined): Params | undefined {
  if (!params) return params;
  let out: Params | undefined;
  for (const name of TECHNICAL_PARAMS) {
    const value = params[name];
    if (typeof value !== "string") continue;
    const text = localizeTechnical(value);
    if (text !== value) (out ??= { ...params })[name] = text;
  }
  return out ?? params;
}
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

/** Index just past the "}" that closes the "{" at open, or -1 when the braces do not balance. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** Form of a count: exactly 1 is "one", everything else (0 included) is "other", in both languages. */
export function pluralCategory(count: number): "one" | "other" {
  return count === 1 ? "one" : "other";
}

const PLURAL_HEAD = /\{(\w+),\s*plural,\s*/y;

/** Replaces each "#" that is not inside a "{...}" of the text. */
function replaceTopLevelHash(text: string, value: string): string {
  let depth = 0;
  let out = "";
  for (const ch of text) {
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    out += ch === "#" && depth === 0 ? value : ch;
  }
  return out;
}

/**
 * Resolves the ICU-style plural blocks of a template: "{count, plural, one {# test} other {# tests}}" becomes the
 * branch of the count with "#" replaced by the number. "=0 {...}" matches that exact number; "other" is the fallback.
 * A block whose count is missing or not a number is left as written, like an unknown placeholder.
 */
export function resolvePlurals(template: string, params: Params = {}): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{", i);
    if (open < 0) break;
    PLURAL_HEAD.lastIndex = open;
    const head = PLURAL_HEAD.exec(template);
    const end = head ? closingBrace(template, open) : -1;
    if (!head || end < 0) {
      out += template.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    const branches = new Map<string, string>();
    let cursor = open + head[0].length;
    const bodyEnd = end - 1;
    while (cursor < bodyEnd) {
      const label = /\s*(=\d+|\w+)\s*\{/y;
      label.lastIndex = cursor;
      const found = label.exec(template);
      if (!found) break;
      const branchOpen = cursor + found[0].length - 1;
      const branchEnd = closingBrace(template, branchOpen);
      if (branchEnd < 0 || branchEnd > bodyEnd) break;
      branches.set(found[1] as string, template.slice(branchOpen + 1, branchEnd - 1));
      cursor = branchEnd;
    }
    const raw = params[head[1] as string];
    const count = raw === undefined || raw === "" ? NaN : Number(raw);
    out += template.slice(i, open);
    if (Number.isNaN(count) || !branches.has("other")) {
      out += template.slice(open, end);
    } else {
      const chosen = branches.get(`=${count}`) ?? branches.get(pluralCategory(count)) ?? (branches.get("other") as string);
      // "#" is this block's number only outside nested blocks; a nested plural keeps its own "#" and is resolved next.
      out += resolvePlurals(replaceTopLevelHash(chosen, String(raw)), params);
    }
    i = end;
  }
  return out + template.slice(i);
}

export function format(template: string, params: Params = {}): string {
  return resolvePlurals(template, params).replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/**
 * Returns a translator bound to one area; a missing key returns the key itself. Without an explicit locale the
 * translator follows the process language (getLocale) at each call, so a module-level translator honours --locale.
 */
export function translator(area: string, locale?: string, dir: string = messagesDir()): Translator {
  return (key, params) => {
    const language = locale ?? getLocale();
    const template = loadCatalog(area, language, dir)[key];
    return template === undefined ? key : format(template, language === "pt-BR" ? localizeParams(params) : params);
  };
}
