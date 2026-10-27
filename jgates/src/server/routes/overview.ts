// Overview: one read-only answer with everything the first screen shows (discovery counts, profile, last run, next
// steps and the categories of the resolved profile), so the screen needs no more than one request.
import fs from "node:fs";
import path from "node:path";
import { listRuns } from "../../core/artifacts/index.js";
import { discoverWorkspace } from "../../core/discovery/index.js";
import { workspaceDir } from "../../core/home/index.js";
import { buildPlan, type Plan } from "../../core/plan/index.js";
import { RESULT_FILE } from "../../core/run/index.js";
import type { RouteDefinition, ServerContext } from "../types.js";

export type CategoryState = "included" | "gap" | "disabled";

export interface OverviewCategory {
  id: string;
  state: CategoryState;
  /** Checks that will run / checks turned off, for the label of the row. */
  checks: number;
  /** Why the category is a gap or disabled (the plan's own message), or null. */
  reason: string | null;
}

/** Categories of the resolved profile: included (something executable covers it), gap (required, nothing executable) or disabled. */
export function categoriesOf(plan: Plan): OverviewCategory[] {
  const ids = new Set<string>();
  for (const item of [...plan.groups.willRun, ...plan.groups.notApplicableOrDisabled]) if (item.category) ids.add(item.category);
  for (const r of plan.requirements) if (r.category) ids.add(r.category);
  for (const u of plan.groups.uncoveredRequirements) if (u.category) ids.add(u.category);
  const out: OverviewCategory[] = [];
  for (const id of [...ids].sort()) {
    const on = plan.groups.willRun.filter((i) => i.category === id && i.state.enabled);
    const executable = on.filter((i) => i.availability.status !== "not_executable");
    const uncovered = plan.groups.uncoveredRequirements.filter((u) => u.category === id);
    const lacking = uncovered.find((u) => u.reason === "NO_EXECUTABLE_CHECK" || u.reason === "EVIDENCE_MISSING");
    if (lacking && executable.length === 0) out.push({ id, state: "gap", checks: 0, reason: lacking.message });
    else if (on.length > 0 && executable.length === 0) out.push({ id, state: "gap", checks: 0, reason: on[0]?.availability.reason ?? null });
    else if (executable.length > 0) out.push({ id, state: "included", checks: executable.length, reason: null });
    else out.push({ id, state: "disabled", checks: 0, reason: uncovered[0]?.message ?? null });
  }
  return out;
}

function readLastRun(server: ServerContext): Record<string, unknown> | null {
  const runs = listRuns(server.home, server.workspace.id);
  const last = runs.find((r) => !r.partial) ?? runs[0];
  if (!last) return null;
  const runsDir = path.join(workspaceDir(server.home, server.workspace.id), "runs");
  let result: any = null;
  for (const dir of [path.join(runsDir, last.runId), last.dir]) {
    try {
      result = JSON.parse(fs.readFileSync(path.join(dir, RESULT_FILE), "utf8"));
      break;
    } catch {
      // Try the next place (a relinked workspace keeps its runs under the old id).
    }
  }
  if (!result) return { runId: last.runId, decision: last.decision, partial: true, stages: [] };
  const started = Date.parse(result.startedAt ?? "");
  const finished = Date.parse(result.finishedAt ?? "");
  const stages = (Array.isArray(result.stages) ? result.stages : [])
    .filter((s: any) => s.kind !== "composite")
    .map((s: any) => ({ id: String(s.id), label: typeof s.label === "string" ? s.label : String(s.id), state: String(s.state), reason: typeof s.reason === "string" ? s.reason : null }));
  return {
    runId: String(result.runId ?? last.runId),
    decision: String(result.decision ?? ""),
    complete: result.complete === true,
    partial: result.partial === true,
    startedAt: result.startedAt ?? null,
    durationMs: Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : null,
    branch: result.analyzed?.git?.branch ?? null,
    commit: result.analyzed?.git?.head ?? result.analyzed?.snapshot?.commit ?? null,
    summary: typeof result.summary === "string" ? result.summary : null,
    findings: Array.isArray(result.findings) ? result.findings.length : 0,
    stages,
  };
}

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/overview",
    timeoutMs: 120_000,
    handler({ server }) {
      const { inventory } = discoverWorkspace(server.projectDir);
      const approvable = inventory.classifications.filter((c) => c.approvable);
      const ambiguous = inventory.classifications.filter((c) => c.classificationStatus === "ambiguous");
      const built = buildPlan(server.projectDir, { version: server.version, home: server.home, compare: false });
      const plan = built.ok ? built.plan : null;
      const categories = plan ? categoriesOf(plan) : [];
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          discovery: {
            components: approvable.length,
            languages: inventory.languages,
            ambiguous: ambiguous.map((c) => ({ id: c.id, root: c.componentRoot, reasonCode: c.reasonCode })),
            inconsistencies: inventory.inconsistencies.length,
            mode: inventory.mode,
          },
          profile: plan?.profile ? { id: plan.profile.id, label: plan.profile.label } : null,
          plan: plan
            ? { planHash: plan.planHash, approvable: plan.approvable, blocked: plan.blocked ? plan.blocked.message : null, uncovered: plan.groups.uncoveredRequirements.map((u) => ({ selector: u.selector, category: u.category, reason: u.reason, message: u.message })) }
            : { planHash: null, approvable: false, blocked: built.ok ? null : built.error.message, uncovered: [] },
          categories,
          lastRun: readLastRun(server),
        },
      };
    },
  },
];
