import { api } from "../../api";
import { ErrorNotice, Loading, Pill, useAsync } from "../../components/common";
import { Icon, type IconName } from "../../components/icons";
import { t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import "./overview.css";

export const screen: ScreenMeta = { id: "overview", path: "/overview", area: "overview", order: 0, icon: "home" };

interface Stage {
  id: string;
  label: string;
  state: string;
  reason: string | null;
}

interface LastRun {
  runId: string;
  decision: string;
  complete?: boolean;
  partial?: boolean;
  durationMs?: number | null;
  branch?: string | null;
  commit?: string | null;
  summary?: string | null;
  findings?: number;
  stages: Stage[];
}

interface Category {
  id: string;
  state: "included" | "gap" | "disabled";
  checks: number;
  reason: string | null;
}

interface Overview {
  discovery: { components: number; languages: string[]; ambiguous: Array<{ id: string; root: string; reasonCode: string }>; inconsistencies: number };
  profile: { id: string; label: string | null } | null;
  plan: { planHash: string | null; approvable: boolean; blocked: string | null; uncovered: Array<{ selector: string; category: string | null; reason: string; message: string }> };
  categories: Category[];
  lastRun: LastRun | null;
}

const DECISION_TONE: Record<string, "green" | "gold" | "red" | "blue"> = { passed: "green", failed: "red", incomplete: "gold", invalid: "red", cancelled: "gold" };

function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function runWhen(runId: string): string {
  const m = /^run_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(runId);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]} UTC` : runId;
}

const stateLabel = (state: string): string => tOr(`overview_stage_state_${state}`, state);
const categoryLabel = (id: string): string => tOr(`overview_category_${id}`, id);

/** States that need no words on the bar: it went well, or nothing was meant to run. */
const QUIET = new Set(["completed", "disabled", "not_applicable"]);

/** One segment per stage; any state other than completed carries its name as text, not only a color. */
function Segments({ stages }: { stages: Stage[] }) {
  const done = stages.filter((s) => s.state === "completed").length;
  return (
    <div>
      <ul className="ov-segments" aria-label={t("overview_stages_label")} data-testid="stage-segments">
        {stages.map((s) => {
          const text = !QUIET.has(s.state);
          return (
            <li key={s.id} className={`ov-seg s-${s.state}${text ? " has-text" : ""}`} data-stage={s.id} data-state={s.state} title={`${s.label}: ${stateLabel(s.state)}`}>
              {text ? <span>{stateLabel(s.state)}</span> : null}
              <span className="sr-only">{`${s.label}: ${stateLabel(s.state)}`}</span>
            </li>
          );
        })}
      </ul>
      <p className="small" data-testid="stage-summary">
        {t("overview_stages_summary", { done, total: stages.length })}
      </p>
    </div>
  );
}

function LastRunCard({ run }: { run: LastRun | null }) {
  if (!run) {
    return (
      <div className="card" data-testid="last-run-empty">
        <p>{t("overview_last_empty")}</p>
        <p className="small">{t("overview_last_empty_hint")}</p>
      </div>
    );
  }
  const decision = run.decision in DECISION_TONE ? run.decision : "unknown";
  return (
    <div className="card" data-testid="last-run">
      <div className="between">
        <Pill tone={DECISION_TONE[run.decision] ?? "blue"}>
          <Icon name={run.decision === "passed" ? "check" : "alert"} />
          {t(`overview_decision_${decision}`)}
        </Pill>
        <span className="small muted">{runWhen(run.runId)}</span>
      </div>
      {run.branch ? <h3 className="ov-run-title">{run.branch}</h3> : null}
      {run.partial ? <p className="small">{t("overview_run_partial")}</p> : null}
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
        </div>
        <a className="ov-link" href={`#/runs/${encodeURIComponent(run.runId)}`}>
          {t("overview_view_result")} <Icon name="chevron" />
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
}

function steps(data: Overview): Step[] {
  const d = data.discovery;
  const gaps = data.categories.filter((c) => c.state === "gap");
  let step1: string | null = null;
  if (d.ambiguous.length > 0) step1 = t("overview_step1_pending", { count: d.ambiguous.length, ids: d.ambiguous.map((a) => a.root).join(", ") });
  else if (d.inconsistencies > 0) step1 = t("overview_step1_inconsistent", { count: d.inconsistencies });
  let step2: string | null = null;
  if (data.plan.blocked && !data.plan.planHash) step2 = t("overview_step2_pending_plan", { reason: data.plan.blocked });
  else if (gaps.length > 0) step2 = t("overview_step2_pending_gaps", { count: gaps.length, ids: gaps.map((g) => categoryLabel(g.id)).join(", ") });
  return [
    { n: "01", icon: "folder", title: t("overview_step1_title"), text: t("overview_step1_text"), pending: step1, href: "#/workspace", open: t("overview_step1_open") },
    { n: "02", icon: "sliders", title: t("overview_step2_title"), text: t("overview_step2_text"), pending: step2, href: "#/config", open: t("overview_step2_open") },
    { n: "03", icon: "play", title: t("overview_step3_title"), text: t("overview_step3_text"), pending: data.lastRun ? null : t("overview_step3_pending"), href: "#/plan", open: t("overview_step3_open") },
  ];
}

function NextSteps({ data }: { data: Overview }) {
  return (
    <ol className="card ov-next" style={{ listStyle: "none", margin: 0 }} data-testid="next-steps">
      {steps(data).map((s) => (
        <li key={s.n} className={`ov-next-row${s.pending ? " pending" : ""}`} data-step={s.n} data-pending={s.pending ? "true" : "false"}>
          <span className="step-number">{s.n}</span>
          <Icon name={s.icon} />
          <div className="grow">
            <strong>{s.title}</strong>
            <p>{s.pending ?? s.text}</p>
          </div>
          <Pill tone={s.pending ? "gold" : "green"}>{s.pending ? t("overview_next_pending") : t("overview_next_done")}</Pill>
          <a className="icon-btn" href={s.href} aria-label={s.open}>
            <Icon name="chevron" />
          </a>
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
            {c.state === "included" ? <p>{t("overview_category_checks", { count: c.checks })}</p> : c.reason ? <p>{c.reason}</p> : null}
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

  return (
    <div className="stack" data-testid="overview">
      <div className="ov-head">
        <div>
          <h1>{t("overview_title")}</h1>
          <p>{t("overview_subtitle")}</p>
        </div>
        <a className="btn primary" href="#/validations" data-testid="new-run">
          <Icon name="play" />
          {t("overview_new_run")}
        </a>
      </div>

      {loaded.loading && !data ? <Loading /> : null}
      {loaded.error ? <ErrorNotice error={loaded.error} onRetry={loaded.reload} /> : null}

      {data ? (
        <>
          <section className="ov-hero">
            <div>
              <span className="eyebrow">{t("overview_hero_eyebrow").toUpperCase()}</span>
              <h2>{t("overview_hero_title")}</h2>
              <p>{first ? t("overview_hero_text_first") : t("overview_hero_text")}</p>
              <a className="btn primary" href="#/plan">
                {t("overview_hero_cta")}
                <Icon name="chevron" />
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
              <LastRunCard run={data.lastRun} />
            </section>
            <section>
              <div className="ov-section-head">
                <h2>{t("overview_next")}</h2>
                <span className="eyebrow">{t("overview_next_eyebrow").toUpperCase()}</span>
              </div>
              <NextSteps data={data} />
            </section>
          </div>

          <section>
            <div className="ov-section-head">
              <h2>{t("overview_protection")}</h2>
              <a className="ov-link" href="#/config">
                {t("overview_customize")} <Icon name="sliders" />
              </a>
            </div>
            <Protection categories={data.categories} />
          </section>

          {uncovered.length > 0 ? (
            <section className="ov-uncovered" data-testid="uncovered">
              <h2>{t("overview_uncovered")}</h2>
              <p className="small">{t("overview_uncovered_text")}</p>
              <ul>
                {uncovered.map((u) => (
                  <li key={u.selector}>
                    <code>{u.selector}</code>: {u.message}
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
