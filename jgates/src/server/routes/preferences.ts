// Personal preferences (theme, language) kept in <JGATES_HOME>/preferences.json. They belong to the user, not to the
// project: nothing here touches the workspace.
import fs from "node:fs";
import path from "node:path";
import { ensureHome } from "../../core/home/index.js";
import { normalizeLocale, setLocale } from "../../i18n/index.js";
import type { RouteDefinition } from "../types.js";

export const PREFERENCES_FILE = "preferences.json";
export const THEMES = ["light", "dark", "system"] as const;
export const LANGUAGES = ["pt-BR", "en"] as const;

export interface Preferences {
  schemaVersion: 1;
  theme: (typeof THEMES)[number];
  language: (typeof LANGUAGES)[number];
}

const DEFAULTS: Preferences = { schemaVersion: 1, theme: "system", language: "pt-BR" };

/** The stored preferences; an unreadable or unknown file gives the defaults (a bad value is never trusted). */
export function readPreferences(home: string): Preferences {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, PREFERENCES_FILE), "utf8")) as Partial<Preferences>;
    return {
      schemaVersion: 1,
      theme: THEMES.includes(parsed.theme as never) ? (parsed.theme as Preferences["theme"]) : DEFAULTS.theme,
      language: LANGUAGES.includes(parsed.language as never) ? (parsed.language as Preferences["language"]) : DEFAULTS.language,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Atomic write (temp file + rename), owner-only. */
export function writePreferences(home: string, next: Preferences): void {
  ensureHome(home);
  const file = path.join(home, PREFERENCES_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The server speaks the language the user chose in the UI, so the API messages match the screen. */
function applyLanguage(language: string): void {
  const locale = normalizeLocale(language);
  if (locale) setLocale(locale);
}

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/preferences",
    handler({ server }) {
      const prefs = readPreferences(server.home);
      applyLanguage(prefs.language);
      return { status: 200, json: { status: "OK", ...prefs } };
    },
  },
  {
    method: "PUT",
    path: "/api/preferences",
    body: {
      type: "object",
      properties: { theme: { enum: [...THEMES] }, language: { enum: [...LANGUAGES] } },
      additionalProperties: false,
      minProperties: 1,
    },
    handler({ body, server }) {
      const patch = body as Partial<Pick<Preferences, "theme" | "language">>;
      const next: Preferences = { ...readPreferences(server.home), ...patch };
      writePreferences(server.home, next);
      applyLanguage(next.language);
      return { status: 200, json: { status: "OK", ...next } };
    },
  },
];
