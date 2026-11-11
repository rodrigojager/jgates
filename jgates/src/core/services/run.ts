// The services of a container-first run (PLAN-services.md section 4). A `services` phase after the sync and the
// dependencies starts the selected compose services as the run's own project (`jgates-<ws>-<run>`) with the JGates
// override file of the run folder, waits for the healthchecks (`up --wait`) and for the target's health path (polled from
// a helper container on the project network), and the steps that need services join that network. A failure never
// blocks the other steps: the dependent ones are blocked with SERVICES_NOT_READY and the services' logs are a log block
// of the run (logs/services.log); a step that names a service nobody configured is SERVICES_REQUIRED. The project is
// registered for the cancellation (runner/cancel.ts) before it starts, and taken down with `down -v --remove-orphans`
// when the services fail and when the run ends, whatever happened.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { composeDown, engineCommand, engineLabels, engineRuntime, inspectImageSync, runInEngine, type EngineContext, type EngineMount } from "../engine/index.js";
import type { Plan } from "../plan/types.js";
import { resolveReason } from "../reasons/index.js";
import { forgetRunServices, registerRunServices, type ServicesProject } from "../runner/cancel.js";
import type { PhaseOutcome, PreflightCode, PreflightProblem, RunPhase, RunStep } from "../runner/index.js";
import { toolsImageTarget } from "../tools-image/index.js";
import { servicesNetworkName, servicesProjectName } from "./config.js";
import { servicesOverride } from "./override.js";
import { selectServices, type ServicesSelection } from "./selection.js";

export const SERVICES_PHASE_ID = "services";
export const SERVICES_NOT_READY = "SERVICES_NOT_READY";
export const SERVICES_REQUIRED = "SERVICES_REQUIRED";
/** The log block of the services (compose up, the services' own logs on failure, the teardown). */
export const SERVICES_LOG = "logs/services.log";

export interface ServicesRunInput {
  plan: Plan;
  /** The analyzed tree (compose files and project bind mounts are relative to it). */
  projectDir: string;
  /** Where jgates.yml is read: the project, or the CI policy in governed runs. */
  configDir: string;
  workspace: string;
  runId: string;
  runDir: string;
  version: string;
  env: NodeJS.ProcessEnv;
  governed: boolean;
  engine?: EngineContext;
  signal?: AbortSignal;
}

export type ServicesStatus = "pending" | "ready" | "not-ready" | "refused" | "not-configured" | "cancelled";

export interface ServicesRun {
  phase: RunPhase;
  /** The steps with a preflight that blocks them when their services are not ready. */
  gate(steps: RunStep[]): RunStep[];
  /** The network of a step that uses the services (null for the others, or when the services are not ready). */
  stepEnvironment(stepId: string): { mounts: EngineMount[]; env: Record<string, string>; network: string } | null;
  /** Takes the run's compose project down (idempotent); always called when the steps end. */
  teardown(): Promise<void>;
  status(): ServicesStatus;
  /** Compose project name of the run. */
  project: string;
  selection: ServicesSelection;
}

/** The health poll of the target: GET until 2xx/3xx or the deadline (python3 of the tools image). */
export const HEALTH_POLL = [
  "import sys, time, urllib.request",
  "url, deadline, last = sys.argv[1], time.time() + float(sys.argv[2]), ''",
  "while time.time() < deadline:",
  "    try:",
  "        with urllib.request.urlopen(url, timeout=5) as r:",
  "            print('ready', r.status, url); sys.exit(0)",
  "    except Exception as e:",
  "        last = str(e)",
  "    time.sleep(1)",
  "print('not ready', url, last); sys.exit(1)",
].join("\n");

interface ComposeState {
  service: string;
  state: string;
  health: string;
}

function parsePs(text: string): ComposeState[] {
  const rows: Array<Record<string, unknown>> = [];
  const trimmed = text.trim();
  try {
    if (trimmed.startsWith("[")) rows.push(...(JSON.parse(trimmed) as Array<Record<string, unknown>>));
    else for (const line of trimmed.split(/\r?\n/)) if (line.trim().startsWith("{")) rows.push(JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
  return rows.map((r) => ({ service: String(r.Service ?? r.Name ?? ""), state: String(r.State ?? ""), health: String(r.Health ?? "") })).sort((a, b) => (a.service < b.service ? -1 : 1));
}

/** The service compose names in a failed `up --wait` ("container jgates-...-db-1 is unhealthy"), when it can tell. */
function failedService(text: string, project: string, services: string[]): string | null {
  const container = new RegExp(`${project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[-_]([A-Za-z0-9_.-]+?)[-_]\\d+`, "i").exec(text);
  if (container?.[1] && services.includes(container[1])) return container[1];
  return services.find((s) => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)) ?? null;
}

/** The services of a run, or null when no planned step uses any. */
export function createServicesRun(input: ServicesRunInput): ServicesRun | null {
  const t = translator("services");
  const selection = selectServices({ projectDir: input.projectDir, configDir: input.configDir, items: input.plan.groups.willRun, invocations: input.plan.invocations, governed: input.governed });
  if (!selection) return null;
  const engine: EngineContext = input.engine ?? { runtime: engineRuntime(input.env), runnerOptions: { parentEnv: input.env } };
  const project = servicesProjectName(input.workspace, input.runId);
  const network = servicesNetworkName(project);
  const labels = engineLabels({ kind: "services", version: input.version, workspace: input.workspace, run: input.runId });
  const config = selection.config;
  const timeout = config?.timeoutSeconds ?? 120;
  const composeFiles = (selection.discovery?.files ?? []).map((f) => path.resolve(input.projectDir, f));
  const overrideFile = path.join(input.runDir, "services", "compose.jgates.yml");
  const logFile = path.join(input.runDir, ...SERVICES_LOG.split("/"));
  const registered: ServicesProject = { project, files: [...composeFiles, overrideFile], labels };
  const base = ["compose", "--project-name", project, ...registered.files.flatMap((f) => ["-f", f]), ...(config?.profiles ?? []).flatMap((p) => ["--profile", p])];
  let status: ServicesStatus = config && selection.start.length > 0 ? "pending" : "not-configured";
  let notReady: { service: string; message: string } | null = null;
  let started = false;
  let down: Promise<void> | null = null;

  const log = (text: string): void => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, text.endsWith("\n") ? text : `${text}\n`);
  };
  const logCommand = (args: string[], result: { stdout: string; stderr: string; exitCode: number | null }): void =>
    log(`$ docker ${args.join(" ")}\n${result.stdout}${result.stderr}[exit ${result.exitCode ?? "-"}]\n`);

  const teardown = (): Promise<void> =>
    (down ??= (async () => {
      if (!started) return;
      try {
        const args = await composeDown(registered, engine);
        log(`$ docker ${args.join(" ")}\n[exit 0]\n`);
      } catch (error) {
        log(`compose down failed: ${error instanceof Error ? `${error.message} ${"details" in error ? String((error as { details: unknown }).details) : ""}` : String(error)}`);
      } finally {
        forgetRunServices(input.runId);
      }
    })());

  const fail = async (service: string, detail: string): Promise<void> => {
    status = "not-ready";
    notReady = { service, message: `${resolveReason(SERVICES_NOT_READY, { service, seconds: timeout }).message} ${t("services_see_log", { log: SERVICES_LOG })}` };
    if (detail) log(detail);
    const logsArgs = [...base, "logs", "--no-color", "--timestamps", "--tail", "500"];
    const logs = await engineCommand(logsArgs, engine, 120_000).catch(() => null);
    if (logs) logCommand(logsArgs, logs);
    await teardown();
  };

  const phase: RunPhase = {
    id: SERVICES_PHASE_ID,
    label: t("services_phase_label"),
    async run(): Promise<PhaseOutcome> {
      const details = (): Record<string, unknown> => ({
        status,
        project,
        network,
        services: selection.start,
        hostEffects: selection.hostEffects,
        ...(selection.refused.length > 0 ? { refused: selection.refused } : {}),
        ...(fs.existsSync(overrideFile) ? { overrideFile: path.relative(input.runDir, overrideFile).split(path.sep).join("/") } : {}),
      });
      if (status === "not-configured") return { ok: true, details: details() };
      if (selection.refused.length > 0) {
        status = "refused";
        return { ok: true, details: details() };
      }
      if (input.signal?.aborted) {
        status = "cancelled";
        return { ok: true, details: details() };
      }
      fs.mkdirSync(path.dirname(overrideFile), { recursive: true });
      fs.writeFileSync(overrideFile, servicesOverride({ discovery: selection.discovery as NonNullable<ServicesSelection["discovery"]>, services: selection.start, labels, writable: selection.writable }), { mode: 0o600 });
      // Registered before anything starts, so a cancellation in the middle of `up` takes the project down too.
      registerRunServices(input.runId, registered);
      started = true;
      const upArgs = [...base, "up", "--detach", "--wait", "--wait-timeout", String(timeout), "--pull", "missing", "--quiet-pull", ...(config?.build === "allow" ? [] : ["--no-build"]), ...selection.start];
      const up = await engineCommand(upArgs, engine, timeout * 1000 + 600_000);
      logCommand(upArgs, up);
      if (input.signal?.aborted) {
        status = "cancelled";
        await teardown();
        return { ok: true, details: details(), logs: [SERVICES_LOG] };
      }
      if (up.spawnError || up.exitCode !== 0) {
        const text = `${up.stdout}\n${up.stderr}`;
        await fail(failedService(text, project, selection.start) ?? selection.start.join(", "), up.spawnError ? up.spawnError.message : "");
        return { ok: true, details: details(), logs: [SERVICES_LOG] };
      }
      const health = config?.target?.health ? `http://${config.target.service}:${config.target.port}${config.target.health}` : null;
      if (health && config?.target) {
        const reference = input.env.JGATES_TOOLS_IMAGE?.trim() || toolsImageTarget(input.env).reference;
        const image = inspectImageSync(reference, engine);
        const poll = image
          ? await runInEngine(
              {
                image: image.id,
                command: ["python3", "-c", HEALTH_POLL, health, String(timeout)],
                labels: engineLabels({ kind: "helper", version: input.version, workspace: input.workspace, run: input.runId }),
                network,
                resources: { memoryMb: 128, cpus: 1, pids: 32 },
                timeoutMs: (timeout + 30) * 1000,
                ...(input.signal ? { signal: input.signal } : {}),
              },
              engine,
            )
          : null;
        log(poll ? `$ health ${health}\n${poll.stdout}${poll.stderr}[exit ${poll.exitCode ?? "-"}]\n` : `$ health ${health}\nthe tools image ${reference} is not available\n`);
        if (!poll || poll.exitCode !== 0) {
          await fail(config.target.service, "");
          return { ok: true, details: details(), logs: [SERVICES_LOG] };
        }
      }
      const psArgs = [...base, "ps", "--all", "--format", "json"];
      const ps = await engineCommand(psArgs, engine, 60_000).catch(() => null);
      status = "ready";
      return { ok: true, details: { ...details(), states: ps ? parsePs(ps.stdout) : [] }, logs: [SERVICES_LOG] };
    },
  };

  const problemsOf = (stepId: string): PreflightProblem[] => {
    const need = selection.steps.get(stepId);
    if (!need) return [];
    if (need.required) {
      const detail = need.required.reason === "unknown-service" ? t("services_unknown", { service: need.required.service ?? "-" }) : t("services_not_configured");
      return [{ code: SERVICES_REQUIRED as PreflightCode, message: `${resolveReason(SERVICES_REQUIRED).message} ${detail}` }];
    }
    if (status === "ready") return [];
    if (status === "refused") {
      const effects = selection.refused.map((e) => `${e.service}: ${e.detail}`).join("; ");
      return [{ code: SERVICES_NOT_READY as PreflightCode, message: t("services_refused", { effects }) }];
    }
    const failed = notReady as { service: string; message: string } | null;
    if (failed) return [{ code: SERVICES_NOT_READY as PreflightCode, message: failed.message }];
    return [{ code: SERVICES_NOT_READY as PreflightCode, message: resolveReason(SERVICES_NOT_READY, { service: selection.start.join(", ") || "-", seconds: timeout }).message }];
  };

  return {
    phase,
    gate(steps) {
      return steps.map((step) => (selection.steps.has(step.id) ? { ...step, preflight: () => [...(step.preflight?.() ?? []), ...problemsOf(step.id)] } : step));
    },
    stepEnvironment(stepId) {
      const need = selection.steps.get(stepId);
      if (!need || need.required || status !== "ready") return null;
      return { mounts: [], env: {}, network };
    },
    teardown,
    status: () => status,
    project,
    selection,
  };
}
