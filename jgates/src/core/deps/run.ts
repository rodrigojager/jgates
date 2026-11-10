// The dependencies of a container-first run: a `deps` phase after the sync prepares every install unit a planned check
// needs (the only containers with network: package registries), then each step that needs a unit gets its volume and
// the package cache mounted, with the unit's environment (VIRTUAL_ENV, PATH, GOMODCACHE, CARGO_HOME, NUGET_PACKAGES...).
// A step whose unit could not be prepared does not start: its stages are blocked with DEPENDENCIES_FAILED (the install
// failed) or DEPENDENCIES_NOT_READY (it could not be installed), so the run ends incomplete, never passed. Steps that need
// no dependencies run as usual.
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { ADAPTER_ID as BRIDGE_ID } from "../../adapters/quality-bridge/requirements.js";
import { discoverFor } from "../config/resolve/index.js";
import { engineCommand, engineRuntime, inspectImageSync, type EngineContext, type EngineMount } from "../engine/index.js";
import type { Plan, PlanItem } from "../plan/types.js";
import { resolveReason } from "../reasons/index.js";
import type { PhaseOutcome, PreflightCode, PreflightProblem, RunPhase, RunStep } from "../runner/index.js";
import { toolsImageTarget } from "../tools-image/index.js";
import { loadDependencySettings } from "./config.js";
import { unitsNeeded } from "./plan.js";
import { CACHE_TARGET } from "./recipes.js";
import { DEFAULT_CACHE_VOLUME, DEPS_NOT_READY, notReadyOutcome, planUnit, prepareUnit, type UnitOutcome } from "./prepare.js";
import { needsDependencies } from "./tools.js";
import type { InstallUnit } from "./units.js";

export const DEPS_PHASE_ID = "deps";
/** PATH of the tools image when the engine does not report it. */
export const DEFAULT_IMAGE_PATH = "/usr/local/cargo/bin:/usr/local/go/bin:/opt/node/bin:/usr/share/dotnet:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export interface DepsRunInput {
  plan: Plan;
  /** The analyzed tree (the workspace or the snapshot of the commit). */
  projectDir: string;
  /** Where workspace.yml and dependencies.yml are read: the project, or the CI policy in governed runs. */
  configDir: string;
  workspace: string;
  runId: string;
  runDir: string;
  version: string;
  home: string;
  env: NodeJS.ProcessEnv;
  /** Governed (CI) run: frozen installs only, secrets from the environment only. */
  governed: boolean;
  engine?: EngineContext;
  signal?: AbortSignal;
  cacheVolume?: string;
}

export interface DepsRun {
  phase: RunPhase;
  /** The steps with a preflight that blocks them when one of their units is not ready. */
  gate(steps: RunStep[]): RunStep[];
  /** Mounts and environment of a step container: its units' volumes, the package cache, the units' variables. */
  stepEnvironment(stepId: string): { mounts: EngineMount[]; env: Record<string, string> } | null;
  outcomes(): UnitOutcome[];
}

/** The step that runs an item (the bridge runs every bridge item; any other adapter one step per tool instance). */
const stepOf = (item: PlanItem): string => (item.adapter === BRIDGE_ID ? BRIDGE_ID : item.tool);

/** The facts of an outcome for events and the result (no recipe, no environment). */
export function publicOutcome(o: UnitOutcome): Record<string, unknown> {
  const { recipe: _recipe, ...rest } = o;
  return rest;
}

async function imagePath(imageId: string, engine: EngineContext): Promise<string> {
  try {
    const result = await engineCommand(["image", "inspect", "--format", "{{json .Config.Env}}", imageId], engine, 30_000);
    const env = JSON.parse(result.stdout) as unknown;
    if (Array.isArray(env)) {
      const found = env.find((e): e is string => typeof e === "string" && e.startsWith("PATH="));
      if (found) return found.slice("PATH=".length);
    }
  } catch {
    // The default below is the image's own PATH.
  }
  return DEFAULT_IMAGE_PATH;
}

/** The deps of a run, or null when no planned check needs any. */
export function createDepsRun(input: DepsRunInput): DepsRun | null {
  const t = translator("deps");
  const engine: EngineContext = input.engine ?? { runtime: engineRuntime(input.env), runnerOptions: { parentEnv: input.env } };
  const classifications = discoverFor(input.projectDir, input.configDir).classifications;
  const items = input.plan.groups.willRun;
  const { units, itemsOf } = unitsNeeded(items, classifications);
  if (units.length === 0) return null;
  const unitsOfStep = new Map<string, Set<string>>();
  const itemById = new Map(items.map((i) => [i.id, i]));
  for (const [unit, ids] of itemsOf) {
    for (const id of ids) {
      const item = itemById.get(id);
      if (!item || !needsDependencies(item)) continue;
      const step = stepOf(item);
      unitsOfStep.set(step, new Set([...(unitsOfStep.get(step) ?? []), unit]));
    }
  }
  const results = new Map<string, UnitOutcome>();
  let pathOfImage = DEFAULT_IMAGE_PATH;
  const cacheVolume = input.cacheVolume ?? DEFAULT_CACHE_VOLUME;

  const phase: RunPhase = {
    id: DEPS_PHASE_ID,
    label: t("deps_phase_label"),
    async run(): Promise<PhaseOutcome> {
      const settings = loadDependencySettings(input.configDir);
      const reference = input.env.JGATES_TOOLS_IMAGE?.trim() || toolsImageTarget(input.env).reference;
      const image = inspectImageSync(reference, engine);
      for (const unit of units) {
        if (input.signal?.aborted) break;
        let outcome: UnitOutcome;
        if (!image) {
          const planned = planUnit(unit, { projectDir: input.projectDir, workspace: input.workspace, imageId: null, governed: input.governed, settings, env: input.env, vault: !input.governed });
          outcome = notReadyOutcome({ ...planned, blocked: { reasonKey: "deps_not_ready_image", params: { image: reference } } });
        } else {
          outcome = await prepareUnit(unit, {
            projectDir: input.projectDir,
            workspace: input.workspace,
            home: input.home,
            version: input.version,
            run: input.runId,
            imageId: image.id,
            governed: input.governed,
            settings,
            env: input.env,
            vault: !input.governed,
            engine,
            cacheVolume,
            logs: { dir: path.join(input.runDir, "logs"), root: input.runDir },
            ...(input.signal ? { signal: input.signal } : {}),
          });
        }
        results.set(unit.id, outcome);
      }
      if (image) pathOfImage = await imagePath(image.id, engine);
      const all = [...results.values()];
      const count = (s: UnitOutcome["status"]): number => all.filter((o) => o.status === s).length;
      return {
        ok: true,
        details: {
          units: all.map(publicOutcome),
          installed: count("installed"),
          reused: count("reused"),
          failed: count("failed"),
          notReady: count("not-ready"),
          network: "bridge",
        },
        logs: all.map((o) => o.log).filter((l): l is string => l !== null),
      };
    },
  };

  const unitById = new Map<string, InstallUnit>(units.map((u) => [u.id, u]));
  const problemsOf = (stepId: string): PreflightProblem[] => {
    const problems: PreflightProblem[] = [];
    for (const id of unitsOfStep.get(stepId) ?? []) {
      const outcome = results.get(id);
      const unit = unitById.get(id);
      if (outcome && (outcome.status === "installed" || outcome.status === "reused")) continue;
      if (outcome?.code) problems.push({ code: outcome.code as PreflightCode, message: outcome.message });
      else {
        const component = unit?.components.join(", ") ?? id;
        problems.push({ code: DEPS_NOT_READY as PreflightCode, message: `${resolveReason(DEPS_NOT_READY, { component }).message} ${t("deps_not_prepared")}` });
      }
    }
    return problems;
  };

  return {
    phase,
    gate(steps) {
      return steps.map((step) =>
        unitsOfStep.has(step.id)
          ? {
              ...step,
              preflight: () => {
                const own = step.preflight?.() ?? [];
                return [...own, ...problemsOf(step.id)];
              },
            }
          : step,
      );
    },
    stepEnvironment(stepId) {
      const ready = [...(unitsOfStep.get(stepId) ?? [])].map((id) => results.get(id)).filter((o): o is UnitOutcome => !!o && (o.status === "installed" || o.status === "reused") && !!o.recipe && !!o.volume);
      if (ready.length === 0) return null;
      const mounts: EngineMount[] = [];
      const env: Record<string, string> = {};
      const prefix: string[] = [];
      for (const o of ready) {
        const recipe = o.recipe as NonNullable<UnitOutcome["recipe"]>;
        mounts.push({ type: "volume", source: o.volume as string, target: recipe.target });
        for (const [k, v] of Object.entries(recipe.stepEnv)) if (!(k in env)) env[k] = v;
        prefix.push(...recipe.pathPrefix);
      }
      mounts.push({ type: "volume", source: cacheVolume, target: CACHE_TARGET });
      env.PATH = [...prefix, pathOfImage].join(":");
      return { mounts, env };
    },
    outcomes() {
      return [...results.values()];
    },
  };
}
