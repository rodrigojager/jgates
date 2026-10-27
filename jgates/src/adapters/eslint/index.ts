// ESLint adapter. Local mode only: plans one `eslint --format json` per tool instance with the project's own flat
// config (the tools.yml binding, else the file ESLint resolves itself), every output in the run folder. The
// configuration and its plugins are the project's code and run during the lint, so the plan declares "executes project
// code" and the cache never reuses the step. The ESLint inside the bridge's MegaLinter is not touched: it keeps forcing
// the trusted config with --no-inline-config.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { resolveToolBindings } from "../../core/tools/index.js";
import { runSpec, substituteTokens } from "../../core/runner/index.js";
import type { AdapterContext, AdapterOutput, ResultStage } from "../../core/run/types.js";
import { eslintManifest } from "./manifest.js";
import { parseEslintOutput } from "./normalize.js";
import { findEslint } from "./probe.js";

export { parseEslintOutput } from "./normalize.js";
export { findEslint, findNodeTool } from "./probe.js";

export { eslintManifest } from "./manifest.js";

/** Flat-config file names, in the order ESLint resolves them. */
export const ESLINT_CONFIG_FILES = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", "eslint.config.cts"] as const;

/**
 * The configuration file ESLint would pick in `dir` (relative name), by existence only: nothing is read or executed.
 * Null when there is none; callers then offer the editor an empty binding or keep the instance without a document.
 */
export function findEslintConfig(dir: string): string | null {
  for (const name of ESLINT_CONFIG_FILES) {
    try {
      if (fs.statSync(path.join(dir, name)).isFile()) return name;
    } catch {
      // not there
    }
  }
  return null;
}

/** The `config` binding of a tools.yml instance for the config found in `dir`, at the "editable file" level. */
export function eslintBinding(dir: string): { adapter: string; config: string } | null {
  const file = findEslintConfig(dir);
  return file ? { adapter: eslintManifest.id, config: file } : null;
}

const ADAPTER_ID = eslintManifest.id;
const RUN_DIR = "{runDir}";
const WORKSPACE = "{workspace}";

function sha256File(abs: string): string | null {
  try {
    return "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * The configuration of the instance: the tools.yml binding, else the flat config ESLint resolves from the component up.
 * Under a CI policy only the policy's binding counts (an absolute path in the policy folder); the project's own
 * eslint.config is never looked for.
 */
function chooseConfig(input: ExternalPlanInput): { file: string | null; source: "binding" | "native" | "policy" | "none" } {
  if (input.policyDir !== undefined) {
    try {
      const bound = resolveToolBindings(input.policyDir, { skipInventory: true, manifests: [eslintManifest] }).instances.find((i) => i.id === input.tool);
      const binding = bound?.bindings.find((b) => b.id === "config" && !b.refused && b.kind === "file" && b.exists);
      if (binding) return { file: binding.absPath, source: "policy" };
    } catch {
      // an unreadable tools.yml of the policy leaves the instance without a configuration
    }
    return { file: null, source: "none" };
  }
  try {
    const bound = resolveToolBindings(input.dir, { skipInventory: true, manifests: [eslintManifest] }).instances.find((i) => i.id === input.tool);
    const binding = bound?.bindings.find((b) => b.id === "config" && !b.refused && b.kind === "file" && b.relPath !== null && b.exists);
    if (binding?.relPath) return { file: binding.relPath, source: "binding" };
  } catch {
    // an unreadable tools.yml is reported by config validate; the native resolution still applies
  }
  // ESLint looks for the flat config from its working directory upward.
  const parts = input.componentRoot && input.componentRoot !== "." ? input.componentRoot.split("/") : [];
  for (let depth = parts.length; depth >= 0; depth--) {
    const rel = parts.slice(0, depth).join("/");
    const found = findEslintConfig(path.join(input.dir, rel));
    if (found) return { file: rel ? `${rel}/${found}` : found, source: "native" };
  }
  return { file: null, source: "none" };
}

function planEslint(input: ExternalPlanInput): ExternalPlan {
  const t = translator("eslint");
  const governed = input.policyDir !== undefined;
  const probe = findEslint(input.dir, input.componentRoot, input.env, governed);
  const config = chooseConfig(input);
  const out = `${RUN_DIR}/outputs/${ADAPTER_ID}/${input.tool}`;
  const args = [
    ...probe.prefix,
    ...(config.source === "binding" && config.file ? ["--config", `${WORKSPACE}/${config.file}`] : []),
    // jgates ci: the policy's file, and the eslint-disable and /* eslint */ comments of the code are ignored.
    ...(config.source === "policy" && config.file ? ["--config", config.file, "--no-inline-config"] : []),
    "--format",
    "json",
    "--output-file",
    `${out}/eslint.json`,
    "--no-warn-ignored",
    "--no-error-on-unmatched-pattern",
    ".",
  ];
  let availability: ExternalPlan["availability"];
  if (probe.problem === "not_found") availability = { status: "unavailable", reason: t("eslint_missing", { detail: probe.detail }) };
  else if (probe.problem === "no_version") availability = { status: "unavailable", reason: t("eslint_no_version", { path: probe.detail }) };
  else if (probe.version !== null && satisfiesRange(probe.version, eslintManifest.toolVersionRange) !== true) {
    availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: eslintManifest.toolName, version: probe.version, range: eslintManifest.toolVersionRange, what: ADAPTER_ID }) };
  } else if (config.file === null) {
    availability = { status: "unavailable", reason: governed ? translator("governed")("governed_eslint_no_policy_config", { tool: input.tool }) : t("eslint_no_config", { tool: input.tool }) };
  } else availability = { status: "available", reason: null };

  const g = translator("governed");
  const conditions: string[] = governed
    ? [g("governed_eslint_condition", { file: config.file ?? "-" })]
    : [t("eslint_condition_executes"), ...(config.file ? [t(config.source === "binding" ? "eslint_condition_config_binding" : "eslint_condition_config_native", { file: config.file })] : []), t("eslint_condition_inline")];
  return {
    label: t("eslint_label"),
    command: {
      executable: probe.executable ?? "eslint",
      args,
      cwd: input.componentRoot && input.componentRoot !== "." ? `${WORKSPACE}/${input.componentRoot}` : WORKSPACE,
      env: { CI: "1" },
      stdin: null,
    },
    runtime: { name: "native", interpreter: probe.executable, available: probe.executable !== null && probe.version !== null },
    toolVersion: probe.version,
    configFiles: config.file ? [{ file: config.file, sha256: sha256File(path.resolve(input.dir, config.file)) }] : [],
    availability,
    // Under a CI policy a missing configuration is the policy's problem: the plan is refused before anything runs.
    blocksPlan: governed && config.file === null,
    network: false,
    limitations: [],
    conditions,
    output: { format: "json", schema: null },
    // The configuration and its plugins are loaded and run by ESLint: the step is never reused from the cache. Under a
    // CI policy the configuration is the policy's and ESLint is never the project's copy: nothing of the project runs.
    effects: { executesProjectCode: !governed },
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");
const tail = (text: string): string => text.trim().split(/\r?\n/).slice(-3).join(" ");

async function runEslint(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("eslint");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("eslint_no_invocation", { tool }));

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const command = invocation.command;
  const cwd = substituteTokens(command.cwd, tokens);
  const args = command.args.map((a) => substituteTokens(a, tokens));
  const env: Record<string, string> = { PATH: context.env.PATH ?? "" };
  for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
  const version = items[0]?.versions.toolVersion ?? null;

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const reportFile = path.join(outDir, "eslint.json");
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
  const all = (state: ResultStage["state"], reason: string, extra: Partial<ResultStage> = {}): AdapterOutput => ({ ...base, stages: items.map((i) => stageFor(i, state, reason, extra)), findings: [] });

  const unavailable = items.find((i) => i.availability.status !== "available");
  if (unavailable) return all("blocked", unavailable.availability.reason ?? t("eslint_blocked", { detail: command.executable }));

  const result = await runSpec(
    { executable: command.executable, args, cwd, env, stdin: null, timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
    { parentEnv: context.env },
  );
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];

  if (result.spawnError) return { ...all("blocked", t("eslint_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
  if (result.timedOut) return { ...all("timeout", t("eslint_timeout", { seconds: timeoutSeconds })), logs: base.logs };
  // 0: clean, 1: lint errors (the report says which); anything else (2: configuration or internal error) proves nothing.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return { ...all("error", t("eslint_exit_error", { code: result.exitCode ?? "-", detail: tail(result.stderr) || String(result.signal ?? "") }), { interpreted: false }), logs: base.logs };
  }
  let text: string;
  try {
    text = fs.readFileSync(reportFile, "utf8");
  } catch (error) {
    return { ...all("error", t("eslint_invalid_output", { detail: (error as Error).message }), { interpreted: false, nativeStatus: `exit ${result.exitCode}` }), logs: base.logs };
  }
  const parsed = parseEslintOutput(text, { stageId: items[0]?.id as string, version, workspace: context.workspacePath });
  if (!parsed.ok || result.truncated) {
    const detail = result.truncated ? "output truncated" : (parsed.problem ?? "");
    return { ...all("error", t("eslint_invalid_output", { detail }), { interpreted: false, nativeStatus: `exit ${result.exitCode}` }), logs: base.logs };
  }
  const count = parsed.findings.length;
  const blocking = parsed.findings.filter((f) => f.blocking).length;
  return {
    ...base,
    stages: items.map((i) =>
      stageFor(i, "completed", t("eslint_reason_completed", { version: version ?? "?", files: parsed.filesLinted, count, blocking }), {
        blockingViolations: blocking,
        findings: count,
        nativeStatus: `exit ${result.exitCode}`,
      }),
    ),
    findings: parsed.findings,
  };
}

export const eslintAdapter: ExternalAdapter = {
  manifest: eslintManifest,
  plan: planEslint,
  run: runEslint,
};
