import { useEffect, useState } from "react";
import { matchRoute, screens, type ScreenModule } from "../registry";

export function currentPath(): string {
  const hash = window.location.hash.replace(/^#/, "");
  return hash === "" ? "" : hash;
}

/** The hash route, kept in state ("" when the address has none: the shell then picks the start screen). */
export function useRoute(): string {
  const [path, setPath] = useState(currentPath());
  useEffect(() => {
    const on = () => setPath(currentPath());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return path;
}

/** The screen that answers a route and its parameters. */
export function resolveScreen(path: string): { mod: ScreenModule; params: Record<string, string> } | null {
  for (const mod of screens) {
    const params = matchRoute(mod.screen.path, path);
    if (params) return { mod, params };
  }
  return null;
}

/** Where a visit with no route starts: the overview, or (until it exists) the first registered screen. */
export function startPath(configured: boolean): string {
  const overview = screens.some((s) => s.screen.path === "/overview");
  if (overview || !configured) return "/overview";
  return screens[0]?.screen.path ?? "/overview";
}

export function navigate(path: string): void {
  window.location.hash = `#${path}`;
}
