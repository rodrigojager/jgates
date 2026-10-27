// What is missing, and how badly: each runtime and tool of the diagnosis gets a classification from the project's
// configuration (the instances of .jgates/tools.yml and how they run):
//   - essential: an enabled check does not run without it, and there is no other runner;
//   - optional: there is an alternative (the image when the local tool is missing, the local tool when the image or
//     Docker is missing), and the text says which, with the line to change;
//   - unused: no enabled check needs it.
// A missing item also gets the recipe that installs it (a preview: commands, hosts, what it writes) and the command
// that switches its check off for one run. Read-only: nothing here installs anything.
import { translator } from "../../i18n/index.js";
import { builtinManifests } from "../../adapters/manifests.js";
import { probeRuff } from "../../adapters/ruff/probe.js";
import type { AdapterManifest } from "../catalog/index.js";
import { readLock } from "../lock/index.js";
import {
  CONTAINER_OPTIONAL_ADAPTERS,
  diagnoseEnvironment,
  probeLockedImage,
  runsInContainer,
  satisfiesRange,
  type EnvironmentDiagnosis,
  type RuntimeStatus,
  type ToolStatus,
} from "../prepare/index.js";
import { dockerInstallRecipe, dockerStartRecipe, pipRequirement, prepareRecipe, previewOf, pythonPackagesRecipe, type Recipe, type RecipePreview } from "./recipes.js";
import { detectSystem, type HostSystem } from "./system.js";

export type Classification = "essential" | "optional" | "unused";

export interface Alternative {
  /** container: run the instance in its image; local: run the local tool. */
  kind: "container" | "local";
  message: string;
  /** The line to change in .jgates/tools.yml (and the preparation, when the image needs one). */
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

/** Adapters whose tool JGates installs with pip into its own environment, with the pip package name. */
export const PYTHON_PACKAGES: Readonly<Record<string, string>> = { ruff: "ruff", semgrep: "semgrep" };
/** Adapters that need a Python interpreter on the host. */
const NEEDS_PYTHON = new Set(["quality-bridge", "builtin-pii", "pytest", "import-linter"]);
/** The variable that chooses the executable of an adapter: when it is set, JGates does not install another one. */
const CHOSEN_BY: Readonly<Record<string, string>> = { ruff: "JGATES_RUFF", semgrep: "JGATES_SEMGREP", "quality-bridge": "JGATES_PYTHON" };

function toolMissing(x: ToolStatus): boolean {
  if (x.state === "absent" || x.state === "incompatible") return true;
  return x.preparation.kind === "rules" && (x.preparation.state === "missing" || x.preparation.state === "corrupt");
}

const TOOLS_FILE = ".jgates/tools.yml";

/** The fields an assessment adds to a runtime or tool of the diagnosis. */
const assessed = (i: ItemAssessment): Omit<ItemAssessment, "key" | "name"> => ({ classification: i.classification, missing: i.missing, alternative: i.alternative, disable: i.disable, recipe: i.recipe });

export function assessEnvironment(projectDir: string, options: AssessOptions = {}): Assessment {
  const t = translator("prepare");
  const env = options.env ?? process.env;
  const manifests = options.manifests ?? builtinManifests();
  const byAdapter = new Map(manifests.map((m) => [m.id, m]));
  const system = options.system ?? detectSystem();
  const d = options.diagnosis ?? diagnoseEnvironment(projectDir, { env, manifests });
  const lock = readLock(projectDir);
  const docker = d.runtimes.find((r) => r.id === "docker");
  const dockerReady = docker?.state === "ready";
  const recipes = new Map<string, Recipe>();
  const items: ItemAssessment[] = [];

  const tools: AssessedTool[] = d.tools.map((x) => {
    const key = `tool:${x.instance}`;
    const manifest = byAdapter.get(x.adapter);
    const missing = x.enabled && toolMissing(x);
    const container = runsInContainer(x.adapter, x.runner);
    let alternative: Alternative | null = null;
    if (missing && CONTAINER_OPTIONAL_ADAPTERS.has(x.adapter)) {
      if (container) {
        // The image or Docker is missing: the local tool, when it answers within the range, is the alternative.
        const local = x.adapter === "ruff" ? probeRuff(env) : null;
        const fits = local?.version && manifest ? satisfiesRange(local.version, manifest.toolVersionRange) === true : false;
        if (local?.executable && fits) {
          alternative = { kind: "local", message: t("prepare_alt_local", { tool: manifest?.toolName ?? x.adapter, path: local.executable }), command: t("prepare_alt_local_command", { instance: x.instance, file: TOOLS_FILE }) };
        }
      } else if (dockerReady && probeLockedImage({ env, dir: projectDir, instance: x.instance }).problem === null) {
        // The local tool is missing, and the image pinned for the instance is in Docker.
        alternative = { kind: "container", message: t("prepare_alt_container", { tool: manifest?.toolName ?? x.adapter }), command: t("prepare_alt_container_command", { instance: x.instance, file: TOOLS_FILE }) };
      }
    }
    const classification: Classification = !x.enabled ? "unused" : alternative ? "optional" : "essential";
    let recipe: Recipe | null = null;
    if (missing && manifest) {
      const chosenBy = CHOSEN_BY[x.adapter];
      const imageProblem = container && x.state !== "ready";
      if (imageProblem || (x.preparation.kind === "rules" && x.state === "ready")) {
        const kind = container ? "image" : "rules";
        const needsDocker = kind === "image" && !dockerReady;
        recipe = prepareRecipe({
          instance: x.instance,
          projectDir,
          kind,
          hosts: x.preparation.network.hosts,
          available: !needsDocker,
          reason: needsDocker ? t("prepare_recipe_needs_docker", { instance: x.instance }) : null,
          env,
        });
      } else if (!container && (Object.hasOwn(PYTHON_PACKAGES, x.adapter) || x.adapter === "quality-bridge")) {
        const pkg = PYTHON_PACKAGES[x.adapter];
        const packages = pkg ? [pipRequirement(pkg, manifest.toolVersionRange, lock.lock.tools[x.instance]?.toolVersion ?? null)] : [];
        recipe = pythonPackagesRecipe(`python:${x.instance}`, packages, env);
        if (chosenBy && env[chosenBy]) recipe = { ...recipe, available: false, reason: t("prepare_recipe_chosen_by", { variable: chosenBy, value: env[chosenBy] ?? "" }) };
      }
    }
    if (recipe) recipes.set(key, recipe);
    const item: ItemAssessment = {
      key,
      name: x.instance,
      classification,
      missing,
      alternative,
      disable: missing ? { command: `jgates run --skip tool:${x.instance}`, message: t("prepare_disable", { instance: x.instance, file: TOOLS_FILE }) } : null,
      recipe: recipe ? previewOf(recipe) : null,
    };
    items.push(item);
    return { ...x, ...assessed(item) };
  });

  const enabled = d.tools.filter((x) => x.enabled);
  const containerUsers = enabled.filter((x) => runsInContainer(x.adapter, x.runner));
  const pythonNeeded = d.tools.length === 0 || enabled.some((x) => NEEDS_PYTHON.has(x.adapter)) || [...recipes.values()].some((r) => r.kind === "python-packages" && r.createEnv);

  const runtimes: AssessedRuntime[] = d.runtimes.map((r) => {
    const key = `runtime:${r.id}`;
    let classification: Classification = "essential";
    let alternative: Alternative | null = null;
    let recipe: Recipe | null = null;
    if (r.id === "python") classification = pythonNeeded ? "essential" : "unused";
    if (r.id === "docker") {
      if (containerUsers.length === 0) classification = "unused";
      else {
        // Docker is optional only when every instance that runs in a container has the local tool as alternative.
        const local = containerUsers.every((x) => tools.find((y) => y.instance === x.instance)?.alternative?.kind === "local");
        classification = local ? "optional" : "essential";
        if (local) alternative = { kind: "local", message: t("prepare_alt_docker_local", { instances: containerUsers.map((x) => x.instance).join(", ") }), command: t("prepare_alt_local_command", { instance: containerUsers.map((x) => x.instance).join(", "), file: TOOLS_FILE }) };
      }
    }
    const missing = classification !== "unused" && r.state !== "ready";
    if (missing && r.id === "docker") recipe = r.stopped ? dockerStartRecipe(system) : dockerInstallRecipe(system);
    if (recipe) recipes.set(key, recipe);
    const item: ItemAssessment = { key, name: r.id, classification, missing, alternative, disable: null, recipe: recipe ? previewOf(recipe) : null };
    items.push(item);
    // The diagnosis calls a missing Docker optional; when an enabled check needs it, the text says so.
    const needed = r.id === "docker" && classification === "essential" && r.state !== "ready" && !r.stopped ? { message: t("prepare_runtime_absent", { name: "Docker", detail: "docker on PATH" }), fix: t("prepare_fix_docker_required") } : {};
    return { ...r, ...needed, ...assessed(item) };
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
