// What will not run, as a list of items (PLAN-guided-flows.md section 4): one item per check, in groups by the kind of
// reason (needs a preparation, needs configuration, does not apply to this project, turned off). Each item has the tool
// in bold, the check it would do, the reason in one sentence, a suggestion when there is one and the buttons the plan
// typed for it. A check that cannot apply to the project has plain information and no button. The preparations the run
// still needs are a block of their own, one button per pending item (PendingPreparations).
import { useEffect, useState } from "react";
import { ErrorNotice, Pill, Spinner } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { adapterName, t, tOr } from "../../i18n";
import { JobButton, PullProgress, useSectionJob } from "../environment/sections";
import { PrepareAction, activateTemplate, enableInProfile, type StateContext } from "./capability-states";
import "./capability-states.css";

export interface ReviewAction {
  type: string;
  label: string;
  route?: string;
  field?: string | null;
  fields?: string[];
  tools?: string[];
  adapter?: string | null;
  template?: string | null;
  files?: string[];
  selectors?: string[];
  url?: string;
}

export interface NotRunningItem {
  id: string;
  selector: string;
  check: string;
  tools: Array<{ id: string; name: string }>;
  category: string | null;
  kind: string;
  reasonCode: string;
  reason: string;
  suggestion: string | null;
  actions: ReviewAction[];
}

export interface NotRunningGroup {
  kind: string;
  count: number;
  items: NotRunningItem[];
}

export interface PendingPreparation {
  id: "tools" | "data" | "dependencies";
  label: string;
  detail: string;
  network: "none" | "bridge";
  affects: string[];
  action: ReviewAction;
}

/** The names of the tools of an item in the language of the screen ("Ruff, mypy"). */
export const toolNames = (item: NotRunningItem): string => item.tools.map((tool) => adapterName(tool.id, tool.name)).join(", ");

/** Where "Configurar" leads: the options of the tool with the field focused, or the form that adds the check. */
export function configureHref(action: ReviewAction): string {
  const focus = (action.fields ?? []).length > 0 ? `focus=${encodeURIComponent((action.fields ?? []).join(","))}` : "";
  const tools = action.tools ?? [];
  if (tools.length > 0) return `#/tools/${encodeURIComponent(tools[0] as string)}${focus ? `?${focus}` : ""}`;
  return `#/tools?add=${encodeURIComponent(String(action.adapter ?? ""))}${focus ? `&${focus}` : ""}`;
}

/** One button that starts an environment job and follows it, with its progress; `onDone` reads the plan again. */
function JobAction({ kind, label, running, onDone, name }: { kind: "pull" | "data" | "dependencies"; label: string; running: string; onDone: () => void; name?: string }) {
  const job = useSectionJob(kind, onDone);
  const busy = job.state === "starting" || job.state === "running";
  return (
    <div className="stack tight" data-testid="job-action" data-job={kind} data-state={job.state}>
      <div className="row wrap">
        <JobButton job={job} label={label} running={running} primary={false} />
      </div>
      {busy && kind === "pull" ? <PullProgress events={job.events} /> : null}
      {job.state === "failed" ? (
        <p className="small" role="alert">
          {t("gtn_job_failed", { name: name ?? label })}
        </p>
      ) : null}
    </div>
  );
}

function ActivateTemplate({ action, item, ctx }: { action: ReviewAction; item: NotRunningItem; ctx: StateContext }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const text = t("gtn_activate_template");
  return (
    <>
      <button
        type="button"
        className="btn capst-btn"
        aria-label={`${text}: ${item.check}`}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          activateTemplate(String(action.template)).then(
            (label) => {
              toast(t("capst_template_added", { template: label }), "ok");
              ctx.onChanged();
            },
            (e) => setError(e),
          ).finally(() => setBusy(false));
        }}
      >
        {busy ? <Spinner /> : null}
        {text}
      </button>
      {error ? <ErrorNotice error={error} /> : null}
    </>
  );
}

function EnableAction({ action, item, ctx }: { action: ReviewAction; item: NotRunningItem; ctx: StateContext }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!ctx.profile) {
    return (
      <a className="small" href="#/config">
        {t("capst_need_project_profile")}
      </a>
    );
  }
  return (
    <>
      <button
        type="button"
        className="btn capst-btn"
        aria-label={`${action.label}: ${item.check}`}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          enableInProfile(ctx.profile as string, (action.selectors ?? []).map((selector) => ({ selector, enabled: true }))).then(
            () => {
              toast(t("capst_enabled_checks", { profile: ctx.profile as string }), "ok");
              ctx.onChanged();
            },
            (e) => setError(e),
          ).finally(() => setBusy(false));
        }}
      >
        {busy ? <Spinner /> : null}
        {action.label}
      </button>
      {error ? <ErrorNotice error={error} /> : null}
    </>
  );
}

/** The control of one typed action; every type has one that works. */
export function ActionControl({ action, item, ctx }: { action: ReviewAction; item: NotRunningItem; ctx: StateContext }) {
  const named = { "aria-label": `${action.label}: ${item.check}` };
  switch (action.type) {
    case "prepare-tools":
      return <JobAction kind="pull" label={action.label} running={t("vrev_tools_downloading")} onDone={ctx.onChanged} />;
    case "prepare-data":
      return <JobAction kind="data" label={action.label} running={t("gtn_data_running")} onDone={ctx.onChanged} />;
    case "prepare-dependencies":
      return <JobAction kind="dependencies" label={action.label} running={t("gtn_dependencies_running")} onDone={ctx.onChanged} />;
    case "prepare-tool":
      return <PrepareAction label={item.check} tools={action.tools ?? []} toolName={toolNames(item) || (action.tools ?? []).join(", ")} docs={null} ctx={ctx} />;
    case "prepare-codeql":
    case "start-services":
    case "add-tool":
      return (
        <a className="btn capst-btn" href={`#/${action.route ?? "environment"}`} data-action-type={action.type} {...named}>
          <Icon name="tools" />
          {action.label}
        </a>
      );
    case "configure":
      if (action.template) return <ActivateTemplate action={action} item={item} ctx={ctx} />;
      return (
        <a className="btn capst-btn" href={configureHref(action)} data-action-type="configure" {...named}>
          <Icon name="tools" />
          {action.label}
        </a>
      );
    case "enable":
      return <EnableAction action={action} item={item} ctx={ctx} />;
    case "include-in-run":
      return ctx.onIncludeRun ? (
        <button type="button" className="btn capst-btn" {...named} onClick={() => ctx.onIncludeRun?.(action.selectors ?? [])}>
          {action.label}
        </button>
      ) : null;
    case "learn-more":
      return (
        <a className="small" href={action.url} target="_blank" rel="noopener noreferrer" {...named}>
          {action.label}
        </a>
      );
    default:
      return null;
  }
}

function ItemRow({ item, ctx }: { item: NotRunningItem; ctx: StateContext }) {
  const tools = toolNames(item);
  return (
    <li className={`capst-row capst-${item.kind}`} data-testid="not-running-item" data-selector={item.selector} data-kind={item.kind} data-reason={item.reasonCode} data-category={item.category ?? undefined}>
      <div className="capst-main">
        <strong className="capst-name" data-testid="not-running-tool">
          {tools || item.check}
        </strong>
        {tools ? <span className="small muted">{item.check}</span> : <span className="small muted">{t("gtn_no_tool")}</span>}
        {item.category ? <Pill>{tOr(`vrev_cat_${item.category}`, item.category)}</Pill> : null}
      </div>
      <p className="small capst-sub" data-testid="not-running-reason">
        {item.reason}
      </p>
      {item.suggestion ? (
        <p className="small muted capst-sub" data-testid="not-running-suggestion">
          {item.suggestion}
        </p>
      ) : null}
      {item.actions.length > 0 ? (
        <div className="capst-action" data-testid="not-running-actions">
          {item.actions.map((action, i) => (
            <ActionControl key={`${action.type}-${i}`} action={action} item={item} ctx={ctx} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

/** The list of what will not run, grouped by the kind of reason. */
export function NotRunningList({ groups, total, ctx, headingId, level = 2 }: { groups: NotRunningGroup[]; total: number; ctx: StateContext; headingId: string; level?: 2 | 3 }) {
  const Heading = level === 2 ? "h2" : "h3";
  const Sub = level === 2 ? "h3" : "h4";
  return (
    <section className="card flat stack capst" aria-labelledby={headingId} data-testid="not-running" data-total={total}>
      <div>
        <Heading id={headingId}>{t("gtn_title", { count: total })}</Heading>
        <p className="muted small">{t("gtn_lead")}</p>
      </div>
      {total === 0 ? <p className="muted">{t("gtn_none")}</p> : null}
      {groups.map((group) => (
        <div key={group.kind} className="stack tight" data-testid="not-running-group" data-kind={group.kind}>
          <Sub>{t("gtn_group_title", { kind: t(`gtn_kind_${group.kind.replace(/-/g, "_")}`), count: group.count })}</Sub>
          <p className="small muted">{t(`gtn_kind_${group.kind.replace(/-/g, "_")}_lead`)}</p>
          <ul className="capst-list" aria-label={t(`gtn_kind_${group.kind.replace(/-/g, "_")}`)}>
            {group.items.map((item) => (
              <ItemRow key={item.id} item={item} ctx={ctx} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** "Preparação": one button per pending item, with what it does, the checks that wait for it and the network it uses. */
export function PendingPreparations({ items, onChanged, onBusy }: { items: PendingPreparation[]; onChanged: () => void; onBusy?: (ids: string[]) => void }) {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  useEffect(() => {
    onBusy?.(Object.entries(busy).filter(([, b]) => b).map(([id]) => id));
  }, [busy, onBusy]);
  if (items.length === 0) return null;
  return (
    <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: 8 }} data-testid="pending-preparations" aria-label={t("gtn_pending_label")}>
      {items.map((item) => (
        <li key={item.id} className="capst-row" data-pending={item.id} data-network={item.network}>
          <div className="capst-main">
            <strong className="capst-name">{item.label}</strong>
            <Pill tone={item.network === "bridge" ? "gold" : "green"}>
              <Icon name={item.network === "bridge" ? "link" : "check"} />
              {t(item.network === "bridge" ? "gtn_network_bridge" : "gtn_network_none")}
            </Pill>
          </div>
          <p className="small capst-sub">{item.detail}</p>
          {item.affects.length > 0 ? <p className="small muted capst-sub">{t("gtn_affects", { checks: item.affects.join(", ") })}</p> : null}
          <div className="capst-action">
            <PendingButton item={item} onChanged={onChanged} onBusy={(b) => setBusy((cur) => (cur[item.id] === b ? cur : { ...cur, [item.id]: b }))} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function PendingButton({ item, onChanged, onBusy }: { item: PendingPreparation; onChanged: () => void; onBusy: (busy: boolean) => void }) {
  const kind = item.id === "tools" ? "pull" : item.id;
  const job = useSectionJob(kind, onChanged);
  const running = job.state === "starting" || job.state === "running";
  useEffect(() => {
    onBusy(running);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);
  const text = item.id === "tools" ? t("vrev_tools_downloading") : item.id === "data" ? t("gtn_data_running") : t("gtn_dependencies_running");
  return (
    <div className="stack tight grow" data-testid="job-action" data-job={kind} data-state={job.state}>
      <div className="row wrap">
        <JobButton job={job} label={item.action.label} running={text} primary={false} />
      </div>
      {running && item.id === "tools" ? <PullProgress events={job.events} /> : null}
      {job.state === "failed" ? (
        <p className="small" role="alert">
          {t("gtn_job_failed", { name: item.label })}
        </p>
      ) : null}
    </div>
  );
}
