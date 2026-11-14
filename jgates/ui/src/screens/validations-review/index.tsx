import { QualityMascotStrip } from "../../components/QualityMascotStrip";
import { ProviderFixLink } from "../../components/ProviderFixLink";
import { useEffect, useMemo, useState } from "react";
import { PreparationGroup, ToolsDownload, preparationSteps, useEnvironmentForReview } from "./preparation";
import { ApiError, api } from "../../api";
import { ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { useShell } from "../../app/shell-context";
import { currentQuery } from "../../app/route";
import { t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { PendingDrafts } from "../tool-area/editbar/pending";
import { TOOLS_DOWNLOAD, blockersOf, unavailableItems, type Blocker } from "./blockers";
import { CapabilityStates, capabilityStates } from "./capability-states";
import { networkLine } from "./network";
import { equivalentCommand, planBody, readRequest, sequenceBody, writeRequest } from "./request";

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
  // In containers each step says what network it gets: none (guaranteed) or the declared one, with the reason.
  if (item.networkKind === "bridge") out.push(t("vrev_net_bridge", { reason: item.networkReason ?? t("vrev_net_bridge_default") }));
  else if (item.networkKind === "none") out.push(t("vrev_net_none"));
  else out.push(item.network ? t("vrev_effect_network") : t("vrev_effect_offline"));
  return out;
}

function ItemList({ items, label }: { items: any[]; label: string }) {
  return (
    <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: 12 }} aria-label={label}>
      {items.map((item) => (
        <li key={item.id} className="stack" style={{ gap: 4 }} data-testid="plan-item" data-item={item.id} data-network={item.networkKind ?? (item.network ? "bridge" : "none")}>
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
          <p className="muted small" style={{ margin: 0, overflowWrap: "anywhere" }}>
            {effectsOf(item).join(" · ")}
          </p>
          {item.reason?.message ? (
            <p className="muted small" style={{ margin: 0, overflowWrap: "anywhere" }}>
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
  const [request, setRequest] = useState(() => readRequest());
  const body = useMemo(() => planBody(request), [request]);
  const [version, setVersion] = useState(0);
  const built = useAsync(() => api("POST", "/api/plans", body), `review:${version}:${request.skip.join(",")}`);
  const [starting, setStarting] = useState(false);
  const [runError, setRunError] = useState<unknown>(null);
  const [unresolved, setUnresolved] = useState(0);

  const both = request.gates === "both";
  // With both gates the selection is planned as a whole (the CLI's `--gates quality,semantic --dry-run`).
  const sequencePlan = useAsync(() => (both ? api("POST", "/api/sequence/plan", sequenceBody(request)) : Promise.resolve(null)), `review-sequence:${both}:${version}:${request.skip.join(",")}`);
  const gatePlan = (sequencePlan.data as any)?.plan ?? null;
  const gateBlockers: any[] = gatePlan?.blockers ?? [];

  async function execute(planHash: string) {
    setStarting(true);
    setRunError(null);
    try {
      if (both) {
        const r = await api("POST", "/api/sequences", { ...sequenceBody(request), ...(request.manualAdvance ? { manualAdvance: true } : {}) });
        window.location.hash = `#/sequence/${r.sequence.sequenceId}`;
        return;
      }
      const r = await api("POST", "/api/runs", { planHash });
      window.location.hash = `#/runs/${r.run.id}`;
    } catch (e) {
      if (e instanceof ApiError && e.code === "RUN_ACTIVE" && e.body.run?.id) window.location.hash = `#/runs/${e.body.run.id}`;
      else if (e instanceof ApiError && e.code === "SEQUENCE_ACTIVE" && e.body.sequenceId) window.location.hash = `#/sequence/${e.body.sequenceId}`;
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
  const canStart = Boolean(plan) && blockers.length === 0 && !built.loading && (!both || (gatePlan?.ready === true && !sequencePlan.loading));
  const command = equivalentCommand(both ? { ...body, gates: ["quality", "semantic"], ...(request.manualAdvance ? { manualAdvance: true } : {}) } : body, info?.workspace.path ?? ".");
  const languages = plan ? [...new Set<string>((plan.components as any[]).map((c) => c.language).filter(Boolean))] : [];
  const capGroups = plan ? capabilityStates(plan, review.catalog ?? null) : [];
  const projectProfile = plan?.profile && !String(plan.profile.chain?.[0]?.file ?? "builtin:").startsWith("builtin:") ? String(plan.profile.id) : null;
  const capContext = {
    profile: projectProfile,
    onChanged: () => setVersion((n) => n + 1),
    // Taking a switch-off of this run back: the request changes and the plan is built again.
    onIncludeRun: (selectors: string[]) => {
      const next = { ...request, skip: request.skip.filter((s) => !selectors.includes(s)) };
      writeRequest(next);
      setRequest(next);
    },
  };
  const concurrency = review.execution?.concurrency;
  const env = useEnvironmentForReview(version);
  const prepSteps = plan ? preparationSteps(plan, env) : [];

  // A link from the overview (?capability=x or ?category=y) lands on that part of "Estado de cada proteção".
  useEffect(() => {
    if (!plan) return;
    const query = currentQuery();
    const capability = query.get("capability");
    const category = query.get("category");
    const target = capability ? document.querySelector(`[data-capability="${CSS.escape(capability)}"]`) : category ? document.querySelector(`[data-category="${CSS.escape(category)}"]`) : null;
    if (!(target instanceof HTMLElement)) return;
    target.setAttribute("tabindex", "-1");
    target.scrollIntoView({ block: "center" });
    target.focus();
  }, [plan?.planHash]);

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
                  {TOOLS_DOWNLOAD.has(b.code) ? <ToolsDownload onDone={() => setVersion((n) => n + 1)} /> : null}
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {both ? (
        <section className="card flat stack" aria-labelledby="vrev-sequence" data-testid="sequence-plan">
          <h2 id="vrev-sequence">{t("vrev_seq_title")}</h2>
          <p className="muted">{t("vrev_seq_lead")}</p>
          {sequencePlan.loading ? <p className="spinner-text" role="status">{t("plan_building")}</p> : null}
          {sequencePlan.error ? <ErrorNotice error={sequencePlan.error} onRetry={sequencePlan.reload} /> : null}
          {gatePlan ? (
            <>
              <ol className="stack" style={{ margin: 0, paddingLeft: 18, gap: 4 }}>
                <li data-gate="quality">{t("vrev_seq_step_quality")}</li>
                <li data-gate="semantic">{t(request.manualAdvance ? "vrev_seq_step_semantic_manual" : "vrev_seq_step_semantic")}</li>
              </ol>
              {gateBlockers.length > 0 ? (
                <div className="notice error" role="alert" data-testid="sequence-blockers">
                  <Icon name="alert" />
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {gateBlockers.map((b, i) => (
                      <li key={`${b.gate}-${b.code}-${i}`} data-blocker={b.code}>
                        <strong>{tOr(`vrev_seq_gate_${b.gate}`, b.gate)}</strong>: {b.message} <ProviderFixLink code={b.code} />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      <QualityMascotStrip snapshot={response?.mascots} />
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
                <dt>{t("vrev_network")}</dt>
                <dd data-testid="review-network">{networkLine(plan, [...prepSteps.map((s) => ({ name: t(`vrev_prep_name_${s.id}`), network: s.network, done: s.done })), ...((review.preparations ?? []) as Array<{ id: string; label: string; network: "none" | "bridge" }>).filter((p) => p.id !== "dependencies").map((p) => ({ name: p.label, network: p.network }))])}</dd>
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

          <PreparationGroup steps={prepSteps} pending={review.preparations ?? []} onChanged={() => setVersion((n) => n + 1)} />

          {capGroups.length > 0 ? <CapabilityStates groups={capGroups} ctx={capContext} title={t("vrev_caps_title")} lead={t("vrev_caps_lead")} headingId="vrev-caps" /> : null}

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
            <div className="stack" style={{ gap: 8 }} data-testid="group-not-applicable-requirements">
              <h3 id="not-applicable-requirements">
                {t("vrev_na_requirements")} ({(plan.groups.notApplicableRequirements ?? []).length})
              </h3>
              {(plan.groups.notApplicableRequirements ?? []).length === 0 ? (
                <p className="muted">{t("vrev_none")}</p>
              ) : (
                <p className="muted">
                  {t("vrev_na_requirements_lead", { list: ((plan.groups.notApplicableRequirements ?? []) as any[]).map((r) => r.label ?? r.selector).join(", ") })}{" "}
                  <button
                    type="button"
                    className="capst-link"
                    onClick={() => {
                      const heading = document.getElementById("vrev-caps");
                      heading?.scrollIntoView({ block: "start" });
                      heading?.setAttribute("tabindex", "-1");
                      heading?.focus();
                    }}
                  >
                    {t("vrev_na_requirements_link")}
                  </button>
                </p>
              )}
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
