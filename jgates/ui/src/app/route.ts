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

/** The query of the hash route (`#/semantic/setup?step=provider` gives step=provider); a screen reads it itself. */
export function currentQuery(): URLSearchParams {
  const hash = currentPath();
  const at = hash.indexOf("?");
  return new URLSearchParams(at < 0 ? "" : hash.slice(at + 1));
}

/** The route without its query. */
export const routeOnly = (path: string): string => path.split("?")[0] as string;

/**
 * Routes that moved: the old address keeps working and is replaced by the new one (the browser history keeps no
 * entry for the old one).
 */
export const REDIRECTS: Record<string, string> = {
  "/preferences/providers": "/semantic/providers",
};

export function redirectOf(path: string): string | null {
  return REDIRECTS[routeOnly(path)] ?? null;
}

/** The screen that answers a route and its parameters. */
export function resolveScreen(path: string): { mod: ScreenModule; params: Record<string, string> } | null {
  const bare = routeOnly(path);
  for (const mod of screens) {
    const params = matchRoute(mod.screen.path, bare);
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
