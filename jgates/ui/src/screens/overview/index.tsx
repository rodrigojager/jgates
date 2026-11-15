import { useCallback, useEffect, useRef, useState } from "react";
import { formatRunWhen } from "../../components/format";
import { fetchEnvironmentState, useRecheckOnFocus, type EnvironmentReason, type EnvironmentState } from "../../api/environment";
import { DoctorAvatar } from "../../components/DoctorAvatar";
import { PrerequisitesBar } from "../../components/PrerequisitesBar";
import { QualityMascotStrip } from "../../components/QualityMascotStrip";
import { api } from "../../api";
import { ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { Icon, type IconName } from "../../components/icons";
import { getLocale, t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { approvedWithWaiversText, isApprovedWithWaivers, type Approval } from "../validations-result/ResultView";
import "./overview.css";

export const screen: ScreenMeta = { id: "overview", path: "/overview", area: "overview", order: 0, icon: "home" };

interface Stage {
  id: string;
  label: string;
  tool?: string;
  findings?: number;
  state: string;
  reason: string | null;
}

interface LastRun {
  runId: string;
  decision: string;
  /** "Approved with N waivers" numbers, computed by the server. */
  approval?: Approval;
  complete?: boolean;
  partial?: boolean;
  /** Partial and its process still beats: the run is going on now. */
  running?: boolean;
  durationMs?: number | null;
  branch?: string | null;
  commit?: string | null;
  summary?: string | null;
  findings?: number;
  /** The tools image (id) and the age in days of the oldest security database the run used. */
  toolsImage?: string | null;
  dataAgeDays?: number | null;
  stages: Stage[];
}

interface Category {
  id: string;
  state: "included" | "gap" | "disabled";
  checks: number;
  reason: string | null;
}

interface Overview {
  mascots?: import("../../../../src/core/mascots/index").MascotSnapshot;
  discovery: { components: number; languages: string[]; ambiguous: Array<{ id: string; root: string; reasonCode: string }>; inconsistencies: number };
  profile: { id: string; label: string | null } | null;
  plan: { planHash: string | null; approvable: boolean; blocked: string | null; uncovered: Array<{ selector: string; category: string | null; reason: string; message: string }> };
  categories: Category[];
  lastRun: LastRun | null;
  /** What to do after a validation that did not pass: read its result. */
  nextStep?: { kind: "open-result"; runId: string; decision: string; route: string } | null;
}

const DECISION_TONE: Record<string, "green" | "gold" | "red" | "blue"> = { passed: "green", failed: "red", incomplete: "gold", invalid: "red", cancelled: "gold" };

function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function runWhen(runId: string): string {
  return formatRunWhen(runId);
}

const stateLabel = (state: string): string => tOr(`overview_stage_state_${state}`, state);
const categoryLabel = (id: string): string => tOr(`overview_category_${id}`, id);

const STATE_ICON: Record<string, IconName> = { completed: "check", error: "x", timeout: "x", blocked: "lock", incomplete: "hourglass", cancelled: "stop", pending: "hourglass", running: "refresh", disabled: "stop", not_applicable: "info" };

/** One tile per stage: the name of the check, its state as an icon and as text, never only a color. */
function Segments({ stages }: { stages: Stage[] }) {
  const done = stages.filter((s) => s.state === "completed").length;
  return (
    <div>
      <ul className="ov-segments" aria-label={t("overview_stages_label")} data-testid="stage-segments">
        {stages.map((s) => (
          <li key={s.id} className={`ov-seg s-${s.state}`} data-stage={s.id} data-state={s.state} title={s.reason ? `${s.label}: ${stateLabel(s.state)} - ${s.reason}` : `${s.label}: ${stateLabel(s.state)}`}>
            <span className="ov-seg-name">{s.label}</span>
            <span className="ov-seg-state">
              <Icon name={STATE_ICON[s.state] ?? "info"} />
              {stateLabel(s.state)}
            </span>
          </li>
        ))}
      </ul>
      <p className="small" data-testid="stage-summary">
        {t("overview_stages_summary", { done, total: stages.length })}
      </p>
    </div>
  );
}

function LastRunCard({ run, image }: { run: LastRun | null; image: { id?: string; version?: string } | null }) {
  if (!run) {
    return (
      <div className="card" data-testid="last-run-empty">
        <p>{t("overview_last_empty")}</p>
        <p className="small">{t("overview_last_empty_hint")}</p>
      </div>
    );
  }
  const decision = run.running ? "running" : run.decision in DECISION_TONE ? run.decision : "unknown";
  // A run that passed with waivers is "Approved with N waivers" here too, never a plain approval.
  const withWaivers = !run.running && run.decision === "passed" && isApprovedWithWaivers(run.approval);
  return (
    <div className="card" data-testid="last-run">
      <div className="between">
        <Pill tone={run.running || withWaivers ? "blue" : (DECISION_TONE[run.decision] ?? "blue")}>
          <Icon name={run.running ? "refresh" : withWaivers ? "info" : run.decision === "passed" ? "check" : "alert"} />
          <span data-testid="last-run-decision" data-kind={withWaivers ? "passed-waivers" : decision}>{withWaivers ? approvedWithWaiversText(run.approval as Approval) : t(`overview_decision_${decision}`)}</span>
        </Pill>
        <span className="small muted">{runWhen(run.runId)}</span>
      </div>
      {run.branch ? <h3 className="ov-run-title">{run.branch}</h3> : null}
      {run.running ? <p className="small">{t("overview_run_running")}</p> : run.partial ? <p className="small">{t("overview_run_partial")}</p> : null}
      {run.summary ? <p className="small">{run.summary}</p> : null}
      {run.stages.length > 0 ? <Segments stages={run.stages} /> : null}
      <div className="between wrap">
        <div className="ov-meta">
          <span>
            {t("overview_duration")}: <span data-testid="run-duration">{duration(run.durationMs)}</span>
          </span>
          {run.commit ? (
            <span>
              {t("overview_commit")} <code>{run.commit.slice(0, 7)}</code>
            </span>
          ) : null}
          <span>{run.findings === 1 ? t("overview_findings_one") : t("overview_findings", { count: run.findings ?? 0 })}</span>
          {run.toolsImage ? (
            <span data-testid="run-image">
              {t("overview_run_image")}{" "}
              <code>{image?.id === run.toolsImage && image.version ? image.version : run.toolsImage.replace("sha256:", "").slice(0, 12)}</code>
            </span>
          ) : null}
          {typeof run.dataAgeDays === "number" && run.dataAgeDays > 0 ? <span data-testid="run-data-age">{t("overview_run_data_age", { days: run.dataAgeDays })}</span> : null}
        </div>
        <a className="ov-link" href={run.running ? `#/runs/${encodeURIComponent(run.runId)}` : `#/validations/result/${encodeURIComponent(run.runId)}`}>
          {run.running ? t("overview_follow_run") : t("overview_view_result")} <Icon name="chevron" />
        </a>
      </div>
    </div>
  );
}

interface Step {
  n: string;
  icon: IconName;
  title: string;
  text: string;
  pending: string | null;
  href: string;
  open: string;
  /** A readiness step carries the id of its pill and the visible label of the action. */
  readiness?: ReadinessId;
  actionLabel?: string;
  external?: boolean;
  /** The step that opens the result of a validation that did not pass. */
  result?: boolean;
}

type ReadinessId = "engine" | "image" | "data" | "dependencies" | "services";

interface ReadinessItem {
  id: ReadinessId;
  state: string;
  /** green: ready; gold: needs attention; undefined: nothing to say (not applicable, not known). */
  ok: boolean | null;
  reason: EnvironmentReason | null;
}

const OK_STATES: Record<ReadinessId, string[]> = {
  engine: ["ready"],
  image: ["ready"],
  data: ["fresh"],
  dependencies: ["ready", "none"],
  services: ["running", "stopped"],
};

/** One pill per element of the environment; Serviços only when the project configures them. */
function readinessOf(env: EnvironmentState | null): ReadinessItem[] {
  if (!env) return [];
  const s = env.sections as unknown as Record<string, { state: string; reasons: EnvironmentReason[]; configured?: boolean }>;
  const inImage = env.mode === "in-image";
  const ids: ReadinessId[] = ["engine", "image", "data", "dependencies"];
  if (s.services?.configured) ids.push("services");
  return ids.map((id) => {
    const section = s[id] as { state: string; reasons: EnvironmentReason[] };
    // Inside the tools image there is no engine to ask and the data is whatever the job mounted.
    if (inImage && (id === "engine" || id === "image" || id === "data")) return { id, state: id === "data" ? "unknown" : "ready", ok: id === "data" ? null : true, reason: null };
    // The server's one definition of ready (notReady) decides; a reason on a ready section still asks for attention.
    const ok = !(env.notReady ?? []).includes(id as never) && OK_STATES[id].includes(section.state) && section.reasons.length === 0;
    return { id, state: section.state, ok, reason: section.reasons.find((r) => r.action.kind !== "none") ?? section.reasons[0] ?? null };
  });
}

/** The first element that is not ready becomes the first step: its sentence and its action. */
function readinessStep(items: ReadinessItem[]): Step | null {
  const first = items.find((i) => i.ok === false);
  if (!first) return null;
  const a = first.reason?.action;
  // The services have their own screen (Configuração > Serviços).
  const own = first.id === "services" ? null : a?.kind === "link" && a.url ? a.url : a?.kind === "route" && a.route ? `#/${a.route.replace(/^\/+/, "")}` : null;
  const href = first.id === "services" ? "#/config/services" : (own ?? `#/environment?section=${first.id}`);
  const label = own && a ? a.label : t(`overview_ready_action_${first.id}`);
  return {
    n: "00",
    icon: "tools",
    title: t(`overview_ready_${first.id}`),
    text: t("overview_ready_pending"),
    pending: first.reason?.message ?? t(`overview_ready_fallback_${first.id}`),
    href,
    open: label,
    readiness: first.id,
    actionLabel: label,
    external: a?.kind === "link",
  };
}

function Readiness({ items, doctor }: { items: ReadinessItem[]; doctor: boolean }) {
  if (items.length === 0) return null;
  const list = (
    <ul className="ov-readiness" aria-label={t("overview_ready_label")} data-testid="readiness">
      {items.map((i) => (
        <li key={i.id} data-readiness={i.id} data-ready={i.ok === null ? "unknown" : String(i.ok)}>
          <a href="#/environment">
            <Pill tone={i.ok === null ? undefined : i.ok ? "green" : "gold"}>
              <Icon name={i.ok === false ? "alert" : "check"} />
              {t(`overview_ready_${i.id}`)}
              <span className="ov-ready-state">{t(i.ok === null ? "overview_ready_state_unknown" : i.ok ? "overview_ready_state_ok" : "overview_ready_state_attention")}</span>
            </Pill>
          </a>
        </li>
      ))}
    </ul>
  );
  // The doctor speaks for the environment here when the prerequisites bar (which has him) is not on view.
  if (!doctor) return list;
  return (
    <div className="ov-doctor row" data-testid="overview-doctor">
      <DoctorAvatar state={items.some((i) => i.ok === false) ? "needs-you" : "ok"} />
      {list}
    </div>
  );
}

/** After a validation that did not pass, the first step is to read its result (the decision names why). */
function resultStep(data: Overview): Step | null {
  const next = data.nextStep;
  if (!next) return null;
  const decision = tOr(`overview_decision_${next.decision}`, next.decision);
  return {
    n: "result",
    icon: "alert",
    title: t("overview_next_result_title"),
    text: t("overview_next_result_text", { decision }),
    pending: t("overview_next_result_text", { decision }),
    href: `#/${next.route}`,
    open: t("overview_next_result_action"),
    actionLabel: t("overview_next_result_action"),
    result: true,
  };
}

function steps(data: Overview, readiness: Step | null): Step[] {
  const d = data.discovery;
  const result = resultStep(data);
  const gaps = data.categories.filter((c) => c.state === "gap");
  let step1: string | null = null;
  if (d.ambiguous.length > 0) step1 = t("overview_step1_pending", { count: d.ambiguous.length, ids: d.ambiguous.map((a) => a.root).join(", ") });
  else if (d.inconsistencies > 0) step1 = t("overview_step1_inconsistent", { count: d.inconsistencies });
  let step2: string | null = null;
  if (data.plan.blocked && !data.plan.planHash) step2 = t("overview_step2_pending_plan", { reason: data.plan.blocked });
  else if (gaps.length > 0) step2 = t("overview_step2_pending_gaps", { count: gaps.length, ids: gaps.map((g) => categoryLabel(g.id)).join(", ") });
  return [
    ...(readiness ? [readiness] : []),
    ...(result ? [result] : []),
    { n: "01", icon: "folder", title: t("overview_step1_title"), text: t("overview_step1_text"), pending: step1, href: "#/workspace", open: t("overview_step1_open") },
    { n: "02", icon: "sliders", title: t("overview_step2_title"), text: t("overview_step2_text"), pending: step2, href: "#/config", open: t("overview_step2_open") },
    { n: "03", icon: "play", title: t("overview_step3_title"), text: t("overview_step3_text"), pending: data.lastRun ? null : t("overview_step3_pending"), href: "#/validations/choose", open: t("overview_step3_open") },
  ];
}

function NextSteps({ data, readiness }: { data: Overview; readiness: Step | null }) {
  return (
    <ol className="card ov-next" style={{ listStyle: "none", margin: 0 }} data-testid="next-steps">
      {steps(data, readiness).map((s) => (
        <li key={s.n} className={`ov-next-row${s.pending ? " pending" : ""}${data.nextStep && !s.result && !s.readiness && !s.pending ? " quiet" : ""}`} data-step={s.readiness ? "readiness" : s.n} data-readiness={s.readiness} data-pending={s.pending ? "true" : "false"}>
          <span className="step-number">{s.readiness || s.result ? "!" : s.n}</span>
          <Icon name={s.icon} />
          <div className="grow">
            <strong>{s.title}</strong>
            <p>{s.pending ?? s.text}</p>
            {s.actionLabel ? (
              <a className="ov-link" href={s.href} data-testid="readiness-action" {...(s.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                {s.actionLabel} <Icon name="chevron" />
              </a>
            ) : null}
          </div>
          {/* While a result waits to be read, the steps that are fine say so with an icon, not a repeated "Em dia". */}
          {data.nextStep && !s.result && !s.readiness && !s.pending ? (
            <span className="ov-quiet-done" role="img" aria-label={t("overview_next_done")}>
              <Icon name="check" />
            </span>
          ) : (
            <Pill tone={s.pending ? "gold" : "green"}>{s.pending ? t("overview_next_pending") : t("overview_next_done")}</Pill>
          )}
          {s.actionLabel ? null : (
            <a className="icon-btn" href={s.href} aria-label={s.open}>
              <Icon name="chevron" />
            </a>
          )}
        </li>
      ))}
    </ol>
  );
}

const CATEGORY_TONE = { included: "green", gap: "gold", disabled: undefined } as const;
const CATEGORY_ICON: Record<Category["state"], IconName> = { included: "check", gap: "alert", disabled: "stop" };

function Protection({ categories }: { categories: Category[] }) {
  if (categories.length === 0) return <p>{t("overview_protection_empty")}</p>;
  return (
    <ul className="card ov-cats" style={{ listStyle: "none", margin: 0 }} data-testid="categories">
      {categories.map((c) => (
        <li key={c.id} className="ov-cat" data-category={c.id} data-state={c.state}>
          <div className="grow">
            <h3>{categoryLabel(c.id)}</h3>
            {c.state === "included" ? <p>{t(c.checks === 1 ? "overview_category_checks_one" : "overview_category_checks", { count: c.checks })}</p> : c.reason ? <p>{c.reason}</p> : null}
            {c.state === "gap" ? (
              <a className="ov-link" href={`#/validations/review?category=${encodeURIComponent(c.id)}`} data-testid="category-action" aria-label={`${t("overview_category_action")}: ${categoryLabel(c.id)}`}>
                {t("overview_category_action")} <Icon name="chevron" />
              </a>
            ) : null}
          </div>
          <Pill tone={CATEGORY_TONE[c.state]}>
            <Icon name={CATEGORY_ICON[c.state]} />
            {t(`overview_category_${c.state}`)}
          </Pill>
        </li>
      ))}
    </ul>
  );
}

export default function OverviewScreen() {
  const loaded = useAsync(() => api<Overview & Record<string, unknown>>("GET", "/api/overview"), "overview");
  const data = loaded.data;
  const languages = data?.discovery.languages ?? [];
  const uncovered = data?.plan.uncovered ?? [];
  const first = data !== null && data.lastRun === null;
  // The environment, read apart so the overview does not wait for the engine; it is read again when the person comes back.
  const [env, setEnv] = useState<EnvironmentState | null>(null);
  // The prerequisites bar carries the Doctor while it is on view; once it leaves, the readiness card carries him.
  const [prerequisitesShown, setPrerequisitesShown] = useState(true);
  const loadEnv = useCallback(() => {
    fetchEnvironmentState(getLocale()).then(setEnv, () => undefined);
  }, []);
  useEffect(loadEnv, [loadEnv]);
  useRecheckOnFocus(loadEnv);
  const readiness = readinessOf(env);
  const readinessFirst = readinessStep(readiness);

  // While a run is going on, look again every few seconds, so the card turns into its result when it ends (or into
  // "Interrompida" when its process dies) without a reload.
  const lastRunning = data?.lastRun?.running === true;
  const reload = useRef(loaded.reload);
  reload.current = loaded.reload;
  useEffect(() => {
    if (!lastRunning) return;
    const timer = setInterval(() => reload.current(), 5000);
    return () => clearInterval(timer);
  }, [lastRunning]);

  return (
    <div className="stack" data-testid="overview">
      <div className="ov-head">
        <div>
          <h1>{t("overview_title")}</h1>
          <p>{t("overview_subtitle")}</p>
          <p className="small">
            <a href="#/validations/coverage/asvs" data-testid="asvs-link">
              {t("overview_asvs_link")}
            </a>
          </p>
        </div>
        <a className="btn primary" href="#/validations/choose" data-testid="new-run">
          <Icon name="play" />
          {t("overview_new_run")}
        </a>
      </div>

      <PrerequisitesBar onChanged={() => { loaded.reload(); loadEnv(); }} onVisibleChange={setPrerequisitesShown} />
      <Readiness items={readiness} doctor={!prerequisitesShown} />

      {loaded.loading && !data ? <Loading /> : null}
      {loaded.error ? <ErrorNotice error={loaded.error} onRetry={loaded.reload} /> : null}

      {data ? (
        <>
          <section className="ov-hero">
            <div>
              <span className="eyebrow">{t("overview_hero_eyebrow").toUpperCase()}</span>
              <h2>{t("overview_hero_title")}</h2>
              <p>{first ? t("overview_hero_text_first") : t("overview_hero_text")}</p>
              {/* One primary action per page ("Nova validação", above); reviewing the plan first is a deliberate detour. */}
              <a className="ov-link" href="#/validations/review" data-testid="hero-review">
                {t("overview_hero_review")} <Icon name="chevron" />
              </a>
            </div>
          </section>

          <ul className="ov-strip" aria-label={t("overview_strip")} data-testid="strip">
            <li>
              <Icon name="folder" />
              <div>
                <strong data-testid="count-components">
                  {data.discovery.components} <span>{data.discovery.components === 1 ? t("overview_components_one") : t("overview_components")}</span>
                </strong>
                {data.discovery.ambiguous.length > 0 ? <small>{t("overview_ambiguous_note", { count: data.discovery.ambiguous.length })}</small> : null}
              </div>
            </li>
            <li>
              <Icon name="terminal" />
              <div>
                <strong data-testid="count-languages">
                  {languages.length} <span>{languages.length === 1 ? t("overview_languages_one") : t("overview_languages")}</span>
                </strong>
                <small>{languages.length > 0 ? languages.join(", ") : t("overview_languages_none")}</small>
              </div>
            </li>
            <li>
              <Icon name="check-circle" />
              <div>
                <strong data-testid="profile">{data.profile ? data.profile.label ?? data.profile.id : t("overview_profile_none")}</strong>
                <small>{t("overview_profile")}</small>
              </div>
            </li>
          </ul>

          <div className="ov-grid">
            <section>
              <div className="ov-section-head">
                <h2>{t("overview_last")}</h2>
                <a className="ov-link" href="#/validations">
                  {t("overview_history")} <Icon name="chevron" />
                </a>
              </div>
              <LastRunCard run={data.lastRun} image={env && env.sections.image.state === "ready" ? (env.sections.image as { id?: string; version?: string }) : null} />
            </section>
            <section>
              <div className="ov-section-head">
                <h2>{t("overview_next")}</h2>
                <span className="eyebrow">{t("overview_next_eyebrow").toUpperCase()}</span>
              </div>
              <NextSteps data={data} readiness={readinessFirst} />
            </section>
          </div>

          <section>
            <div className="ov-section-head">
              <h2>{t("overview_protection")}</h2>
              <a className="ov-link" href="#/config">
                {t("overview_customize")} <Icon name="sliders" />
              </a>
            </div>
            <QualityMascotStrip snapshot={data.mascots} />
            <Protection categories={data.categories} />
          </section>

          {uncovered.length > 0 ? (
            <section className="ov-uncovered" data-testid="uncovered">
              <h2>{t("overview_uncovered")}</h2>
              <p className="small">{t("overview_uncovered_text")}</p>
              <ul>
                {uncovered.map((u) => (
                  <li key={u.selector}>
                    <code>{u.selector}</code>: {u.message}{" "}
                    <a className="ov-link" href={`#/validations/review${u.selector.startsWith("capability:") ? `?capability=${encodeURIComponent(u.selector.slice(11))}` : u.category ? `?category=${encodeURIComponent(u.category)}` : ""}`} aria-label={`${t("overview_category_action")}: ${u.selector}`}>
                      {t("overview_category_action")}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
