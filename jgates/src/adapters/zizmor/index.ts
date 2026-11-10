// zizmor adapter: plans one `zizmor --format json-v1` per tool instance (workflows and actions of the scan root, offline
// by default, the finding severity kept out of the exit code) and normalizes its findings. The tool comes from the
// JGates tools image (image.json), never installed by the run.
// The home and the cache of zizmor are folders of the run folder; nothing is written in the workspace.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { runSpec, substituteTokens } from "../../core/runner/index.js";
import { createOutputPaths, outputPathFor, outputPathUnder, redirectionEnv, RUN_DIR_TOKEN } from "../../core/run/redirection.js";
import type { AdapterContext, AdapterOutput, ResultStage } from "../../core/run/types.js";
import { zizmorManifest } from "./manifest.js";
import { parseZizmorOutput } from "./normalize.js";
import { probeZizmor } from "./probe.js";

export { zizmorManifest } from "./manifest.js";
export { parseZizmorOutput, relativeWorkflowPath } from "./normalize.js";
export { findZizmor, probeZizmor } from "./probe.js";

const ADAPTER_ID = zizmorManifest.id;
const WORKSPACE = "{workspace}";

export const PERSONAS = ["regular", "pedantic", "auditor"] as const;
export const MIN_SEVERITIES = ["informational", "low", "medium", "high"] as const;

/** The settings of an instance (tools.<id> in .jgates/tools.yml or in a template). */
export interface ZizmorSettings {
  persona: (typeof PERSONAS)[number];
  minSeverity: (typeof MIN_SEVERITIES)[number] | null;
  offline: boolean;
  /** What the instance wrote that is not valid; the plan refuses it instead of guessing. */
  problems: string[];
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads and validates persona, minSeverity and offline of the instance (defaults: regular, no minimum, offline). */
export function zizmorSettings(input: Pick<ExternalPlanInput, "config" | "tool">): ZizmorSettings {
  const t = translator("zizmor");
  const tools = isRec(input.config) && isRec(input.config.tools) ? input.config.tools : {};
  const body = isRec(tools[input.tool]) ? (tools[input.tool] as Record<string, unknown>) : {};
  const problems: string[] = [];
  let persona: ZizmorSettings["persona"] = "regular";
  if (body.persona !== undefined) {
    if (typeof body.persona === "string" && (PERSONAS as readonly string[]).includes(body.persona)) persona = body.persona as ZizmorSettings["persona"];
    else problems.push(t("zizmor_setting_persona", { tool: input.tool, value: String(body.persona), allowed: PERSONAS.join(", ") }));
  }
  let minSeverity: ZizmorSettings["minSeverity"] = null;
  if (body.minSeverity !== undefined) {
    if (typeof body.minSeverity === "string" && (MIN_SEVERITIES as readonly string[]).includes(body.minSeverity)) minSeverity = body.minSeverity as ZizmorSettings["minSeverity"];
    else problems.push(t("zizmor_setting_min_severity", { tool: input.tool, value: String(body.minSeverity), allowed: MIN_SEVERITIES.join(", ") }));
  }
  let offline = true;
  if (body.offline !== undefined) {
    if (typeof body.offline === "boolean") offline = body.offline;
    else problems.push(t("zizmor_setting_offline", { tool: input.tool, value: String(body.offline) }));
  }
  return { persona, minSeverity, offline, problems };
}

const cacheEntry = (): NonNullable<ReturnType<typeof outputPathFor>> => {
  const entry = outputPathFor(zizmorManifest, "cache");
  if (!entry) throw new Error("the zizmor manifest declares no cache output path");
  return entry;
};

/** The command the plan shows: executable and args (no shell), settings applied, home and cache in the run folder. */
function planZizmor(input: ExternalPlanInput): ExternalPlan {
  const t = translator("zizmor");
  const governed = input.policyDir !== undefined;
  const settings = zizmorSettings(input);
  const probe = probeZizmor(input.env);
  const root = input.componentRoot && input.componentRoot !== "." ? input.componentRoot : null;
  const args = [
    "--format",
    "json-v1",
    // The severity of a finding stays in the report; the exit code only says whether the audit ran.
    "--no-exit-codes",
    "--no-progress",
    "--color",
    "never",
    "--persona",
    settings.persona,
    ...(settings.minSeverity ? ["--min-severity", settings.minSeverity] : []),
    ...(settings.offline ? ["--offline"] : []),
    // jgates ci: neither zizmor.yml nor ignore comments of the analyzed project change the verdict.
    ...(governed ? ["--no-config", "--no-ignores"] : []),
    "--cache-dir",
    outputPathUnder(RUN_DIR_TOKEN, cacheEntry()),
    ".",
  ];
  let availability: ExternalPlan["availability"];
  let blocksPlan = false;
  if (settings.problems.length > 0) {
    // A setting that is not valid never falls back to a default silently.
    availability = { status: "unavailable", reason: settings.problems.join(" ") };
    blocksPlan = true;
  } else if (probe.problem === "not_found") availability = { status: "unavailable", reason: t("zizmor_missing", { detail: probe.detail }) };
  else if (probe.problem === "no_answer") availability = { status: "unavailable", reason: t("zizmor_probe_failed", { path: probe.detail }) };
  else if (probe.version !== null && satisfiesRange(probe.version, zizmorManifest.toolVersionRange) !== true) {
    availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: zizmorManifest.toolName, version: probe.version, range: zizmorManifest.toolVersionRange, what: ADAPTER_ID }) };
  } else availability = { status: "available", reason: null };

  const configFile = ["zizmor.yml", ".github/zizmor.yml"].map((f) => (root ? `${root}/${f}` : f)).find((f) => fs.existsSync(path.join(input.dir, ...f.split("/"))));
  return {
    label: t("zizmor_label"),
    command: {
      executable: probe.executable ?? zizmorManifest.toolName,
      args,
      cwd: root ? `${WORKSPACE}/${root}` : WORKSPACE,
      env: { ...redirectionEnv(zizmorManifest), NO_COLOR: "1" },
      stdin: null,
    },
    runtime: { name: "native", interpreter: probe.executable, available: probe.executable !== null && probe.version !== null },
    toolVersion: probe.version,
    configFiles: configFile && !governed ? [{ file: configFile, sha256: null }] : [],
    availability,
    blocksPlan,
    network: !settings.offline,
    limitations: [t("zizmor_limitation_exceptions")],
    conditions: [
      t("zizmor_condition_persona", { persona: settings.persona, minimum: settings.minSeverity ?? t("zizmor_no_minimum") }),
      t(settings.offline ? "zizmor_condition_offline" : "zizmor_condition_online"),
      ...(governed ? [t("zizmor_condition_governed")] : []),
    ],
    output: { format: "json", schema: null },
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");

async function runZizmor(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("zizmor");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("zizmor_no_invocation", { tool }));

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const command = invocation.command;
  const cwd = substituteTokens(command.cwd, tokens);
  const args = command.args.map((a) => substituteTokens(a, tokens));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
  // The online audits (offline: false) read the token of the caller; it is never written in the plan.
  const token = context.env.GH_TOKEN ?? context.env.GITHUB_TOKEN;
  if (token && !args.includes("--offline")) env.GH_TOKEN = token;
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
  const version = items[0]?.versions.toolVersion ?? null;
  const scanRoot = path.relative(context.workspacePath, cwd).split(path.sep).join("/") || ".";

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  // The home and the cache the manifest says zizmor writes into instead of the workspace.
  createOutputPaths(zizmorManifest, context.runDir);
  const outFile = path.join(outDir, "zizmor.json");
  const stdoutLog = path.join(context.logsDir, `${tool}.stdout.log`);
  const stderrLog = path.join(context.logsDir, `${tool}.stderr.log`);

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
    outputs: [relToRun(context.runDir, outDir)],
  };
  const blockedAll = (reason: string): AdapterOutput => ({ ...base, stages: items.map((i) => stageFor(i, "blocked", reason)), findings: [] });

  const unavailable = items.find((i) => i.availability.status !== "available");
  if (unavailable) return blockedAll(unavailable.availability.reason ?? t("zizmor_blocked", { detail: command.executable }));

  const result = await runSpec(
    { executable: command.executable, args, cwd, env, stdin: command.stdin === null ? null : JSON.stringify(command.stdin), timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
    { parentEnv: context.env },
  );
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];

  if (result.spawnError) return { ...blockedAll(t("zizmor_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
  if (result.timedOut) return { ...base, stages: items.map((i) => stageFor(i, "timeout", t("zizmor_timeout", { seconds: timeoutSeconds }))), findings: [] };
  // Only the run-owned process is stopped; whatever zizmor wrote before stays in the logs as partial evidence.
  if (result.cancelled) return { ...base, stages: items.map((i) => stageFor(i, "cancelled", t("zizmor_cancelled"))), findings: [] };
  // With --no-exit-codes a finished audit is exit 0; anything else (no input collected, a crash, a signal) proves nothing.
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split(/\r?\n/).slice(-3).join(" ") || String(result.signal ?? "");
    return { ...base, stages: items.map((i) => stageFor(i, "error", t("zizmor_exit_error", { code: result.exitCode ?? "-", detail }), { interpreted: false })), findings: [] };
  }
  fs.writeFileSync(outFile, result.stdout, { mode: 0o600 });
  const parsed = parseZizmorOutput(result.stdout, { stageId: items[0]?.id as string, version, root: scanRoot });
  if (!parsed.ok || result.truncated) {
    const detail = result.truncated ? "output truncated" : (parsed.problem ?? "");
    return { ...base, stages: items.map((i) => stageFor(i, "completed", t("zizmor_invalid_output", { detail }), { interpreted: false, nativeStatus: "exit 0" })), findings: [] };
  }
  const count = parsed.findings.length;
  const blocking = parsed.findings.filter((f) => f.blocking).length;
  const reason = t("zizmor_reason_completed", { version: version ?? "?", count }) + (parsed.ignored > 0 ? `; ${t("zizmor_ignored", { count: parsed.ignored })}` : "");
  return {
    ...base,
    stages: items.map((i) => stageFor(i, "completed", reason, { blockingViolations: blocking, findings: count, nativeStatus: "exit 0" })),
    findings: parsed.findings,
  };
}

export const zizmorAdapter: ExternalAdapter = {
  manifest: zizmorManifest,
  plan: planZizmor,
  run: runZizmor,
};
