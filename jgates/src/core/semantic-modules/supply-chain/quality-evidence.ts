// The Quality run a Semantic run attached as evidence (`--quality`), read by the host for a module: its result's
// findings and metrics are deterministic facts a method may interpret (supply-chain signals, property-test counts). It
// is evidence only: a missing, unreadable or unattached Quality run is simply absent, never a prerequisite.
import fs from "node:fs";
import path from "node:path";
import { listRuns } from "../../artifacts/index.js";

export interface AttachedQuality {
  runId: string;
  findings: Array<Record<string, unknown>>;
  metrics: Array<Record<string, unknown>>;
}

/** The attached Quality run of a Semantic run folder (from its plan.json), or null. */
export function attachedQualityResult(runDir: string): AttachedQuality | null {
  try {
    const plan = JSON.parse(fs.readFileSync(path.join(runDir, "plan.json"), "utf8")) as { quality?: { attached?: unknown } };
    const runId = plan.quality?.attached;
    if (typeof runId !== "string" || !runId.startsWith("run_")) return null;
    // <home>/workspaces/<workspace id>/semantic-runs/<sem_...>
    const workspaceDir = path.resolve(runDir, "..", "..");
    const home = path.resolve(workspaceDir, "..", "..");
    const run = listRuns(home, path.basename(workspaceDir)).find((r) => r.runId === runId);
    if (!run) return null;
    const result = JSON.parse(fs.readFileSync(path.join(run.dir, "result.json"), "utf8")) as { findings?: unknown; metrics?: unknown };
    const recs = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : []);
    return { runId, findings: recs(result.findings), metrics: recs(result.metrics) };
  } catch {
    return null;
  }
}
