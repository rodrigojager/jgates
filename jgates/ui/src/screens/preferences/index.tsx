import { api } from "../../api";
import { ErrorNotice, Loading, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t } from "../../i18n";
import { getLocale, LOCALES, rememberLocale, type Locale } from "../../i18n/locale";
import type { ScreenMeta } from "../../registry";
import { THEME_CHOICES, useTheme, type ThemePreference } from "../../theme/ThemeProvider";
import "./preferences.css";

export const screen: ScreenMeta = { id: "preferences", path: "/preferences", area: "preferences", order: 90, icon: "settings" };

/** Personal preferences only (theme and language): they live in the user's data folder, never in the project. */
export default function PreferencesScreen() {
  const { theme, setTheme } = useTheme();
  const toast = useToast();
  const prefs = useAsync(() => api<{ language: string }>("GET", "/api/preferences"), "preferences");
  // The number of checks that run at the same time: a setting of the run (Configuration > Execution), explained here.
  const concurrency = useAsync(() => api<{ value: number; source: "configuration" | "automatic"; automatic: number; max: number; step: { memoryMb: number; cpus: number } }>("GET", "/api/execution/concurrency").catch(() => null), "prefs-concurrency");

  if (prefs.loading && !prefs.data) return <Loading />;
  if (prefs.error) return <ErrorNotice error={prefs.error} onRetry={prefs.reload} />;

  const choose = (next: ThemePreference) =>
    setTheme(next).then(
      () => toast(t("theme_saved", { theme: t(`theme_${next}`) }), "ok"),
      () => toast(t("theme_failed"), "error"),
    );

  const saveLanguage = (language: string) =>
    api("PUT", "/api/preferences", { language }).then(
      () => {
        // Both catalogs are bundled: remembering the choice and reloading re-renders every screen in the new language.
        rememberLocale(language as Locale);
        window.location.reload();
      },
      () => toast(t("prefs_language_failed"), "error"),
    );

  return (
    <div className="stack">
      <div>
        <h1>{t("prefs_title")}</h1>
        <p>{t("prefs_lead")}</p>
      </div>

      <section className="card flat stack" aria-labelledby="prefs-theme">
        <h2 id="prefs-theme">{t("theme_label")}</h2>
        <div className="prefs-choices" role="radiogroup" aria-labelledby="prefs-theme">
          {THEME_CHOICES.map((choice) => (
            <label key={choice} className="prefs-choice">
              <input type="radio" name="theme" value={choice} checked={theme === choice} onChange={() => void choose(choice)} />
              <span>{t(`theme_${choice}`)}</span>
            </label>
          ))}
        </div>
        <p className="small muted">{t("prefs_theme_note")}</p>
      </section>

      <section className="card flat stack" aria-labelledby="prefs-language">
        <h2 id="prefs-language">{t("prefs_language")}</h2>
        <label className="prefs-select">
          <span className="sr-only">{t("prefs_language")}</span>
          <select data-testid="prefs-language" value={prefs.data?.language ?? getLocale()} onChange={(e) => void saveLanguage(e.target.value)}>
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {t(`prefs_language_${l}`)}
              </option>
            ))}
          </select>
        </label>
        <p className="small muted">{t("prefs_language_note")}</p>
      </section>

      <section className="card flat stack" aria-labelledby="prefs-providers">
        <h2 id="prefs-providers">{t("prefs_providers")}</h2>
        <p>{t("prefs_providers_note")}</p>
        <div>
          <a className="btn" href="#/semantic/providers" data-testid="prefs-providers-link">
            <Icon name="lock" />
            {t("prefs_providers_link")}
          </a>
        </div>
      </section>

      <section className="card flat stack" aria-labelledby="prefs-concurrency" data-testid="prefs-concurrency">
        <h2 id="prefs-concurrency">{t("prefs_concurrency")}</h2>
        <p>{t("prefs_concurrency_what")}</p>
        {concurrency.data ? (
          <p data-testid="prefs-concurrency-value" data-value={concurrency.data.value} data-source={concurrency.data.source}>
            {concurrency.data.source === "configuration"
              ? t("prefs_concurrency_configured", { value: concurrency.data.value, automatic: concurrency.data.automatic })
              : t("prefs_concurrency_automatic", { value: concurrency.data.value })}
          </p>
        ) : null}
        <p className="small muted">{t("prefs_concurrency_how", { memory: concurrency.data?.step.memoryMb ?? 4096, cpus: concurrency.data?.step.cpus ?? 2, max: concurrency.data?.max ?? 8 })}</p>
        <p className="small muted">{t("prefs_concurrency_same")}</p>
        <div>
          <a className="btn" href="#/config/execution" data-testid="prefs-concurrency-link">
            <Icon name="settings" />
            {t("prefs_concurrency_link")}
          </a>
        </div>
      </section>

      <section className="card flat stack" aria-labelledby="prefs-more">
        <h2 id="prefs-more">{t("prefs_more")}</h2>
        <p>{t("prefs_network_note")}</p>
        <div>
          <a className="btn" href="#/preferences/storage">
            <Icon name="folder" />
            {t("prefs_storage_link")}
          </a>
        </div>
      </section>
    </div>
  );
}
