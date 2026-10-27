import { useState } from "react";
import { api } from "../../api";
import { ErrorNotice } from "../../components/common";
import { LockedField } from "../../components/LockedField";
import { OriginLine, type OriginRef, type SaveTarget } from "../../components/origin";
import { useToast } from "../../components/Toast";
import { t } from "../../i18n";
import { Switch } from "./switch";

export interface PolicyView {
  governed: boolean;
  severity: { value: "critical" | "high" | "medium" | "low"; explicit: boolean; origin: OriginRef | null; saveTo: SaveTarget };
  onMissing: { value: "block" | "warn"; explicit: boolean; origin: OriginRef | null; saveTo: SaveTarget };
  coverage: { denominator: string; scopes: Array<{ scope: string | null; key: string; value: number | null; origin: OriginRef | null; saveTo: SaveTarget }> };
}

const LEVELS = ["critical", "high", "medium", "low"] as const;

function CoverageRow({ scope, onSave, busy, governedReason }: { scope: PolicyView["coverage"]["scopes"][number]; onSave: (scope: string | null, value: number) => void; busy: boolean; governedReason: string | null }) {
  const [value, setValue] = useState(scope.value === null ? "" : String(scope.value));
  const name = scope.scope ?? t("cfgp_coverage_all");
  const number = Number(value);
  const valid = value !== "" && Number.isInteger(number) && number >= 0 && number <= 100;
  if (governedReason) {
    return (
      <div data-scope={scope.scope ?? "all"}>
        <LockedField label={t("cfgp_coverage_for", { scope: name })} value={scope.value === null ? t("cfgp_coverage_none") : `${scope.value}%`} reason={governedReason} />
      </div>
    );
  }
  return (
    <div className="field" data-scope={scope.scope ?? "all"}>
      <div className="row wrap">
        <label htmlFor={`cov-${scope.key}`} className="field-label">
          {t("cfgp_coverage_for", { scope: name })}
        </label>
        <input id={`cov-${scope.key}`} className="input number" type="number" min={0} max={100} step={5} value={value} onChange={(e) => setValue(e.target.value)} />
        <span aria-hidden="true">%</span>
        <button type="button" className="btn" disabled={!valid || busy || (scope.value !== null && number === scope.value)} aria-label={t("cfgp_coverage_save_aria", { scope: name })} onClick={() => onSave(scope.scope, number)}>
          {t("save")}
        </button>
      </div>
      <OriginLine origin={scope.origin} saveTo={scope.saveTo} fallback={t("cfgp_coverage_unset")} />
    </div>
  );
}

/** "Quando bloquear a entrega?": severity limit, minimum coverage (denominator and component) and the missing-check policy. */
export function Policy({ policy, governedPolicy, onChanged }: { policy: PolicyView; governedPolicy: string | null; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const governedReason = policy.governed ? t("cfgp_governed_reason", { policy: governedPolicy ?? "policy" }) : null;

  const save = async (changes: Array<{ control: string; value: string | number; scope?: string }>) => {
    setBusy(true);
    setError(null);
    try {
      await api("PUT", "/api/config/policy", { changes });
      toast(t("cfgp_policy_saved"), "ok");
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card pad stack" aria-labelledby="cfgp-policy-title">
      <div>
        <h2 id="cfgp-policy-title">{t("cfgp_policy_title")}</h2>
        <p className="small muted">{t("cfgp_policy_lead")}</p>
      </div>
      {error ? <ErrorNotice error={error} /> : null}

      {governedReason ? (
        <LockedField label={t("cfgp_severity_label")} value={t(`cfgp_level_${policy.severity.value}`)} reason={governedReason} />
      ) : (
        <div className="field" data-control-unavailable={t("cfgp_not_applied")}>
          <label htmlFor="cfgp-severity" className="field-label">
            {t("cfgp_severity_label")}
          </label>
          <select id="cfgp-severity" className="input" value={policy.severity.value} disabled={busy} onChange={(e) => save([{ control: "severity", value: e.target.value }])}>
            {LEVELS.map((level) => (
              <option key={level} value={level}>
                {t(`cfgp_level_${level}`)}
              </option>
            ))}
          </select>
          <p className="small muted">{t("cfgp_severity_help")}</p>
          <p className="small muted">{t("cfgp_not_applied")}</p>
          <OriginLine origin={policy.severity.origin} saveTo={policy.severity.saveTo} fallback={t("cfgp_default_value")} />
        </div>
      )}

      <div className="stack" role="group" aria-labelledby="cfgp-coverage-title">
        <div>
          <h3 id="cfgp-coverage-title">{t("cfgp_coverage_title")}</h3>
          <p className="small muted" data-testid="coverage-denominator">
            {t("cfgp_coverage_denominator", { denominator: t(`cfgp_denominator_${policy.coverage.denominator}`) })}
          </p>
        </div>
        {policy.coverage.scopes.map((scope) => (
          <CoverageRow key={scope.key} scope={scope} busy={busy} governedReason={governedReason} onSave={(s, value) => save([{ control: "coverage", value, ...(s ? { scope: s } : {}) }])} />
        ))}
      </div>

      {governedReason ? (
        <LockedField label={t("cfgp_missing_label")} value={t("cfgp_missing_block")} reason={t("cfgp_governed_missing", { policy: governedPolicy ?? "policy" })} />
      ) : (
        <div className="field" data-control-unavailable={t("cfgp_not_applied")}>
          <div className="between">
            <label id="cfgp-missing-label" className="field-label">
              {t("cfgp_missing_label")}
            </label>
            <Switch checked={policy.onMissing.value === "block"} label={t("cfgp_missing_label")} disabled={busy} onChange={(next) => save([{ control: "onMissing", value: next ? "block" : "warn" }])} />
          </div>
          <p className="small muted">{policy.onMissing.value === "block" ? t("cfgp_missing_block_help") : t("cfgp_missing_warn_help")}</p>
          <p className="small muted">{t("cfgp_not_applied")}</p>
          <OriginLine origin={policy.onMissing.origin} saveTo={policy.onMissing.saveTo} fallback={t("cfgp_default_value")} />
        </div>
      )}
    </section>
  );
}
