import type { IconName } from "../components/icons";

/**
 * The areas of the navigation. They are fixed by the product, so they are listed
 * here once; what changes from screen to screen is which screens belong to an area, and a screen says that itself with
 * `area` in its own `screen` export (see registry.ts). A new screen never edits this file.
 */
export interface Area {
  id: "overview" | "workspace" | "config" | "validations" | "help" | "preferences";
  /** Hash route the link points to. */
  path: string;
  /** Catalog key of the label. */
  label: string;
  icon: IconName;
  /** Where the link sits: the "workspace" block, the "quality" block or the foot of the sidebar. */
  block: "workspace" | "quality" | "foot";
}

export const AREAS: Area[] = [
  { id: "overview", path: "/overview", label: "nav_overview", icon: "home", block: "workspace" },
  { id: "workspace", path: "/workspace", label: "nav_workspace", icon: "folder", block: "workspace" },
  { id: "config", path: "/config", label: "nav_config", icon: "sliders", block: "workspace" },
  { id: "validations", path: "/validations", label: "nav_validations", icon: "check-circle", block: "quality" },
  { id: "help", path: "/help", label: "nav_help", icon: "terminal", block: "foot" },
  { id: "preferences", path: "/preferences", label: "nav_preferences", icon: "settings", block: "foot" },
];

export const areaById = (id: string | undefined): Area | undefined => AREAS.find((a) => a.id === id);

/** The area a route belongs to: the one its path starts with. */
export function areaOfPath(path: string): Area | undefined {
  return AREAS.find((a) => path === a.path || path.startsWith(`${a.path}/`));
}
