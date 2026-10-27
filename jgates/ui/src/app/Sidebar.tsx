import { forwardRef } from "react";
import { Icon } from "../components/icons";
import { t } from "../i18n";
import { screens } from "../registry";
import { AREAS, areaOfPath, type Area } from "./areas";
import { resolveScreen } from "./route";
import { useShell } from "./shell-context";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

function AreaLink({ area, current, onNavigate }: { area: Area; current: boolean; onNavigate: () => void }) {
  const { info } = useShell();
  const count = area.id === "validations" ? info?.runs.count : undefined;
  return (
    <a href={`#${area.path}`} className="nav-item" onClick={onNavigate} {...(current ? { "aria-current": "page" as const } : {})}>
      <Icon name={area.icon} />
      <span className="grow">{t(area.label)}</span>
      {count !== undefined ? (
        <span className="nav-count" aria-label={t("nav_runs_count", { count })}>
          {count}
        </span>
      ) : null}
    </a>
  );
}

/** Sub-links of an area: the screens that say `area` and have a `navLabel` (shown while the area is open). */
function SubLinks({ areaId, path, onNavigate }: { areaId: string; path: string; onNavigate: () => void }) {
  const items = screens.filter((s) => s.screen.area === areaId && s.screen.navLabel);
  if (items.length === 0) return null;
  return (
    <ul className="nav-sub">
      {items.map((mod) => {
        const target = mod.screen.navPath ?? mod.screen.path;
        const active = path === target || path.startsWith(`${target}/`);
        return (
          <li key={mod.screen.id}>
            <a href={`#${target}`} onClick={onNavigate} {...(active ? { "aria-current": "page" as const } : {})}>
              {t(mod.screen.navLabel as string)}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

const Logo = () => (
  <svg className="logo" viewBox="0 0 32 36" width="22" height="25" aria-hidden="true" focusable="false">
    <path className="a" d="M3 30V11a8 8 0 0 1 8-8h14v27" fill="none" strokeWidth="3.2" strokeLinecap="round" />
    <path className="b" d="M10 30V14a4 4 0 0 1 4-4h11M17 30V19a2 2 0 0 1 2-2h6" fill="none" strokeWidth="3.2" strokeLinecap="round" />
  </svg>
);

/**
 * The navigation. Above 700 px it is a column; below, it is a drawer (`open` shows it) that the shell traps focus in.
 */
export const Sidebar = forwardRef<HTMLElement, { path: string; open: boolean; onClose: () => void }>(function Sidebar({ path, open, onClose }, ref) {
  const { info } = useShell();
  const activeArea = resolveScreen(path)?.mod.screen.area ?? areaOfPath(path)?.id;
  const legacy = screens.filter((s) => s.screen.navLabel && !s.screen.area);
  const block = (name: Area["block"]) => AREAS.filter((a) => a.block === name);
  const running = info?.runs.active != null;
  const governed = info?.mode === "governed";
  const policyMode = info?.policyMode === true;

  const group = (name: "workspace" | "quality", label: string) => (
    <>
      <div className="nav-label" id={`nav-${name}`}>
        {label}
      </div>
      <ul className="nav-list" aria-labelledby={`nav-${name}`}>
        {block(name).map((area) => (
          <li key={area.id}>
            <AreaLink area={area} current={activeArea === area.id} onNavigate={onClose} />
            {activeArea === area.id ? <SubLinks areaId={area.id} path={path} onNavigate={onClose} /> : null}
          </li>
        ))}
      </ul>
    </>
  );

  return (
    <aside id="sidebar" ref={ref} className="sidebar" data-open={open ? "true" : "false"} aria-label={t("sidebar_label")} {...(open ? { role: "dialog", "aria-modal": true } : {})}>
      <div className="brand-row">
        <div className="brand">
          <Logo />
          <span>jgates</span>
          {info && info.version.startsWith("0.") ? <sup>{t("brand_preview")}</sup> : null}
        </div>
        <button type="button" className="icon-btn drawer-close" aria-label={t("drawer_close")} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <WorkspaceSwitcher />
      <nav className="nav" aria-label={t("nav_label")}>
        {group("workspace", t("nav_section_workspace"))}
        {group("quality", t("nav_section_quality"))}
        {legacy.length > 0 ? (
          <>
            <div className="nav-label" id="nav-other">
              {t("nav_section_other")}
            </div>
            <ul className="nav-list" aria-labelledby="nav-other">
              {legacy.map((mod) => {
                const target = mod.screen.navPath ?? mod.screen.path;
                const active = path === target || path.startsWith(`${target}/`);
                return (
                  <li key={mod.screen.id}>
                    <a href={`#${target}`} className="nav-item" onClick={onClose} {...(active ? { "aria-current": "page" as const } : {})}>
                      <Icon name={mod.screen.icon ?? "tools"} />
                      {t(mod.screen.navLabel as string)}
                    </a>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </nav>
      <div className="sidebar-foot">
        <ul className="nav-list" aria-label={t("nav_foot")}>
          {block("foot").map((area) => (
            <li key={area.id}>
              <AreaLink area={area} current={activeArea === area.id} onNavigate={onClose} />
            </li>
          ))}
        </ul>
        <div className="local-card" data-testid="local-card">
          <div className="row">
            <span className={`dot${running ? " busy" : ""}`} aria-hidden="true" />
            <strong>{t("card_title")}</strong>
          </div>
          <p>{policyMode ? t("card_mode_policy") : governed ? t("card_mode_governed") : t("card_mode_local")}</p>
          <a href="#/environment" className="small" onClick={onClose} data-testid="card-environment">
            {t("nav_environment")}
          </a>
          <p className="small" role="status">
            {running ? t("card_running") : t("card_idle")}
          </p>
        </div>
      </div>
    </aside>
  );
});
