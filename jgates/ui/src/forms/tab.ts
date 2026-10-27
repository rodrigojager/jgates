import type { ComponentType } from "react";

/**
 * Contract of a tab of the tool area (screens/tool-area/<tab>/index.tsx): the tool screen finds the folders with
 * import.meta.glob and shows the tabs whose `applies` accepts the instance, in `order` (Files is built in, order 20).
 */
export interface ToolTabMeta {
  id: string;
  /** Visible label. */
  label: string;
  order: number;
  applies?: (instance: any) => boolean;
}

/** Where a tab asks the Files tab to go: a binding (and entry of a directory binding), optionally a line. */
export interface FileTarget {
  binding: string;
  entry?: string | null;
  line?: number | null;
}

export interface ToolTabProps {
  instance: any;
  /** True while the tab is the selected one (tabs stay mounted, so drafts survive a tab switch). */
  active: boolean;
  /** Switches to the Files tab with that file open (and the cursor on the line). */
  openFile: (target: FileTarget) => void;
}

export interface ToolTabModule {
  tab: ToolTabMeta;
  default: ComponentType<ToolTabProps>;
}
