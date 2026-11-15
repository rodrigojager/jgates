// The ASVS coverage map (PLAN-asvs.md section 6): five counters that filter, one row per requirement with its state and the
// reason, the checks behind an opened row, the level switch, and "Não se aplica" with a required reason, a preview of the
// entry and an undo. The map is read from GET /api/coverage/asvs (the same answer as `jgates coverage asvs --json`); every
// write goes through POST /api/coverage/asvs/decisions (`preview: true` first). The requirement text is the official English
// text, marked as English and shown with its attribution. Nothing here says the project complies, and no figure is a
// percentage: the counters are plain counts.
import { useMemo, useState } from "react";
import { api } from "../../api";
import { useShell } from "../../app/shell-context";
import { currentQuery } from "../../app/route";
import { ErrorNotice, Loading, Pill, Updating, useAsync } from "../../components/common";
import { Icon, type IconName } from "../../components/icons";
import { getLocale, t, tOr } from "../../i18n";
import type { ScreenMeta } from "../../registry";
import { NotApplicableDialog, type Target } from "./NotApplicableDialog";
import "./coverage-asvs.css";

export const screen: ScreenMeta = { id: "coverage-asvs", path: "/validations/coverage/asvs", area: "validations", navLabel: "asvs_nav", navPath: "/validations/coverage/asvs", order: 6, icon: "check-circle" };

type State = "examined" | "unexamined" | "unsupported" | "not-applicable" | "awaiting-evidence";
const STATES: State[] = ["examined", "unexamined", "unsupported", "not-applicable", "awaiting-evidence"];
const TOTAL_KEY: Record<State, "examined" | "unexamined" | "unsupported" | "notApplicable" | "awaitingEvidence"> = {
  examined: "examined",
  unexamined: "unexamined",
  unsupported: "unsupported",
  "not-applicable": "notApplicable",
  "awaiting-evidence": "awaitingEvidence",
};
const STATE_ICON: Record<State, IconName> = { examined: "check", unexamined: "hourglass", unsupported: "stop", "not-applicable": "info", "awaiting-evidence": "lock" };
const LEVELS = [1, 2, 3] as const;
const key = (state: string): string => state.replace(/-/g, "_");

interface Check {
  id: string;
  category?: string;
  unit: string;
  covers: string;
  misses: string;
  depth: string;
  basis: string;
  status: string;
  ran: boolean;
  code: string;
  reason: string;
  runId: string | null;
  reused: boolean;
  openFindings: number | null;
}

export interface Row {
  id: string;
  chapter: string;
  section: string;
  level: number;
  text: string;
  state: State;
  code: string;
  reason: string;
  basis: string | null;
  evidence: string;
  checks: Check[];
  decision: { id: string; reason: string; recorded: string; scope: "requirement" | "section" | "chapter" } | null;
}

interface Totals {
  rows: number;
  examined: number;
  examinedDeterministic: number;
  examinedAiOnly: number;
  unexamined: number;
  unsupported: number;
  notApplicable: number;
  awaitingEvidence: number;
}

interface RunRef {
  runId: string;
  revision: string | null;
}

export interface AsvsMap {
  source: { name: string; version: string; licence: string; licenceUrl: string; sourceUrl: string; attribution: string };
  asvsVersion: string;
  level: 1 | 2 | 3;
  levelSource: string;
  deterministicOnly: boolean;
  statement: string;
  runs: { quality: RunRef | null; semantic: Array<RunRef & { methods: string[] }> };
  warnings: Array<{ code: string; message: string }>;
  decisions: { file: string; exists: boolean; revision: string; level: number | null; notApplicable: number; problem: string | null };
  totals: Totals;
  chapters: Array<{ id: string; name: string; totals: Totals; sections: Array<{ id: string; name: string; totals: Totals }> }>;
  requirements: Row[];
}

interface UndoInfo {
  undo: { file: string; expectedRevision: string; previous: string | null };
  what: string;
}

export default function CoverageAsvsScreen() {
  const shell = useShell();
  const governed = shell.info?.mode === "governed";
  const query = useMemo(() => currentQuery(), []);
  const [viewLevel, setViewLevel] = useState<number | null>(() => {
    const n = Number(query.get("level"));
    return n === 1 || n === 2 || n === 3 ? n : null;
  });
  const [deterministicOnly, setDeterministicOnly] = useState(false);
  const [filter, setFilter] = useState<State | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [undo, setUndo] = useState<UndoInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const run = query.get("run") ?? "";
  const semanticRun = query.get("semanticRun") ?? "";

  const lang = getLocale();
  const params = new URLSearchParams({ lang });
  if (viewLevel !== null) params.set("level", String(viewLevel));
  if (deterministicOnly) params.set("deterministicOnly", "true");
  if (run) params.set("run", run);
  if (semanticRun) params.set("semanticRuns", semanticRun);
  const url = `/api/coverage/asvs?${params.toString()}`;
  const loaded = useAsync(() => api<AsvsMap>("GET", url), `asvs:${url}`);
  const map = loaded.data;

  const guarded = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await work();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  };

  const chooseLevel = (level: number): void => {
    // The switch records the project's choice when the project may be written; in governed mode it only changes the view.
    if (governed || !map || map.decisions.level === level || (map.decisions.level === null && level === 1 && !map.decisions.exists)) {
      setViewLevel(level);
      return;
    }
    // Written first, then shown: the map that follows is read after the write, so it carries the file's new revision.
    void guarded(async () => {
      await api("POST", `/api/coverage/asvs/decisions?lang=${lang}`, { action: "level", level, expectedRevision: map.decisions.revision });
      if (viewLevel === level) loaded.reload();
      else setViewLevel(level);
    });
  };

  const doUndo = (): void => {
    if (!undo) return;
    void guarded(async () => {
      await api("POST", `/api/coverage/asvs/undo?lang=${lang}`, { undo: undo.undo });
      setUndo(null);
      loaded.reload();
    });
  };

  const removeDecision = (id: string): void => {
    if (!map) return;
    void guarded(async () => {
      const r = await api("POST", `/api/coverage/asvs/decisions?lang=${lang}`, { action: "remove", id, expectedRevision: map.decisions.revision });
      setUndo({ undo: r.undo, what: t("asvs_removed", { id }) });
      loaded.reload();
    });
  };

  const rows = map ? map.requirements.filter((r) => filter === null || r.state === filter) : [];
  const byChapter = useMemo(() => {
    const out = new Map<string, Map<string, Row[]>>();
    for (const r of rows) {
      const sections = out.get(r.chapter) ?? new Map<string, Row[]>();
      sections.set(r.section, [...(sections.get(r.section) ?? []), r]);
      out.set(r.chapter, sections);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, filter]);

  return (
    <div className="stack" data-testid="asvs-screen">
      <div>
        <div className="crumbs">
          <a href="#/validations">{t("asvs_back")}</a>
        </div>
        <h1>{t("asvs_title")}</h1>
        <p data-testid="asvs-statement">{map?.statement ?? t("asvs_statement")}</p>
      </div>

      {loaded.loading && !map ? <Loading /> : null}
      {loaded.error ? <ErrorNotice error={loaded.error} onRetry={loaded.reload} /> : null}
      {actionError ? <ErrorNotice error={actionError} /> : null}
      {governed ? (
        <div className="notice" role="status" id="asvs-governed-note" data-testid="asvs-governed-note">
          <Icon name="lock" />
          <p>{t("asvs_na_governed")}</p>
        </div>
      ) : null}

      {map ? (
        <div className="stack" aria-busy={loaded.reloading}>
          <Updating active={loaded.reloading} />
          <section className="card stack" aria-labelledby="asvs-header-title" data-testid="asvs-header">
            <h2 id="asvs-header-title">{t("asvs_standard", { version: map.asvsVersion })}</h2>
            <div className="asvs-controls">
              <div role="group" aria-label={t("asvs_level_label")} className="asvs-levels" data-testid="asvs-levels">
                {/* aria-disabled, not disabled, while a write runs: the pressed button keeps the keyboard focus. */}
                {LEVELS.map((level) => (
                  <button type="button" key={level} className="btn" aria-pressed={map.level === level} aria-disabled={busy || undefined} data-testid={`asvs-level-${level}`} onClick={() => !busy && chooseLevel(level)}>
                    {t("asvs_level", { level })}
                  </button>
                ))}
              </div>
              <label className="asvs-switch">
                <input type="checkbox" checked={deterministicOnly} onChange={(e) => setDeterministicOnly(e.target.checked)} data-testid="asvs-deterministic-only" />
                <span>{t("asvs_deterministic_only")}</span>
              </label>
            </div>
            <p className="small muted" data-testid="asvs-level-source">
              {governed ? t("asvs_level_governed") : t(`asvs_level_source_${map.levelSource}`, { level: map.level })}
            </p>
            <dl className="kv" data-testid="asvs-runs">
              <dt>{t("asvs_run_quality")}</dt>
              <dd>
                {map.runs.quality ? (
                  <a href={`#/validations/result/${encodeURIComponent(map.runs.quality.runId)}`} data-testid="asvs-run-quality">
                    {map.runs.quality.runId}
                  </a>
                ) : (
                  <span data-testid="asvs-no-quality">{t("asvs_no_quality")}</span>
                )}
              </dd>
              <dt>{t("asvs_run_semantic")}</dt>
              <dd>
                {map.runs.semantic.length === 0 ? (
                  <span data-testid="asvs-no-semantic">{t("asvs_no_semantic")}</span>
                ) : (
                  <ul className="asvs-plain-list">
                    {map.runs.semantic.map((s) => (
                      <li key={s.runId}>
                        <a href={`#/semantic/results/${encodeURIComponent(s.runId)}`} data-testid="asvs-run-semantic">
                          {s.runId}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </dl>
            {map.warnings.map((w) => (
              <div className="notice warn" role="status" key={w.code} data-testid="asvs-warning">
                <Icon name="alert" />
                <p>{w.message}</p>
              </div>
            ))}
            {map.decisions.problem ? (
              <div className="notice warn" role="status" data-testid="asvs-decisions-problem">
                <Icon name="alert" />
                <p>{t("asvs_decisions_problem", { file: map.decisions.file, problem: map.decisions.problem })}</p>
              </div>
            ) : null}
          </section>

          <section aria-labelledby="asvs-counters-title" className="stack">
            <h2 id="asvs-counters-title" className="sr-only">
              {t("asvs_counters_title")}
            </h2>
            <div className="asvs-counters" role="group" aria-label={t("asvs_counters_label")} data-testid="asvs-counters">
              {STATES.map((state) => (
                <button type="button" key={state} className={`asvs-counter s-${key(state)}`} aria-pressed={filter === state} data-testid={`asvs-counter-${state}`} data-count={map.totals[TOTAL_KEY[state]]} onClick={() => setFilter(filter === state ? null : state)}>
                  <span className="asvs-counter-count">{map.totals[TOTAL_KEY[state]]}</span>
                  <span className="asvs-counter-name">
                    <Icon name={STATE_ICON[state]} />
                    {t(`asvs_state_${key(state)}`)}
                  </span>
                  {state === "examined" ? <span className="small muted">{t("asvs_examined_split", { deterministic: map.totals.examinedDeterministic, ai: map.totals.examinedAiOnly })}</span> : null}
                </button>
              ))}
            </div>
            <p className="small" role="status" data-testid="asvs-shown">
              {filter === null ? t("asvs_shown_all", { count: rows.length }) : t("asvs_shown_filtered", { count: rows.length, state: t(`asvs_state_${key(filter)}`) })}
              {filter !== null ? (
                <>
                  {" "}
                  <button type="button" className="btn" onClick={() => setFilter(null)} data-testid="asvs-filter-clear">
                    {t("asvs_filter_clear")}
                  </button>
                </>
              ) : null}
            </p>
          </section>

          {undo ? (
            <div className="notice" role="status" data-testid="asvs-undo-bar">
              <Icon name="info" />
              <div className="grow row wrap">
                <strong>{undo.what}</strong>
                <button type="button" className="btn" disabled={busy} onClick={doUndo} data-testid="asvs-undo">
                  {t("asvs_undo")}
                </button>
              </div>
            </div>
          ) : null}

          {map.chapters.map((chapter) => {
            const sections = byChapter.get(chapter.id);
            if (!sections) return null;
            return (
              <section key={chapter.id} className="stack asvs-chapter" aria-labelledby={`asvs-ch-${chapter.id}`} data-testid={`asvs-chapter-${chapter.id}`}>
                <div className="asvs-heading">
                  <h2 id={`asvs-ch-${chapter.id}`}>
                    {chapter.id} {chapter.name}
                  </h2>
                  <NaButton id={chapter.id} label={`${chapter.id} ${chapter.name}`} kind="chapter" governed={governed} busy={busy} onOpen={setTarget} />
                </div>
                {chapter.sections.map((section) => {
                  const list = sections.get(section.id);
                  if (!list) return null;
                  return (
                    <div key={section.id} className="stack asvs-section" role="group" aria-labelledby={`asvs-sec-${section.id}`} data-testid={`asvs-section-${section.id}`}>
                      <div className="asvs-heading">
                        <h3 id={`asvs-sec-${section.id}`}>
                          {section.id} {section.name}
                        </h3>
                        <NaButton id={section.id} label={`${section.id} ${section.name}`} kind="section" governed={governed} busy={busy} onOpen={setTarget} />
                      </div>
                      <ul className="asvs-rows">
                        {list.map((row) => (
                          <RequirementRow key={row.id} row={row} governed={governed} busy={busy} onNotApplicable={setTarget} onRemove={removeDecision} />
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </section>
            );
          })}
          {rows.length === 0 ? <p data-testid="asvs-no-rows">{t("asvs_no_rows")}</p> : null}

          <p className="small muted" data-testid="asvs-attribution">
            {map.source.attribution} (<a href={map.source.licenceUrl} target="_blank" rel="noopener noreferrer">{map.source.licence}</a>, <a href={map.source.sourceUrl} target="_blank" rel="noopener noreferrer">{t("asvs_source_link")}</a>). {t("asvs_text_english")}
          </p>
        </div>
      ) : null}

      {target && map ? (
        <NotApplicableDialog
          target={target}
          revision={map.decisions.revision}
          lang={lang}
          onClose={() => setTarget(null)}
          onWritten={(info) => {
            setUndo({ undo: info.undo, what: t("asvs_recorded", { id: target.id }) });
            setTarget(null);
            loaded.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function NaButton({ id, label, kind, governed, busy, onOpen }: { id: string; label: string; kind: Target["kind"]; governed: boolean; busy: boolean; onOpen: (t: Target) => void }) {
  return (
    <span className="asvs-na">
      <button type="button" className="btn" disabled={governed || busy} aria-label={`${t("asvs_na")}: ${label}`} {...(governed ? { "aria-describedby": "asvs-governed-note" } : {})} data-testid={`asvs-na-${id}`} onClick={() => onOpen({ id, label, kind })}>
        {t("asvs_na")}
      </button>
    </span>
  );
}

const TONE: Record<State, "green" | "gold" | "red" | "blue" | undefined> = { examined: "green", unexamined: "gold", unsupported: undefined, "not-applicable": "blue", "awaiting-evidence": "blue" };

function RequirementRow({ row, governed, busy, onNotApplicable, onRemove }: { row: Row; governed: boolean; busy: boolean; onNotApplicable: (t: Target) => void; onRemove: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const panel = `asvs-panel-${row.id}`;
  const own = row.decision !== null && row.decision.id === row.id;
  return (
    <li className="asvs-row" data-testid={`asvs-row-${row.id}`} data-state={row.state}>
      <div className="asvs-row-head">
        <button type="button" className="asvs-toggle" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)} data-testid={`asvs-toggle-${row.id}`}>
          <span className={`asvs-chevron${open ? " open" : ""}`}><Icon name="chevron" /></span>
          <strong className="asvs-id">{row.id}</strong>
          <span className="pill" data-testid="asvs-row-level">{t("asvs_level_short", { level: row.level })}</span>
          <Pill {...(TONE[row.state] ? { tone: TONE[row.state] as "green" | "gold" | "red" | "blue" } : {})}>
            <span data-testid="asvs-row-state">{t(`asvs_state_${key(row.state)}`)}</span>
          </Pill>
        </button>
        <span className="asvs-na">
          {row.state === "not-applicable" && own ? (
            <button type="button" className="btn" disabled={governed || busy} onClick={() => onRemove(row.id)} data-testid={`asvs-applicable-${row.id}`}>
              {t("asvs_applicable")}
            </button>
          ) : (
            <button type="button" className="btn" disabled={governed || busy || row.state === "not-applicable"} aria-label={`${t("asvs_na")}: ${row.id}`} {...(governed ? { "aria-describedby": "asvs-governed-note" } : {})} data-testid={`asvs-na-${row.id}`} onClick={() => onNotApplicable({ id: row.id, label: row.id, kind: "requirement" })}>
              {t("asvs_na")}
            </button>
          )}
        </span>
      </div>
      <p className="asvs-text" lang="en" data-testid="asvs-row-text">
        <span className="sr-only">{t("asvs_text_english_sr")} </span>
        {row.text}
      </p>
      <p className="small" data-testid="asvs-row-reason">
        {row.reason}
      </p>
      {open ? (
        <div id={panel} className="stack asvs-detail" data-testid={`asvs-detail-${row.id}`}>
          {row.decision ? (
            <p className="small" data-testid="asvs-decision">
              {t("asvs_decision", { id: row.decision.id, reason: row.decision.reason, date: row.decision.recorded })}
            </p>
          ) : null}
          {row.checks.length > 0 ? (
            <ul className="asvs-checks" aria-label={t("asvs_checks_label")}>
              {row.checks.map((c) => (
                <li key={`${c.unit}:${c.id}`} className="asvs-check" data-testid="asvs-check" data-status={c.status}>
                  <strong>{c.category ? `${c.id} (${c.category})` : c.id}</strong> · <span>{tOr(`asvs_check_status_${key(c.status)}`, c.status)}</span>
                  <p className="small">{c.reason}</p>
                  <dl className="kv small">
                    <dt>{t("asvs_check_covers")}</dt>
                    <dd>{c.covers}</dd>
                    <dt>{t("asvs_check_misses")}</dt>
                    <dd>{c.misses}</dd>
                    <dt>{t("asvs_check_basis")}</dt>
                    <dd>{tOr(`asvs_basis_${key(c.basis)}`, c.basis)}</dd>
                    {c.ran && c.openFindings !== null ? (
                      <>
                        <dt>{t("asvs_check_open")}</dt>
                        <dd>
                          {c.runId ? (
                            <a href={`#/validations/result/${encodeURIComponent(c.runId)}`} data-testid="asvs-check-link">
                              {t("asvs_check_open_findings", { count: c.openFindings })}
                            </a>
                          ) : (
                            t("asvs_check_open_findings", { count: c.openFindings })
                          )}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </li>
              ))}
            </ul>
          ) : row.state === "awaiting-evidence" ? (
            <p data-testid="asvs-awaits">{t("asvs_awaits", { kind: tOr(`asvs_evidence_${key(row.evidence)}`, row.evidence) })}</p>
          ) : (
            <p data-testid="asvs-no-check">{t("asvs_no_check")}</p>
          )}
        </div>
      ) : null}
    </li>
  );
}
