import { Pill } from "../../../components/common";
import { yamlHref } from "../../../forms/derived/api";
import { Icon } from "../../../components/icons";
import { t, tOr } from "../../../i18n";

// Execution section of the tool area (collapsed): the command the plan runs for the instance, rendered from the
// adapter's own plan(), with the folder, the context, the network and the effects the adapter declares. It is not a tab:
// the tool screen shows it under the tabs, so it does not export `tab` and the tab loader skips this folder.

export interface ExecutionData {
  planned: boolean;
  reason: string | null;
  command: { executable: string; args: string[]; cwd: string; env: Record<string, string>; line: string; container: { runtime: string; image: string; network: string } | null } | null;
  runtime: { name: string; interpreter: string | null; available: boolean } | null;
  toolVersion: string | null;
  availability: { status: string; reason: string | null } | null;
  limits?: { memoryMb: number; cpus: number; timeoutSeconds: number; origin: { memoryMb: "adapter" | "default"; cpus: "adapter" | "default"; timeoutSeconds: "configuration" | "default" } } | null;
  network: boolean;
  effects: Record<string, boolean>;
  context: { granularity: string[]; minimumContext: string[]; componentRoot: string | null };
  output: { format: string; schema: string | null } | null;
  conditions: string[];
  limitations: string[];
}

/** The container contract of the step (defaults of PLAN-architecture): shown as a form, changed in the YAML. */
const DEFAULT_MEMORY_MB = 4096;
const DEFAULT_CPUS = 2;
const DEFAULT_TIMEOUT_MINUTES = 30;

function ContainerLimits({ execution }: { execution: ExecutionData }) {
  const container = execution.command?.container ?? null;
  // The effective values of this instance and where they come from; the defaults only when the server sent none.
  const limits = execution.limits ?? null;
  const memoryMb = limits?.memoryMb ?? DEFAULT_MEMORY_MB;
  const cpus = limits?.cpus ?? DEFAULT_CPUS;
  const timeoutMinutes = limits ? Math.round((limits.timeoutSeconds / 60) * 100) / 100 : DEFAULT_TIMEOUT_MINUTES;
  const networkOn =execution.network || execution.effects.usesNetwork === true;
  return (
    <fieldset className="stack tight" data-testid="execution-limits">
      <legend>{t("exec_limits")}</legend>
      <label className="stack tight">
        <span>{t("exec_limit_image")}</span>
        <select value="image" disabled data-testid="execution-image">
          <option value="image">{container ? container.image || t("exec_limit_image_pinned") : t("exec_limit_image_none")}</option>
        </select>
      </label>
      <label className="stack tight">
        <span>{t("exec_limit_network")}</span>
        <select value={networkOn ? "on" : "none"} disabled data-testid="execution-network">
          <option value="none">{t("exec_network_no")}</option>
          <option value="on">{t("exec_network_yes")}</option>
        </select>
      </label>
      <label className="stack tight">
        <span>{t("exec_limit_memory")}</span>
        <input type="number" value={memoryMb} readOnly disabled data-free-text="identifier" data-testid="execution-memory" />
        <span className="small muted" data-testid="execution-memory-origin">{t(`exec_origin_${limits?.origin.memoryMb ?? "default"}`)}</span>
      </label>
      <label className="stack tight">
        <span>{t("exec_limit_cpus")}</span>
        <input type="number" value={cpus} readOnly disabled data-free-text="identifier" data-testid="execution-cpus" />
        <span className="small muted" data-testid="execution-cpus-origin">{t(`exec_origin_${limits?.origin.cpus ?? "default"}`)}</span>
      </label>
      <label className="stack tight">
        <span>{t("exec_limit_timeout")}</span>
        <input type="number" value={timeoutMinutes} readOnly disabled data-free-text="identifier" data-testid="execution-timeout" />
        <span className="small muted" data-testid="execution-timeout-origin">{t(`exec_origin_${limits?.origin.timeoutSeconds ?? "default"}`)}</span>
      </label>
      <p className="small">
        {t("exec_limits_hint")} <a href={yamlHref("jgates.yml", "execution")}>{t("exec_edit_yaml")}</a>
      </p>
    </fieldset>
  );
}

export function ExecutionPanel({ execution }: { execution: ExecutionData }) {
  const effects = Object.entries(execution.effects).filter(([, on]) => on);
  const env = Object.entries(execution.command?.env ?? {});
  return (
    <details className="card flat" data-testid="execution">
      <summary>
        <Icon name="terminal" /> {t("exec_summary")}
      </summary>
      <div className="stack" style={{ marginTop: "12px" }}>
        <p className="small">{t("exec_lead")}</p>
        {!execution.planned || !execution.command ? (
          <p>{t("exec_not_planned")}</p>
        ) : (
          <dl className="kv">
            <dt>{t("exec_command")}</dt>
            <dd>
              <code className="command" data-testid="execution-command">
                {execution.command.line}
              </code>
            </dd>
            <dt>{t("exec_cwd")}</dt>
            <dd>
              <code data-testid="execution-cwd">{execution.command.cwd}</code>
            </dd>
            <dt>{t("exec_env")}</dt>
            <dd>
              {env.length === 0 ? (
                t("exec_env_none")
              ) : (
                <ul className="stack tight">
                  {env.map(([name, value]) => (
                    <li key={name}>
                      <code>
                        {name}={value}
                      </code>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
            <dt>{t("exec_runtime")}</dt>
            <dd>{execution.command.container ? t("exec_runtime_container", { image: execution.command.container.image || "-" }) : t("exec_runtime_native")}</dd>
          </dl>
        )}
        <ContainerLimits execution={execution} />
        <dl className="kv">
          <dt>{t("exec_context")}</dt>
          <dd>
            {t("exec_context_value", { granularity: execution.context.granularity.join(", ") || "-", minimum: execution.context.minimumContext.join(", ") || "-" })}
            {execution.context.componentRoot ? ` ${t("exec_context_component", { root: execution.context.componentRoot })}` : ""}
          </dd>
          <dt>{t("exec_network")}</dt>
          <dd>{execution.network || execution.effects.usesNetwork ? t("exec_network_yes") : t("exec_network_no")}</dd>
          <dt>{t("exec_effects")}</dt>
          <dd>
            {effects.length === 0 ? (
              t("exec_effects_none")
            ) : (
              <div className="row wrap">
                {effects.map(([name]) => (
                  <Pill key={name} tone={name === "executesProjectCode" || name === "mayChangeCode" ? "gold" : undefined}>
                    {tOr(`exec_effect_${name}`, name)}
                  </Pill>
                ))}
              </div>
            )}
          </dd>
          {execution.output ? (
            <>
              <dt>{t("exec_report")}</dt>
              <dd>{t("exec_report_value", { format: execution.output.format })}</dd>
            </>
          ) : null}
        </dl>
        {execution.conditions.length > 0 ? (
          <div>
            <h4>{t("exec_conditions")}</h4>
            <ul>
              {execution.conditions.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {execution.limitations.length > 0 ? (
          <div>
            <h4>{t("exec_limitations")}</h4>
            <ul>
              {execution.limitations.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}
