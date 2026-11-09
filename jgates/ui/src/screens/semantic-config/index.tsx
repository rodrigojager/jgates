import { useState } from "react";
import { api } from "../../api";
import { ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { t } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { DEFAULT_CHOICES, readChoices, writeChoices, type RunChoices } from "../semantic-setup/choices";
import { providerChoice, useSemanticInfo } from "../semantic-setup/provider-model";
import { ProviderPicker } from "../semantic-setup/provider-step";
import { RunChoicesForm, methodLabel, type SemanticOptions } from "./RunChoicesForm";

export const screen: ScreenMeta = { id: "semantic-config", path: "/semantic/config", area: "semantic", navLabel: "semcfg_nav", navPath: "/semantic/config", order: 51, icon: "sliders" };

/** Configuration of the Semantic gate: the saved settings (read here, edited in the gate card) and the run-only defaults. */
export default function SemanticConfigScreen() {
  const toast = useToast();
  const [choices, setChoices] = useState<RunChoices>(() => readChoices());
  const options = useAsync(() => api<SemanticOptions>("GET", "/api/semantic/options"), "semantic-options");
  const data = options.data;
  const semantic = useSemanticInfo();
  const sem = semantic.data;
  const [picking, setPicking] = useState(false);

  function keep() {
    writeChoices(choices);
    toast(t("semcfg_kept"), "ok");
  }

  return (
    <div className="stack">
      <div className="between wrap">
        <div>
          <h1>{t("semcfg_title")}</h1>
          <p>{t("semcfg_lead")}</p>
        </div>
        <a className="btn primary" href="#/semantic/setup">
          <Icon name="play" />
          {t("semcfg_to_setup")}
        </a>
      </div>
      {options.loading && !data ? <Loading /> : null}
      {options.error ? <ErrorNotice error={options.error} onRetry={options.reload} /> : null}
      {data ? (
        <>
          <section className="card flat stack" aria-labelledby="semcfg-saved" data-testid="semcfg-saved">
            <div className="between wrap">
              <h2 id="semcfg-saved">{t("semcfg_saved_title")}</h2>
              <Pill tone="green">{t("semcfg_saved_badge")}</Pill>
            </div>
            <p className="muted small">{t("semcfg_saved_lead")}</p>
            <dl className="kv">
              <dt>{t("semcfg_state")}</dt>
              <dd>
                <Pill tone={data.settings.state === "configured" ? "green" : data.settings.state === "invalid" ? "red" : "gold"}>{t(`semcfg_state_${data.settings.state}`)}</Pill>
              </dd>
              <dt id="semcfg-provider-label">{t("semcfg_backend")}</dt>
              <dd className="row wrap" data-testid="semcfg-provider">
                <span>{sem ? (sem.provider ? providerChoice(sem) : t("semcfg_provider_none")) : (data.settings.provider ?? t("semcfg_provider_none"))}</span>
                {sem && !picking && sem.form.editable ? (
                  <button type="button" className={`btn${sem.provider ? "" : " primary"}`} aria-describedby="semcfg-provider-label" data-testid="semcfg-provider-change" onClick={() => setPicking(true)}>
                    <Icon name={sem.provider ? "settings" : "play"} />
                    {t(sem.provider ? "semcfg_provider_change" : "semcfg_provider_choose")}
                  </button>
                ) : null}
              </dd>
              <dt>{t("semcfg_limits")}</dt>
              <dd>{data.settings.limits ? t("semcfg_limits_value", { calls: data.settings.limits.maxCalls, seconds: data.settings.limits.timeoutSeconds, chars: data.settings.limits.maxContextChars }) : "-"}</dd>
              <dt>{t("semcfg_cost")}</dt>
              <dd>{data.settings.costPerCall !== null ? String(data.settings.costPerCall) : t("semres_usage_cost_unreported")}</dd>
              <dt>{t("semcfg_modules")}</dt>
              <dd data-testid="semcfg-modules">
                {choices.methods.length > 0 ? choices.methods.map((id) => methodLabel(data.catalog?.find((m) => m.id === id) ?? { id })).join(", ") : "-"}
              </dd>
            </dl>
            {data.settings.problems.length > 0 ? (
              <div className="notice error" role="alert">
                <Icon name="alert" />
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {data.settings.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {picking && sem ? (
              <ProviderPicker
                semantic={sem}
                saveLabel={t("semprov_save")}
                onReload={semantic.reload}
                onCancel={() => setPicking(false)}
                onSaved={(next) => {
                  semantic.replace(next);
                  setPicking(false);
                  options.reload();
                }}
              />
            ) : null}
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }} aria-label={t("semcfg_prerequisites")}>
              {data.prerequisites.map((p) => (
                <li key={p.id} data-prerequisite={p.id} data-ok={p.ok}>
                  {p.ok ? t("semcfg_prereq_ok") : p.required ? t("semcfg_prereq_missing") : t("semcfg_prereq_optional")} · {p.id === "provider" && !p.ok && sem && !sem.provider ? t("semprov_blocker") : p.message}
                  {p.id === "provider" && !p.ok && !picking && sem?.form.editable ? (
                    <>
                      {" "}
                      <button type="button" className="semprov-linkbtn" data-testid="semcfg-prereq-provider" onClick={() => setPicking(true)}>
                        {t("semprov_blocker_action")}
                      </button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
            <div>
              <a href="#/tools">{t("semcfg_edit_saved")}</a>
            </div>
          </section>

          <section className="card flat stack" aria-labelledby="semcfg-run" data-testid="semcfg-run-only">
            <div className="between wrap">
              <h2 id="semcfg-run">{t("semcfg_run_title")}</h2>
              <Pill tone="blue">{t("semcfg_run_badge")}</Pill>
            </div>
            <p className="muted small">{t("semcfg_run_lead")}</p>
            <RunChoicesForm options={data} choices={choices} onChange={setChoices} />
            <div className="row wrap">
              <button type="button" className="btn primary" onClick={keep} disabled={choices.methods.length === 0}>
                <Icon name="check" />
                {t("semcfg_keep")}
              </button>
              <button type="button" className="btn" onClick={() => setChoices(DEFAULT_CHOICES)}>
                <Icon name="refresh" />
                {t("semcfg_reset")}
              </button>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
