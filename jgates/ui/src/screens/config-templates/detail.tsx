import { api } from "../../api";
import { yamlHref } from "../../forms/derived/api";
import { DerivedForm } from "../../forms/derived/DerivedForm";
import { Dialog, ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { showValue } from "../../components/origin";
import { t, tOr } from "../../i18n";
import type { TemplateRow } from "./index";

interface ChainNode {
  ref: string;
  file: string;
  label: string;
  parents: string[];
  sets: Array<{ pointer: string; value: unknown; path: string | null; overrides: boolean }>;
  overrides: Array<{ pointer: string; value: unknown; previous: unknown; previousNode: string }>;
}

interface Detail {
  template: TemplateRow;
  chain: ChainNode[];
  errors: string[];
  /** Index of the template in the templates list of jgates.yml (null: not listed there). */
  entry?: number | null;
  yaml: { text: string; file: string; readOnly: boolean };
}

/** The template modal: how it is applied, what it inherits, what it sets over its parents and the YAML. */
export function TemplateDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useAsync<Detail>(() => api("GET", `/api/config/templates/${encodeURIComponent(id)}`), `template:${id}`);
  const d = detail.data;
  return (
    <Dialog title={d ? d.template.label : id} onClose={onClose} wide>
      {detail.error ? <ErrorNotice error={detail.error} onRetry={detail.reload} /> : null}
      {!d && !detail.error ? <Loading /> : null}
      {d ? (
        <div className="stack" data-testid="template-detail">
          <dl className="kv">
            <dt>{t("cft_d_application")}</dt>
            <dd data-testid="application">{d.template.activation === "always" ? t("cft_d_always") : d.template.activation === "manual" ? t("cft_d_manual") : t("cft_d_detected")}</dd>
            <dt>{t("cft_d_source")}</dt>
            <dd>
              <code>{d.template.source}</code>
            </dd>
            <dt>{t("cft_d_match")}</dt>
            <dd>{d.template.match.languages.length + d.template.match.frameworks.length === 0 ? t("cft_d_no_match") : [...d.template.match.languages, ...d.template.match.frameworks].join(", ")}</dd>
            <dt>{t("cft_d_components")}</dt>
            <dd>{d.template.components.length === 0 ? t("cft_badge_none") : d.template.components.join(", ")}</dd>
            <dt>{t("cft_d_extends")}</dt>
            <dd data-testid="extends">{d.template.extends.length === 0 ? t("cft_d_nothing") : d.template.extends.join(", ")}</dd>
            <dt>{t("cft_d_compat")}</dt>
            <dd>
              {d.template.support ? (
                <>
                  <Pill>{tOr(`cft_support_${d.template.support.level}`, d.template.support.level)}</Pill>
                  <ul>
                    {d.template.support.uncovered.map((u) => (
                      <li key={u} className="small">
                        {u}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                t("cft_d_compat_none")
              )}
            </dd>
          </dl>

          {d.errors.length > 0 ? (
            <div className="notice error" role="alert">
              <ul>
                {d.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Every key of the entry in jgates.yml and of a project template's own file, each with its control and written
              one at a time (the stepper edits the command; what was written by hand is edited here). */}
          {typeof d.entry === "number" ? (
            <details className="card flat stack" data-testid="template-entry">
              <summary>
                <h3>{t("cft_d_entry")}</h3>
              </summary>
              <p className="small muted">{t("cft_d_entry_lead")}</p>
              <DerivedForm source={{ file: "jgates.yml" }} under={["templates", d.entry]} headingLevel={4} onWrite={() => detail.reload()} />
            </details>
          ) : null}
          {!d.yaml.readOnly ? (
            <details className="card flat stack" data-testid="template-keys">
              <summary>
                <h3>{t("cft_d_keys")}</h3>
              </summary>
              <p className="small muted">{t("cft_d_keys_lead", { file: d.yaml.file })}</p>
              <DerivedForm source={{ file: d.yaml.file }} headingLevel={4} onWrite={() => detail.reload()} />
            </details>
          ) : null}
          <section className="stack" aria-labelledby="cft-chain-title">
            <h3 id="cft-chain-title">{t("cft_d_chain")}</h3>
            <p className="small muted">{t("cft_d_chain_lead")}</p>
            <ol className="tpl-chain">
              {d.chain.map((node) => (
                <li key={node.ref} data-node={node.ref}>
                  <strong>{node.label}</strong> <code className="small">{node.file}</code>
                  {node.sets.length === 0 ? <p className="small muted">{t("cft_d_sets_none")}</p> : null}
                  <ul>
                    {node.sets.map((s) => (
                      <li key={s.pointer} className="small">
                        <code>{s.pointer}</code> = <code>{showValue(s.value)}</code>
                        {s.overrides ? <Pill>{t("cft_d_overrides")}</Pill> : null}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </section>

          <section className="stack" aria-labelledby="cft-yaml-title">
            <h3 id="cft-yaml-title">{t("cft_d_yaml")}</h3>
            <p className="small muted">{d.yaml.readOnly ? t("cft_d_yaml_builtin", { file: d.yaml.file }) : t("cft_d_yaml_project", { file: d.yaml.file })}</p>
            <pre className="tpl-yaml" tabIndex={0} aria-label={t("cft_d_yaml_label", { file: d.yaml.file })}>
              {d.yaml.text}
            </pre>
            {!d.yaml.readOnly ? (
              <a className="btn" href={yamlHref(d.yaml.file, "")}>
                {t("cft_d_open_yaml")}
              </a>
            ) : null}
          </section>
        </div>
      ) : null}
    </Dialog>
  );
}
