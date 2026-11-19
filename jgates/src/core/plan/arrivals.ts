import fs from "node:fs";
import path from "node:path";
import { workspaceDir, workspaceLineage } from "../home/index.js";
import type { PlanItem, PlanNewSinceLastRun } from "./types.js";

/**
 * What is new since the workspace's last run (ADR-0022): the new tools reach an existing project with an upgrade, so
 * its result can change; the plan names the tools that will run now and did not run in the last finished run, for the
 * overview and the result to say so. Reads only the data folder (<home>/workspaces/<id>/runs/<run>/{result,plan}.json),
 * never the project.
 */

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface FinishedRun {
  runId: string;
  startedAt: string | null;
  time: number;
  plan: Record<string, unknown>;
}

/** The newest run of the workspace (and of the ids relinked into it) that finished and kept its plan. */
export function lastFinishedRun(home: string, wsId: string): FinishedRun | null {
  let best: FinishedRun | null = null;
  for (const id of workspaceLineage(home, wsId)) {
    const runsDir = path.join(workspaceDir(home, id), "runs");
    let names: string[];
    try {
      names = fs.readdirSync(runsDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = path.join(runsDir, name);
      const result = readJson(path.join(dir, "result.json"));
      if (!result || result.partial === true) continue;
      const plan = readJson(path.join(dir, "plan.json"));
      if (!plan) continue;
      const startedAt = typeof result.startedAt === "string" ? result.startedAt : null;
      const parsed = startedAt ? Date.parse(startedAt) : NaN;
      let time = parsed;
      if (!Number.isFinite(time)) {
        try {
          time = fs.statSync(dir).mtimeMs;
        } catch {
          continue;
        }
      }
      if (!best || time > best.time || (time === best.time && name > best.runId)) best = { runId: name, startedAt, time, plan };
    }
  }
  return best;
}

/** The ids of the items a stored plan ran (its willRun group). */
function ranItems(plan: Record<string, unknown>): PlanItem[] {
  const groups = plan.groups;
  const willRun = groups !== null && typeof groups === "object" ? (groups as { willRun?: unknown }).willRun : undefined;
  return Array.isArray(willRun) ? (willRun.filter((i) => i !== null && typeof i === "object" && typeof (i as PlanItem).tool === "string") as PlanItem[]) : [];
}

/**
 * The tools of `willRun` that the last finished run did not run; null when the workspace has no finished run to
 * compare with. A tool that ran before (under any capability) is not new.
 */
export function newSinceLastRun(home: string, wsId: string, willRun: readonly PlanItem[]): PlanNewSinceLastRun | null {
  const last = lastFinishedRun(home, wsId);
  if (!last) return null;
  const toolsBefore = new Set(ranItems(last.plan).map((i) => i.tool));
  const fresh = willRun.filter((i) => !toolsBefore.has(i.tool));
  const sort = (values: Iterable<string>): string[] => [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { runId: last.runId, startedAt: last.startedAt, tools: sort(fresh.map((i) => i.tool)), items: sort(fresh.map((i) => i.id)) };
}
