// Format-check adapter: one tool instance per formatter (ruff, prettier, gofmt, rustfmt, dotnet). The plan shows the
// exact command (the formatter's check mode, in the working folder of the component); the run executes it in the step
// container of the tools image and turns the list of files the formatter would change into located, blocking findings.
// A formatter that is missing, a crash, or an output no exit code explains is a blocked or error stage, never a pass.
// Nothing is rewritten: the formatters run in their check mode only.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { runSpec, substituteTokens, type ExecutionResult } from "../../core/runner/index.js";
import { stepViewOfPaths } from "../../core/runner/container.js";
import type { AdapterContext, AdapterOutput, ResultStage } from "../../core/run/types.js";
import { formatCheckManifest } from "./manifest.js";
import { FORMATTERS, FORMATTER_TOOL, parseFormat, toFindings, type Formatter } from "./normalize.js";
import { probeFormatter, VERSION_TOOL } from "./probe.js";

export { formatCheckManifest } from "./manifest.js";
export { FORMATTERS, parseDotnet, parseFormat, parseGofmt, parsePrettier, parseRuff, parseRustfmt } from "./normalize.js";
export { probeFormatter } from "./probe.js";

const ADAPTER_ID = formatCheckManifest.id;
const WORKSPACE = "{workspace}";

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface FormatCheckSettings {
  formatter: Formatter | null;
  /** What the instance wrote that is not valid; the plan refuses it instead of guessing. */
  problems: string[];
}

/** Reads and validates the formatter of the instance (tools.<id> in .jgates/tools.yml or in a template). */
export function formatCheckSettings(input: Pick<ExternalPlanInput, "config" | "tool">): FormatCheckSettings {
  const t = translator("format-check");
  const tools = isRec(input.config) && isRec(input.config.tools) ? input.config.tools : {};
  const raw = isRec(tools[input.tool]) ? (tools[input.tool] as Record<string, unknown>) : {};
  // A template carries the settings under `config` (its schema allows nothing else); tools.yml writes them next to the adapter.
  const body: Record<string, unknown> = { ...(isRec(raw.config) ? raw.config : {}), ...(raw.formatter !== undefined ? { formatter: raw.formatter } : {}) };
  if (typeof body.formatter === "string" && (FORMATTERS as readonly string[]).includes(body.formatter)) return { formatter: body.formatter as Formatter, problems: [] };
  return { formatter: null, problems: [t("format_check_setting_formatter", { tool: input.tool, value: String(body.formatter ?? "-"), allowed: FORMATTERS.join(", ") })] };
}

interface Command {
  args: string[];
  env: Record<string, string>;
}

/** The check-mode command of each formatter, relative to the working folder of the component. */
function commandOf(formatter: Formatter): Command {
  switch (formatter) {
    case "ruff":
      return { args: ["format", "--check", "--no-cache", "--output-format", "concise", "."], env: { NO_COLOR: "1" } };
    case "prettier":
      return { args: ["--check", "--no-color", "."], env: { NO_COLOR: "1" } };
    case "gofmt":
      return { args: ["-l", "."], env: { GOTELEMETRY: "off" } };
    case "rustfmt":
      return { args: ["fmt", "--check"], env: { CARGO_TERM_COLOR: "never", NO_COLOR: "1" } };
    case "dotnet":
      return { args: ["format", "whitespace", ".", "--folder", "--verify-no-changes"], env: { DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1", DOTNET_CLI_UI_LANGUAGE: "en", NO_COLOR: "1" } };
  }
}

function planFormatCheck(input: ExternalPlanInput): ExternalPlan {
  const t = translator("format-check");
  const settings = formatCheckSettings(input);
  const formatter = settings.formatter ?? "ruff";
  const root = input.componentRoot && input.componentRoot !== "." ? input.componentRoot : null;
  const scanDir = root ? path.join(input.dir, ...root.split("/")) : input.dir;
  const probe = probeFormatter(formatter, input.env);
  const command = commandOf(formatter);

  let availability: ExternalPlan["availability"];
  let blocksPlan = false;
  if (settings.problems.length > 0) {
    // A setting that is not valid never falls back to a default silently.
    availability = { status: "unavailable", reason: settings.problems.join(" ") };
    blocksPlan = true;
  } else if (probe.problem === "not_found") availability = { status: "unavailable", reason: t("format_check_missing", { formatter: FORMATTER_TOOL[formatter], detail: probe.detail }) };
  else if (probe.problem === "no_answer") availability = { status: "unavailable", reason: t("format_check_probe_failed", { formatter: FORMATTER_TOOL[formatter], path: probe.detail }) };
  else if (probe.version !== null && satisfiesRange(probe.version, formatCheckManifest.toolVersionRange) !== true) {
    availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: FORMATTER_TOOL[formatter], version: probe.version, range: formatCheckManifest.toolVersionRange, what: ADAPTER_ID }) };
  } else if (formatter === "rustfmt" && !fs.existsSync(path.join(scanDir, "Cargo.toml"))) availability = { status: "unavailable", reason: t("format_check_no_manifest", { file: "Cargo.toml" }) };
  else availability = { status: "available", reason: null };

  const executable = probe.executable ?? FORMATTER_TOOL[formatter];
  return {
    label: t(`format_check_label_${formatter}`),
    command: {
      executable,
      // A script override (prettier) runs through Node: the script comes first, then the formatter's own arguments.
      args: [...probe.prefix, ...command.args],
      cwd: root ? `${WORKSPACE}/${root}` : WORKSPACE,
      env: command.env,
      stdin: null,
    },
    runtime: { name: "native", interpreter: probe.executable, available: probe.executable !== null && probe.version !== null },
    toolVersion: probe.version,
    configFiles: [],
    availability,
    blocksPlan,
    network: false,
    limitations: [t(`format_check_limitation_${formatter}`)],
    conditions: [t("format_check_condition_check_only")],
    // A formatter the image lacks is the shared "tools image" cause, not an install offer.
    imageTool: VERSION_TOOL[formatter],
    contract: { formatter },
    output: { format: "text", schema: null },
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");
const tail = (text: string): string => text.trim().split(/\r?\n/).slice(-3).join(" ");

async function runFormatCheck(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("format-check");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("format_check_no_invocation", { tool }));

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const command = invocation.command;
  const formatter = ((invocation.contract ?? {}) as { formatter?: Formatter }).formatter ?? "ruff";
  const cwd = substituteTokens(command.cwd, tokens);
  const args = command.args.map((a) => substituteTokens(a, tokens));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
  const version = items[0]?.versions.toolVersion ?? null;

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
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
  if (unavailable) return blockedAll(unavailable.availability.reason ?? t("format_check_blocked", { detail: command.executable }));

  const result: ExecutionResult = await runSpec(
    { executable: command.executable, args, cwd, env, stdin: null, timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
    { parentEnv: context.env },
  );
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];

  if (result.spawnError) return { ...blockedAll(t("format_check_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
  if (result.cancelled) return { ...base, stages: items.map((i) => stageFor(i, "cancelled", t("format_check_cancelled"))), findings: [] };
  if (result.timedOut) return { ...base, stages: items.map((i) => stageFor(i, "timeout", t("format_check_timeout", { seconds: timeoutSeconds }))), findings: [] };

  fs.writeFileSync(path.join(outDir, `${FORMATTER_TOOL[formatter]}.txt`), `${result.stdout}${result.stderr === "" ? "" : `\n--- stderr ---\n${result.stderr}`}`, { mode: 0o600 });
  const parsed = parseFormat(formatter, result.stdout, result.stderr, result.exitCode);
  if (!parsed.ok || result.truncated) {
    const detail = result.truncated ? "output truncated" : `${parsed.problem ?? ""} ${tail(result.stderr || result.stdout)}`.trim();
    return { ...base, stages: items.map((i) => stageFor(i, "error", t("format_check_exit_error", { tool: FORMATTER_TOOL[formatter], code: result.exitCode ?? "-", detail: detail || String(result.signal ?? "") }), { interpreted: false, nativeStatus: `exit ${result.exitCode ?? "-"}` })), findings: [] };
  }
  const paths = { workspace: stepViewOfPaths(context.env, { workspace: context.workspacePath, runDir: context.runDir }, context.workspacePath), cwd: stepViewOfPaths(context.env, { workspace: context.workspacePath, runDir: context.runDir }, cwd) };
  const findings = toFindings(parsed.files, { stageId: items[0]?.id as string, formatter, version, workspace: paths.workspace, cwd: paths.cwd, message: (f) => t("format_check_finding", { tool: FORMATTER_TOOL[formatter], edits: f.edits }) });
  const reason = t("format_check_reason_completed", { tool: FORMATTER_TOOL[formatter], version: version ?? "?", count: findings.length });
  return {
    ...base,
    stages: items.map((i) => stageFor(i, "completed", reason, { blockingViolations: findings.length, findings: findings.length, nativeStatus: `exit ${result.exitCode}` })),
    findings,
  };
}

export const formatCheckAdapter: ExternalAdapter = {
  manifest: formatCheckManifest,
  plan: planFormatCheck,
  run: runFormatCheck,
};
