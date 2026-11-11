// `jgates tools test <instance>`: builds the extension image when it is out of date, then runs the one tool once on the
// synced copy of the project (a normal run limited to that tool) and says what the report gave: findings with file and
// line, or the reason it could not be read. Saving a tool never depends on this.
import { ADAPTER_ID } from "../../adapters/quality-bridge/index.js";
import { buildPlan, type Plan, type PlanBlocker } from "../plan/index.js";
import { executeRun, isLegacyPlan, legacySteps, type RunResult } from "../run/index.js";
import { planDisabled, planSteps } from "../run/plan-run.js";
import { workspaceId } from "../ids/index.js";
import { buildExtension, type BuildExtensionOutcome } from "./build.js";

export interface ToolTestOptions {
  projectDir: string;
  instance: string;
  version: string;
  env: NodeJS.ProcessEnv;
  /** Build the extension image first when it is out of date (default true). */
  build?: boolean;
  onBuildOutput?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface ToolTestFinding {
  rule: string;
  message: string;
  severity: string;
  path: string | null;
  line: number | null;
  blocking: boolean;
}

export type ToolTestState = "ok" | "findings" | "unreadable" | "blocked" | "build-failed" | "not-found";

export interface ToolTestResult {
  state: ToolTestState;
  instance: string;
  build: BuildExtensionOutcome | null;
  blockers: PlanBlocker[];
  /** The stage's own words: why it ended as it did (the report problem when it could not be read). */
  reason: string | null;
  findingCount: number;
  blockingCount: number;
  sample: ToolTestFinding[];
  runId: string | null;
  runDir: string | null;
}

const SAMPLE = 5;

export async function testTool(options: ToolTestOptions): Promise<ToolTestResult> {
  const empty = (state: ToolTestState, extra: Partial<ToolTestResult> = {}): ToolTestResult => ({
    state,
    instance: options.instance,
    build: null,
    blockers: [],
    reason: null,
    findingCount: 0,
    blockingCount: 0,
    sample: [],
    runId: null,
    runDir: null,
    ...extra,
  });
  const plan = (): Plan | { error: string } => {
    const built = buildPlan(options.projectDir, { only: [`tool:${options.instance}`], version: options.version, compare: false });
    return built.ok ? built.plan : { error: built.error.message };
  };
  let current = plan();
  if ("error" in current) return empty("blocked", { reason: current.error });
  let build: BuildExtensionOutcome | null = null;
  if (current.blockers.some((b) => b.code === "EXTENSION_OUTDATED") && options.build !== false) {
    build = await buildExtension({
      projectDir: options.projectDir,
      workspace: workspaceId(options.projectDir),
      env: options.env,
      version: options.version,
      ...(options.onBuildOutput ? { onOutput: options.onBuildOutput } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!build.ok) return empty("build-failed", { build, reason: build.error?.message ?? null });
    current = plan();
    if ("error" in current) return empty("blocked", { build, reason: current.error });
  }
  if (!current.groups.willRun.some((item) => item.tool === options.instance)) {
    return empty("not-found", { build, blockers: current.blockers, reason: current.blocked?.message ?? null });
  }
  if (current.blocked || !current.approvable) return empty("blocked", { build, blockers: current.blocked ? [current.blocked, ...current.blockers] : current.blockers });

  const planned = current;
  const result: RunResult = await executeRun({
    workspacePath: options.projectDir,
    version: options.version,
    adapter: ADAPTER_ID,
    options: { planHash: planned.planHash, planSource: "built", profile: planned.profile?.id ?? "", scope: planned.selection.request.scope },
    selection: {
      planHash: planned.planHash,
      planSource: "built",
      profile: planned.profile?.id ?? planned.selection.request.profile,
      scope: planned.scope.requested,
      request: planned.selection.request as unknown as Record<string, unknown>,
      planOverrides: planned.selection.overrides as unknown as Array<Record<string, unknown>>,
    },
    runFiles: { "plan.json": `${JSON.stringify(planned, null, 2)}\n` },
    plan: planned,
    steps: (context) => (isLegacyPlan(planned) ? legacySteps(context, planned) : planSteps(context, planned)),
    ...(isLegacyPlan(planned) ? {} : { disabled: planDisabled(planned) }),
    summarize: (r) => r.decision,
    ownsProcess: true,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const mine = result.findings.filter((f) => f.tool === options.instance);
  const stage = result.stages.find((s) => s.id.includes(options.instance) || s.label?.includes(options.instance));
  const read = stage !== undefined && stage.interpreted !== false && stage.state === "completed";
  const sample = mine.slice(0, SAMPLE).map((f) => ({
    rule: f.ruleId,
    message: f.message,
    severity: f.severity,
    path: f.location?.path ?? null,
    line: f.location?.line ?? null,
    blocking: f.blocking,
  }));
  const blockingCount = mine.filter((f) => f.blocking).length;
  return {
    state: !read ? "unreadable" : mine.length > 0 ? "findings" : "ok",
    instance: options.instance,
    build,
    blockers: [],
    reason: stage?.reason ?? null,
    findingCount: mine.length,
    blockingCount,
    sample,
    runId: result.runId,
    runDir: result.runDir,
  };
}
