import { useState } from "react";
import { api } from "../../api";
import { Pill, ErrorNotice, Loading, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { t } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { useShell } from "../../app/shell-context";
import { CopyButton } from "./CopyButton";
import "./policy.css";

export const screen: ScreenMeta = { id: "policy", path: "/policy", area: "config", navLabel: "pol_nav", navPath: "/policy", order: 45, icon: "lock" };

interface PolicyFile {
  path: string;
  sha256: string;
  size: number;
}

interface PolicyState {
  editing: boolean;
  mode?: "local" | "governed";
  governed?: { policy: string; shaPinned: boolean } | null;
  name?: string;
  path?: string;
  problem?: { code: string; message: string; fix: string | null };
  sha256?: string;
  count?: number;
  files?: PolicyFile[];
  variables?: Array<{ name: string; value: string | null }>;
  command?: string;
  snippets?: { github: string; gitlab: string };
}

interface PlanSummary {
  project: string;
  planHash: string;
  status: "OK" | "BLOCKED";
  profile: { id: string; label: string | null } | null;
  approvable: boolean;
  blockers: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
  components: Array<{ id: string; root: string; language: string | null; framework: string | null; status: string }>;
  willRun: Array<{ id: string; label: string; category: string | null; tool: string }>;
  willRunCount: number;
  offCount: number;
  uncoveredCount: number;
  configFiles: string[];
}

function Snippet({ id, title, text }: { id: string; title: string; text: string }) {
  return (
    <section className="stack" aria-labelledby={`pol-snippet-${id}`}>
      <div className="row between wrap">
        <h3 id={`pol-snippet-${id}`}>{title}</h3>
        <CopyButton text={text} label={t("pol_copy_snippet", { title })} testid={`pol-copy-${id}`} />
      </div>
      <pre className="policy-snippet" data-testid={`pol-snippet-${id}`}>
        {text}
      </pre>
    </section>
  );
}

function TestAgainstProject() {
  const { info } = useShell();
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const others = (info?.workspaces ?? []).filter((w) => !w.current && w.exists);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setPlan(await api<PlanSummary>("POST", "/api/policy/test", { project: project.trim() }));
    } catch (e) {
      setPlan(null);
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card flat stack" aria-labelledby="pol-test">
      <h2 id="pol-test">{t("pol_test_title")}</h2>
      <p>{t("pol_test_lead")}</p>
      <form
        className="policy-test-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (project.trim() !== "") void run();
        }}
      >
        <label htmlFor="pol-project">{t("pol_test_label")}</label>
        <input id="pol-project" type="text" value={project} list="pol-projects" autoComplete="off" spellCheck={false} placeholder={t("pol_test_placeholder")} onChange={(event) => setProject(event.target.value)} />
        <datalist id="pol-projects">
          {others.map((w) => (
            <option key={w.id} value={w.path} label={w.name} />
          ))}
        </datalist>
        <div>
          <button type="submit" className="btn primary" disabled={busy || project.trim() === ""} data-testid="pol-test-run">
            <Icon name="plan" />
            {busy ? t("pol_test_running") : t("pol_test_run")}
          </button>
        </div>
      </form>
      {error ? <ErrorNotice error={error} /> : null}
      {plan ? (
        <div className="policy-plan stack" role="status" data-testid="pol-test-result">
          <div className="row wrap">
            <Pill tone={plan.status === "OK" ? "green" : "gold"}>{plan.status === "OK" ? t("pol_test_ok") : t("pol_test_blocked")}</Pill>
            <span className="small muted">{t("pol_test_readonly")}</span>
          </div>
          <dl className="kv">
            <dt>{t("pol_test_project")}</dt>
            <dd>
              <code>{plan.project}</code>
            </dd>
            <dt>{t("pol_test_profile")}</dt>
            <dd data-testid="pol-test-profile">{plan.profile ? (plan.profile.label ?? plan.profile.id) : t("pol_test_no_profile")}</dd>
            <dt>{t("pol_test_checks")}</dt>
            <dd data-testid="pol-test-count">{t("pol_test_counts", { run: plan.willRunCount, off: plan.offCount, uncovered: plan.uncoveredCount })}</dd>
            <dt>{t("pol_test_hash")}</dt>
            <dd>
              <code>{plan.planHash}</code>
            </dd>
          </dl>
          {plan.blockers.length > 0 ? (
            <div>
              <strong>{t("pol_test_blockers")}</strong>
              <ul>
                {plan.blockers.map((b) => (
                  <li key={`${b.code}-${b.message}`}>
                    <code>{b.code}</code> {b.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div>
            <strong>{t("pol_test_will_run")}</strong>
            {plan.willRun.length === 0 ? (
              <p className="small muted">{t("pol_test_nothing")}</p>
            ) : (
              <ul data-testid="pol-test-items">
                {plan.willRun.map((item) => (
                  <li key={item.id}>
                    <code>{item.id}</code> {item.label}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <strong>{t("pol_test_config_files")}</strong>
            <ul>
              {plan.configFiles.map((file) => (
                <li key={file}>
                  <code>{file}</code>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function NotEditing({ state }: { state: PolicyState }) {
  const command = "jgates ui --policy <pasta-da-politica>";
  return (
    <div className="stack">
      <div>
        <h1>{t("pol_title")}</h1>
        <p>{t("pol_lead")}</p>
      </div>
      <section className="card flat stack" aria-labelledby="pol-how">
        <h2 id="pol-how">{t("pol_project_title")}</h2>
        {state.mode === "governed" ? (
          <p data-testid="pol-governed-note">
            <Pill tone="gold">{t("pol_project_governed", { policy: state.governed?.policy ?? "" })}</Pill>
          </p>
        ) : (
          <p>{t("pol_project_local")}</p>
        )}
        <p>{t("pol_project_how")}</p>
        <div className="command row">
          <code className="grow">{command}</code>
          <CopyButton text={command} label={t("pol_copy_command")} testid="pol-copy-command" />
        </div>
        <p className="small muted">{t("pol_project_note")}</p>
      </section>
    </div>
  );
}

export default function PolicyScreen() {
  const { data, error, loading, reload } = useAsync(() => api<PolicyState>("GET", "/api/policy"), "policy");
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  if (!data.editing) return <NotEditing state={data} />;

  return (
    <div className="stack">
      <div>
        <h1>{t("pol_title")}</h1>
        <p>{t("pol_lead")}</p>
      </div>

      {data.problem ? (
        <div className="notice error" role="alert" data-testid="pol-problem">
          <Icon name="alert" />
          <div className="grow stack">
            <strong>{t("pol_problem_title")}</strong>
            <p>{data.problem.message}</p>
            {data.problem.fix ? <p className="small">{data.problem.fix}</p> : null}
            <div>
              <button type="button" className="btn" onClick={reload} data-testid="pol-reload-problem">
                <Icon name="refresh" />
                {t("pol_reload")}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <section className="card flat stack" aria-labelledby="pol-hash-title">
            <h2 id="pol-hash-title">{t("pol_hash_title")}</h2>
            <p>{t("pol_hash_lead")}</p>
            <div className="row between wrap">
              <code className="policy-hash" data-testid="pol-hash">
                {data.sha256}
              </code>
              <div className="row wrap">
                <CopyButton text={data.sha256 ?? ""} label={t("pol_copy_hash")} testid="pol-copy-hash" />
                <button type="button" className="btn" onClick={reload} data-testid="pol-reload">
                  <Icon name="refresh" />
                  {t("pol_reload")}
                </button>
              </div>
            </div>
            <p className="small muted">{t("pol_hash_rule")}</p>
          </section>

          <section className="card flat stack" aria-labelledby="pol-files-title">
            <h2 id="pol-files-title">{t("pol_files_title", { count: data.count ?? 0 })}</h2>
            <p className="small">{t("pol_files_lead")}</p>
            <div className="table-wrap">
              <table className="policy-files" data-testid="pol-files">
                <caption className="sr-only">{t("pol_files_caption")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("pol_col_file")}</th>
                    <th scope="col">{t("pol_col_sha")}</th>
                    <th scope="col">{t("pol_col_size")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.files ?? []).map((file) => (
                    <tr key={file.path}>
                      <td>
                        <code>{file.path}</code>
                      </td>
                      <td>
                        <code title={file.sha256}>{file.sha256.slice(0, 12)}</code>
                      </td>
                      <td className="num">{t("pol_bytes", { size: file.size })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card flat stack" aria-labelledby="pol-ci-title">
            <h2 id="pol-ci-title">{t("pol_ci_title")}</h2>
            <p>{t("pol_ci_lead")}</p>
            <dl className="kv" data-testid="pol-variables">
              {(data.variables ?? []).map((variable) => (
                <div key={variable.name} className="kv-row">
                  <dt>
                    <code>{variable.name}</code>
                  </dt>
                  <dd>{variable.value ? <code className="policy-hash">{variable.value}</code> : t("pol_var_dir")}</dd>
                </div>
              ))}
            </dl>
            <p className="small muted">{t("pol_ci_protect")}</p>
            <div className="command row">
              <code className="grow" data-testid="pol-command">
                {data.command}
              </code>
              <CopyButton text={data.command ?? ""} label={t("pol_copy_ci_command")} testid="pol-copy-ci-command" />
            </div>
            <Snippet id="github" title={t("pol_github")} text={data.snippets?.github ?? ""} />
            <Snippet id="gitlab" title={t("pol_gitlab")} text={data.snippets?.gitlab ?? ""} />
            <p className="small muted">{t("pol_ci_platform")}</p>
          </section>
        </>
      )}

      <TestAgainstProject />
    </div>
  );
}
