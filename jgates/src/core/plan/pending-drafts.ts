import { listDraftStatuses, type DraftStatus } from "../drafts/index.js";
import type { Plan } from "./types.js";

/**
 * Unsaved text of documents the plan uses (before running, the UI offers to save the pending
 * ones or to use the saved version; a buffer the plan does not use is never executed). A run reads the files on disk and
 * the plan carries their hashes, so what runs is always exactly the saved version the plan names.
 */
export interface PlanDraftOffer extends DraftStatus {
  /** The plan lists the document (a configuration file hashed in the plan) or runs the tool instance the draft belongs to. */
  usedByPlan: boolean;
  /** sha256 the plan recorded for the document ("sha256:<hex>"), or null when the plan does not list the file. */
  planSha256: string | null;
}

/** The pending drafts of the workspace, each one marked with whether (and with which hash) the plan uses it. */
export function draftsOfPlan(plan: Plan | null, dir: string, home: string, wsId: string): PlanDraftOffer[] {
  const files = new Map<string, string | null>();
  const tools = new Set<string>();
  if (plan) {
    for (const f of plan.inputs.configFiles) files.set(f.file, f.sha256);
    for (const item of plan.groups.willRun) {
      tools.add(item.tool);
      for (const f of item.configFiles) if (!files.has(f.file)) files.set(f.file, f.sha256);
    }
  }
  return listDraftStatuses(dir, home, wsId).map((s) => {
    const rel = s.draft.relPath;
    const listed = rel !== null && files.has(rel);
    return { ...s, usedByPlan: listed || tools.has(s.draft.ref.instance), planSha256: listed ? (files.get(rel) ?? null) : null };
  });
}
