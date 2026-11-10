// file-size adapter: the line budget per file (Quality domain). The analysis is pure and offline (analyze.ts); this
// file is the plan/run side: the plan shows the limit as the in-process command it will run (no external tool, nothing
// installed or downloaded), and the run turns each file over the limit into a located, blocking finding. A tree too
// big to walk whole leaves the stage not interpreted (incomplete), never passed.
import fs from "node:fs";
import path from "node:path";
import { contentHash } from "../../core/ids/index.js";
import { translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import type { AdapterContext, AdapterOutput, ResultFinding, ResultStage } from "../../core/run/types.js";
import { analyzeFileSize, DEFAULT_MAX_LINES, type FileSizeResult } from "./analyze.js";
import { fileSizeManifest } from "./manifest.js";

export { analyzeFileSize, DEFAULT_MAX_LINES, type FileSizeResult, type OversizedFile } from "./analyze.js";
export { fileSizeManifest } from "./manifest.js";

const ADAPTER_ID = fileSizeManifest.id;
const WORKSPACE = "{workspace}";

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface FileSizeSettings {
  maxLines: number;
  problems: string[];
}

/** The settings of an instance (tools.<id> in .jgates/tools.yml or in a template). */
export function fileSizeSettings(input: Pick<ExternalPlanInput, "config" | "tool">): FileSizeSettings {
  const t = translator("file-size");
  const tools = isRec(input.config) && isRec(input.config.tools) ? input.config.tools : {};
  const raw = isRec(tools[input.tool]) ? (tools[input.tool] as Record<string, unknown>) : {};
  const body: Record<string, unknown> = { ...(isRec(raw.config) ? raw.config : {}), ...(raw.maxLines !== undefined ? { maxLines: raw.maxLines } : {}) };
  if (body.maxLines === undefined) return { maxLines: DEFAULT_MAX_LINES, problems: [] };
  if (typeof body.maxLines === "number" && Number.isInteger(body.maxLines) && body.maxLines >= 1) return { maxLines: body.maxLines, problems: [] };
  return { maxLines: DEFAULT_MAX_LINES, problems: [t("file_size_setting_max_lines", { tool: input.tool, value: String(body.maxLines) })] };
}

function planFileSize(input: ExternalPlanInput): ExternalPlan {
  const t = translator("file-size");
  const settings = fileSizeSettings(input);
  const blocksPlan = settings.problems.length > 0;
  return {
    label: t("file_size_label"),
    // The analysis runs in-process; the command is what the plan shows and what the run reads back.
    command: { executable: process.execPath, args: ["file-size", "--max-lines", String(settings.maxLines)], cwd: WORKSPACE, env: {}, stdin: null },
    runtime: { name: "native", interpreter: null, available: true },
    toolVersion: fileSizeManifest.adapterVersion,
    configFiles: [],
    availability: blocksPlan ? { status: "unavailable", reason: settings.problems.join(" ") } : { status: "available", reason: null },
    blocksPlan,
    network: false,
    limitations: [t("file_size_limitation_text_only")],
    conditions: [t("file_size_condition_limit", { limit: settings.maxLines })],
    output: { format: "json", schema: null },
  };
}

function readMaxLines(args: string[]): number {
  const at = args.indexOf("--max-lines");
  const value = at >= 0 ? Number.parseInt(args[at + 1] ?? "", 10) : NaN;
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_MAX_LINES;
}

/** Normalized findings of an analysis: one per file over the limit, the biggest first. */
export function normalizeFileSize(result: FileSizeResult, opts: { stageId: string; version?: string | null; message: (file: string, lines: number, limit: number) => string }): ResultFinding[] {
  return [...result.oversized]
    .sort((a, b) => b.lines - a.lines || (a.file < b.file ? -1 : 1))
    .map((f) => ({
      stageId: opts.stageId,
      tool: ADAPTER_ID,
      ...(opts.version ? { toolVersion: opts.version } : {}),
      ruleId: "file-size.max-lines",
      category: "file-size",
      severity: "medium",
      normalizedSeverity: "medium" as const,
      message: opts.message(f.file, f.lines, result.limit),
      location: { path: f.file },
      fingerprint: contentHash({ tool: ADAPTER_ID, rule: "file-size.max-lines", file: f.file }),
      origin: ADAPTER_ID,
      blocking: true,
      blockingReason: "blocking-tool" as const,
      waived: false,
    }));
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");

async function runFileSize(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("file-size");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("file_size_no_invocation", { tool }));
  const stageFor = (item: PlanItem, state: ResultStage["state"], reason?: string, extra: Partial<ResultStage> = {}): ResultStage => ({
    id: item.id,
    label: item.label,
    kind: "step",
    adapter: ADAPTER_ID,
    state,
    ...(reason ? { reason } : {}),
    ...extra,
  });
  const base = {
    requirements: items.map((i) => ({ id: i.id, required: i.requirement === "required", reason: i.reason.message })),
    disabled: [],
    logs: [] as string[],
    outputs: [] as string[],
  };
  const unavailable = items.find((i) => i.availability.status !== "available");
  if (unavailable) return { ...base, stages: items.map((i) => stageFor(i, "blocked", unavailable.availability.reason ?? t("file_size_blocked"))), findings: [] };

  const version = items[0]?.versions.toolVersion ?? null;
  let analysis: FileSizeResult;
  try {
    analysis = analyzeFileSize(context.workspacePath, { maxLines: readMaxLines(invocation.command.args) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ...base, stages: items.map((i) => stageFor(i, "error", t("file_size_analysis_failed", { detail }), { interpreted: false })), findings: [] };
  }
  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(outDir, "file-size.json"), JSON.stringify(analysis, null, 2), { mode: 0o600 });
  base.outputs = [relToRun(context.runDir, outDir)];

  const findings = normalizeFileSize(analysis, { stageId: items[0]?.id as string, version, message: (file, lines, limit) => t("file_size_finding", { file, lines, limit }) });
  const reason = t("file_size_reason_completed", { checked: analysis.checked, count: findings.length, limit: analysis.limit }) + (analysis.skipped.length > 0 ? `; ${t("file_size_skipped", { count: analysis.skipped.length })}` : "") + (analysis.truncated ? `; ${t("file_size_truncated")}` : "");
  return {
    ...base,
    stages: items.map((i) => stageFor(i, "completed", reason, { blockingViolations: findings.length, findings: findings.length, nativeStatus: "completed", interpreted: !analysis.truncated })),
    findings,
  };
}

export const fileSizeAdapter: ExternalAdapter = {
  manifest: fileSizeManifest,
  plan: planFileSize,
  run: runFileSize,
};
