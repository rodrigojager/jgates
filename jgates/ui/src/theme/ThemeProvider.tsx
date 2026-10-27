import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api";

// The preference lives in <JGATES_HOME>/preferences.json (served by /api/preferences), never in the project. The page keeps
// a copy in localStorage only to paint the right theme before the first answer of the server arrives.

export type ThemePreference = "light" | "dark" | "system";
export const THEME_CHOICES: ThemePreference[] = ["light", "dark", "system"];
const CACHE_KEY = "jgates-theme";

function isTheme(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

/** "light" and "dark" pin the tokens through data-theme; "system" removes it so prefers-color-scheme decides. */
export function applyTheme(theme: ThemePreference): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

function cached(): ThemePreference {
  try {
    const value = window.localStorage.getItem(CACHE_KEY);
    return isTheme(value) ? value : "system";
  } catch {
    return "system";
  }
}

function remember(theme: ThemePreference): void {
  try {
    window.localStorage.setItem(CACHE_KEY, theme);
  } catch {
    // Private window or blocked storage: the server copy is the one that counts.
  }
}

/** Paints the cached theme right away (call before the first render). */
export function applyCachedTheme(): void {
  applyTheme(cached());
}

interface ThemeApi {
  theme: ThemePreference;
  /** Applies the theme at once and saves it; rejects when the server could not save it (the theme goes back). */
  setTheme(next: ThemePreference): Promise<void>;
}

const ThemeContext = createContext<ThemeApi>({ theme: "system", setTheme: async () => undefined });

/** `const { theme, setTheme } = useTheme()`: for the topbar switch and for the Preferences screen. */
export function useTheme(): ThemeApi {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(cached);
  // A choice made before the first answer of the server arrives wins over that answer (it would otherwise undo the choice).
  const chosen = useRef(false);

  useEffect(() => {
    let live = true;
    api<{ theme?: unknown }>("GET", "/api/preferences").then(
      (prefs) => {
        if (!live || chosen.current || !isTheme(prefs.theme)) return;
        setThemeState(prefs.theme);
        applyTheme(prefs.theme);
        remember(prefs.theme);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  const setTheme = useCallback(
    async (next: ThemePreference) => {
      const before = theme;
      chosen.current = true;
      setThemeState(next);
      applyTheme(next);
      try {
        await api("PUT", "/api/preferences", { theme: next });
        remember(next);
      } catch (error) {
        setThemeState(before);
        applyTheme(before);
        throw error;
      }
    },
    [theme],
  );

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
