// The language of the UI text. The choice lives in <JGATES_HOME>/preferences.json (GET/PUT /api/preferences); the page keeps
// a copy in localStorage only so the first paint already speaks the chosen language. Changing the language reloads the
// page: every catalog is loaded for both languages, so the reload only re-renders in the new one.

export type Locale = "pt-BR" | "en";
export const LOCALES: readonly Locale[] = ["pt-BR", "en"];
export const DEFAULT_LOCALE: Locale = "pt-BR";
const STORAGE_KEY = "jgates.language";

function normalize(value: unknown): Locale | null {
  return value === "en" || value === "pt-BR" ? value : null;
}

function readCached(): Locale | null {
  try {
    return normalize(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

let current: Locale = readCached() ?? DEFAULT_LOCALE;

export function getLocale(): Locale {
  return current;
}

/** Locale for number and date formatting. */
export function formatLocale(): string {
  return current;
}

/** Remembers the language for the next paint and uses it from now on (the caller reloads to re-render). */
export function rememberLocale(next: Locale): void {
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Without storage the page just starts in the default language until the preferences answer.
  }
  document.documentElement.lang = next;
}

/**
 * Reads the stored preference once at start-up. When it differs from the cached language (first visit, or the
 * preference was changed from another window), the page reloads once in the right language.
 */
export async function syncLocaleWithPreferences(): Promise<void> {
  document.documentElement.lang = current;
  try {
    const response = await fetch("/api/preferences", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!response.ok) return;
    const stored = normalize(((await response.json()) as { language?: unknown }).language);
    if (stored && stored !== current) {
      rememberLocale(stored);
      window.location.reload();
    }
  } catch {
    // Preferences are optional for rendering: keep the cached language.
  }
}
