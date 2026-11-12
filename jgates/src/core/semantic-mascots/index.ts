// Read-only presentation of a Semantic run as six AI mascots, one per phase of the Cloudflare security-audit method
// (reconnaissance, coverage-led hunting, candidate validation, structured output, independent verification,
// target-neutral reporting). It maps the stages of an investigation module (the Cloudflare stages, the general-review
// stages, the context/review steps) to exactly one mascot by STAGE PHASE, so a stage id nobody listed still lands on one
// mascot without a code change. It never reads a Quality domain: Quality's six mascots (core/mascots) are a different
// family and a different projection.

export const SEMANTIC_MASCOTS = ["atlas", "trace", "verdict", "fit", "seal", "folio"] as const;
export type SemanticMascotId = (typeof SEMANTIC_MASCOTS)[number];
export type SemanticMascotState = "waiting" | "working" | "done" | "incomplete" | "failed" | "cancelled";

/**
 * The four role ids of the first Semantic mascots, as stored runs and older clients may still carry them, and the phase
 * mascot each one became. Nothing that reads a stored id breaks: it resolves through resolveSemanticMascot().
 */
export const LEGACY_SEMANTIC_MASCOTS: Readonly<Record<string, SemanticMascotId>> = Object.freeze({
  scout: "atlas",
  tracker: "trace",
  challenger: "verdict",
  verifier: "seal",
});

/**
 * Phase of each mascot, what it is responsible for and the stage ids (without the `<module>/` prefix) it is known to own.
 * `host` phases are done by JGates itself after the model stages (the Cloudflare module validates and writes the records,
 * then derives the reports): a module rarely has a stage of its own for them.
 */
export const SEMANTIC_MASCOT_GROUPS: Readonly<Record<SemanticMascotId, { phase: string; responsibility: string; host: boolean; stages: readonly string[] }>> = {
  atlas: { phase: "reconnaissance", responsibility: "map the code, its surfaces and trust boundaries, and plan the coverage", host: false, stages: ["reconnaissance", "coverage-planning", "semantic-context", "context"] },
  trace: { phase: "coverage-led-hunting", responsibility: "hunt for candidate problems in the planned units and find the coverage gaps", host: false, stages: ["hunting", "hunt", "coverage-critic", "semantic-review", "review"] },
  verdict: { phase: "candidate-validation", responsibility: "try to refute each candidate against the source", host: false, stages: ["refutation", "validate", "validation"] },
  fit: { phase: "structured-output", responsibility: "give every decided finding its schema-shaped record and check the ledger", host: true, stages: ["structured-output", "output", "records"] },
  seal: { phase: "independent-verification", responsibility: "re-check the final records in a fresh context", host: false, stages: ["verification", "verify"] },
  folio: { phase: "reporting", responsibility: "derive the readable report from the verified records", host: true, stages: ["reporting", "report", "summary"] },
};

/** The current mascot id of a mascot id, an old role id of a stored run, or null for anything else. */
export function resolveSemanticMascot(id: string): SemanticMascotId | null {
  if ((SEMANTIC_MASCOTS as readonly string[]).includes(id)) return id as SemanticMascotId;
  return LEGACY_SEMANTIC_MASCOTS[id] ?? null;
}

export interface SemanticStageInput {
  /** Stage id, with or without a `<module>/` prefix (`security-audit/hunting`). */
  id: string;
  /** pending | running | completed | budget-exhausted | invalid | timeout | error | cancelled | not-run. */
  state: string;
  required?: boolean;
  /** explore | validate (the executor stage role); decides the mascot of an id nobody listed. */
  role?: string;
  /** A verify-mode stage (independent verification of decided records). */
  verify?: boolean;
}

const baseId = (id: string): string => id.slice(id.lastIndexOf("/") + 1).toLowerCase();

/**
 * The one mascot of a stage: by known id, otherwise by the closest phase (verification, reporting, output shaping,
 * validation and refutation, context and planning, and hunting for anything else).
 */
export function mascotForStage(stage: Pick<SemanticStageInput, "id" | "role" | "verify">): SemanticMascotId {
  const id = baseId(stage.id);
  for (const m of SEMANTIC_MASCOTS) if (SEMANTIC_MASCOT_GROUPS[m].stages.includes(id)) return m;
  if (stage.verify || /verif/.test(id)) return "seal";
  if (/report|summar|final|digest/.test(id)) return "folio";
  if (/output|format|schema|structur|shap|record|normali[sz]/.test(id)) return "fit";
  if (stage.role === "validate" || /refut|critic|validat|challeng|adversar|skeptic|triage/.test(id)) return "verdict";
  if (/recon|plan|context|scope|map|discover|analy[sz]|survey/.test(id)) return "atlas";
  return "trace";
}

export interface SemanticMascotView {
  mascot: SemanticMascotId;
  state: SemanticMascotState;
  /** Stage ids owned by this mascot, in the order given. */
  stages: Array<{ id: string; state: SemanticMascotState }>;
  progress: { completed: number; total: number } | null;
}

export interface SemanticMascotSnapshot {
  schemaVersion: 1;
  runId: string | null;
  running: boolean;
  cancelled: boolean;
  mascots: SemanticMascotView[];
}

function stageState(state: string, running: boolean, cancelled: boolean): SemanticMascotState {
  if (cancelled) return state === "completed" ? "incomplete" : "cancelled";
  switch (state) {
    case "completed": return "done";
    case "running": return running ? "working" : "incomplete";
    case "pending": return running ? "waiting" : "incomplete";
    case "cancelled": return "cancelled";
    case "invalid": case "timeout": case "error": return "failed";
    default: return "incomplete"; // budget-exhausted, not-run, anything unknown: never favorable
  }
}

const PRIORITY: SemanticMascotState[] = ["failed", "cancelled", "incomplete", "working", "waiting", "done"];

/**
 * Projects stage records onto the six mascots. A cancelled run never shows a mascot as done (stages that completed before
 * the cancel stay `incomplete`: their evidence is kept, the run is not complete). A mascot with no stage in the module
 * stays `waiting` while the run goes; once the run stops, a model phase with no stage is `incomplete` (it did not
 * happen), while a host phase (structured output, reporting: JGates writes the records and derives the report after the
 * model stages) is `done` when every stage of the run completed and `incomplete` otherwise.
 */
export function projectSemanticMascots(input: {
  stages: readonly SemanticStageInput[];
  runId?: string | null;
  running?: boolean;
  /** The run's decision or state says it was cancelled. */
  cancelled?: boolean;
}): SemanticMascotSnapshot {
  const running = input.running === true && input.cancelled !== true;
  const cancelled = input.cancelled === true;
  const all = input.stages.map((s) => ({ mascot: mascotForStage(s), id: s.id, state: stageState(s.state, running, cancelled) }));
  const everyStageDone = all.length > 0 && all.every((s) => s.state === "done");
  const mascots = SEMANTIC_MASCOTS.map((mascot): SemanticMascotView => {
    const owned = all.filter((s) => s.mascot === mascot).map(({ id, state }) => ({ id, state }));
    let state: SemanticMascotState;
    if (!owned.length) {
      if (cancelled) state = "cancelled";
      else if (running) state = "waiting";
      else state = SEMANTIC_MASCOT_GROUPS[mascot].host && everyStageDone ? "done" : "incomplete";
    } else {
      state = PRIORITY.find((p) => owned.some((o) => o.state === p)) ?? "incomplete";
      // Some stages done and the rest still queued while the run goes: the mascot is working, not waiting.
      if (state === "waiting" && owned.some((o) => o.state === "done")) state = "working";
    }
    const completed = owned.filter((o) => o.state === "done").length;
    return { mascot, state, stages: owned, progress: owned.length ? { completed, total: owned.length } : null };
  });
  return { schemaVersion: 1, runId: input.runId ?? null, running, cancelled, mascots };
}
