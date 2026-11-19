// "N checks are new since your last validation": the tools of a plan (overview) or of a result (result screen) that the
// last finished validation before it did not run. Both sides are compared by tool id, so a tool that only changed its
// state (failed, then passed) is never "new". Without a validation to compare with there is nothing to name.
import type { ResultStage } from "../run/types.js";

/** A check that is new: its tool id and the name the screens show. */
export interface NewCheck {
  tool: string;
  label: string;
}

/** The tool a stage belongs to: its adapter, else the part of the stage id before "#". */
export function stageTool(stage: Pick<ResultStage, "id" | "adapter">): string {
  return typeof stage.adapter === "string" && stage.adapter !== "" ? stage.adapter : String(stage.id).split("#")[0] ?? "";
}

/** The tools a stored result ran or tried to run (composite stages are only wrappers). */
export function toolsOfStages(stages: ReadonlyArray<Pick<ResultStage, "id" | "adapter" | "kind">> | undefined): Set<string> {
  const out = new Set<string>();
  for (const s of stages ?? []) {
    if (s.kind === "composite") continue;
    // The instance id (the stage id before "#") and the adapter: a plan names an instance, a stage may name either.
    for (const tool of [String(s.id).split("#")[0] ?? "", stageTool(s)]) if (tool !== "") out.add(tool);
  }
  return out;
}

/** The tools of `current` that `previous` does not hold, by tool id; empty when there is no previous validation. */
export function newChecks(current: Iterable<{ tool: string; label?: string | undefined }>, previous: Set<string> | null): NewCheck[] {
  if (previous === null || previous.size === 0) return [];
  const fresh = new Map<string, NewCheck>();
  for (const c of current) if (c.tool !== "" && !previous.has(c.tool) && !fresh.has(c.tool)) fresh.set(c.tool, { tool: c.tool, label: c.label && c.label !== "" ? c.label : c.tool });
  return [...fresh.values()].sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
}
