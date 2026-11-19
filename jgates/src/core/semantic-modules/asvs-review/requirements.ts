// Which requirements the method asvs-review reviews: for the project's ASVS level, every requirement whose mapping entry
// says its evidence is the repository, that the latest Quality run's map does not show as examined by a deterministic
// check, and that the user did not record as not applicable. The map is read with "deterministic only", so an earlier
// AI review never removes a requirement from the list; it is built from stored files only (ADR-0010). Without a Quality
// run there is nothing to measure "not examined" against, and the method refuses: validate the project first.
//
// The requirements are grouped by chapter into review units, in the order of the release file.
import path from "node:path";
import { resolveHome } from "../../home/index.js";
import { workspaceId } from "../../ids/index.js";
import { SEMANTIC_RUNS_DIR } from "../../semantic/store.js";
import { ASVS_MAP_DIR_ENV, buildAsvsMap, loadAsvs, type AsvsLevel } from "../../coverage/asvs/index.js";

export const ASVS_REVIEW_NO_QUALITY_RUN = "ASVS_REVIEW_NO_QUALITY_RUN";
export const ASVS_REVIEW_NOTHING_TO_REVIEW = "ASVS_REVIEW_NOTHING_TO_REVIEW";
export const ASVS_REVIEW_MAP_UNAVAILABLE = "ASVS_REVIEW_MAP_UNAVAILABLE";
/** The refusal codes of the plan of asvs-review (each has its message in both languages: semantic_blocker_<code>). */
export const ASVS_REVIEW_REFUSALS = [ASVS_REVIEW_NO_QUALITY_RUN, ASVS_REVIEW_NOTHING_TO_REVIEW, ASVS_REVIEW_MAP_UNAVAILABLE] as const;

export interface PlannedRequirement {
  id: string;
  chapter: string;
  section: string;
  level: AsvsLevel;
}

/** One review unit: a chapter and the requirements of the plan in it. */
export interface AsvsReviewUnitPlan {
  id: string;
  name: string;
  requirements: PlannedRequirement[];
}

export interface AsvsReviewSelection {
  /** The Quality run whose map decided what is not examined. */
  qualityRun: string;
  asvsVersion: string;
  level: AsvsLevel;
  levelSource: "option" | "project" | "default";
  requirements: PlannedRequirement[];
  units: AsvsReviewUnitPlan[];
}

export type AsvsReviewRefusal = { code: (typeof ASVS_REVIEW_REFUSALS)[number]; missing: string; reason: string };

/** The data folder and workspace of a run folder (`<home>/workspaces/<id>/semantic-runs/<run>`), or null. */
function locationOfRunDir(runDir: string): { home: string; workspaceId: string } | null {
  const parent = path.dirname(path.resolve(runDir));
  if (path.basename(parent) !== SEMANTIC_RUNS_DIR) return null;
  const ws = path.dirname(parent);
  const workspaces = path.dirname(ws);
  if (path.basename(workspaces) !== "workspaces") return null;
  return { home: path.dirname(workspaces), workspaceId: path.basename(ws) };
}

/**
 * The requirements asvs-review reviews in a workspace, grouped by chapter; or why it refuses. `runDir` locates the data
 * folder and the workspace of the run (a plan preview passes a folder of the same place that is never created).
 */
export function selectReviewRequirements(input: { workspacePath: string; env: NodeJS.ProcessEnv; runDir: string; home?: string }): AsvsReviewSelection | AsvsReviewRefusal {
  const located = locationOfRunDir(input.runDir);
  const home = input.home ?? located?.home ?? resolveHome({ env: input.env });
  const wsId = located?.workspaceId ?? workspaceId(path.resolve(input.workspacePath));
  const mappingDir = input.env[ASVS_MAP_DIR_ENV]?.trim();
  const map = buildAsvsMap({ home, workspaceId: wsId, projectDir: input.workspacePath, deterministicOnly: true, ...(mappingDir ? { mappingDir } : {}) });
  if ("ok" in map) return { code: ASVS_REVIEW_MAP_UNAVAILABLE, missing: "ASVS coverage map", reason: `the ASVS coverage map cannot be built: ${map.message}` };
  if (!map.runs.quality) return { code: ASVS_REVIEW_NO_QUALITY_RUN, missing: "Quality run", reason: "no finished Quality run of this workspace: validate the project first, so the map can say which requirements no deterministic check examined" };
  const rows = map.requirements.filter((r) => r.evidence === "repository" && r.state !== "not-applicable" && !(r.state === "examined" && r.basis === "deterministic"));
  if (rows.length === 0) {
    return { code: ASVS_REVIEW_NOTHING_TO_REVIEW, missing: "requirement to review", reason: `every requirement of level ${map.level} whose evidence is the repository was examined by a deterministic check or recorded as not applicable` };
  }
  const data = loadAsvs(map.asvsVersion);
  const requirements: PlannedRequirement[] = rows.map((r) => ({ id: r.id, chapter: r.chapter, section: r.section, level: r.level }));
  const units: AsvsReviewUnitPlan[] = [];
  for (const r of requirements) {
    let unit = units.find((u) => u.id === r.chapter);
    if (!unit) units.push((unit = { id: r.chapter, name: data.chapters.find((c) => c.id === r.chapter)?.name ?? r.chapter, requirements: [] }));
    unit.requirements.push(r);
  }
  return { qualityRun: map.runs.quality.runId, asvsVersion: map.asvsVersion, level: map.level, levelSource: map.levelSource, requirements, units };
}

/** The official text of a requirement, read from the vendored release file at the moment it is needed (never stored). */
export function requirementText(asvsVersion: string, id: string): string | null {
  try {
    return loadAsvs(asvsVersion).requirements.find((r) => r.id === id)?.text ?? null;
  } catch {
    return null;
  }
}
