import { useState } from "react";
import { api } from "../../api";
import { Dialog, ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { t } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { WorkspaceTabs } from "../workspace/tabs";

export const screen: ScreenMeta = { id: "environment", path: "/environment", area: "workspace", navLabel: "nav_environment", navPath: "/environment", order: 30, icon: "tools" };

const TONE: Record<string, "green" | "gold" | "red" | "blue"> = { ready: "green", absent: "red", incompatible: "red", not_checked: "gold" };

function StatePill({ state }: { state: string }) {
  return <Pill tone={TONE[state] ?? "blue"}>{t(`env_state_${state}`)}</Pill>;
}

/** The versions and the network of a preparation, shown before anything runs; "Baixar e fixar" is the explicit yes. */
function PrepareDialog({ instance, onClose, onDone }: { instance: string; onClose: () => void; onDone: () => void }) {
  const preview = useAsync(() => api("POST", "/api/environment/prepare", { instance, dryRun: true }), `preview:${instance}`);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<any>(null);

  const execute = async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await api("POST", "/api/environment/prepare", { instance, dryRun: false });
      setDone(result.result);
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setRunning(false);
    }
  };

  const p = (preview.data as any)?.preview;
  return (
    <Dialog title={t("env_prepare_title", { tool: instance })} onClose={onClose}>
      {preview.loading ? <Loading /> : null}
      {preview.error ? <ErrorNotice error={preview.error} /> : null}
      {p ? (
        <div className="stack">
          <dl className="facts">
            <dt>{t("env_prepare_versions")}</dt>
            <dd data-testid="prepare-versions">
              {t("env_prepare_versions_value", { tool: p.versions.tool, installed: p.versions.installed ?? "-", range: p.versions.range, pinned: p.versions.pinned ?? "-" })}
            </dd>
            <dt>{t("env_prepare_network")}</dt>
            <dd data-testid="prepare-network">
              {p.rules
                ? t("env_prepare_network_value", { ref: p.rules.ref, url: p.rules.url })
                : t(p.network.required ? "env_prepare_image_pull" : "env_prepare_image_local", { image: p.image?.reference ?? "-", hosts: (p.network.hosts as string[]).join(", ") })}
            </dd>
            <dt>{t("env_prepare_writes")}</dt>
            <dd>
              {(p.writes as string[]).map((w) => (
                <code key={w}>{w} </code>
              ))}
            </dd>
          </dl>
          <p className="small">{t(p.image ? "env_prepare_image_note" : "env_prepare_note")}</p>
        </div>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
      {done ? (
        <div className="notice ok" role="status">
          <Icon name="check" />
          <span data-testid="prepare-done">
            {done.image
              ? t("env_prepare_image_done", { image: done.image.reference, pinned: String(done.image.pinned).slice(0, 80) })
              : t("env_prepare_done", { ref: done.rules.ref, hash: done.rules.hash.slice(0, 12) })}
          </span>
        </div>
      ) : null}
      <div className="row">
        <button type="button" className="btn primary" disabled={!p || running || done !== null} onClick={execute}>
          <Icon name="refresh" />
          {running ? t("env_prepare_running") : t("env_prepare_confirm")}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          {t("close")}
        </button>
      </div>
    </Dialog>
  );
}

export default function EnvironmentScreen() {
  const env = useAsync(() => api("GET", "/api/environment"), "environment");
  const [preparing, setPreparing] = useState<string | null>(null);
  if (env.loading && !env.data) return <Loading />;
  if (env.error) return <ErrorNotice error={env.error} onRetry={env.reload} />;
  const d = env.data as any;
  const runtimes: any[] = d.runtimes ?? [];
  const tools: any[] = d.tools ?? [];

  return (
    <div className="stack">
      <WorkspaceTabs selected="environment" />
      <div className="between">
        <div>
          <h1>{t("env_title")}</h1>
          <p>{t("env_lead")}</p>
        </div>
        <button type="button" className="btn" onClick={env.reload}>
          <Icon name="refresh" />
          {t("env_recheck")}
        </button>
      </div>

      <div className={`notice ${d.environmentReady ? "ok" : "warn"}`} role="status" data-testid="env-summary">
        <Icon name={d.environmentReady ? "check" : "alert"} />
        <div>
          <strong>{d.environmentReady ? t("env_ready") : t("env_not_ready", { absent: d.summary.absent, incompatible: d.summary.incompatible })}</strong>
          <p className="small">{t("env_three_states")}</p>
        </div>
      </div>

      <section className="stack" aria-labelledby="env-runtimes">
        <h2 id="env-runtimes">{t("env_runtimes")}</h2>
        <div className="card flat table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{t("env_col_name")}</th>
                <th scope="col">{t("env_col_state")}</th>
                <th scope="col">{t("env_col_version")}</th>
                <th scope="col">{t("env_col_detail")}</th>
              </tr>
            </thead>
            <tbody>
              {runtimes.map((r) => (
                <tr key={r.id} data-runtime={r.id}>
                  <th scope="row">
                    {r.id}
                    {r.optional ? <span className="muted"> ({t("env_optional")})</span> : null}
                  </th>
                  <td>
                    <StatePill state={r.state} />
                  </td>
                  <td>{r.version ?? "-"}</td>
                  <td>
                    {r.state === "ready" ? <code>{r.path}</code> : r.message}
                    {r.fix ? <div className="small">{t("env_fix", { fix: r.fix })}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack" aria-labelledby="env-tools">
        <h2 id="env-tools">{t("env_tools")}</h2>
        {tools.length === 0 ? (
          <p>{t("env_no_tools")}</p>
        ) : (
          <div className="card flat table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t("env_col_tool")}</th>
                  <th scope="col">{t("env_col_state")}</th>
                  <th scope="col">{t("env_col_version")}</th>
                  <th scope="col">{t("env_col_range")}</th>
                  <th scope="col">{t("env_col_detail")}</th>
                  <th scope="col">{t("env_col_action")}</th>
                </tr>
              </thead>
              <tbody>
                {tools.map((x) => (
                  <tr key={x.instance} data-tool={x.instance}>
                    <th scope="row">
                      {x.instance}
                      <div className="small muted">{x.adapter}</div>
                    </th>
                    <td>
                      <StatePill state={x.state} />
                    </td>
                    <td>{x.version ?? "-"}</td>
                    <td>
                      <code>{x.range}</code>
                    </td>
                    <td>
                      {x.state === "ready" ? null : <div>{x.message}</div>}
                      {x.fix ? <div className="small">{t("env_fix", { fix: x.fix })}</div> : null}
                      {x.lock.message ? <div className="small">{x.lock.message}</div> : null}
                      {x.preparation.supported ? (
                        <div className="small">
                          {t("env_preparation", { state: t(`env_prepared_${x.preparation.state}`), hash: x.preparation.hash ? x.preparation.hash.slice(0, 12) : "-" })}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {x.preparation.supported ? (
                        <button type="button" className="btn" onClick={() => setPreparing(x.instance)} aria-label={t("env_prepare_aria", { tool: x.instance })}>
                          {t("env_prepare")}
                        </button>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="small">
        {t("env_lock", { file: d.lock.file, state: !d.lock.exists ? t("env_lock_missing") : d.lock.valid ? t("env_lock_ok") : t("env_lock_invalid", { problem: d.lock.problem ?? "" }) })}
      </p>

      {preparing ? <PrepareDialog instance={preparing} onClose={() => setPreparing(null)} onDone={env.reload} /> : null}
    </div>
  );
}
