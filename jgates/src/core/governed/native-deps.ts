// The project's dependencies for a governed run inside the tools image (PLAN-architecture.md section 8): frozen installs
// only, run natively in the clean copy of the commit (there is no engine and no dependency volume in the job). The
// recipes are the container ones (`npm ci`, `uv sync --locked`, `--frozen-lockfile`, `go mod download` with
// `-mod=readonly`, `cargo fetch --locked`, `dotnet restore --locked-mode`); only the places change: `/workspace` is the
// copy of the commit, and what the container recipes redirect into volumes (/cache, /deps) stays where the tool puts it
// by default. Registries and their secrets come from the policy (`.jgates/dependencies.yml` of the policy folder, tokens
// from the environment only). A unit that cannot be installed (no lockfile, ambiguous or unsupported manager, failed
// install) blocks the checks that need it (DEPENDENCIES_NOT_READY / DEPENDENCIES_FAILED), so the run ends incomplete.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { ADAPTER_ID as BRIDGE_ID } from "../../adapters/quality-bridge/requirements.js";
import { discoverFor } from "../config/resolve/index.js";
import { loadDependencySettings } from "../deps/config.js";
import { maskSecrets, registryScript, TOKEN_VARIABLE } from "../deps/credentials.js";
import { planUnit } from "../deps/prepare.js";
import { unitsNeeded } from "../deps/plan.js";
import { needsDependencies, toolSourceOf } from "../deps/tools.js";
import type { InstallRecipe } from "../deps/recipes.js";
import type { Plan, PlanItem } from "../plan/types.js";
import { resolveExecutable } from "../runner/preflight.js";
import type { PhaseOutcome, PreflightCode, PreflightProblem, RunPhase, RunStep } from "../runner/index.js";
import { runSpec } from "../runner/process.js";
import type { AdapterContext } from "../run/types.js";

/** The record of the installs, in the run folder. */
export const NATIVE_DEPS_FILE = "deps-install.json";
export const NATIVE_DEPS_PHASE_ID = "deps";
const INSTALL_TIMEOUT_MS = 30 * 60_000;

export interface NativeUnitRecord {
  unit: string;
  components: string[];
  installRoot: string;
  manager: string | null;
  mode: InstallRecipe["mode"] | null;
  status: "installed" | "failed" | "not-ready";
  code: "DEPENDENCIES_FAILED" | "DEPENDENCIES_NOT_READY" | null;
  message: string;
  /** The commands run, one after the other, in the unit's install root. */
  commands: string[][];
  /** The environment the commands got besides the allowlisted one (GOFLAGS=-mod=readonly...): never a secret. */
  env: Record<string, string>;
  exitCode: number | null;
  log: string | null;
}

export interface NativeDepsInput {
  plan: Plan;
  /** Where dependencies.yml is read: the CI policy folder. */
  configDir: string;
}

export interface NativeDeps {
  phase(context: AdapterContext): RunPhase;
  /** The steps with a preflight that blocks them while one of their units is not installed. */
  gate(steps: RunStep[]): RunStep[];
  records(): NativeUnitRecord[];
}

/** The step that runs an item (the bridge runs every bridge item; any other adapter one step per tool instance). */
const stepOf = (item: PlanItem): string => (item.adapter === BRIDGE_ID ? BRIDGE_ID : item.tool);

/** The container paths of a recipe become paths of the copy of the commit; the volume targets (/cache, /deps) are dropped. */
function toNative(value: string, workspace: string): string {
  return value.replace(/^\/workspace(?=\/|$)/, workspace.split(path.sep).join("/"));
}
const redirectsToVolume = (value: string): boolean => /^\/(?:cache|deps)(?:\/|$)/.test(value);

function nativeEnv(env: Record<string, string>, workspace: string): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => !redirectsToVolume(v)).map(([k, v]) => [k, toNative(v, workspace)]));
}

export function createNativeDeps(input: NativeDepsInput): NativeDeps | null {
  const t = translator("deps");
  const items = input.plan.groups.willRun;
  const records = new Map<string, NativeUnitRecord>();
  const unitsOfStep = new Map<string, Set<string>>();
  const pathPrefixes: string[] = [];
  const stepEnvs: Record<string, string> = {};
  let planned = false;

  const plan = (workspace: string): void => {
    if (planned) return;
    planned = true;
    const classifications = discoverFor(workspace, input.configDir).classifications;
    const contractOf = new Map(input.plan.invocations.map((i) => [i.id, i.contract]));
    // ESLint under a policy is the image's copy with the policy's configuration (the project's node_modules is never
    // used): when the project does not declare ESLint, its dependencies are not installed for it.
    const needed = items.filter((item) => !(item.adapter === "eslint" && toolSourceOf(workspace, item, classifications, contractOf.get(item.tool))?.origin === "image"));
    const { units, itemsOf } = unitsNeeded(needed, classifications);
    const itemById = new Map(items.map((i) => [i.id, i]));
    for (const [unit, ids] of itemsOf) {
      for (const id of ids) {
        const item = itemById.get(id);
        if (!item || !needsDependencies(item)) continue;
        unitsOfStep.set(stepOf(item), new Set([...(unitsOfStep.get(stepOf(item)) ?? []), unit]));
      }
    }
    unitsToInstall = units;
  };
  let unitsToInstall: ReturnType<typeof unitsNeeded>["units"] = [];

  const wanted = items.some((i) => i.state.enabled && needsDependencies(i));
  if (!wanted) return null;

  const phase = (context: AdapterContext): RunPhase => ({
    id: NATIVE_DEPS_PHASE_ID,
    label: t("deps_phase_label"),
    async run(): Promise<PhaseOutcome> {
      const workspace = context.workspacePath;
      plan(workspace);
      const settings = loadDependencySettings(input.configDir);
      const logs: string[] = [];
      for (const unit of unitsToInstall) {
        const record: NativeUnitRecord = { unit: unit.id, components: unit.components, installRoot: unit.installRoot, manager: unit.info.manager, mode: null, status: "not-ready", code: "DEPENDENCIES_NOT_READY", message: "", commands: [], env: {}, exitCode: null, log: null };
        records.set(unit.id, record);
        if (context.signal?.aborted) break;
        // Governed: frozen only, secrets from the environment only (never the key store).
        const unitPlan = planUnit(unit, { projectDir: workspace, workspace: "native", imageId: null, governed: true, settings, env: context.env, vault: false });
        if (unitPlan.blocked || !unitPlan.recipe) {
          const blocked = unitPlan.blocked ?? { reasonKey: "deps_not_ready_unsupported", params: { unit: unit.id, manager: unit.info.manager ?? "-" } };
          record.message = t(blocked.reasonKey, blocked.params);
          continue;
        }
        const recipe = unitPlan.recipe;
        record.mode = recipe.mode;
        record.commands = recipe.commands.map((argv) => argv.map((a) => toNative(a, workspace)));
        const cwd = path.join(workspace, ...(unit.installRoot === "." ? [] : unit.installRoot.split("/")));
        const env = nativeEnv(recipe.installEnv, workspace);
        record.env = env;
        const registry = unitPlan.registry;
        const logName = `logs/deps-${unit.id.replace(/[^A-Za-z0-9_.-]/g, "_")}.log`;
        const logFile = path.join(context.runDir, ...logName.split("/"));
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        let text = "";
        let exitCode: number | null = 0;
        let spawnProblem = "";
        // With a registry the configuration is written by the same script the container uses (the token is read from
        // standard input); without one each command starts directly.
        const attempts: Array<{ executable: string; args: string[]; stdin: string | null }> = registry
          ? [
              {
                executable: "sh",
                args: ["-c", ["set -eu", ...registryScript(unit.info.ecosystem, unit.info.manager, unit.info.variant, registry), ...record.commands.map((argv) => argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" "))].join("\n")],
                stdin: registry.token !== null ? `${registry.token}\n` : null,
              },
            ]
          : record.commands.map((argv) => ({ executable: resolveExecutable(argv[0] as string, context.env) ?? (argv[0] as string), args: argv.slice(1), stdin: null }));
        for (const attempt of attempts) {
          text += `+ ${registry ? record.commands.map((a) => a.join(" ")).join(" && ") : [attempt.executable, ...attempt.args].join(" ")}\n`;
          const result = await runSpec({ executable: attempt.executable, args: attempt.args, cwd, env, stdin: attempt.stdin, timeoutMs: INSTALL_TIMEOUT_MS, ...(context.signal ? { signal: context.signal } : {}) }, { parentEnv: context.env });
          text += result.stdout + result.stderr;
          exitCode = result.exitCode;
          if (result.spawnError) spawnProblem = result.spawnError.message;
          if (result.exitCode !== 0) break;
        }
        const secrets = [registry?.token, registry?.tokenSecret ? context.env[registry.tokenSecret] : null, context.env[TOKEN_VARIABLE]];
        fs.writeFileSync(logFile, maskSecrets(text, secrets));
        logs.push(logName);
        record.log = logName;
        record.exitCode = exitCode;
        if (exitCode === 0) {
          record.status = "installed";
          record.code = null;
          record.message = t("deps_installed");
          pathPrefixes.push(...recipe.pathPrefix.map((p) => toNative(p, workspace)));
          Object.assign(stepEnvs, nativeEnv(recipe.stepEnv, workspace));
        } else {
          record.status = "failed";
          record.code = "DEPENDENCIES_FAILED";
          record.message = `${unit.components.join(", ")}: ${maskSecrets(spawnProblem, secrets) || t("deps_install_failed", { exit: String(exitCode ?? "-") })}`;
        }
      }
      // The steps start the project's own tools first (node_modules/.bin, .venv/bin).
      if (pathPrefixes.length > 0) {
        const key = Object.keys(context.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
        context.env[key] = [...new Set(pathPrefixes), ...(context.env[key] ? [context.env[key] as string] : [])].join(path.delimiter);
      }
      for (const [k, v] of Object.entries(stepEnvs)) if (context.env[k] === undefined) context.env[k] = v;
      const all = [...records.values()];
      fs.mkdirSync(context.runDir, { recursive: true });
      fs.writeFileSync(path.join(context.runDir, NATIVE_DEPS_FILE), `${JSON.stringify({ mode: "in-image", governed: true, units: all }, null, 2)}\n`);
      return { ok: true, details: { units: all.map((r) => ({ unit: r.unit, manager: r.manager, mode: r.mode, status: r.status, code: r.code })), installed: all.filter((r) => r.status === "installed").length, failed: all.filter((r) => r.status === "failed").length, notReady: all.filter((r) => r.status === "not-ready").length, network: "host" }, logs };
    },
  });

  const problemsOf = (stepId: string): PreflightProblem[] => {
    const problems: PreflightProblem[] = [];
    for (const unit of unitsOfStep.get(stepId) ?? []) {
      const record = records.get(unit);
      if (record?.status === "installed") continue;
      problems.push({ code: (record?.code ?? "DEPENDENCIES_NOT_READY") as PreflightCode, message: record?.message || t("deps_not_prepared") });
    }
    return problems;
  };

  return {
    phase,
    gate(steps) {
      return steps.map((step) => ({
        ...step,
        preflight: () => {
          const own = step.preflight?.() ?? [];
          return [...own, ...problemsOf(step.id)];
        },
      }));
    },
    records: () => [...records.values()],
  };
}
