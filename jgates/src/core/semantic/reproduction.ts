// The link between a Semantic run and the reproduction runs (method confirm-by-reproduction) that started from it. The
// earlier run is never rewritten: its findings' reproduction state is read at view time from the reproduction runs of
// the workspace that name it (their reproduction.json, or their investigation record when the run ended before one was
// written). A finding is "confirmed" (evidence basis execution) once a reproduction run reproduced it, "attempted" with
// the reason when runs tried and did not, and "none" when no run tried. A later attempt never undoes a confirmation, and
// nothing here ever rejects a finding or changes its severity.
import fs from "node:fs";
import path from "node:path";
import { INVESTIGATION_RECORD } from "../semantic-executor/index.js";
import { EXECUTION_FILE, REPRODUCTION_FILE, REPRODUCTION_METHOD } from "../semantic-modules/reproduction/index.js";
import { SEMANTIC_PLAN_FILE, SEMANTIC_RESULT_FILE, listSemanticRuns, type SemanticRunInfo } from "./store.js";

export type ReproductionState = "none" | "attempted" | "confirmed";

/** What the reproduction runs say about one finding of an earlier run. */
export interface FindingReproduction {
  /** The finding's candidate in the earlier run (C1, C2...). */
  candidateId: string;
  state: Exclude<ReproductionState, "none">;
  /** execution when confirmed (the reproducer executed, failed and the failure was attributed to the defect). */
  evidenceBasis: "execution" | null;
  /** Why it stays needs-validation (an attempt reason or a reason code); null when confirmed. */
  reason: string | null;
  detail: string;
  /** The reproduction run the state comes from, and its records (paths inside that run's folder). */
  reproductionRunId: string;
  record: string | null;
  execution: string | null;
  /** The regression proposal of the reproducer (<run>/<P1>), when it reproduced. */
  proposal: string | null;
  at: string | null;
  /** Every reproduction run that tried this finding, oldest first. */
  runs: string[];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function readJson(dir: string, rel: string): Rec | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, ...rel.split("/")), "utf8")) as unknown;
    return isRec(value) ? value : null;
  } catch {
    return null;
  }
}

/** One finding as one reproduction run reports it ("*": every needs-validation finding of the earlier run). */
type Entry = Omit<FindingReproduction, "runs">;

/** What one settled reproduction run says: the earlier run it names and an entry per finding it tried. */
function entriesOf(run: Pick<SemanticRunInfo, "runId" | "dir" | "startedAt">): { target: string; entries: Entry[] } | null {
  const base = { reproductionRunId: run.runId, at: run.startedAt };
  const doc = readJson(run.dir, REPRODUCTION_FILE);
  if (doc && doc.kind === "semantic-reproduction" && isRec(doc.seedRun) && typeof doc.seedRun.runId === "string") {
    const entries: Entry[] = [];
    for (const f of list(doc.findings).filter(isRec)) {
      const finding = isRec(f.finding) ? f.finding : {};
      const candidateId = text(finding.candidateId);
      if (!candidateId) continue;
      const reproduced = f.outcome === "reproduced";
      entries.push({
        ...base,
        candidateId,
        state: reproduced ? "confirmed" : "attempted",
        evidenceBasis: reproduced ? "execution" : null,
        reason: reproduced ? null : (text(f.reason) ?? "NOT_RUN"),
        detail: text(f.detail) ?? "",
        record: REPRODUCTION_FILE,
        execution: isRec(f.execution) ? EXECUTION_FILE : null,
        proposal: text(f.proposal) ? `${run.runId}/${String(f.proposal)}` : null,
      });
    }
    for (const s of list(doc.skipped).filter(isRec)) {
      const candidateId = text(s.candidateId);
      if (candidateId) entries.push({ ...base, candidateId, state: "attempted", evidenceBasis: null, reason: text(s.code) ?? "NOT_RUN", detail: text(s.reason) ?? "", record: REPRODUCTION_FILE, execution: null, proposal: null });
    }
    return { target: doc.seedRun.runId, entries };
  }
  // No reproduction.json: the run ended before its report (not applicable, nothing executed, cancelled). What it tried
  // comes from its investigation record and its plan; every finding stays needs-validation with the reason.
  const result = readJson(run.dir, SEMANTIC_RESULT_FILE);
  const outcome = isRec(result?.semanticRun) && isRec(result.semanticRun.outcome) ? result.semanticRun.outcome : null;
  const investigation = isRec(outcome?.investigation) ? outcome.investigation : readJson(run.dir, INVESTIGATION_RECORD);
  const applicability = isRec(investigation?.applicability) ? investigation.applicability : {};
  const asked = (() => {
    const plan = readJson(run.dir, SEMANTIC_PLAN_FILE);
    return isRec(plan?.reproduction) ? plan.reproduction : null;
  })();
  const target = (isRec(applicability.seedRun) ? text(applicability.seedRun.runId) : null) ?? text(asked?.seedRun) ?? text(asked?.from);
  if (!target) return null;
  const why = text(outcome?.reason) ?? text(applicability.reason) ?? "the reproduction run ended before it executed anything";
  const code = text(applicability.code) ?? "NOT_EXECUTED";
  const candidates = list(investigation?.candidates).filter(isRec);
  const entries: Entry[] = [];
  const add = (candidateId: string, reason: string, detail: string): void => {
    const c = candidates.find((x) => isRec(x.details) && isRec(x.details.seed) && x.details.seed.candidateId === candidateId);
    const details = isRec(c?.details) ? c.details : {};
    // An executed, failing and attributed reproducer already confirmed it, even if the run's report is missing.
    const confirmed = c?.status === "confirmed" && details.evidence_basis === "execution";
    const tried = isRec(details.reproduction) ? details.reproduction : null;
    entries.push({
      ...base,
      candidateId,
      state: confirmed ? "confirmed" : "attempted",
      evidenceBasis: confirmed ? "execution" : null,
      reason: confirmed ? null : (text(tried?.reason) ?? reason),
      detail: confirmed ? "the reproducer executed, failed, and the assessment attributes the failure to the defect" : (text(tried?.detail) ?? detail),
      record: INVESTIGATION_RECORD,
      execution: tried?.executed === true || confirmed ? EXECUTION_FILE : null,
      proposal: null,
    });
  };
  for (const f of list(applicability.findings).filter(isRec)) if (text(f.candidateId)) add(String(f.candidateId), code, why);
  for (const s of list(applicability.skipped).filter(isRec)) if (text(s.candidateId)) add(String(s.candidateId), text(s.code) ?? code, text(s.reason) ?? why);
  if (entries.length === 0) {
    const named = list(asked?.findings).filter((f): f is string => typeof f === "string" && f !== "");
    for (const id of named.length > 0 ? named : ["*"]) add(id, code, why);
  }
  return { target, entries };
}

/** The settled reproduction runs of a workspace, oldest first. */
function reproductionRuns(home: string, workspaceId: string): SemanticRunInfo[] {
  return listSemanticRuns(home, workspaceId)
    .filter((r) => r.lifecycle === "settled" && r.methods.includes(REPRODUCTION_METHOD))
    .reverse();
}

/** Every earlier run a reproduction run named, with the state of each finding it tried (key "*": all of them). */
export function reproductionIndex(home: string, workspaceId: string): Map<string, Map<string, FindingReproduction>> {
  const index = new Map<string, Map<string, FindingReproduction>>();
  for (const run of reproductionRuns(home, workspaceId)) {
    const found = entriesOf(run);
    if (!found) continue;
    let byFinding = index.get(found.target);
    if (!byFinding) index.set(found.target, (byFinding = new Map()));
    for (const entry of found.entries) {
      const prior = byFinding.get(entry.candidateId);
      const runs = [...(prior?.runs ?? []), ...(prior?.runs.includes(run.runId) ? [] : [run.runId])];
      // A confirmation stands: a later attempt that did not reproduce adds to the runs but never undoes it.
      const keep = prior && prior.state === "confirmed" && entry.state !== "confirmed";
      byFinding.set(entry.candidateId, keep ? { ...prior, runs } : { ...entry, runs });
    }
  }
  return index;
}

/** The candidates of a stored Semantic run (its investigation), as the earlier run recorded them. */
function candidatesOf(runDir: string): Rec[] {
  const result = readJson(runDir, SEMANTIC_RESULT_FILE);
  const outcome = isRec(result?.semanticRun) && isRec(result.semanticRun.outcome) ? result.semanticRun.outcome : null;
  const investigation = isRec(outcome?.investigation) ? outcome.investigation : readJson(runDir, INVESTIGATION_RECORD);
  return list(investigation?.candidates).filter(isRec);
}

/** One finding of an earlier run with its reproduction state, as the history, the views and the CLI show it. */
export interface FindingReproductionView {
  candidateId: string;
  title: string;
  path: string | null;
  line: number | null;
  severity: string;
  /** What the earlier run recorded (never rewritten). */
  recordedConfirmation: string;
  /** What a screen shows: confirmed when a reproduction confirmed it, else the recorded confirmation. */
  confirmation: string;
  evidenceBasis: "execution" | null;
  state: ReproductionState;
  reason: string | null;
  detail: string | null;
  reproductionRunId: string | null;
  record: string | null;
  execution: string | null;
  proposal: string | null;
  runs: string[];
}

/** A stored run as the history or a view knows it. */
export type RunRef = Pick<SemanticRunInfo, "runId" | "dir" | "methods">;

export interface RunReproduction {
  /** This run is itself a reproduction run: the earlier run it started from. */
  reproduces: string | null;
  /** The findings of this run a reproduction can concern (needs-validation, or already tried), with their state. */
  findings: FindingReproductionView[];
  counts: { confirmed: number; attempted: number; none: number };
  /** The reproduction runs that named this run, oldest first. */
  runs: string[];
}

/** The reproduction state of every finding of one run (needs-validation or tried), read from the reproduction runs. */
export function runReproduction(run: RunRef, index: Map<string, Map<string, FindingReproduction>>): RunReproduction {
  // A reproduction run's own findings are never reproduced again: it only says which earlier run it started from.
  if (run.methods.includes(REPRODUCTION_METHOD)) {
    return { reproduces: entriesOf({ ...run, startedAt: null })?.target ?? null, findings: [], counts: { confirmed: 0, attempted: 0, none: 0 }, runs: [] };
  }
  const byFinding = index.get(run.runId) ?? new Map<string, FindingReproduction>();
  const all = byFinding.get("*") ?? null;
  const findings: FindingReproductionView[] = [];
  const runs = new Set<string>();
  for (const c of candidatesOf(run.dir)) {
    const candidateId = text(c.id);
    if (!candidateId) continue;
    const recorded = typeof c.status === "string" ? c.status : "open";
    const link = byFinding.get(candidateId) ?? (recorded === "needs-validation" ? all : null);
    if (recorded !== "needs-validation" && !link) continue;
    for (const r of link?.runs ?? []) runs.add(r);
    const confirmed = link?.state === "confirmed";
    findings.push({
      candidateId,
      title: text(c.title) ?? candidateId,
      path: text(c.path),
      line: typeof c.line === "number" ? c.line : null,
      severity: typeof c.severity === "string" ? c.severity : "important",
      recordedConfirmation: recorded,
      confirmation: confirmed ? "confirmed" : recorded,
      evidenceBasis: confirmed ? "execution" : null,
      state: link?.state ?? "none",
      reason: link?.reason ?? null,
      detail: link ? link.detail : null,
      reproductionRunId: link?.reproductionRunId ?? null,
      record: link?.record ?? null,
      execution: link?.execution ?? null,
      proposal: link?.proposal ?? null,
      runs: link?.runs ?? [],
    });
  }
  const count = (s: ReproductionState): number => findings.filter((f) => f.state === s).length;
  return { reproduces: null, findings, counts: { confirmed: count("confirmed"), attempted: count("attempted"), none: count("none") }, runs: [...runs].sort() };
}

/** History entries with the reproduction state of their findings (the index of the workspace is built once). */
export function withReproduction<T extends RunRef>(home: string, workspaceId: string, runs: readonly T[]): Array<T & { reproduction: RunReproduction }> {
  const index = reproductionIndex(home, workspaceId);
  return runs.map((run) => ({ ...run, reproduction: runReproduction(run, index) }));
}

/** The reproduction state of one run's findings (builds the index of the workspace once). */
export function reproductionOf(home: string, workspaceId: string, run: RunRef): RunReproduction {
  return runReproduction(run, reproductionIndex(home, workspaceId));
}
