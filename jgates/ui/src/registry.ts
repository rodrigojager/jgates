import { lazy, type ComponentType } from "react";
import { entries } from "virtual:screens";
import type { IconName } from "./components/icons";

export interface ScreenMeta {
  id: string;
  /** Hash route pattern, for example "/tools/:instance". */
  path: string;
  /**
   * Area of the navigation the screen belongs to (see app/areas.ts). The area's link highlights while one of its screens
   * is open; a screen with a navLabel is also listed as a sub-link of its area.
   */
  area?: "overview" | "workspace" | "config" | "validations" | "help" | "preferences";
  /** Catalog key of the navigation label; screens without one are not in the navigation. */
  navLabel?: string;
  /** Route the navigation link points to and highlights by prefix. */
  navPath?: string;
  order: number;
  icon?: IconName;
}

export interface ScreenModule {
  screen: ScreenMeta;
  default: ComponentType<{ params: Record<string, string> }>;
}

// Each folder in screens/ with an index.tsx is a screen; nothing else registers it (see virtual:screens in vite.config.ts).
// The metadata is available at once for the navigation; the component is a lazy import, fetched when its route opens. Its
// messages come the same way, from the messages.pt-BR.json next to the index.tsx (see i18n/index.ts).
export const screens: ScreenModule[] = entries
  .map((entry) => ({ screen: entry.screen, default: lazy(entry.load) as unknown as ScreenModule["default"] }))
  .sort((a, b) => a.screen.order - b.screen.order);

export function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split("/").filter(Boolean);
  const have = pathname.split("/").filter(Boolean);
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i] as string;
    const h = have[i] as string;
    if (w.startsWith(":")) params[w.slice(1)] = decodeURIComponent(h);
    else if (w !== h) return null;
  }
  return params;
}
