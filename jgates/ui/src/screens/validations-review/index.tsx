import { useMemo, useState } from "react";
import { ApiError, api } from "../../api";
import { ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { useShell } from "../../app/shell-context";
import { t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { PendingDrafts } from "../tool-area/editbar/pending";
import { blockersOf, unavailableItems, type Blocker } from "./blockers";
import { equivalentCommand, planBody, readRequest } from "./request";

export const screen: ScreenMeta = { id: "validations-review", path: "/validations/review", area: "validations", navLabel: "vrev_nav", navPath: "/validations/review", order: 32, icon: "plan" };

const capLabel = (cap: string): string => tOr(`vrev_cap_${cap.replace(/[^a-z0-9]+/gi, "_")}`, cap);
const catLabel = (cat: string | null): string => (cat ? tOr(`vrev_cat_${cat}`, cat) : t("vrev_cat_none"));

function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return t("vrev_duration_seconds", { n: s });
  return t("vrev_duration_minutes", { n: Math.round(s / 60) });
}

/** The command an item runs: the exact process of the plan, or the scanner command the bridge runs for it. */
function commandOf(item: any): string {
  const effective = item.bridge?.effectiveCommand;
  if (effective) return [effective.executable, ...effective.args].join(" ");
  const c = item.command;
  if (!c) return "";
  return [c.executable, ...c.args].join(" ");
}

function effectsOf(item: any): string[] {
  const e = item.effects ?? {};
  const out: string[] = [];
  out.push(e.readsCode ? t("vrev_effect_reads") : t("vrev_effect_no_read"));
  if (e.mayChangeCode) out.push(t("vrev_effect_changes_code"));
  if (e.executesProjectCode) out.push(t("vrev_effect_executes"));
  if (e.writesOutputs) out.push(t("vrev_effect_outputs"));
  if ((e.workspaceWrites ?? []).length > 0) out.push(t("vrev_effect_writes", { files: (e.workspaceWrites as string[]).join(", ") }));
  out.push(item.network ? t("vrev_effect_network") : t("vrev_effect_offline"));
  return out;
}

function ItemList({ items, label }: { items: any[]; label: string }) {
  return (
    <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: 12 }} aria-label={label}>
      {items.map((item) => (
        <li key={item.id} className="stack" style={{ gap: 4 }} data-testid="plan-item" data-item={item.id}>
          <div className="row wrap">
            <strong>{item.label}</strong>
            <span className="muted small">
              {(item.languages ?? []).length > 0 ? `${(item.languages as string[]).join(", ")} · ` : ""}
              {capLabel((item.capabilities ?? [])[0] ?? "")}
            </span>
            <Pill tone={item.requirement === "required" ? "blue" : undefined}>{t(`vrev_req_${item.requirement}`)}</Pill>
          </div>
          {commandOf(item) ? (
            <code className="small" style={{ overflowWrap: "anywhere" }}>
              {commandOf(item)}
            </code>
          ) : null}
          <p className="muted small" style={{ margin: 0 }}>
            {effectsOf(item).join(" · ")}
          </p>
          {item.reason?.message ? (
            <p className="muted small" style={{ margin: 0 }}>
              {item.reason.message}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function groupByCategory(items: any[]): Array<[string | null, any[]]> {
  const map = new Map<string | null, any[]>();
  for (const item of items) {
    const key = item.category ?? null;
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return [...map.entries()];
}

function describeChange(change: any): string[] {
  const out: string[] = [];
  if (change.profile) out.push(t("vrev_changes_profile", { from: change.profile.from ?? "-", to: change.profile.to ?? "-" }));
  for (const id of change.items.added) out.push(t("vrev_changes_added", { id }));
  for (const id of change.items.removed) out.push(t("vrev_changes_removed", { id }));
  for (const c of change.items.changed) out.push(t("vrev_changes_changed", { id: c.id, fields: c.fields.map((f: any) => f.field).join(", ") }));
  for (const f of [...change.configFiles.added, ...change.configFiles.removed, ...change.configFiles.changed]) out.push(t("vrev_changes_file", { file: f }));
  for (const v of change.versions) out.push(t("vrev_changes_version", { field: v.field, from: String(v.from ?? "-"), to: String(v.to ?? "-") }));
  if (change.network) out.push(t(change.network.to ? "vrev_changes_network_on" : "vrev_changes_network_off"));
  return out;
}

function TieNote({ tie }: { tie: any }) {
  const against = (tie.overridden as any[]).filter((o) => o.layer === tie.decision?.layer);
  return (
    <li>
      <strong>{tie.selector}</strong>: {t("vrev_tie_explain", { layer: tOr(`vrev_layer_${tie.decision?.layer}`, String(tie.decision?.layer ?? "")) })}{" "}
      {t("vrev_tie_decisions", {
        winner: tie.decision ? `${tie.decision.selector}=${String(tie.decision.value)}` : "-",
        others: against.map((o) => `${o.selector}=${String(o.value)}`).join(", ") || "-",
      })}
    </li>
  );
}

export default function ReviewScreen() {
  const { info } = useShell();
  const toast = useToast();
  const request = useMemo(() => readRequest(), []);
  const body = useMemo(() => planBody(request), [request]);
  const [version, setVersion] = useState(0);
  const built = useAsync(() => api("POST", "/api/plans", body), `review:${version}`);
  const [starting, setStarting] = useState(false);
  const [runError, setRunError] = useState<unknown>(null);
  const [unresolved, setUnresolved] = useState(0);

  async function execute(planHash: string) {
    setStarting(true);
    setRunError(null);
    try {
      const r = await api("POST", "/api/runs", { planHash });
      window.location.hash = `#/runs/${r.run.id}`;
    } catch (e) {
      if (e instanceof ApiError && e.code === "RUN_ACTIVE" && e.body.run?.id) window.location.hash = `#/runs/${e.body.run.id}`;
      else setRunError(e);
    } finally {
      setStarting(false);
    }
  }

  const response = built.data as any;
  const plan = response?.plan;
  const review = response?.review ?? { ties: [], execution: {}, estimate: null };
  const blockers: Blocker[] = built.loading ? [] : blockersOf(plan ?? null, built.error, unresolved);
  const unavailable = plan ? unavailableItems(plan) : [];
  // TOOL_UNAVAILABLE is shown per instance below, with the way to resolve it.
  const otherWarnings: any[] = plan ? (plan.warnings as any[]).filter((w) => w.code !== "TOOL_UNAVAILABLE") : [];
  const canStart = Boolean(plan) && blockers.length === 0 && !built.loading;
  const command = equivalentCommand(body, info?.workspace.path ?? ".");
  const runner = plan
    ? (() => {
        const items = [...plan.groups.willRun] as any[];
        const containers = items.some((i) => i.command?.container);
        const local = items.some((i) => !i.command?.container);
        return containers && local ? t("vrev_runner_both") : containers ? t("vrev_runner_container") : t("vrev_runner_local");
      })()
    : "";
  const languages = plan ? [...new Set<string>((plan.components as any[]).map((c) => c.language).filter(Boolean))] : [];
  const concurrency = review.execution?.concurrency;

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      toast(t("vrev_command_copied"), "ok");
    } catch {
      toast(t("vrev_command_copy_failed"), "warn");
    }
  }

  return (
    <div className="stack">
      <div className="between wrap">
        <div>
          <h1>{t("vrev_title")}</h1>
          <p>{t("vrev_lead")}</p>
        </div>
        <div className="row wrap">
          <a className="btn" href="#/validations/choose">
            <Icon name="sliders" />
            {t("vrev_back")}
          </a>
          <button type="button" className="btn" onClick={() => setVersion((n) => n + 1)} disabled={built.loading}>
            <Icon name="refresh" />
            {t("plan_build")}
          </button>
        </div>
      </div>

      {built.loading ? <p className="spinner-text" role="status">{t("plan_building")}</p> : null}
      {built.error && !(built.error instanceof ApiError && built.error.status === 422) ? <ErrorNotice error={built.error} onRetry={built.reload} /> : null}
      {runError ? <ErrorNotice error={runError} /> : null}

      {blockers.length > 0 ? (
        <section className="notice error" role="alert" aria-labelledby="vrev-blockers" data-testid="blockers">
          <Icon name="alert" />
          <div className="stack" style={{ gap: 10 }}>
            <strong id="vrev-blockers">{t("vrev_blockers_title")}</strong>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {blockers.map((b, i) => (
                <li key={`${b.code}-${i}`} data-blocker={b.code}>
                  <strong>{b.title}</strong>
                  <div>{b.message}</div>
                  <div>
                    <strong>{t("vrev_how_label")}</strong> {b.how}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {plan ? (
        <>
          <div className="card flat stack">
            <div className="between wrap">
              <dl className="kv">
                <dt>{t("plan_profile")}</dt>
                <dd>{plan.profile?.label ?? plan.profile?.id ?? "-"}</dd>
                <dt>{t("vrev_target")}</dt>
                <dd>
                  {tOr(`scope_${plan.scope.effective}`, plan.scope.effective)}
                  {plan.scope.paths.length > 0 ? ` · ${(plan.scope.paths as string[]).join(", ")}` : ""}
                  {plan.scope.base ? ` · ${t("vrev_target_base", { ref: String(plan.scope.base).slice(0, 12) })}` : ""}
                  {plan.scope.head ? ` · ${t("vrev_target_head", { ref: String(plan.scope.head).slice(0, 12) })}` : ""}
                </dd>
                <dt>{t("vrev_languages")}</dt>
                <dd>{languages.length > 0 ? languages.join(", ") : "-"}</dd>
                <dt>{t("vrev_concurrency")}</dt>
                <dd>{concurrency === 1 || concurrency === null || concurrency === undefined ? t("vrev_concurrency_one") : t("vrev_concurrency_many", { n: concurrency })}</dd>
                <dt>{t("vrev_runner")}</dt>
                <dd>{runner}</dd>
                <dt>{t("vrev_network")}</dt>
                <dd>{plan.network.required ? t("vrev_network_needed", { policy: plan.network.policy, count: plan.network.items.length }) : t("vrev_network_none")}</dd>
                <dt>{t("vrev_estimate")}</dt>
                <dd>{review.estimate ? t("vrev_estimate_value", { time: formatDuration(review.estimate.ms), runs: review.estimate.runs }) : t("vrev_estimate_none")}</dd>
                <dt>{t("plan_hash")}</dt>
                <dd>
                  <code data-testid="plan-hash">{plan.planHash}</code>
                </dd>
              </dl>
              <div className="row wrap">
                {canStart ? (
                  <Pill tone="green">
                    <Icon name="check" />
                    {t("plan_approvable")}
                  </Pill>
                ) : (
                  <Pill tone="red">
                    <Icon name="alert" />
                    {blockers.length > 0 ? t("plan_blocked") : t("plan_not_approvable")}
                  </Pill>
                )}
                <button type="button" className="btn primary" disabled={!canStart || starting} onClick={() => execute(plan.planHash)}>
                  <Icon name="play" />
                  {t("plan_run")}
                </button>
              </div>
            </div>
            {plan.selection.reduced ? (
              <div className="notice warn" role="status">
                <Icon name="alert" />
                <span>{t("vrev_reduced")}</span>
              </div>
            ) : null}
          </div>

          <PendingDrafts planHash={plan.planHash} onUnresolved={setUnresolved} onSaved={() => setVersion((n) => n + 1)} />

          {otherWarnings.length > 0 ? (
            <div className="notice warn" role="status" data-testid="warnings">
              <Icon name="alert" />
              <div>
                <strong>{t("plan_warnings")}</strong>
                <ul>
                  {otherWarnings.map((w, i) => (
                    <li key={`w${i}`}>{w.message}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          {unavailable.length > 0 ? (
            <section className="card flat stack" aria-labelledby="vrev-unavailable" data-testid="unavailable">
              <h2 id="vrev-unavailable">{t("vrev_unavailable_title")}</h2>
              <p className="muted">{t("vrev_unavailable_lead")}</p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {unavailable.map((u) => (
                  <li key={u.id} data-unavailable={u.id}>
                    <strong>{u.tool}</strong> ({capLabel(u.capability)}): {u.reason}
                    <div>
                      <strong>{t("vrev_how_label")}</strong> {u.how}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {review.ties.length > 0 ? (
            <section className="notice warn" aria-labelledby="vrev-ties" data-testid="ties">
              <Icon name="info" />
              <div>
                <strong id="vrev-ties">{t("vrev_ties_title")}</strong>
                <ul>
                  {(review.ties as any[]).map((tie) => (
                    <TieNote key={tie.selector} tie={tie} />
                  ))}
                </ul>
              </div>
            </section>
          ) : null}

          <section className="card flat stack" aria-labelledby="vrev-changes" data-testid="changes">
            <h2 id="vrev-changes">{t("vrev_changes_title")}</h2>
            {plan.changes === null ? (
              <p>{t("vrev_changes_first")}</p>
            ) : plan.changes.same ? (
              <p>{t("vrev_changes_same")}</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {describeChange(plan.changes).map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="card flat stack" aria-labelledby="will-run" data-testid="group-will-run">
            <h2 id="will-run">
              {t("plan_will_run")} ({plan.groups.willRun.length})
            </h2>
            {plan.groups.willRun.length === 0 ? (
              <p>{t("plan_will_run_empty")}</p>
            ) : (
              groupByCategory(plan.groups.willRun).map(([category, items]) => (
                <div key={category ?? "none"} className="stack" style={{ gap: 8 }}>
                  <h3>{catLabel(category)}</h3>
                  <ItemList items={items} label={catLabel(category)} />
                </div>
              ))
            )}
          </section>

          <section className="card flat stack" aria-labelledby="outside" data-testid="group-outside">
            <h2 id="outside">{t("vrev_outside_title")}</h2>
            <div className="stack" style={{ gap: 8 }} data-testid="group-not-applicable">
              <h3 id="not-applicable">
                {t("plan_not_applicable")} ({plan.groups.notApplicableOrDisabled.length})
              </h3>
              {plan.groups.notApplicableOrDisabled.length === 0 ? <p className="muted">{t("vrev_none")}</p> : <ItemList items={plan.groups.notApplicableOrDisabled} label={t("plan_not_applicable")} />}
            </div>
            <div className="stack" style={{ gap: 8 }} data-testid="group-uncovered">
              <h3 id="uncovered">
                {t("plan_uncovered")} ({plan.groups.uncoveredRequirements.length})
              </h3>
              {plan.groups.uncoveredRequirements.length === 0 ? (
                <p className="muted">{t("vrev_uncovered_none")}</p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {(plan.groups.uncoveredRequirements as any[]).map((r, i) => (
                    <li key={i}>{r.message}</li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="card flat stack" aria-labelledby="vrev-terminal">
            <h2 id="vrev-terminal">{t("vrev_terminal_title")}</h2>
            <p className="muted">{t("vrev_terminal_lead")}</p>
            <div className="row wrap">
              <code data-testid="equivalent-command" style={{ overflowWrap: "anywhere", flex: "1 1 280px" }}>
                {command}
              </code>
              <button type="button" className="btn" onClick={copy}>
                <Icon name="copy" />
                {t("vrev_command_copy")}
              </button>
            </div>
          </section>
        </>
      ) : built.loading ? (
        <Loading />
      ) : (
        // No plan to run (the server refused to build one): the reasons are above and Executar stays off.
        <div className="row wrap">
          <Pill tone="red">
            <Icon name="alert" />
            {t("plan_blocked")}
          </Pill>
          <button type="button" className="btn primary" disabled>
            <Icon name="play" />
            {t("plan_run")}
          </button>
        </div>
      )}
    </div>
  );
}
