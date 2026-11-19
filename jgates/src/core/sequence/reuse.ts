// Reuse of an equivalent Quality execution in a combined sequence (asked for explicitly: --reuse-quality or the API's
// reuseQuality). A finished Quality run stands in for a new one only when every input matches: the same source identity
// (current, recorded by the run itself), the same plan (its hash covers the configuration, the inventory, the
// selection and the versions), the same configuration, policy, templates and native files, the same tool versions and
// commands, the same JGates version, and a run that passed complete, not reduced, not partial and not stale. Anything
// else runs Quality again. The provenance says which run was reused and what matched; the reused run is never changed.
import fs from "node:fs";
import path from "node:path";
import { listRuns } from "../artifacts/index.js";
import { loadGateRecord } from "../gates/read.js";
import { sourceMatch } from "../gates/source.js";
import type { SourceIdentity } from "../gates/types.js";
import type { Plan } from "../plan/types.js";
import { hashesOfPlan, type AnalysisHashes } from "../provenance/index.js";
import type { RunResult } from "../run/types.js";
import { approvalWording } from "../results/index.js";
import { translator } from "../../i18n/index.js";

const t = translator("sequence");
/** The identity file a Quality run writes next to result.json (schemas/gates/run-identity). */
export const QUALITY_RUN_IDENTITY_FILE = "run.json";
/** How many finished runs are examined, newest first. */
const MAX_CANDIDATES = 20;

export interface ReuseMatch {
  field: "source" | "plan" | "config" | "policy" | "templates" | "nativeFiles" | "inventory" | "tools" | "version" | "outcome";
  matched: boolean;
  expected: string | null;
  found: string | null;
}

export interface ReuseOutcome {
  /** reused: an equivalent run stands in; executed: Quality runs again (no candidate, or none matched). */
  state: "reused" | "executed";
  /** The run reused, with what matched (every field matched for a reuse). */
  reusedFrom: { runId: string; finishedAt: string | null; sourceId: string; matches: ReuseMatch[] } | null;
  /** The newest candidate that did not match, and why (null when there was no candidate). */
  rejected: { runId: string; code: string; message: string; matches: ReuseMatch[] } | null;
  message: string;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

const FIELD_CODE: Record<ReuseMatch["field"], string> = {
  source: "REUSE_SOURCE_CHANGED",
  plan: "REUSE_PLAN_CHANGED",
  config: "REUSE_SETTINGS_CHANGED",
  policy: "REUSE_SETTINGS_CHANGED",
  templates: "REUSE_SETTINGS_CHANGED",
  nativeFiles: "REUSE_SETTINGS_CHANGED",
  inventory: "REUSE_INPUTS_CHANGED",
  tools: "REUSE_VERSIONS_CHANGED",
  version: "REUSE_VERSIONS_CHANGED",
  outcome: "REUSE_NOT_APPROVED",
};

/** Compares one finished Quality run with the plan about to run and the current source. */
export function compareQualityRun(dir: string, plan: Plan, current: SourceIdentity, version: string, options: { noWaivers?: boolean } = {}): { runId: string; finishedAt: string | null; sourceId: string | null; matches: ReuseMatch[] } | null {
  const result = readJson<RunResult>(path.join(dir, "result.json"));
  if (!result || typeof result.runId !== "string") return null;
  let sourceId: string | null = null;
  let sourceSame = false;
  try {
    const identity = loadGateRecord("run-identity", path.join(dir, QUALITY_RUN_IDENTITY_FILE));
    sourceId = identity.source.id;
    sourceSame = sourceMatch(identity.source, current).same;
  } catch {
    // Without its own run identity a run cannot prove which source it judged: it is never reused.
  }
  const expected: AnalysisHashes = hashesOfPlan(plan);
  const found: Partial<AnalysisHashes> = result.analyzed?.hashes ?? {};
  const hashField = (field: keyof AnalysisHashes & ReuseMatch["field"]): ReuseMatch => ({ field, matched: found[field] === expected[field], expected: expected[field], found: found[field] ?? null });
  const approved = result.decision === "passed" && result.complete === true && result.reduced !== true && result.partial !== true && result.analyzed?.stale !== true && !(options.noWaivers === true && approvalWording(result).kind === "with-waivers");
  const matches: ReuseMatch[] = [
    { field: "source", matched: sourceSame, expected: current.id, found: sourceId },
    hashField("plan"),
    hashField("config"),
    hashField("policy"),
    hashField("templates"),
    hashField("nativeFiles"),
    hashField("inventory"),
    hashField("tools"),
    { field: "version", matched: result.version === version, expected: version, found: typeof result.version === "string" ? result.version : null },
    { field: "outcome", matched: approved, expected: "passed/complete/not-reduced", found: `${String(result.decision)}/${result.complete === true ? "complete" : "incomplete"}/${result.reduced === true ? "reduced" : "not-reduced"}` },
  ];
  return { runId: result.runId, finishedAt: typeof result.finishedAt === "string" ? result.finishedAt : null, sourceId, matches };
}

/** The newest equivalent finished Quality run of the workspace, or why the newest candidate does not qualify. */
export function findEquivalentQuality(home: string, workspaceId: string, plan: Plan, current: SourceIdentity, version: string, options: { noWaivers?: boolean } = {}): ReuseOutcome {
  const runs = listRuns(home, workspaceId)
    .filter((r) => !r.partial)
    .slice(0, MAX_CANDIDATES);
  let rejected: ReuseOutcome["rejected"] = null;
  for (const run of runs) {
    const compared = compareQualityRun(run.dir, plan, current, version, options);
    if (!compared) continue;
    const miss = compared.matches.find((m) => !m.matched);
    if (!miss && compared.sourceId) {
      return {
        state: "reused",
        reusedFrom: { runId: compared.runId, finishedAt: compared.finishedAt, sourceId: compared.sourceId, matches: compared.matches },
        rejected,
        message: t("sequence_reuse_reused", { runId: compared.runId }),
      };
    }
    if (!rejected && miss) {
      const code = FIELD_CODE[miss.field];
      rejected = { runId: compared.runId, code, message: t(`sequence_${code.toLowerCase()}`, { runId: compared.runId, field: miss.field }), matches: compared.matches };
    }
  }
  return { state: "executed", reusedFrom: null, rejected, message: rejected ? rejected.message : t("sequence_reuse_none") };
}
