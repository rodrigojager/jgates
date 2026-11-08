// Read-only presentation of a Semantic run as four AI mascots. It maps the stages of an investigation module (the
// Cloudflare security-audit phases, the general-review stages, the T13 context/review steps) to exactly one mascot by
// STAGE ROLE, so a stage id nobody listed still lands on one mascot without a code change. It never reads a Quality
// domain: Quality's six mascots (core/mascots) are a different family and a different projection.

export const SEMANTIC_MASCOTS = ["scout", "tracker", "challenger", "verifier"] as const;
export type SemanticMascotId = (typeof SEMANTIC_MASCOTS)[number];
export type SemanticMascotState = "waiting" | "working" | "done" | "incomplete" | "failed" | "cancelled";

/** Responsibility of each mascot and the stage ids (without the `<module>/` prefix) it is known to own. */
export const SEMANTIC_MASCOT_GROUPS: Readonly<Record<SemanticMascotId, { responsibility: string; stages: readonly string[] }>> = {
  scout: { responsibility: "analysis: map the code, plan the coverage", stages: ["reconnaissance", "coverage-planning", "semantic-context", "context"] },
  tracker: { responsibility: "investigation: hunt for candidate problems in the planned units", stages: ["hunting", "hunt", "semantic-review", "review"] },
  challenger: { responsibility: "adversarial validation: try to refute coverage and candidates", stages: ["coverage-critic", "refutation", "validate", "validation"] },
  verifier: { responsibility: "reporting: independent verification of the final records and the report", stages: ["verification", "report", "reporting"] },
};

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

/** The one mascot of a stage: by known id, otherwise by role and id keywords. */
export function mascotForStage(stage: Pick<SemanticStageInput, "id" | "role" | "verify">): SemanticMascotId {
  const id = baseId(stage.id);
  for (const m of SEMANTIC_MASCOTS) if (SEMANTIC_MASCOT_GROUPS[m].stages.includes(id)) return m;
  if (stage.verify || /verif|report|summar|final/.test(id)) return "verifier";
  if (stage.role === "validate" || /refut|critic|validat|challeng|adversar|skeptic/.test(id)) return "challenger";
  if (/recon|plan|context|scope|map|discover|analy[sz]/.test(id)) return "scout";
  return "tracker";
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
 * Projects stage records onto the mascots. A cancelled run never shows a mascot as done (stages that completed before
 * the cancel stay `incomplete`: their evidence is kept, the run is not complete). A mascot with no stage in the module
 * stays `waiting` while the run goes and `incomplete` otherwise.
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
  const mascots = SEMANTIC_MASCOTS.map((mascot): SemanticMascotView => {
    const owned = input.stages.filter((s) => mascotForStage(s) === mascot).map((s) => ({ id: s.id, state: stageState(s.state, running, cancelled) }));
    let state: SemanticMascotState;
    if (!owned.length) state = cancelled ? "cancelled" : running ? "waiting" : "incomplete";
    else {
      state = PRIORITY.find((p) => owned.some((o) => o.state === p)) ?? "incomplete";
      // Some stages done and the rest still queued while the run goes: the mascot is working, not waiting.
      if (state === "waiting" && owned.some((o) => o.state === "done")) state = "working";
    }
    const completed = owned.filter((o) => o.state === "done").length;
    return { mascot, state, stages: owned, progress: owned.length ? { completed, total: owned.length } : null };
  });
  return { schemaVersion: 1, runId: input.runId ?? null, running, cancelled, mascots };
}
