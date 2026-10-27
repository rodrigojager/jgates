import { Suspense, useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { useFocusTrap } from "../components/useFocusTrap";
import { t } from "../i18n";
import { areaOfPath } from "./areas";
import { currentPath, navigate, resolveScreen, startPath, useRoute } from "./route";
import { useShell } from "./shell-context";
import { Sidebar } from "./Sidebar";
import { ActiveRunBanner, AreaUnavailable, FirstAccess, ServerStopped, SessionExpired } from "./states";
import { Topbar } from "./Topbar";
import { PolicyUnavailable } from "../screens/policy/PolicyBand";

/** The screens that need a project to validate: unavailable while the interface edits the CI policy. */
const PROJECT_ONLY_SCREENS = new Set(["overview", "history", "validations-choose", "validations-review", "validations-run", "validations-result", "plan"]);

/** Width under which the menu is a drawer (the narrowest layout width). */
const NARROW = "(max-width: 700px)";

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const on = () => setNarrow(query.matches);
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, []);
  return narrow;
}

export function App() {
  const { info, connection } = useShell();
  const route = useRoute();
  const narrow = useNarrow();
  const [drawer, setDrawer] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const main = useRef<HTMLElement>(null);
  const drawerOpen = drawer && narrow;
  const closeDrawer = useCallback(() => setDrawer(false), []);
  useFocusTrap(sidebar, drawerOpen, closeDrawer);

  // No route in the address: go to the start screen once the shell knows whether the workspace has a configuration.
  const configured = info?.workspace.configured ?? true;
  const policyMode = info?.policyMode === true;
  const start = policyMode ? "/policy" : startPath(configured);
  useEffect(() => {
    // Read the address again here: `route` can lag a hashchange that already happened (a link followed while the shell
    // was still loading), and the start screen must never override a route the visitor already chose.
    if (route === "" && info && currentPath() === "") navigate(start);
  }, [route, info, start]);
  const path = route === "" ? start : route;

  // After the user moves to another screen, focus goes to the content (not at first load, and not while typing in a screen
  // that only changes its own hash).
  const found = resolveScreen(path);
  const focusKey = found ? found.mod.screen.id : (areaOfPath(path)?.id ?? path);
  const before = useRef<{ key: string; loaded: boolean } | null>(null);
  const loaded = info !== null;
  useEffect(() => {
    const last = before.current;
    before.current = { key: focusKey, loaded };
    if (!last || !last.loaded || last.key === focusKey) return;
    main.current?.focus();
  }, [focusKey, loaded]);

  const skip = (event: MouseEvent) => {
    event.preventDefault();
    main.current?.focus();
  };

  let body;
  if (connection === "stopped") body = <ServerStopped path={info?.workspace.path ?? ""} />;
  else if (connection === "expired") body = <SessionExpired />;
  else if (!info) body = <p className="spinner-text" role="status">{t("loading")}</p>;
  else if (path === "/overview" && !info.workspace.configured && !policyMode) body = <FirstAccess />;
  else if (found && policyMode && PROJECT_ONLY_SCREENS.has(found.mod.screen.id)) body = <PolicyUnavailable />;
  else if (found) {
    const Screen = found.mod.default;
    body = (
      <Suspense fallback={<p className="spinner-text" role="status">{t("loading")}</p>}>
        <Screen key={path} params={found.params} />
      </Suspense>
    );
  } else body = <AreaUnavailable area={areaOfPath(path)} />;

  const active = info?.runs.active ?? null;
  const showRunBanner = connection === "ok" && active !== null && !path.startsWith(`/runs/${active.id}`);

  return (
    <div className="shell" data-drawer={drawerOpen ? "open" : "closed"}>
      <a className="skip" href="#content" onClick={skip}>
        {t("app_skip")}
      </a>
      <Sidebar ref={sidebar} path={path} open={drawerOpen} onClose={closeDrawer} />
      {drawerOpen ? <div className="scrim" onClick={closeDrawer} aria-hidden="true" /> : null}
      <div className="app" {...(drawerOpen ? { inert: true } : {})}>
        <Topbar path={path} menuOpen={drawerOpen} onMenu={() => setDrawer(true)} />
        <main id="content" ref={main} className="main" tabIndex={-1}>
          {showRunBanner && active ? <ActiveRunBanner runId={active.id} /> : null}
          {body}
        </main>
        <footer className="page-footer">
          <span>{t("footer_local")}</span>
          <span className="mono">{info?.workspace.path ?? ""}</span>
        </footer>
      </div>
    </div>
  );
}
