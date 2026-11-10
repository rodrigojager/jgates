// What is missing, and how badly (container-first, ADR-0004): the host needs Node, Git and a Docker-compatible engine;
// every tool comes from the JGates tools image. Each runtime and tool of the diagnosis gets a classification:
//   - essential: an enabled check does not run without it (the engine, the tools image, a required tool);
//   - optional: a check on only "when available" (strict) lacks it;
//   - unused: no enabled check needs it.
// A missing item gets the one recipe that prepares it, as a preview: the engine's install or start, the tools image's
// download, an instance's data (Semgrep rules). A tool the image does not have is never installed on the host: its
// fix is the image of this JGates release (the shared TOOL_MISSING cause). Also the command that switches a check off
// for one run. Read-only: nothing here installs anything.
import { translator } from "../../i18n/index.js";
import { builtinManifests } from "../../adapters/manifests.js";
import type { AdapterManifest } from "../catalog/index.js";
import { readToolsImagePin, toolsImageTarget } from "../tools-image/index.js";
import { diagnoseEnvironment, type EnvironmentDiagnosis, type RuntimeStatus, type ToolStatus } from "../prepare/index.js";
import { dockerInstallRecipe, dockerStartRecipe, imagePullRecipe, prepareRecipe, previewOf, type Recipe, type RecipePreview } from "./recipes.js";
import { detectSystem, type HostSystem } from "./system.js";

export type Classification = "essential" | "optional" | "unused";

/** Kept for the readers of the report: container-first leaves no alternative runner, so it is always null. */
export interface Alternative {
  kind: "container" | "local";
  message: string;
  command: string;
}

export interface ItemAssessment {
  /** runtime:<id> or tool:<instance>. */
  key: string;
  name: string;
  classification: Classification;
  /** Absent, incompatible, stopped, or its pinned rules or image are missing: something to install or prepare. */
  missing: boolean;
  alternative: Alternative | null;
  /** How to switch the check off for one run (tools only). */
  disable: { command: string; message: string } | null;
  recipe: RecipePreview | null;
}

export type AssessedRuntime = RuntimeStatus & Omit<ItemAssessment, "key" | "name">;
export type AssessedTool = ToolStatus & Omit<ItemAssessment, "key" | "name">;

export interface EnvironmentAssessment extends Omit<EnvironmentDiagnosis, "runtimes" | "tools"> {
  runtimes: AssessedRuntime[];
  tools: AssessedTool[];
  /** The keys of the missing items, by classification (unused items never appear). */
  install: { essential: string[]; optional: string[] };
}

export interface Assessment {
  report: EnvironmentAssessment;
  items: ItemAssessment[];
  /** The full recipes of the missing items, by key (the report carries only their previews). */
  recipes: Map<string, Recipe>;
}

export interface AssessOptions {
  env?: NodeJS.ProcessEnv;
  manifests?: AdapterManifest[];
  system?: HostSystem;
  /** A diagnosis already made (the doctor's); made here when absent. */
  diagnosis?: EnvironmentDiagnosis;
}

function toolMissing(x: ToolStatus): boolean {
  if (x.state === "absent" || x.state === "incompatible") return true;
  // On "when available" the plan already found the tool missing here; without an environment check of its own, the
  // plan is the evidence.
  if (x.whenAvailable === true && x.state === "not_checked") return true;
  return x.preparation.kind === "rules" && (x.preparation.state === "missing" || x.preparation.state === "corrupt");
}

const TOOLS_FILE = ".jgates/tools.yml";

/** The fields an assessment adds to a runtime or tool of the diagnosis. */
const assessed = (i: ItemAssessment): Omit<ItemAssessment, "key" | "name"> => ({ classification: i.classification, missing: i.missing, alternative: i.alternative, disable: i.disable, recipe: i.recipe });

/** The registry host a pull of the reference reaches (docker.io when the reference names none). */
function registryOf(reference: string): string {
  const name = reference.split("@")[0] ?? reference;
  const first = name.split("/")[0] ?? "";
  return name.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost") ? first : "docker.io";
}

/** The tools image's download: only a published pin (or a reference JGATES_TOOLS_IMAGE names) can be pulled. */
function imageRecipe(env: NodeJS.ProcessEnv): Recipe {
  const t = translator("prepare");
  const target = toolsImageTarget(env);
  let published = target.source === "env";
  if (!published) {
    try {
      published = readToolsImagePin().published === true;
    } catch {
      published = false;
    }
  }
  const local = /^sha256:[0-9a-f]{64}$/.test(target.reference);
  const available = published && !local;
  return imagePullRecipe({ reference: target.reference, hosts: available ? [registryOf(target.reference)] : [], available, reason: available ? null : t("prepare_recipe_image_unpublished", { image: target.reference }) });
}

export function assessEnvironment(projectDir: string, options: AssessOptions = {}): Assessment {
  const t = translator("prepare");
  const env = options.env ?? process.env;
  const manifests = options.manifests ?? builtinManifests();
  const byAdapter = new Map(manifests.map((m) => [m.id, m]));
  const system = options.system ?? detectSystem();
  const d = options.diagnosis ?? diagnoseEnvironment(projectDir, { env, manifests });
  const recipes = new Map<string, Recipe>();
  const items: ItemAssessment[] = [];

  const tools: AssessedTool[] = d.tools.map((x) => {
    const key = `tool:${x.instance}`;
    const manifest = byAdapter.get(x.adapter);
    const missing = x.enabled && toolMissing(x);
    // On "when available" only: offered, never essential (the plan runs without it).
    const classification: Classification = !x.enabled ? "unused" : x.whenAvailable ? "optional" : "essential";
    let recipe: Recipe | null = null;
    // The only per-instance preparation left is its data (the Semgrep rules), once the tool itself is there.
    if (missing && manifest && x.preparation.kind === "rules" && x.state === "ready") {
      recipe = prepareRecipe({ instance: x.instance, projectDir, hosts: x.preparation.network.hosts, available: true, reason: null, env });
    }
    if (recipe) recipes.set(key, recipe);
    const item: ItemAssessment = {
      key,
      name: x.instance,
      classification,
      missing,
      alternative: null,
      disable: missing ? { command: `jgates run --skip tool:${x.instance}`, message: t("prepare_disable", { instance: x.instance, file: TOOLS_FILE }) } : null,
      recipe: recipe ? previewOf(recipe) : null,
    };
    items.push(item);
    return { ...x, ...assessed(item) };
  });

  const runtimes: AssessedRuntime[] = d.runtimes.map((r) => {
    const key = `runtime:${r.id}`;
    const classification: Classification = r.optional ? "unused" : "essential";
    const missing = classification !== "unused" && r.state !== "ready" && r.state !== "not_checked";
    let recipe: Recipe | null = null;
    if (missing && r.id === "docker" && r.state === "absent") recipe = r.stopped ? dockerStartRecipe(system) : dockerInstallRecipe(system);
    if (missing && r.id === "image") recipe = imageRecipe(env);
    if (recipe) recipes.set(key, recipe);
    const item: ItemAssessment = { key, name: r.id, classification, missing, alternative: null, disable: null, recipe: recipe ? previewOf(recipe) : null };
    items.push(item);
    return { ...r, ...assessed(item) };
  });

  const ordered = [...items.filter((i) => i.key.startsWith("runtime:")), ...items.filter((i) => i.key.startsWith("tool:"))];
  const report: EnvironmentAssessment = {
    ...d,
    runtimes,
    tools,
    install: {
      essential: ordered.filter((i) => i.missing && i.classification === "essential").map((i) => i.key),
      optional: ordered.filter((i) => i.missing && i.classification === "optional").map((i) => i.key),
    },
  };
  return { report, items: ordered, recipes };
}
