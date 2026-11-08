// CodeQL adapter (customer-supplied): per tool instance it plans `codeql database create` (a database of one language
// under the run folder) followed by `codeql database analyze <suite> --format=sarif-latest` and normalizes the SARIF.
// The CodeQL CLI, its query packs and its license are the customer's: a missing tool is a structured setup state naming
// the tool, the supported versions and the official links, the stage is blocked (never passed) and nothing is installed
// or downloaded. The plan shows the analyze command; the database command is part of the reviewed contract.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { runSpec, substituteTokens } from "../../core/runner/index.js";
import { createOutputPaths, outputPathFor, outputPathUnder, redirectionEnv, RUN_DIR_TOKEN } from "../../core/run/redirection.js";
import type { AdapterContext, AdapterOutput, ResultStage } from "../../core/run/types.js";
import { codeqlManifest } from "./manifest.js";
import { parseCodeqlSarif } from "./normalize.js";
import { probeCodeql } from "./probe.js";

export { codeqlManifest } from "./manifest.js";
export { parseCodeqlSarif } from "./normalize.js";
export { findCodeql, probeCodeql } from "./probe.js";

const ADAPTER_ID = codeqlManifest.id;
const WORKSPACE = "{workspace}";
/** Replaced at run time by the SARIF file of the run. */
export const SARIF_TOKEN = "{codeqlSarif}";

/** CodeQL language identifiers and the query pack (and suite prefix) each one uses. */
export const LANGUAGES: Readonly<Record<string, string>> = {
  python: "python",
  "javascript-typescript": "javascript",
  "java-kotlin": "java",
  go: "go",
  csharp: "csharp",
  ruby: "ruby",
  swift: "swift",
  rust: "rust",
  "c-cpp": "cpp",
  actions: "actions",
};
export const SUITES = ["code-scanning", "security-extended", "security-and-quality"] as const;

/** The settings of an instance (tools.<id> in .jgates/tools.yml or in a template). */
export interface CodeqlSettings {
  language: string | null;
  suite: (typeof SUITES)[number];
  buildCommand: string | null;
  /** What the instance wrote that is not valid; the plan refuses it instead of guessing. */
  problems: string[];
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function codeqlSettings(input: Pick<ExternalPlanInput, "config" | "tool">): CodeqlSettings {
  const t = translator("codeql");
  const tools = isRec(input.config) && isRec(input.config.tools) ? input.config.tools : {};
  const body = isRec(tools[input.tool]) ? (tools[input.tool] as Record<string, unknown>) : {};
  const problems: string[] = [];
  let language: string | null = null;
  if (body.language === undefined) problems.push(t("codeql_setting_language_required", { tool: input.tool, allowed: Object.keys(LANGUAGES).join(", ") }));
  else if (typeof body.language === "string" && body.language in LANGUAGES) language = body.language;
  else problems.push(t("codeql_setting_language", { tool: input.tool, value: String(body.language), allowed: Object.keys(LANGUAGES).join(", ") }));
  let suite: CodeqlSettings["suite"] = "security-extended";
  if (body.suite !== undefined) {
    if (typeof body.suite === "string" && (SUITES as readonly string[]).includes(body.suite)) suite = body.suite as CodeqlSettings["suite"];
    else problems.push(t("codeql_setting_suite", { tool: input.tool, value: String(body.suite), allowed: SUITES.join(", ") }));
  }
  let buildCommand: string | null = null;
  if (body.buildCommand !== undefined) {
    if (typeof body.buildCommand === "string" && body.buildCommand.trim() !== "" && !/[\r\n]/.test(body.buildCommand)) buildCommand = body.buildCommand;
    else problems.push(t("codeql_setting_build_command", { tool: input.tool }));
  }
  return { language, suite, buildCommand, problems };
}

/** The suite file of a language: `codeql/<pack>-queries:codeql-suites/<pack>-<suite>.qls`. */
export function suiteReference(language: string, suite: string): string {
  const pack = LANGUAGES[language] ?? language;
  return `codeql/${pack}-queries:codeql-suites/${pack}-${suite}.qls`;
}

const dbEntry = (): NonNullable<ReturnType<typeof outputPathFor>> => {
  const entry = outputPathFor(codeqlManifest, "cache");
  if (!entry) throw new Error("the codeql manifest declares no database output path");
  return entry;
};

/** The structured setup guidance of the missing tool (name, versions, official links, license note). */
export function codeqlSetupGuidance(detail: string): string {
  return translator("codeql")("codeql_missing", {
    detail,
    range: codeqlManifest.toolVersionRange,
    download: (codeqlManifest.distribution?.acquisition ?? []).join(" , "),
    docs: (codeqlManifest.distribution?.setup ?? []).join(" , "),
  });
}

function planCodeql(input: ExternalPlanInput): ExternalPlan {
  const t = translator("codeql");
  const settings = codeqlSettings(input);
  const probe = probeCodeql(input.env);
  const root = input.componentRoot && input.componentRoot !== "." ? input.componentRoot : null;
  const db = outputPathUnder(RUN_DIR_TOKEN, dbEntry());
  const language = settings.language ?? "<language>";
  const suite = suiteReference(language, settings.suite);
  const createArgs = ["database", "create", db, `--language=${language}`, "--source-root=.", "--overwrite", ...(settings.buildCommand ? [`--command=${settings.buildCommand}`] : [])];
  const args = ["database", "analyze", db, suite, "--format=sarif-latest", `--output=${SARIF_TOKEN}`, "--no-download"];
  let availability: ExternalPlan["availability"];
  let blocksPlan = false;
  if (settings.problems.length > 0) {
    availability = { status: "unavailable", reason: settings.problems.join(" ") };
    blocksPlan = true;
  } else if (probe.problem === "not_found") availability = { status: "unavailable", reason: codeqlSetupGuidance(probe.detail) };
  else if (probe.problem === "no_answer") availability = { status: "unavailable", reason: t("codeql_probe_failed", { path: probe.detail, range: codeqlManifest.toolVersionRange }) };
  else if (probe.version !== null && satisfiesRange(probe.version, codeqlManifest.toolVersionRange) !== true) {
    availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: codeqlManifest.toolName, version: probe.version, range: codeqlManifest.toolVersionRange, what: ADAPTER_ID }) };
  } else availability = { status: "available", reason: null };

  return {
    label: t("codeql_label"),
    command: {
      executable: probe.executable ?? codeqlManifest.toolName,
      args,
      cwd: root ? `${WORKSPACE}/${root}` : WORKSPACE,
      env: { ...redirectionEnv(codeqlManifest), NO_COLOR: "1" },
      stdin: null,
    },
    runtime: { name: "native", interpreter: probe.executable, available: probe.executable !== null && probe.version !== null },
    toolVersion: probe.version,
    configFiles: [],
    availability,
    blocksPlan,
    network: false,
    limitations: [t("codeql_limitation_customer")],
    conditions: [
      t("codeql_condition_scope", { language, suite: settings.suite }),
      t(settings.buildCommand ? "codeql_condition_build" : "codeql_condition_autobuild", { command: settings.buildCommand ?? "" }),
      t("codeql_condition_license"),
    ],
    contract: { language: settings.language, suite: settings.suite, createArgs },
    output: { format: "sarif", schema: null },
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");

async function runCodeql(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("codeql");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("codeql_no_invocation", { tool }));

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const command = invocation.command;
  const cwd = substituteTokens(command.cwd, tokens);
  const contract = (invocation.contract ?? {}) as Record<string, unknown>;
  const createArgs = Array.isArray(contract.createArgs) ? (contract.createArgs as unknown[]).filter((a): a is string => typeof a === "string") : [];
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
  const version = items[0]?.versions.toolVersion ?? null;
  const scanRoot = path.relative(context.workspacePath, cwd).split(path.sep).join("/") || ".";

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  createOutputPaths(codeqlManifest, context.runDir);
  const sarifFile = path.join(outDir, "codeql.sarif");
  const stdoutLog = path.join(context.logsDir, `${tool}.stdout.log`);
  const stderrLog = path.join(context.logsDir, `${tool}.stderr.log`);
  const createStdout = path.join(context.logsDir, `${tool}.create.stdout.log`);
  const createStderr = path.join(context.logsDir, `${tool}.create.stderr.log`);

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
  const all = (state: ResultStage["state"], reason: string, extra: Partial<ResultStage> = {}): AdapterOutput => ({ ...base, stages: items.map((i) => stageFor(i, state, reason, extra)), findings: [] });

  const unavailable = items.find((i) => i.availability.status !== "available");
  if (unavailable) return all("blocked", unavailable.availability.reason ?? t("codeql_blocked", { detail: command.executable }), { nativeStatus: "setup-required" });

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
  const spec = (args: string[], out: string, err: string) => ({ executable: command.executable, args, cwd, env, stdin: null, timeoutMs: timeoutSeconds * 1000, stdoutFile: out, stderrFile: err });

  // 1. The database. Only the run-owned process is stopped on cancellation; whatever was written stays as partial evidence.
  const created = await runSpec(spec(createArgs.map((a) => substituteTokens(a, tokens)), createStdout, createStderr), { parentEnv: context.env });
  base.logs = [relToRun(context.runDir, createStdout), relToRun(context.runDir, createStderr)];
  const stop = (r: typeof created, step: string): AdapterOutput | null => {
    if (r.spawnError) return { ...all("blocked", t("codeql_blocked", { detail: `${r.spawnError.code}: ${r.spawnError.message}` })), logs: base.logs };
    if (r.timedOut) return all("timeout", t("codeql_timeout", { seconds: timeoutSeconds }));
    if (r.cancelled) return all("cancelled", t("codeql_cancelled"));
    if (r.exitCode !== 0) {
      const detail = r.stderr.trim().split(/\r?\n/).slice(-3).join(" ") || String(r.signal ?? "");
      return all("error", t("codeql_exit_error", { step, code: r.exitCode ?? "-", detail }), { interpreted: false });
    }
    return null;
  };
  const createStop = stop(created, "database create");
  if (createStop) return createStop;

  // 2. The analysis of the selected suite, SARIF into the run folder.
  const args = command.args.map((a) => substituteTokens(a.replace(SARIF_TOKEN, sarifFile), tokens));
  const analyzed = await runSpec(spec(args, stdoutLog, stderrLog), { parentEnv: context.env });
  base.logs = [...base.logs, relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];
  const analyzeStop = stop(analyzed, "database analyze");
  if (analyzeStop) return { ...analyzeStop, logs: base.logs };

  let sarif = "";
  try {
    sarif = fs.readFileSync(sarifFile, "utf8");
  } catch {
    sarif = "";
  }
  const parsed = sarif === "" ? { ok: false, findings: [], driverVersion: null, problem: "no SARIF file was written" } : parseCodeqlSarif(sarif, { stageId: items[0]?.id as string, version, root: scanRoot });
  if (!parsed.ok || analyzed.truncated) {
    const detail = analyzed.truncated ? "output truncated" : (parsed.problem ?? "");
    return { ...base, stages: items.map((i) => stageFor(i, "completed", t("codeql_invalid_output", { detail }), { interpreted: false, nativeStatus: "exit 0" })), findings: [] };
  }
  const count = parsed.findings.length;
  const blocking = parsed.findings.filter((f) => f.blocking).length;
  const reason = t("codeql_reason_completed", { version: version ?? parsed.driverVersion ?? "?", count });
  return {
    ...base,
    stages: items.map((i) => stageFor(i, "completed", reason, { blockingViolations: blocking, findings: count, nativeStatus: "exit 0" })),
    findings: parsed.findings,
  };
}

export const codeqlAdapter: ExternalAdapter = {
  manifest: codeqlManifest,
  plan: planCodeql,
  run: runCodeql,
};
