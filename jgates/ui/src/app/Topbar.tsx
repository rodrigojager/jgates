import { useState } from "react";
import { Dialog } from "../components/common";
import { Icon } from "../components/icons";
import { LockedField } from "../components/LockedField";
import { useToast } from "../components/Toast";
import { t } from "../i18n";
import { screens } from "../registry";
import { THEME_CHOICES, useTheme, type ThemePreference } from "../theme/ThemeProvider";
import { areaById, areaOfPath } from "./areas";
import { resolveScreen } from "./route";
import { PolicyBand } from "../screens/policy/PolicyBand";
import { useShell } from "./shell-context";

function Breadcrumb({ path }: { path: string }) {
  const { info } = useShell();
  const mod = resolveScreen(path)?.mod;
  const area = areaById(mod?.screen.area) ?? areaOfPath(path);
  const page = mod?.screen.navLabel ? t(mod.screen.navLabel) : area ? t(area.label) : "";
  return (
    <nav className="breadcrumb" aria-label={t("crumb_label")}>
      <Icon name="folder" />
      <span>{info?.workspace.name ?? ""}</span>
      <span className="slash" aria-hidden="true">
        /
      </span>
      <span aria-current="page">{page}</span>
    </nav>
  );
}

function GitInfo() {
  const { info } = useShell();
  const git = info?.git;
  if (!info) return null;
  if (!git) return <span className="branch muted">{t("topbar_no_git")}</span>;
  const branch = git.branch ?? t("topbar_detached");
  const short = git.commit ? git.commit.slice(0, 7) : null;
  return (
    <span className="branch" data-testid="git-info">
      <Icon name="branch" label={t("topbar_branch_icon")} />
      <span data-testid="git-branch">{branch}</span>
      {short ? (
        <code data-testid="git-commit" title={git.commit ?? undefined}>
          {short}
        </code>
      ) : (
        <span className="muted small">{t("topbar_no_commit")}</span>
      )}
      {git.dirty === true ? (
        <span className="pill gold" data-testid="git-dirty" title={t("topbar_dirty_hint")}>
          {t("topbar_dirty")}
        </span>
      ) : null}
    </span>
  );
}

/** Claro, Escuro or Sistema; the choice is saved in the user's data folder, never in the project. */
function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  const toast = useToast();
  const label: Record<ThemePreference, string> = { light: t("theme_light"), dark: t("theme_dark"), system: t("theme_system") };
  return (
    <label className="theme-switch">
      <span className="sr-only">{t("theme_label")}</span>
      <select
        aria-label={t("theme_label")}
        value={theme}
        onChange={(event) => {
          const next = event.target.value as ThemePreference;
          setTheme(next).then(
            () => toast(t("theme_saved", { theme: label[next] }), "ok"),
            () => toast(t("theme_failed"), "error"),
          );
        }}
      >
        {THEME_CHOICES.map((choice) => (
          <option key={choice} value={choice}>
            {label[choice]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The badge of the governed mode and the dialog that lists what it locks, with the reason. */
function GovernedBadge() {
  const { info } = useShell();
  const [open, setOpen] = useState(false);
  if (info?.mode !== "governed") return null;
  const policy = info.governed;
  return (
    <>
      <button type="button" className="pill blue badge-button" data-testid="governed-badge" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Icon name="lock" />
        {t("mode_governed")}
      </button>
      {open ? (
        <Dialog title={t("governed_title")} onClose={() => setOpen(false)}>
          <p>{t("governed_lead")}</p>
          <LockedField label={t("governed_policy_label")} value={policy?.policy ?? ""} reason={t("governed_policy_reason")} mono />
          <LockedField label={t("governed_sha_label")} value={policy?.shaPinned ? t("governed_sha_pinned") : t("governed_sha_missing")} reason={t("governed_sha_reason")} />
          <LockedField label={t("governed_waivers_label")} value={t("governed_waivers_value")} reason={t("governed_waivers_reason")} />
        </Dialog>
      ) : null}
    </>
  );
}

export function Topbar({ path, menuOpen, onMenu }: { path: string; menuOpen: boolean; onMenu: () => void }) {
  const about = screens.find((s) => s.screen.id === "about");
  return (
    <header className="topbar">
      <PolicyBand />
      <div className="row grow">
        <button type="button" className="icon-btn mobile-toggle" aria-label={t("drawer_open")} aria-expanded={menuOpen} aria-controls="sidebar" onClick={onMenu}>
          <Icon name="menu" />
        </button>
        <Breadcrumb path={path} />
      </div>
      <div className="top-actions">
        <GovernedBadge />
        <GitInfo />
        <ThemeSwitch />
        {about ? (
          <a className="btn" href={`#${about.screen.path}`}>
            <Icon name="info" />
            {t("topbar_about")}
          </a>
        ) : null}
      </div>
    </header>
  );
}
