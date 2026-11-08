// supply-chain adapter: provenance and package-execution signals of the lockfiles of the workspace (Dependencies
// domain). The analysis is pure and offline (analyze.ts); this file is the plan/run side: the plan lists the lockfiles
// and the settings as the command it will run in-process (no external tool, nothing installed or downloaded), and the
// run turns the analysis into normalized findings. What the offline read cannot decide is an `unknown`: a network-only
// signal is a non-blocking finding that says so, and a lockfile that cannot be read leaves the stage not interpreted
// (incomplete), so an unknown is never counted as clean.
import fs from "node:fs";
import path from "node:path";
import { contentHash } from "../../core/ids/index.js";
import { translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import type { AdapterContext, AdapterOutput, NormalizedSeverity, ResultFinding, ResultStage } from "../../core/run/types.js";
import { analyzeSupplyChain, findLockfiles, type SupplyChainFinding, type SupplyChainResult } from "./analyze.js";
import { supplyChainManifest } from "./manifest.js";

export { analyzeSupplyChain, findLockfiles, type SupplyChainFinding, type SupplyChainResult, type SupplyChainSignal, type SupplyChainUnknown } from "./analyze.js";
export { supplyChainManifest } from "./manifest.js";

const ADAPTER_ID = supplyChainManifest.id;
const WORKSPACE = "{workspace}";

export const FAIL_ON_LEVELS = ["none", "low", "medium", "high"] as const;
const RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };

/** The settings of an instance (tools.<id> in .jgates/tools.yml or in a template). */
export interface SupplyChainSettings {
  /** The lowest severity that blocks (none: findings are reported and never block). */
  failOn: (typeof FAIL_ON_LEVELS)[number];
  /** true (the default): an install script is reported but does not block (it is common and often legitimate). */
  allowInstallScripts: boolean;
  trustedHosts: string[] | null;
  /** Explicit lockfile paths (workspace-relative); null: the workspace is searched. */
  lockfiles: string[] | null;
  problems: string[];
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const stringList = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "") ? (v as string[]) : null);

export function supplyChainSettings(input: Pick<ExternalPlanInput, "config" | "tool">): SupplyChainSettings {
  const t = translator("supply-chain");
  const tools = isRec(input.config) && isRec(input.config.tools) ? input.config.tools : {};
  const body = isRec(tools[input.tool]) ? (tools[input.tool] as Record<string, unknown>) : {};
  const problems: string[] = [];
  let failOn: SupplyChainSettings["failOn"] = "high";
  if (body.blockOn !== undefined) {
    if (typeof body.blockOn === "string" && (FAIL_ON_LEVELS as readonly string[]).includes(body.blockOn)) failOn = body.blockOn as SupplyChainSettings["failOn"];
    else problems.push(t("sc_setting_fail_on", { tool: input.tool, value: String(body.blockOn), allowed: FAIL_ON_LEVELS.join(", ") }));
  }
  let allowInstallScripts = true;
  if (body.allowInstallScripts !== undefined) {
    if (typeof body.allowInstallScripts === "boolean") allowInstallScripts = body.allowInstallScripts;
    else problems.push(t("sc_setting_allow_install_scripts", { tool: input.tool, value: String(body.allowInstallScripts) }));
  }
  let trustedHosts: string[] | null = null;
  if (body.trustedHosts !== undefined) {
    trustedHosts = stringList(body.trustedHosts);
    if (trustedHosts === null) problems.push(t("sc_setting_list", { tool: input.tool, setting: "trustedHosts" }));
  }
  let lockfiles: string[] | null = null;
  if (body.lockfiles !== undefined) {
    lockfiles = stringList(body.lockfiles);
    if (lockfiles === null) problems.push(t("sc_setting_list", { tool: input.tool, setting: "lockfiles" }));
    else if (lockfiles.some((f) => path.isAbsolute(f) || f.split(/[\\/]/).includes(".."))) {
      problems.push(t("sc_setting_lockfile_path", { tool: input.tool }));
      lockfiles = null;
    }
  }
  return { failOn, allowInstallScripts, trustedHosts, lockfiles, problems };
}

function planSupplyChain(input: ExternalPlanInput): ExternalPlan {
  const t = translator("supply-chain");
  const settings = supplyChainSettings(input);
  const lockfiles = settings.lockfiles ?? findLockfiles(input.dir);
  const args = [
    "supply-chain",
    "--offline",
    "--fail-on",
    settings.failOn,
    ...(settings.allowInstallScripts ? ["--allow-install-scripts"] : []),
    ...(settings.trustedHosts ?? []).flatMap((h) => ["--trusted-host", h]),
    ...lockfiles.flatMap((f) => ["--lockfile", f]),
  ];
  const blocksPlan = settings.problems.length > 0;
  return {
    label: t("sc_label"),
    // The analysis runs in-process; the command is what the plan shows and what the run reads back.
    // The executable is the Node.js that runs JGates (always present for the preflight); args are the analysis the plan shows.
    command: { executable: process.execPath, args, cwd: WORKSPACE, env: {}, stdin: null },
    runtime: { name: "native", interpreter: null, available: true },
    toolVersion: supplyChainManifest.adapterVersion,
    configFiles: [],
    availability: blocksPlan ? { status: "unavailable", reason: settings.problems.join(" ") } : { status: "available", reason: null },
    blocksPlan,
    network: false,
    limitations: [t("sc_limitation_offline")],
    conditions: [
      t("sc_condition_fail_on", { level: settings.failOn }),
      t(settings.allowInstallScripts ? "sc_condition_install_scripts_allowed" : "sc_condition_install_scripts_blocked"),
      t("sc_condition_lockfiles", { count: lockfiles.length }),
    ],
    output: { format: "json", schema: null },
  };
}

interface ParsedArgs {
  failOn: SupplyChainSettings["failOn"];
  allowInstallScripts: boolean;
  trustedHosts: string[];
  lockfiles: string[];
}

function readArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = { failOn: "high", allowInstallScripts: false, trustedHosts: [], lockfiles: [] };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--fail-on") out.failOn = (args[(i += 1)] ?? "high") as ParsedArgs["failOn"];
    else if (a === "--allow-install-scripts") out.allowInstallScripts = true;
    else if (a === "--trusted-host") out.trustedHosts.push(args[(i += 1)] ?? "");
    else if (a === "--lockfile") out.lockfiles.push(args[(i += 1)] ?? "");
  }
  return out;
}

const SEVERITY: Record<SupplyChainFinding["severity"], NormalizedSeverity> = { high: "high", medium: "medium", low: "low" };

/** Normalized findings of an analysis: the signals, then the unknowns (never blocking, never hidden). */
export function normalizeSupplyChain(result: SupplyChainResult, opts: { stageId: string; failOn: SupplyChainSettings["failOn"]; allowInstallScripts: boolean; version?: string | null }): ResultFinding[] {
  const out: ResultFinding[] = [];
  const threshold = opts.failOn === "none" ? Infinity : (RANK[opts.failOn] ?? Infinity);
  for (const f of result.findings) {
    const blocking = !(f.signal === "install-script" && opts.allowInstallScripts) && (RANK[f.severity] ?? 0) >= threshold;
    out.push({
      stageId: opts.stageId,
      tool: ADAPTER_ID,
      ...(opts.version ? { toolVersion: opts.version } : {}),
      ruleId: f.ruleId,
      category: "supply-chain",
      severity: f.severity,
      normalizedSeverity: SEVERITY[f.severity],
      message: f.message,
      location: { path: f.file },
      fingerprint: contentHash({ tool: ADAPTER_ID, rule: f.ruleId, file: f.file, package: f.package, version: f.version }),
      origin: ADAPTER_ID,
      blocking,
      ...(blocking ? { blockingReason: "blocking-tool" as const } : {}),
      waived: false,
    });
  }
  for (const u of result.unknown) {
    out.push({
      stageId: opts.stageId,
      tool: ADAPTER_ID,
      ...(opts.version ? { toolVersion: opts.version } : {}),
      ruleId: `supply-chain/unknown-${u.signal}`,
      category: "supply-chain",
      severity: "unknown",
      normalizedSeverity: "unknown",
      message: u.reason,
      location: { path: u.file },
      fingerprint: contentHash({ tool: ADAPTER_ID, rule: `unknown-${u.signal}`, file: u.file }),
      origin: ADAPTER_ID,
      blocking: false,
      waived: false,
    });
  }
  return out;
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");

async function runSupplyChain(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("supply-chain");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("sc_no_invocation", { tool }));
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
  if (unavailable) return { ...base, stages: items.map((i) => stageFor(i, "blocked", unavailable.availability.reason ?? t("sc_blocked"))), findings: [] };

  const args = readArgs(invocation.command.args);
  const version = items[0]?.versions.toolVersion ?? null;
  let analysis: SupplyChainResult;
  try {
    analysis = analyzeSupplyChain(context.workspacePath, { lockfiles: args.lockfiles, ...(args.trustedHosts.length > 0 ? { trustedHosts: args.trustedHosts } : {}) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ...base, stages: items.map((i) => stageFor(i, "error", t("sc_analysis_failed", { detail }), { interpreted: false })), findings: [] };
  }
  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(outDir, "supply-chain.json"), JSON.stringify(analysis, null, 2), { mode: 0o600 });
  base.outputs = [relToRun(context.runDir, outDir)];

  const findings = normalizeSupplyChain(analysis, { stageId: items[0]?.id as string, failOn: args.failOn, allowInstallScripts: args.allowInstallScripts, version });
  const blocking = findings.filter((f) => f.blocking).length;
  // A lockfile that could not be read (or lists nothing) leaves the stage not interpreted: incomplete, never passed.
  const undecided = analysis.unknown.filter((u) => u.signal === "lockfile").length;
  const unknown = analysis.unknown.length;
  const reason = t("sc_reason_completed", { count: analysis.findings.length, lockfiles: analysis.lockfiles.length, unknown });
  return {
    ...base,
    stages: items.map((i) => stageFor(i, "completed", reason, { blockingViolations: blocking, findings: findings.length, nativeStatus: "completed", ...(undecided > 0 ? { interpreted: false } : { interpreted: true }) })),
    findings,
  };
}

export const supplyChainAdapter: ExternalAdapter = {
  manifest: supplyChainManifest,
  plan: planSupplyChain,
  run: runSupplyChain,
};
