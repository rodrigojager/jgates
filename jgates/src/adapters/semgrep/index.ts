// Semgrep adapter: plans one `semgrep scan` per tool instance that uses only the local rules of the instance's
// binding (a rule file or a directory of rule files), with metrics and the version check off and the JSON output in
// the run folder. Its home (settings, log, caches) is the throwaway folder the manifest declares in the run folder.
// Nothing is downloaded and nothing is written in the workspace.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { collectRuleSource, issuesOf, type RuleSource } from "../../core/rules/index.js";
import { resolveHome } from "../../core/home/index.js";
import { LOCK_FILE, readLock } from "../../core/lock/index.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { SEMGREP_RULES_REF, preparedRulesOf } from "../../core/prepare/store.js";
import { runSpec, substituteTokens } from "../../core/runner/index.js";
import { createOutputPaths, redirectionEnv } from "../../core/run/redirection.js";
import type { AdapterContext, AdapterOutput, ResultStage } from "../../core/run/types.js";
import { semgrepManifest } from "./manifest.js";
import { parseSemgrepOutput } from "./normalize.js";
import { probeSemgrep, scannerPath } from "./probe.js";

export { semgrepManifest } from "./manifest.js";
export { parseSemgrepOutput } from "./normalize.js";
export { findSemgrep, probeSemgrep, scannerPath } from "./probe.js";

const ADAPTER_ID = semgrepManifest.id;
const RUN_DIR = "{runDir}";
const WORKSPACE = "{workspace}";
const MAX_SHOWN = 3;

/** Environment of the scanner: no metrics, no version check, the throwaway home of the manifest's output paths. */
const scannerEnv = (): Record<string, string> => ({
  ...redirectionEnv(semgrepManifest),
  SEMGREP_SEND_METRICS: "off",
  SEMGREP_ENABLE_VERSION_CHECK: "0",
});

function unusableReason(source: RuleSource, tool: string): string | null {
  const t = translator("semgrep");
  const where = source.relPath ?? source.binding ?? "-";
  if (source.problem?.code === "NO_BINDING") return t("semgrep_no_binding", { tool });
  if (source.problem?.code === "BINDING_REFUSED") return t("semgrep_binding_refused", { tool, detail: where });
  if (source.problem?.code === "BINDING_MISSING") return t("semgrep_binding_missing", { tool, detail: where });
  if (source.problem?.code === "NO_RULE_FILES") return t("semgrep_no_rule_files", { tool, detail: where });
  if (!source.valid) {
    const issues = issuesOf(source);
    const shown = issues.slice(0, MAX_SHOWN).map((i) => t("semgrep_issue", { file: i.file, where: i.line ? `:${i.line}` : "", message: i.message }));
    const more = issues.length > MAX_SHOWN ? ` ${t("semgrep_rules_hidden", { count: issues.length - MAX_SHOWN })}` : "";
    return t("semgrep_rules_invalid", { tool, detail: shown.join("; ") + more });
  }
  return null;
}

/** The command the plan shows: only the local rule files, no registry. */
function planSemgrep(input: ExternalPlanInput): ExternalPlan {
  const t = translator("semgrep");
  const probe = probeSemgrep(input.env);
  // Under a CI policy the rules and the lock are the policy's (absolute paths), never files of the analyzed project.
  const governed = input.policyDir !== undefined;
  const configDir = input.policyDir ?? input.dir;
  const source = collectRuleSource(configDir, input.tool);
  // Rules prepared by `jgates tools prepare` (pinned in .jgates/lock.json): the run uses that stored copy, never the network.
  const lockRead = readLock(configDir);
  const home = resolveHome({ env: input.env });
  const prepared = preparedRulesOf(lockRead.lock, input.tool, home);
  const usePrepared = prepared.state === "ready";
  const nothingLocal = source.problem?.code === "NO_BINDING" || source.problem?.code === "NO_RULE_FILES" || source.problem?.code === "BINDING_MISSING";
  const rulesProblem = usePrepared && nothingLocal ? null : unusableReason(source, input.tool);
  const root = input.componentRoot && input.componentRoot !== "." ? input.componentRoot : null;
  const configArgs = [
    ...source.files.flatMap((f) => ["--config", f.path && !governed ? `${WORKSPACE}/${f.path}` : f.abs]),
    ...(usePrepared && prepared.abs ? ["--config", prepared.abs] : []),
  ];
  const args = [
    "scan",
    ...configArgs,
    "--metrics=off",
    "--disable-version-check",
    "--no-rewrite-rule-ids",
    // jgates ci: nosem / nosemgrep comments, .semgrepignore and .gitignore of the project are ignored.
    ...(governed ? ["--disable-nosem", "--x-ignore-semgrepignore-files", "--no-git-ignore"] : []),
    "--quiet",
    "--json",
    "--output",
    `${RUN_DIR}/outputs/${ADAPTER_ID}/${input.tool}/semgrep.json`,
    ".",
  ];
  let availability: ExternalPlan["availability"];
  let blocksPlan = false;
  if (prepared.state === "missing" || prepared.state === "corrupt") {
    // The lock pins a rule set that is no longer on disk (or was altered): never fall back to something else silently.
    availability = { status: "unavailable", reason: t(prepared.state === "missing" ? "semgrep_prepared_missing" : "semgrep_prepared_corrupt", { tool: input.tool, ref: SEMGREP_RULES_REF, file: LOCK_FILE }) };
    blocksPlan = rulesProblem !== null;
  } else if (rulesProblem) {
    // A rule set that is missing or invalid cannot be run at all: the plan itself is blocked until it is fixed.
    availability = { status: "unavailable", reason: rulesProblem };
    blocksPlan = true;
  } else if (probe.problem === "not_found") availability = { status: "unavailable", reason: t("semgrep_missing", { detail: probe.detail }) };
  else if (probe.problem === "no_answer") availability = { status: "unavailable", reason: t("semgrep_probe_failed", { path: probe.detail }) };
  else if (probe.version !== null && satisfiesRange(probe.version, semgrepManifest.toolVersionRange) !== true) {
    availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: semgrepManifest.toolName, version: probe.version, range: semgrepManifest.toolVersionRange, what: ADAPTER_ID }) };
  } else availability = { status: "available", reason: null };
  const preparedFiles = usePrepared && lockRead.exists ? [{ file: LOCK_FILE, sha256: lockRead.sha256 }] : [];
  return {
    label: t("semgrep_label"),
    command: {
      executable: probe.executable ?? "semgrep",
      args,
      cwd: root ? `${WORKSPACE}/${root}` : WORKSPACE,
      env: scannerEnv(),
      stdin: null,
    },
    runtime: { name: "native", interpreter: probe.executable, available: probe.executable !== null && probe.version !== null },
    toolVersion: probe.version,
    configFiles: [
      ...(governed ? source.files.map((f) => ({ file: f.abs, sha256: f.sha256 })) : source.files.filter((f) => f.path !== null).map((f) => ({ file: f.path as string, sha256: f.sha256 }))),
      ...(governed ? preparedFiles.map((f) => ({ ...f, file: path.join(configDir, f.file) })) : preparedFiles),
    ],
    availability,
    blocksPlan,
    network: false,
    limitations: [],
    conditions: [
      usePrepared && prepared.entry ? t("semgrep_condition_prepared", { ref: prepared.entry.ref, hash: prepared.entry.hash.slice(0, 12), source: prepared.entry.source }) : t("semgrep_condition_local"),
      ...(governed ? [translator("governed")("governed_semgrep_condition")] : []),
    ],
    output: { format: "json", schema: null },
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");

async function runSemgrep(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("semgrep");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("semgrep_no_invocation", { tool }));

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const command = invocation.command;
  const cwd = substituteTokens(command.cwd, tokens);
  const args = command.args.map((a) => substituteTokens(a, tokens));
  const env: Record<string, string> = { PATH: scannerPath(context.env.PATH) };
  for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
  const version = items[0]?.versions.toolVersion ?? null;
  const ruleFiles = (items[0]?.configFiles ?? []).filter((f) => f.file !== LOCK_FILE).length;

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  // The folders the manifest says the scanner writes into instead of the workspace (its home).
  createOutputPaths(semgrepManifest, context.runDir);
  const outFile = path.join(outDir, "semgrep.json");
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
  if (unavailable) return blockedAll(unavailable.availability.reason ?? t("semgrep_blocked", { detail: command.executable }));

  // The runner streams both outputs to the log files with its size limit (JGATES_MAX_LOG_BYTES) and the process facts.
  const result = await runSpec(
    { executable: command.executable, args, cwd, env, stdin: command.stdin === null ? null : JSON.stringify(command.stdin), timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
    { parentEnv: context.env },
  );
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];

  if (result.spawnError) return { ...blockedAll(t("semgrep_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
  if (result.timedOut) return { ...base, stages: items.map((i) => stageFor(i, "timeout", t("semgrep_timeout", { seconds: timeoutSeconds }))), findings: [] };
  // Without --error Semgrep exits 0 whether or not it found something; any other code proves nothing.
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split(/\r?\n/).slice(-3).join(" ") || String(result.signal ?? "");
    return { ...base, stages: items.map((i) => stageFor(i, "error", t("semgrep_exit_error", { code: result.exitCode ?? "-", detail }), { interpreted: false })), findings: [] };
  }
  let json: string;
  try {
    json = fs.readFileSync(outFile, "utf8");
  } catch (error) {
    return { ...base, stages: items.map((i) => stageFor(i, "completed", t("semgrep_invalid_output", { detail: (error as Error).message }), { interpreted: false, nativeStatus: "exit 0" })), findings: [] };
  }
  const parsed = parseSemgrepOutput(json, { stageId: items[0]?.id as string, version, workspace: context.workspacePath, cwd });
  if (!parsed.ok || result.truncated) {
    const detail = result.truncated ? "output truncated" : (parsed.problem ?? "");
    return { ...base, stages: items.map((i) => stageFor(i, "completed", t("semgrep_invalid_output", { detail }), { interpreted: false, nativeStatus: "exit 0" })), findings: [] };
  }
  const count = parsed.findings.length;
  const blocking = parsed.findings.filter((f) => f.blocking).length;
  return {
    ...base,
    stages: items.map((i) =>
      stageFor(i, "completed", t("semgrep_reason_completed", { version: version ?? "?", count, rules: ruleFiles }), {
        blockingViolations: blocking,
        findings: count,
        nativeStatus: "exit 0",
      }),
    ),
    findings: parsed.findings,
  };
}

export const semgrepAdapter: ExternalAdapter = {
  manifest: semgrepManifest,
  plan: planSemgrep,
  run: runSemgrep,
};
