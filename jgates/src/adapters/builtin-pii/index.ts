// builtin-pii adapter: the PII detector of the quality sidecar, called through the JSON bridge with a PII-only request.
// The plan shows the command (interpreter, `-m quality_sidecar bridge`, request on stdin); the run executes exactly that.
// Nothing is written in the workspace, and neither the findings, the response file nor the logs carry the matched text.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { resolvePython, resolveSidecarDir } from "../../core/bridge/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { runSpec, substituteTokens } from "../../core/runner/index.js";
import type { AdapterContext, AdapterOutput, ResultStage } from "../../core/run/types.js";
import { builtinPiiManifest } from "./manifest.js";
import { parsePiiResponse } from "./normalize.js";
import { bridgeConfig } from "./settings.js";
import type { SelectionResult } from "../../core/selection/index.js";

export { builtinPiiManifest } from "./manifest.js";
export { parsePiiResponse } from "./normalize.js";
export { bridgeConfig, entityStates, SUPPORTED_ENTITIES, UNSUPPORTED_ENTITIES } from "./settings.js";

const ADAPTER_ID = builtinPiiManifest.id;
const CONFIG_FILE = ".jgates/pii.yml";
const RUN_DIR = "{runDir}";
const WORKSPACE = "{workspace}";
const BRIDGE_ARGS = ["-m", "quality_sidecar", "bridge"];

interface PiiFile {
  file: string | null;
  sha256: string | null;
}

/** The hash of .jgates/pii.yml (absent: no file). `config validate` reports problems in it. */
function readFile(dir: string): PiiFile {
  try {
    const bytes = fs.readFileSync(path.join(dir, CONFIG_FILE));
    return { file: CONFIG_FILE, sha256: "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex") };
  } catch {
    return { file: null, sha256: null };
  }
}

/** What the plan builder hands over beyond the common input: the resolved configuration and its selection. */
export type PiiPlanInput = ExternalPlanInput & { config?: Record<string, unknown>; selection?: SelectionResult };

function sidecarVersion(sidecarDir: string | null): string | null {
  if (!sidecarDir) return null;
  try {
    const text = fs.readFileSync(path.join(path.dirname(sidecarDir), "pyproject.toml"), "utf8");
    return /^version\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

function planPii(input: PiiPlanInput): ExternalPlan {
  const t = translator("pii");
  const { interpreter } = resolvePython(input.env);
  const sidecarDir = resolveSidecarDir(input.env);
  const settings = readFile(input.dir);
  const root = input.componentRoot && input.componentRoot !== "." ? input.componentRoot : null;
  const availability: ExternalPlan["availability"] =
    interpreter === null
      ? { status: "unavailable", reason: t("pii_python_missing", { python: input.env.JGATES_PYTHON ?? "python" }) }
      : sidecarDir === null
        ? { status: "unavailable", reason: t("pii_sidecar_missing") }
        : { status: "available", reason: null };
  return {
    label: t("pii_label"),
    command: {
      executable: interpreter ?? input.env.JGATES_PYTHON ?? "python",
      args: [...BRIDGE_ARGS],
      cwd: RUN_DIR,
      env: sidecarDir ? { PYTHONPATH: sidecarDir } : {},
      stdin: {
        schemaVersion: 1,
        operation: "pii",
        target: root ? `${WORKSPACE}/${root}` : WORKSPACE,
        config: bridgeConfig(input.config, input.selection),
      },
    },
    runtime: { name: "python", interpreter, available: interpreter !== null && sidecarDir !== null },
    toolVersion: sidecarVersion(sidecarDir),
    configFiles: settings.file ? [{ file: settings.file, sha256: settings.sha256 }] : [],
    availability,
    blocksPlan: false,
    network: false,
    limitations: [t("pii_limitation")],
    conditions: [t("pii_condition")],
    output: { format: "json", schema: null },
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");

async function runPii(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("pii");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("pii_no_invocation", { tool }));

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const command = invocation.command;
  const cwd = substituteTokens(command.cwd, tokens);
  const args = command.args.map((a) => substituteTokens(a, tokens));
  const env = Object.fromEntries(Object.entries(command.env).map(([k, v]) => [k, substituteTokens(v, tokens)]));
  const request = JSON.stringify(command.stdin, (_k, v: unknown) => (typeof v === "string" ? substituteTokens(v, tokens) : v));
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
    // An entity switched off for this run only (--skip pii:<entity>) is a reduction of the run, shown with its origin.
    disabled: items.flatMap((item) =>
      plan.selection.overrides
        .filter((o) => o.source === "--skip" && o.selector?.startsWith("pii:") && o.items.includes(item.id))
        .map((o) => ({ id: `${item.id}:${(o.selector as string).slice(4)}`, origin: "run" as const, reason: t("pii_entity_skipped", { entity: (o.selector as string).slice(4) }) })),
    ),
    logs: [] as string[],
    outputs: [relToRun(context.runDir, outDir)],
  };
  const blockedAll = (reason: string): AdapterOutput => ({ ...base, stages: items.map((i) => stageFor(i, "blocked", reason)), findings: [] });

  const unavailable = items.find((i) => i.availability.status !== "available");
  if (unavailable) return blockedAll(unavailable.availability.reason ?? t("pii_blocked", { detail: command.executable }));

  // The response holds no matched text; the logs are the response and the process facts only, streamed to disk by
  // the runner with its size limit.
  const result = await runSpec(
    {
      executable: command.executable,
      args,
      cwd,
      env: { ...env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      stdin: request,
      timeoutMs: timeoutSeconds * 1000,
      stdoutFile: stdoutLog,
      stderrFile: stderrLog,
    },
    { parentEnv: context.env },
  );
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];

  if (result.spawnError) return { ...blockedAll(t("pii_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
  if (result.timedOut) return { ...base, stages: items.map((i) => stageFor(i, "timeout", t("pii_timeout", { seconds: timeoutSeconds }))), findings: [] };

  const parsed = parsePiiResponse(result.stdout, { stageId: items[0]?.id as string, version });
  if (parsed.bridgeError) {
    const reason = t("pii_bridge_error", { code: parsed.bridgeError.code, message: parsed.bridgeError.message });
    return { ...base, stages: items.map((i) => stageFor(i, "error", reason, { interpreted: false, nativeStatus: `exit ${result.exitCode}` })), findings: [] };
  }
  if (!parsed.ok || result.truncated || result.exitCode !== 0) {
    const detail = result.truncated ? "output truncated" : (parsed.problem ?? `exit code ${result.exitCode ?? "-"}`);
    return { ...base, stages: items.map((i) => stageFor(i, "error", t("pii_invalid_output", { detail }), { interpreted: false, nativeStatus: `exit ${result.exitCode}` })), findings: [] };
  }
  fs.writeFileSync(path.join(outDir, "pii.json"), result.stdout, { mode: 0o600 });
  const count = parsed.findings.length;
  return {
    ...base,
    stages: items.map((i) =>
      stageFor(i, "completed", t("pii_reason_completed", { count }), { blockingViolations: count, findings: count, nativeStatus: `exit ${result.exitCode}` }),
    ),
    findings: parsed.findings,
  };
}

export const builtinPiiAdapter: ExternalAdapter = {
  manifest: builtinPiiManifest,
  plan: planPii,
  run: runPii,
};
