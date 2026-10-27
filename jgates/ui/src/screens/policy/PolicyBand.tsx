import { Icon } from "../../components/icons";
import { t } from "../../i18n";
import { useShell } from "../../app/shell-context";
import "./policy.css";

/** The fixed band at the top of every screen (inside the sticky top bar) while the interface edits the CI policy. */
export function PolicyBand() {
  const { info } = useShell();
  if (!info?.policyMode) return null;
  return (
    <div className="policy-band" role="note" data-testid="policy-band">
      <Icon name="lock" />
      <strong>{t("pol_band_title")}</strong>
      <span>{t("pol_band_text", { name: info.workspace.name })}</span>
    </div>
  );
}

/** What a project-validation screen shows in policy mode: it is unavailable, and why. */
export function PolicyUnavailable() {
  return (
    <section className="state" role="status" aria-labelledby="pol-unavailable-title" data-state="policy-unavailable" data-testid="policy-unavailable">
      <Icon name="lock" />
      <div className="stack grow">
        <h1 id="pol-unavailable-title">{t("pol_unavailable_title")}</h1>
        <p>{t("pol_unavailable_lead")}</p>
        <p>
          <a href="#/policy">{t("pol_unavailable_back")}</a>
        </p>
      </div>
    </section>
  );
}
