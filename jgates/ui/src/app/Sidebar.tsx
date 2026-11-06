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

// The JGates mark: the braces and the pencil J. Its two greens swap in the dark theme (theme.css, --logo-brace and
// --logo-mark); the same drawing is the favicon (public/favicon.svg).
const Logo = () => (
  <svg className="logo" viewBox="17 24 549 534" width="26" height="25" aria-hidden="true" focusable="false">
    <path className="a" fillRule="evenodd" d="M446 558 L429 557 L429 512 L448 512 L466 505 L479 493 L488 476 L492 458 L493 434 L491 412 L483 374 L483 333 L485 323 L492 306 L509 290 L500 285 L493 277 L487 265 L483 249 L482 218 L484 201 L490 176 L493 147 L492 123 L489 109 L481 91 L467 77 L451 70 L429 69 L429 24 L450 24 L468 28 L495 41 L507 50 L521 64 L541 93 L542 135 L538 173 L530 212 L531 241 L536 261 L544 276 L554 286 L562 290 L566 290 L553 296 L541 310 L534 327 L530 349 L530 370 L535 390 L541 434 L542 486 L523 515 L500 537 L472 552ZM153 558 L125 556 L111 552 L92 543 L66 522 L44 492 L41 486 L41 446 L46 402 L53 370 L52 341 L46 318 L38 304 L27 294 L17 291 L29 286 L39 276 L47 261 L52 241 L53 212 L47 186 L42 148 L41 95 L61 65 L81 46 L107 31 L133 24 L154 24 L154 69 L137 69 L121 74 L105 87 L96 103 L91 123 L90 148 L93 176 L100 208 L100 248 L96 265 L90 277 L83 285 L74 291 L80 294 L91 306 L98 323 L101 342 L100 374 L94 400 L90 434 L91 458 L94 473 L104 493 L117 505 L135 512 L154 512ZM406 154 L335 153 L337 152 L347 132 L395 132Z" />
    <path className="b" fillRule="evenodd" d="M295 501 L293 501 L182 391 L182 291 L254 291 L254 359 L295 400 L297 400 L301 394 L335 360 L335 154 L406 154 L406 393 L398 401 L396 401ZM394 132 L348 132 L371 89 L373 89Z" />
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
