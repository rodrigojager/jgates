// "N checks are new since your last validation", naming them: the tools the plan (overview) or the result (result screen)
// holds that the validation before did not run. Nothing is shown when there is none, or nothing to compare with.
import { Icon } from "./icons";
import { t } from "../i18n";

export interface NewCheckView {
  tool: string;
  label: string;
}

export function NewChecks({ checks, where }: { checks: NewCheckView[] | undefined | null; where: "overview" | "result" }) {
  if (!checks || checks.length === 0) return null;
  return (
    <details className="notice" data-testid="new-checks" data-where={where} data-count={checks.length}>
      <summary>
        <Icon name="info" /> <strong>{t(where === "overview" ? "newchecks_title_plan" : "newchecks_title_result", { count: checks.length })}</strong>
      </summary>
      <p className="small muted">{t(where === "overview" ? "newchecks_lead_plan" : "newchecks_lead_result")}</p>
      <ul className="file-sub" aria-label={t("newchecks_list")}>
        {checks.map((c) => (
          <li key={c.tool} data-tool={c.tool}>
            {c.label} {c.label !== c.tool ? <code className="small muted">{c.tool}</code> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
