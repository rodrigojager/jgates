// The sequence as GET /api/sequences/:id shows it, and the state of each gate derived from the sequence's own records:
// the run references in the coordination record and the run summaries copied into details.json. A gate's state is that
// gate's own decision; nothing here merges the two.

export interface SequenceDto {
  sequenceId: string;
  lifecycle: "running" | "waiting" | "settled" | "interrupted";
  live?: boolean;
  record: {
    status: string;
    selectedGates: Array<"quality" | "semantic">;
    runs: Array<{ gate: "quality" | "semantic"; runId: string }>;
    reason?: { code: string; message: string };
  };
  details: {
    quality: { runId: string; decision: string | null; complete: boolean; reduced: boolean } | null;
    semantic: { runId: string; decision: string | null; complete: boolean; reduced: boolean } | null;
    assessment: { approved: boolean; status: string; code: string; message: string; reasons: Array<{ code: string; message: string }> } | null;
    coverage: { message: string } | null;
    timeline: Array<{ at: string; event: string; code?: string; runId?: string }>;
  } | null;
}

export type GateStateName = "not-started" | "running" | "passed" | "failed" | "incomplete" | "invalid" | "cancelled";

export interface GateView {
  state: GateStateName;
  runId: string | null;
  complete: boolean | null;
  reduced: boolean;
}

/** One gate of the sequence: not started (no run reference), running (a run without a decision yet) or its own decision. */
export function gateState(sequence: SequenceDto, gate: "quality" | "semantic"): GateView {
  const ref = sequence.record.runs.find((r) => r.gate === gate) ?? null;
  if (!ref) return { state: "not-started", runId: null, complete: null, reduced: false };
  const summary = sequence.details?.[gate] ?? null;
  const decision = summary?.decision ?? null;
  const known: GateStateName[] = ["passed", "failed", "incomplete", "invalid", "cancelled"];
  const state: GateStateName = decision && (known as string[]).includes(decision) ? (decision as GateStateName) : sequence.lifecycle === "running" ? "running" : "incomplete";
  return { state, runId: ref.runId, complete: summary ? summary.complete : null, reduced: summary?.reduced === true };
}
