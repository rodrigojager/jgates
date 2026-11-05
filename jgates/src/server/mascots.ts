import { scrub } from "../core/agent-context/index.js";
import fs from "node:fs";
import path from "node:path";
import { workspaceDir } from "../core/home/index.js";
import { readEvents, type RunEvent } from "../core/events/index.js";
import { projectMascots } from "../core/mascots/index.js";
import type { Plan } from "../core/plan/types.js";
import type { RunResult } from "../core/run/types.js";
import type { ServerContext } from "./types.js";

/** The frozen run artifact, never the current workspace configuration. Do not follow symlinks. */
export function frozenPlan(server: ServerContext, runId: string | null): Plan | null {
  if (!runId) return null;
  const dir = path.join(workspaceDir(server.home, server.workspace.id), "runs", runId);
  const file = path.join(dir, "plan.json");
  try {
    if (!fs.lstatSync(dir).isDirectory() || !fs.lstatSync(file).isFile()) return null;
    const plan = JSON.parse(fs.readFileSync(file, "utf8")) as Plan;
    return plan.kind === "jgates-plan" && plan.schemaVersion === 1 ? plan : null;
  } catch { return null; }
}

export function runMascots(server: ServerContext, runId: string | null, result: RunResult | null, options: {
  plan?: Plan | null; events?: RunEvent[]; running?: boolean; orphan?: boolean; cancelRequested?: boolean;
} = {}) {
  const events = options.events ?? (runId ? readEvents(path.join(workspaceDir(server.home, server.workspace.id), "runs", runId, "events.jsonl"), { runId }).events : []);
  const snapshot = projectMascots({ plan: frozenPlan(server, runId) ?? options.plan ?? null, result, runId,
    events, running: options.running === true && (!result || result.partial === true),
    orphan: options.orphan === true });
  snapshot.cancelling = snapshot.cancelling || (options.cancelRequested === true && options.running === true && (!result || result.partial === true));
  for (const domain of snapshot.domains) for (const check of domain.checks) check.reason = scrub(check.reason);
  return snapshot;
}
