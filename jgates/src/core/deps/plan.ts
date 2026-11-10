// What the plan says about dependencies (container-first only): the key of every install unit a planned check needs
// (inputs.container.dependencyKeys, part of the plan hash), where each check's tool comes from (item.toolSource), and the
// blockers of a governed plan (a unit without a lockfile, an ambiguous or unsupported manager).
import { translator } from "../../i18n/index.js";
import type { Classification } from "../discovery/types.js";
import { loadDependencySettings } from "./config.js";
import { planUnit } from "./prepare.js";
import { needsDependencies, toolSourceOf, type ToolItem, type ToolSource } from "./tools.js";
import { installUnits, type InstallUnit } from "./units.js";

export interface PlanDepsItem extends ToolItem {
  id: string;
  state: { enabled: boolean };
}

export interface PlanDependenciesInput {
  /** The analyzed tree. */
  dir: string;
  /** Where .jgates/dependencies.yml is read (the project, or the CI policy). */
  configDir: string;
  workspace: string;
  classifications: readonly Classification[];
  items: readonly PlanDepsItem[];
  /** Contract of the invocation of a tool (build-check names its checker there). */
  contractOf: (tool: string) => Record<string, unknown> | undefined;
  imageId: string | null;
  governed: boolean;
  env: NodeJS.ProcessEnv;
}

export interface PlanDependencies {
  /** Unit id -> key, for the units a planned check needs (sorted by the caller). */
  keys: Record<string, string>;
  toolSources: Map<string, ToolSource>;
  blockers: Array<{ code: string; message: string; items: string[] }>;
}

/** The units the items need: unit -> the ids of the items that need it. */
export function unitsNeeded(items: readonly PlanDepsItem[], classifications: readonly Classification[]): { units: InstallUnit[]; itemsOf: Map<string, string[]> } {
  const { units, unitOf } = installUnits(classifications.filter((c) => c.approvable));
  const itemsOf = new Map<string, string[]>();
  for (const item of items) {
    if (!item.state.enabled || !needsDependencies(item)) continue;
    for (const ref of item.components) {
      const unit = unitOf.get(ref.id);
      if (unit) itemsOf.set(unit, [...new Set([...(itemsOf.get(unit) ?? []), item.id])]);
    }
  }
  return { units: units.filter((u) => itemsOf.has(u.id)), itemsOf };
}

export function planDependencies(input: PlanDependenciesInput): PlanDependencies {
  const t = translator("deps");
  const toolSources = new Map<string, ToolSource>();
  for (const item of input.items) {
    const source = toolSourceOf(input.dir, item, input.classifications, input.contractOf(item.tool));
    if (source) toolSources.set(item.id, source);
  }
  const { units, itemsOf } = unitsNeeded(input.items, input.classifications);
  const settings = loadDependencySettings(input.configDir);
  const keys: Record<string, string> = {};
  const blockers: PlanDependencies["blockers"] = [];
  for (const unit of units) {
    // Secrets are not looked up while planning: only the registry URL enters the key.
    const planned = planUnit(unit, { projectDir: input.dir, workspace: input.workspace, imageId: input.imageId, governed: input.governed, settings, env: {}, vault: false });
    if (planned.key) keys[unit.id] = planned.key;
    if (input.governed && planned.blocked && planned.blocked.reasonKey !== "deps_not_ready_secret") {
      blockers.push({ code: "DEPENDENCIES_NOT_READY", message: t(planned.blocked.reasonKey, planned.blocked.params), items: itemsOf.get(unit.id) ?? [] });
    }
  }
  return { keys, toolSources, blockers };
}
