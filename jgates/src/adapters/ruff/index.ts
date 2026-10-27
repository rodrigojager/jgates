// Ruff adapter: plans one `ruff check` per tool instance (configuration file chosen by the binding or by Ruff's own
// resolution, cache in the run folder as the manifest declares, JSON on stdout) and normalizes its findings. The
// instance runs on the local runner, or on the container runner when tools.yml says `runner: container` (the image
// pinned in .jgates/lock.json by `tools prepare`, workspace read-only, the cache folder as the only writable mount).
// Nothing is written in the workspace.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { CONTAINER_OUTPUT, CONTAINER_WORKSPACE, runContainer, runSpec, substituteTokens, toContainerPath, type ExecutionResult } from "../../core/runner/index.js";
import { createOutputPaths, outputPathFor, outputPathUnder, redirectionEnv, RUN_DIR_TOKEN } from "../../core/run/redirection.js";
import type { AdapterContext, AdapterOutput, ResultStage } from "../../core/run/types.js";
import { chooseRuffConfig } from "./config.js";
import { probeRuffImage, type RuffImageProbe } from "./container.js";
import { ruffManifest } from "./manifest.js";
import { parseRuffOutput } from "./normalize.js";
import { probeRuff } from "./probe.js";

export { ruffManifest } from "./manifest.js";
export { parseRuffOutput } from "./normalize.js";
export { chooseRuffConfig } from "./config.js";
export { findRuff, probeRuff } from "./probe.js";
export { IMAGE_VERSION_LABEL, probeRuffImage } from "./container.js";

const ADAPTER_ID = ruffManifest.id;
const WORKSPACE = "{workspace}";

/** The planning input with the resolved configuration (the build passes it to every adapter). */
export type RuffPlanInput = ExternalPlanInput & { config?: Record<string, unknown> };

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The runner tools.yml chose for the instance: `container` or the default `local`. */
export function runnerOf(input: RuffPlanInput): "local" | "container" {
  const tools = isRec(input.config) && isRec(input.config.tools) ? input.config.tools : {};
  const body = tools[input.tool];
  return isRec(body) && body.runner === "container" ? "container" : "local";
}

/** The cache folder the manifest declares (run-folder relative). */
const cachePath = (): NonNullable<ReturnType<typeof outputPathFor>> => {
  const entry = outputPathFor(ruffManifest, "cache");
  if (!entry) throw new Error("the Ruff manifest declares no cache output path");
  return entry;
};

function versionAvailability(version: string | null): ExternalPlan["availability"] | null {
  if (version !== null && satisfiesRange(version, ruffManifest.toolVersionRange) !== true) {
    return { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: ruffManifest.toolName, version, range: ruffManifest.toolVersionRange, what: ADAPTER_ID }) };
  }
  return null;
}

function containerAvailability(probe: RuffImageProbe, instance: string): ExternalPlan["availability"] {
  const t = translator("ruff");
  const params = { instance, image: probe.image ?? "-", detail: probe.detail, command: probe.command, runtime: probe.runtimeName };
  switch (probe.problem) {
    case "runtime_missing":
      return { status: "unavailable", reason: t("ruff_container_runtime_missing", params) };
    case "lock_invalid":
      return { status: "unavailable", reason: t("ruff_container_lock_invalid", params) };
    case "image_unprepared":
      return { status: "unavailable", reason: t("ruff_container_image_unprepared", params) };
    case "image_missing":
      return { status: "unavailable", reason: t("ruff_container_image_missing", params) };
    case "image_changed":
      return { status: "unavailable", reason: t("ruff_container_image_changed", params) };
    default:
      return versionAvailability(probe.version) ?? { status: "available", reason: null };
  }
}

/** The command the plan shows: executable and args (no shell), configuration chosen, cache in the run folder. */
function planRuff(input: RuffPlanInput): ExternalPlan {
  const t = translator("ruff");
  const governed = input.policyDir !== undefined;
  const config = chooseRuffConfig(input.dir, input.tool, input.componentRoot, input.policyDir);
  // jgates ci: # noqa and # ruff: noqa are ignored, and so is a .gitignore of the project.
  const hardening = governed ? ["--ignore-noqa", "--no-respect-gitignore"] : [];
  const configPath = (file: string): string => (config.source === "policy" ? file : `${WORKSPACE}/${file}`);
  const governedConditions = governed ? [translator("governed")("governed_ruff_condition", { config: config.file ?? "--isolated" })] : [];
  const root = input.componentRoot && input.componentRoot !== "." ? input.componentRoot : null;
  const cache = cachePath();
  const common = {
    label: t("ruff_label"),
    configFiles: config.file ? [{ file: config.file, sha256: config.sha256 }] : [],
    blocksPlan: false,
    network: false,
    limitations: [],
    output: { format: "json", schema: null },
  };
  const cwd = root ? `${WORKSPACE}/${root}` : WORKSPACE;

  if (runnerOf(input) === "container") {
    // Inside the container the workspace is /workspace (read-only) and the cache folder of the run is /output.
    // The image comes from the lock of the configuration folder (the policy's, under a CI policy).
    const probe = probeRuffImage(input.env, input.policyDir ?? input.dir, input.tool);
    const args = [
      "check",
      ...(config.file ? ["--config", config.source === "policy" ? config.file : toContainerPath(config.file)] : ["--isolated"]),
      ...hardening,
      "--no-fix",
      "--output-format",
      "json",
      "--cache-dir",
      CONTAINER_OUTPUT,
      ".",
    ];
    return {
      ...common,
      command: {
        executable: ruffManifest.toolName,
        args,
        cwd,
        env: redirectionEnv(ruffManifest, RUN_DIR_TOKEN, () => CONTAINER_OUTPUT),
        stdin: null,
        container: {
          runtime: probe.runtime ?? probe.runtimeName,
          image: probe.image ?? "",
          network: "none",
          mounts: [
            { source: WORKSPACE, target: CONTAINER_WORKSPACE, readOnly: true },
            { source: outputPathUnder(RUN_DIR_TOKEN, cache), target: CONTAINER_OUTPUT, readOnly: false },
          ],
        },
      },
      runtime: { name: "container", interpreter: probe.runtime, available: probe.problem === null },
      toolVersion: probe.version,
      // The container sees only the workspace and the output folder: the policy's file cannot reach it.
      availability: config.source === "policy" ? { status: "unavailable", reason: translator("governed")("governed_ruff_container_policy", { tool: input.tool }) } : containerAvailability(probe, input.tool),
      ...(config.source === "policy" ? { blocksPlan: true } : {}),
      conditions: [t("ruff_condition_python"), t("ruff_condition_container", { image: probe.image ?? "-" }), ...governedConditions],
    };
  }

  const probe = probeRuff(input.env);
  const args = [
    "check",
    ...(config.file ? ["--config", configPath(config.file)] : ["--isolated"]),
    ...hardening,
    "--no-fix",
    "--output-format",
    "json",
    "--cache-dir",
    outputPathUnder(RUN_DIR_TOKEN, cache),
    ".",
  ];
  const availability: ExternalPlan["availability"] =
    probe.problem === "not_found"
      ? { status: "unavailable", reason: t("ruff_missing", { detail: probe.detail }) }
      : probe.problem === "no_answer"
        ? { status: "unavailable", reason: t("ruff_probe_failed", { path: probe.detail }) }
        : (versionAvailability(probe.version) ?? { status: "available", reason: null });
  return {
    ...common,
    command: {
      executable: probe.executable ?? ruffManifest.toolName,
      args,
      cwd,
      env: redirectionEnv(ruffManifest),
      stdin: null,
    },
    runtime: { name: "native", interpreter: probe.executable, available: probe.executable !== null && probe.version !== null },
    toolVersion: probe.version,
    availability,
    conditions: [t("ruff_condition_python"), ...governedConditions],
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");

async function runRuff(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("ruff");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("ruff_no_invocation", { tool }));

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const command = invocation.command;
  const cwd = substituteTokens(command.cwd, tokens);
  const args = command.args.map((a) => substituteTokens(a, tokens));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
  const version = items[0]?.versions.toolVersion ?? null;

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  // The folders the manifest says the tool writes into instead of the workspace (the cache).
  createOutputPaths(ruffManifest, context.runDir);
  const outFile = path.join(outDir, "ruff.json");
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
  if (unavailable) return blockedAll(unavailable.availability.reason ?? t("ruff_blocked", { detail: command.executable }));

  // The runner streams both outputs to the log files with its size limit (JGATES_MAX_LOG_BYTES) and the process facts.
  const container = command.container;
  let result: ExecutionResult;
  let parseRoots = { workspace: context.workspacePath, cwd };
  if (container) {
    const mount = (target: string): string => substituteTokens(container.mounts.find((m) => m.target === target)?.source ?? "", tokens);
    const workspace = mount(CONTAINER_WORKSPACE);
    const outputDir = mount(CONTAINER_OUTPUT);
    const relCwd = path.relative(workspace, cwd).split(path.sep).join("/") || ".";
    try {
      result = await runContainer(
        {
          runtime: container.runtime,
          image: container.image,
          command: args,
          workspace,
          ...(outputDir ? { outputDir } : {}),
          cwd: relCwd,
          env,
          network: container.network,
          timeoutMs: timeoutSeconds * 1000,
          stdin: null,
          stdoutFile: stdoutLog,
          stderrFile: stderrLog,
        },
        { parentEnv: context.env },
      );
    } catch (error) {
      // A spec the container runner refuses (an image not pinned, a bad mount) never starts.
      return blockedAll(t("ruff_blocked", { detail: (error as Error).message }));
    }
    parseRoots = { workspace: CONTAINER_WORKSPACE, cwd: toContainerPath(relCwd) };
  } else {
    result = await runSpec(
      { executable: command.executable, args, cwd, env, stdin: command.stdin === null ? null : JSON.stringify(command.stdin), timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
      { parentEnv: context.env },
    );
  }
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];

  if (result.spawnError) return { ...blockedAll(t("ruff_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
  if (result.timedOut) return { ...base, stages: items.map((i) => stageFor(i, "timeout", t("ruff_timeout", { seconds: timeoutSeconds }))), findings: [] };
  // Exit 0: clean. Exit 1: violations. Anything else (2: abnormal termination, a signal, 125-127: the container
  // runtime itself failed) proves nothing.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    const detail = result.stderr.trim().split(/\r?\n/).slice(-3).join(" ") || String(result.signal ?? "");
    return { ...base, stages: items.map((i) => stageFor(i, "error", t("ruff_exit_error", { code: result.exitCode ?? "-", detail }), { interpreted: false })), findings: [] };
  }
  fs.writeFileSync(outFile, result.stdout, { mode: 0o600 });
  const stageIds = items.map((i) => i.id);
  const parsed = parseRuffOutput(result.stdout, { stageId: stageIds[0] as string, version, ...parseRoots });
  if (!parsed.ok || result.truncated) {
    const detail = result.truncated ? "output truncated" : (parsed.problem ?? "");
    return { ...base, stages: items.map((i) => stageFor(i, "completed", t("ruff_invalid_output", { detail }), { interpreted: false, nativeStatus: `exit ${result.exitCode}` })), findings: [] };
  }
  const count = parsed.findings.length;
  return {
    ...base,
    stages: items.map((i) =>
      stageFor(i, "completed", t("ruff_reason_completed", { version: version ?? "?", count }), {
        blockingViolations: count,
        findings: count,
        nativeStatus: `exit ${result.exitCode}`,
      }),
    ),
    findings: parsed.findings,
  };
}

export const ruffAdapter: ExternalAdapter = {
  manifest: ruffManifest,
  plan: planRuff,
  run: runRuff,
};
