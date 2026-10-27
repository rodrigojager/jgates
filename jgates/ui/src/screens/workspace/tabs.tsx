import type { KeyboardEvent } from "react";
import { t } from "../../i18n";
import { navigate } from "../../app/route";

export type WorkspaceTab = "components" | "scope" | "environment";

const TAB_KEY = "jgates.workspace.tab";
const ORDER: WorkspaceTab[] = ["components", "scope", "environment"];

/** The tab the Workspace opens on (remembered when the user comes back from the Ambiente tab). */
export function rememberedTab(): WorkspaceTab {
  try {
    const v = window.sessionStorage.getItem(TAB_KEY);
    return v === "scope" ? "scope" : "components";
  } catch {
    return "components";
  }
}

export function rememberTab(tab: WorkspaceTab): void {
  try {
    window.sessionStorage.setItem(TAB_KEY, tab);
  } catch {
    // session storage can be blocked; the tab then starts on Componentes
  }
}

/**
 * The tabs of the Workspace area. Componentes and Detecção e escopo are panels of the Workspace screen; Ambiente is its
 * own screen (#/environment), so choosing it navigates. The same strip is shown on both screens.
 */
export function WorkspaceTabs({ selected, onSelect }: { selected: WorkspaceTab; onSelect?: (tab: WorkspaceTab) => void }) {
  const choose = (tab: WorkspaceTab) => {
    if (tab === "environment") {
      navigate("/environment");
      return;
    }
    rememberTab(tab);
    if (onSelect) onSelect(tab);
    else navigate("/workspace");
  };
  const onKey = (e: KeyboardEvent, index: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = ORDER[(index + (e.key === "ArrowRight" ? 1 : ORDER.length - 1)) % ORDER.length] as WorkspaceTab;
    // Moving the focus with the arrows does not navigate away; Enter or Space on Ambiente does.
    (document.getElementById(`ws-tab-${next}`) as HTMLElement | null)?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={t("ws_tabs_label")}>
      {ORDER.map((tab, i) => (
        <button
          key={tab}
          type="button"
          role="tab"
          className="tab"
          id={`ws-tab-${tab}`}
          aria-selected={selected === tab}
          aria-controls={tab === "environment" ? undefined : `ws-panel-${tab}`}
          tabIndex={selected === tab ? 0 : -1}
          onClick={() => choose(tab)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t(`ws_tab_${tab}`)}
        </button>
      ))}
    </div>
  );
}
