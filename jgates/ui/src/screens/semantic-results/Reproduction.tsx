import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, api } from "../../api";
import { Pill, useAsync } from "../../components/common";
import { Icon } from "../../components/icons";
import { t, tOr } from "../../i18n";

/** The method a reproduction run is (core/semantic-modules/reproduction). */
const METHOD = "confirm-by-reproduction";

/** One finding of the report of GET /api/semantic/runs/:id/report, with what the reproduction views add to it. */
export interface ReproFinding {
  confirmation: string;
  recordedConfirmation?: string;
  candidateId?: string | null;
  reproducible?: { runner: string | null; code: string | null };
  reproduction?: { state: "none" | "attempted" | "confirmed"; reason: string | null; detail: string | null; reproductionRunId: string | null; record: string | null; proposal: string | null };
}

/** What the report says about reproduction as a whole. */
export interface ReproReport {
  runId: string;
  lifecycle: string;
  /** The run's methods read source code, so its needs-validation findings can be reproduced. */
  reproducible?: boolean;
  reproduction?: { reproduces: string | null; counts: { confirmed: number; attempted: number; none: number }; runs: string[] } | null;
  findings: ReproFinding[];
}

/** What blocks every finding at once: no engine (or tools image), or dependencies not prepared. */
type Gate = "checking" | "engine" | "dependencies" | null;

interface EnvironmentState {
  notReady?: string[];
}

interface PlanPreview {
  plan: { reproduction?: { seedRun: string | null; findingsToTry: number; budget: { maxCalls: number }; execution: { network: string } } | null; blockers: Array<{ message: string }> };
}

interface Evidence {
  test: { path: string; runner: string; content: string | null } | null;
  execution: { executed: boolean; outcome: string; tests: { total: number; pass: number; fail: number } | null; output: string; reason: string | null } | null;
  reproductionRunId: string;
}

const pending = (f: ReproFinding): boolean => (f.recordedConfirmation ?? f.confirmation) === "needs-validation" && f.reproduction?.state !== "confirmed";

/** Why a finding cannot be tried right now, or null when it can. */
function blockedReason(f: ReproFinding, gate: Gate): { key: string; action?: { href: string; label: string } } | null {
  if (!f.candidateId) return { key: "semres_repro_blocked_no_id" };
  if (f.reproducible?.code) return { key: "semres_repro_blocked_runner" };
  if (gate === "checking") return { key: "semres_repro_blocked_checking" };
  if (gate === "engine") return { key: "semres_repro_blocked_engine", action: { href: "#/environment?section=engine", label: t("semres_repro_action_engine") } };
  if (gate === "dependencies") return { key: "semres_repro_blocked_dependencies", action: { href: "#/environment?section=dependencies", label: t("semres_repro_action_dependencies") } };
  return null;
}

/** The test of a reproduction and what it printed (masked by the server), loaded when the person asks for it. */
function EvidenceDetails({ runId, candidateId }: { runId: string; candidateId: string }) {
  const [open, setOpen] = useState(false);
  const loaded = useAsync(() => (open ? api<Evidence>("GET", `/api/semantic/runs/${encodeURIComponent(runId)}/reproduction/${encodeURIComponent(candidateId)}`) : Promise.resolve(null)), `repro-evidence:${runId}:${candidateId}:${open}`);
  const data = loaded.data;
  return (
    <div className="stack" style={{ gap: 4 }} data-testid={`repro-evidence-${candidateId}`}>
      <button type="button" className="btn small" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? t("semres_repro_evidence_hide") : t("semres_repro_evidence_show")}
      </button>
      {open && loaded.loading && !data ? <span className="small muted">{t("semres_repro_loading")}</span> : null}
      {open && loaded.error ? <span className="small" role="alert">{loaded.error instanceof ApiError ? loaded.error.message : t("semres_repro_evidence_error")}</span> : null}
      {open && data ? (
        <div className="stack" style={{ gap: 6 }}>
          {data.test ? (
            <>
              <strong className="small">
                {t("semres_repro_test")} <code>{data.test.path}</code> ({data.test.runner})
              </strong>
              <pre className="log" tabIndex={0} aria-label={t("semres_repro_test")} data-testid={`repro-test-${candidateId}`} style={{ margin: 0, overflow: "auto", maxHeight: 280 }}>
                {data.test.content ?? t("semres_repro_test_unavailable")}
              </pre>
            </>
          ) : null}
          {data.execution?.executed ? (
            <>
              <strong className="small">
                {t("semres_repro_output")}
                {data.execution.tests ? ` · ${t("semres_repro_tests", { pass: data.execution.tests.pass, total: data.execution.tests.total })}` : ""}
              </strong>
              <pre className="log" tabIndex={0} aria-label={t("semres_repro_output")} data-testid={`repro-output-${candidateId}`} style={{ margin: 0, overflow: "auto", maxHeight: 280 }}>
                {data.execution.output || t("semres_repro_output_empty")}
              </pre>
            </>
          ) : (
            <span className="small muted">{t("semres_repro_not_executed")}</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The reproduction cell of one finding: the state it has, with its evidence, and the action to try. */
export function ReproductionCell({ report, finding, gate, onTry }: { report: ReproReport; finding: ReproFinding; gate: Gate; onTry: (candidateId: string, trigger: HTMLElement) => void }) {
  const r = finding.reproduction;
  const blocked = pending(finding) ? blockedReason(finding, gate) : null;
  return (
    <div className="stack" style={{ gap: 4 }} data-testid="repro-cell" data-candidate={finding.candidateId ?? ""} data-state={r?.state ?? "none"}>
      {r?.state === "confirmed" ? (
        <>
          <span className="small">
            <strong>{t("semres_repro_confirmed")}</strong>
            {r.reproductionRunId ? (
              <>
                {" · "}
                <a href={`#/semantic/results/${encodeURIComponent(r.reproductionRunId)}`}>{t("semres_repro_run_link")}</a>
              </>
            ) : null}
          </span>
          {finding.candidateId ? <EvidenceDetails runId={report.runId} candidateId={finding.candidateId} /> : null}
        </>
      ) : null}
      {r?.state === "attempted" ? (
        <>
          <span className="small" data-testid="repro-attempted">
            <Pill tone="gold">{t("semres_repro_attempted", { reason: tOr(`semres_repro_reason_${r.reason ?? "NOT_RUN"}`, r.reason ?? "") })}</Pill>
            {r.reproductionRunId ? (
              <>
                {" "}
                <a href={`#/semantic/results/${encodeURIComponent(r.reproductionRunId)}`}>{t("semres_repro_run_link")}</a>
              </>
            ) : null}
          </span>
          <span className="small muted">{t("semres_repro_never_rejects")}</span>
          {finding.candidateId ? <EvidenceDetails runId={report.runId} candidateId={finding.candidateId} /> : null}
        </>
      ) : null}
      {pending(finding) ? (
        <>
          <button
            type="button"
            className="btn small"
            data-testid="repro-try"
            disabled={blocked !== null}
            aria-describedby={blocked ? `repro-why-${finding.candidateId ?? "x"}` : undefined}
            onClick={(e) => finding.candidateId && onTry(finding.candidateId, e.currentTarget)}
          >
            <Icon name="play" />
            {t("semres_repro_try")}
          </button>
          {blocked ? (
            <span className="small muted" id={`repro-why-${finding.candidateId ?? "x"}`} data-testid="repro-blocked" data-reason={blocked.key}>
              {t(blocked.key)}
              {blocked.action ? (
                <>
                  {" "}
                  <a href={blocked.action.href}>{blocked.action.label}</a>
                </>
              ) : null}
            </span>
          ) : null}
        </>
      ) : null}
      {!pending(finding) && r?.state !== "confirmed" && r?.state !== "attempted" ? <span className="muted small">-</span> : null}
    </div>
  );
}

/**
 * The reproduction offer of a Semantic result: the state of the environment, the action of each finding and of the
 * whole list, and the confirmation that shows what the attempt may cost before anything starts.
 */
export function useReproduction(report: ReproReport): {
  /** Whether the result offers reproduction at all (a settled run of a method that reads source, with a needs-validation finding). */
  offered: boolean;
  gate: Gate;
  all: ReactNode;
  panel: ReactNode;
  cell: (finding: ReproFinding) => ReactNode;
  note: ReactNode;
} {
  const offered = report.lifecycle === "settled" && report.reproducible === true && report.reproduction?.reproduces == null && report.findings.some(pending);
  const env = useAsync(() => (offered ? api<EnvironmentState>("GET", "/api/environment/state") : Promise.resolve(null)), `repro-env:${report.runId}:${offered}`);
  const gate: Gate = !offered ? null : env.loading && !env.data ? "checking" : env.data?.notReady?.some((n) => n === "engine" || n === "image") ? "engine" : env.data?.notReady?.includes("dependencies") ? "dependencies" : null;
  const [target, setTarget] = useState<{ finding: string | null } | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const actionable = report.findings.filter((f) => pending(f) && blockedReason(f, gate) === null);

  function open(finding: string | null, from: HTMLElement) {
    trigger.current = from;
    setTarget({ finding });
  }
  function close() {
    setTarget(null);
    const back = trigger.current;
    // Back to the control that opened the confirmation, once it is gone.
    if (back) setTimeout(() => back.isConnected && back.focus(), 0);
  }

  const all = offered ? (
    <div className="stack" style={{ gap: 4 }}>
      <button type="button" className="btn" data-testid="repro-try-all" disabled={actionable.length === 0} onClick={(e) => open(null, e.currentTarget)}>
        <Icon name="play" />
        {t("semres_repro_try_all", { count: actionable.length })}
      </button>
    </div>
  ) : null;

  const note = report.reproduction?.reproduces ? (
    <p className="small" data-testid="repro-reproduces">
      {t("semres_repro_reproduces")} <a href={`#/semantic/results/${encodeURIComponent(report.reproduction.reproduces)}`}>{report.reproduction.reproduces}</a>
    </p>
  ) : null;

  return {
    offered,
    gate,
    all,
    note,
    panel: target ? <ConfirmPanel runId={report.runId} finding={target.finding} fallbackCount={target.finding ? 1 : actionable.length} onClose={close} /> : null,
    cell: (finding) => <ReproductionCell report={report} finding={finding} gate={gate} onTry={(candidateId, el) => open(candidateId, el)} />,
  };
}

/** What the attempt may cost, shown before it starts; nothing runs until it is confirmed. */
function ConfirmPanel({ runId, finding, fallbackCount, onClose }: { runId: string; finding: string | null; fallbackCount: number; onClose: () => void }) {
  const query = `methods=${METHOD}&from=${encodeURIComponent(runId)}${finding ? `&finding=${encodeURIComponent(finding)}` : ""}`;
  const preview = useAsync(() => api<PlanPreview>("GET", `/api/semantic/plan?${query}`), `repro-plan:${query}`);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    head.current?.focus();
  }, []);
  const plan = preview.data?.plan ?? null;
  const reproduction = plan?.reproduction ?? null;
  const count = reproduction && reproduction.findingsToTry > 0 ? reproduction.findingsToTry : fallbackCount;
  const blockers = plan?.blockers ?? [];

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const started = await api<{ run: { runId: string } }>("POST", "/api/semantic/runs", { methods: [METHOD], reproduction: { from: runId, ...(finding ? { finding } : {}) } });
      window.location.hash = `#/semantic/runs/${encodeURIComponent(started.run.runId)}`;
    } catch (e) {
      setError(e);
      setStarting(false);
    }
  }

  return (
    <section
      className="card flat stack"
      role="group"
      aria-labelledby="repro-confirm-title"
      data-testid="repro-confirm"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !starting) onClose();
      }}
    >
      <h3 id="repro-confirm-title" tabIndex={-1} ref={head}>
        {finding ? t("semres_repro_confirm_title_one") : t("semres_repro_confirm_title_all")}
      </h3>
      {preview.loading && !preview.data ? <p className="muted small">{t("semres_repro_cost_loading")}</p> : null}
      {preview.error ? <p role="alert">{preview.error instanceof ApiError ? preview.error.message : t("semres_repro_cost_error")}</p> : null}
      {plan ? (
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }} data-testid="repro-cost">
          <li data-testid="repro-cost-findings" data-count={count}>
            {t("semres_repro_cost_findings", { count })}
          </li>
          <li data-testid="repro-cost-calls" data-calls={reproduction?.budget.maxCalls ?? ""}>
            {reproduction ? t("semres_repro_cost_calls", { calls: reproduction.budget.maxCalls }) : t("semres_repro_cost_calls_unknown")}
          </li>
          <li data-testid="repro-cost-container">{t("semres_repro_cost_container")}</li>
          <li>{t("semres_repro_never_rejects")}</li>
        </ul>
      ) : null}
      {blockers.length > 0 ? (
        <div className="notice warn" role="status">
          <Icon name="alert" />
          <span>{blockers.map((b) => b.message).join(" ")}</span>
        </div>
      ) : null}
      {error ? <p role="alert">{error instanceof ApiError ? error.message : t("semres_repro_start_error")}</p> : null}
      <div className="row wrap">
        <button type="button" className="btn primary" data-testid="repro-confirm-start" disabled={!plan || blockers.length > 0 || starting} onClick={() => void start()}>
          <Icon name="play" />
          {starting ? t("semres_repro_starting") : t("semres_repro_start")}
        </button>
        <button type="button" className="btn" data-testid="repro-confirm-cancel" disabled={starting} onClick={onClose}>
          {t("semres_repro_cancel")}
        </button>
      </div>
    </section>
  );
}
