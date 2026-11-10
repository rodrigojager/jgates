// Project dependencies in Linux volumes (PLAN-dependencies.md): install units (units.ts), the recipe of each manager
// (recipes.ts), the key of a volume (key.ts), .jgates/dependencies.yml (config.ts), private registry credentials
// (credentials.ts), the fresh-volume install and swap (prepare.ts), the host record (state.ts), what the plan shows
// (plan.ts, tools.ts) and the `deps` phase of a run (run.ts).
export * from "./units.js";
export * from "./config.js";
export * from "./credentials.js";
export * from "./recipes.js";
export * from "./key.js";
export * from "./state.js";
export * from "./prepare.js";
export * from "./tools.js";
export * from "./plan.js";
export * from "./run.js";
export {
  DEPS_KEY_FILE,
  DependencyInstallError,
  PYTHON_VENV_TARGET,
  preparePythonDependencies,
  prototypeDependencyKey,
  pythonInstallScript,
  pythonManifests,
  type DependencyKeyInput,
  type PythonDepsInput,
  type PythonDepsResult,
} from "./prototype.js";
