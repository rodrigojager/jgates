// How each manager installs inside the `deps` container (PLAN-dependencies.md sections 2 and 4): the command, where the
// dependency volume is mounted, the environment of the install and the environment the steps get. Local runs install
// from the lockfile when there is one (from the manifest otherwise, shown as a note); governed runs install frozen only,
// and a component without a lockfile is not installed at all.
import fs from "node:fs";
import path from "node:path";
import { CREDENTIALS_DIR, type ResolvedRegistry } from "./credentials.js";
import type { ToolchainPin } from "./toolchains.js";
import type { InstallUnit } from "./units.js";

/** Bumped whenever a recipe changes what it installs: part of every key. */
export const RECIPE_VERSION = "deps-recipes/1";
/** The shared package-manager cache volume (jgates-cache) inside the deps container and the steps. */
export const CACHE_TARGET = "/cache";
/** Where the volumes of Go, Rust and .NET units are mounted (they redirect through variables). */
export const DEPS_MOUNT_ROOT = "/deps";
/** The key of what a volume holds, at the root of the volume (written last, after a successful install). */
export const MARKER_FILE = ".jgates-deps.json";
/** The image's default Python (the toolchains volume brings other versions). */
export const IMAGE_PYTHON = "/usr/local/bin/python3";
/** Python managers the image does not carry run through uvx; the requirement is part of the key. */
export const UVX_MANAGERS: Readonly<Record<string, string>> = { poetry: "poetry>=2,<3", pdm: "pdm>=2,<3", pipenv: "pipenv>=2024.0" };

export interface InstallRecipe {
  /** Manager id, or "custom" for install.command. */
  manager: string;
  /** Mount point of the unit's volume (container path). */
  target: string;
  /** Install commands, run one after the other in the install root. */
  commands: string[][];
  /** Environment of the deps container (besides the base environment). */
  installEnv: Record<string, string>;
  /** Environment of the steps that use the unit (besides PATH). */
  stepEnv: Record<string, string>;
  /** Folders put first on PATH in the steps (the project's own tools: .venv/bin, node_modules/.bin). */
  pathPrefix: string[];
  /** Project-relative files whose bytes enter the key (lockfile and manifests). */
  keyFiles: string[];
  /** "frozen" (lockfile) or "manifest" (no lockfile, local mode only). */
  mode: "frozen" | "manifest";
  /** Language versions and browsers this unit takes from the toolchain volume (toolchains.ts), when it pins any. */
  toolchains?: ToolchainPin[];
  /** Files written into the unit's volume before the install commands (name relative to the target -> content). */
  files?: Record<string, string>;
}

/** The MSBuild file of a .NET unit: imported before any Directory.Build.props (CustomBeforeDirectoryBuildProps). */
export const DOTNET_BUILD_PROPS = "jgates-build.props";

/**
 * obj/ and bin/ of every project of a .NET unit, in the unit's volume, one folder per project: an environment variable
 * cannot name a per-project path (MSBuild takes its value literally), so the props file the environment points at does,
 * and a test project and the project it tests no longer share (and overwrite) one project.assets.json.
 */
export function dotnetBuildProps(target: string): string {
  return [
    "<Project>",
    "  <PropertyGroup>",
    `    <BaseIntermediateOutputPath>${target}/obj/$(MSBuildProjectName)/</BaseIntermediateOutputPath>`,
    `    <BaseOutputPath>${target}/bin/$(MSBuildProjectName)/</BaseOutputPath>`,
    "  </PropertyGroup>",
    "</Project>",
    "",
  ].join("\n");
}

export type RecipeResult = { ok: true; recipe: InstallRecipe } | { ok: false; code: "DEPENDENCIES_NOT_READY"; reasonKey: string; params: Record<string, string> };

export interface RecipeOptions {
  /** Governed (CI) run: frozen installs only, a missing lockfile is a blocker. */
  governed: boolean;
  /** Names of the files in the install root (host folder or snapshot). */
  files: string[];
  /** install.command of .jgates/dependencies.yml (for a manager JGates does not support). */
  installCommand: string | null;
  registry: ResolvedRegistry | null;
  /** Reads a file of the install root (undefined when it is missing). */
  read?: (name: string) => string | undefined;
}

const workspacePath = (root: string, ...rest: string[]): string => path.posix.join("/workspace", root === "." ? "" : root, ...rest);

/** The files of the install root that enter the key, by ecosystem. */
function keyFilesOf(unit: InstallUnit, files: string[]): string[] {
  const at = (name: string): string => (unit.installRoot === "." ? name : `${unit.installRoot}/${name}`);
  const pick = (test: (name: string) => boolean): string[] => files.filter(test).sort().map(at);
  switch (unit.info.ecosystem) {
    case "python":
      return pick((n) => ["pyproject.toml", "uv.lock", "poetry.lock", "pdm.lock", "Pipfile", "Pipfile.lock", "setup.cfg", "setup.py", ".python-version"].includes(n) || /^requirements.*\.txt$/.test(n));
    case "node":
      return pick((n) => ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", ".yarnrc.yml", ".yarnrc", ".npmrc", ".nvmrc", ".node-version"].includes(n));
    case "go":
      return pick((n) => ["go.mod", "go.sum", "go.work", "go.work.sum"].includes(n));
    case "rust":
      return pick((n) => ["Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml"].includes(n));
    case "dotnet":
      return pick((n) => /\.(csproj|fsproj|vbproj|sln|slnx)$/.test(n) || ["packages.lock.json", "Directory.Packages.props", "Directory.Build.props", "nuget.config", "NuGet.Config", "global.json"].includes(n));
  }
}

const notReady = (reasonKey: string, params: Record<string, string> = {}): RecipeResult => ({ ok: false, code: "DEPENDENCIES_NOT_READY", reasonKey, params });

/** The recipe of a unit, or why it cannot be installed (ambiguous, unsupported, governed without a lockfile). */
export function recipeFor(unit: InstallUnit, options: RecipeOptions): RecipeResult {
  const info = unit.info;
  const root = unit.installRoot;
  const params = { unit: unit.id, components: unit.components.join(", "), root };
  if (info.state === "ambiguous") return notReady("deps_not_ready_ambiguous", { ...params, candidates: info.candidates.join(", ") });
  const custom = options.installCommand;
  if ((info.manager === "bun" || info.state === "unsupported") && !custom) return notReady("deps_not_ready_unsupported", { ...params, manager: info.manager ?? "-" });
  // Python files with no manifest at all (no pyproject.toml, requirements, Pipfile): nothing to install, the unit is the
  // image's Python in an empty virtual environment.
  if (!info.manager && info.ecosystem === "python" && info.lockfile === null) {
    const venv = workspacePath(root, ".venv");
    return {
      ok: true,
      recipe: {
        manager: "none",
        target: venv,
        commands: [["uv", "venv", "--allow-existing", "--python", IMAGE_PYTHON, venv]],
        installEnv: { UV_CACHE_DIR: `${CACHE_TARGET}/uv`, UV_PYTHON_DOWNLOADS: "never", UV_NO_PROGRESS: "1" },
        stepEnv: { VIRTUAL_ENV: venv },
        pathPrefix: [`${venv}/bin`],
        keyFiles: keyFilesOf(unit, options.files),
        mode: "manifest",
      },
    };
  }
  if (!info.manager) return notReady("deps_not_ready_no_manager", params);
  const locked = info.lockfile !== null;
  if (options.governed && !locked) return notReady("deps_not_ready_governed_lockfile", { ...params, manager: info.manager });
  if (options.governed && custom && (info.manager === "bun" || info.state === "unsupported")) return notReady("deps_not_ready_governed_custom", params);

  const keyFiles = keyFilesOf(unit, options.files);
  const mode: InstallRecipe["mode"] = locked ? "frozen" : "manifest";
  const governed = options.governed;
  const base = { keyFiles, mode };

  switch (info.ecosystem) {
    case "python": {
      const venv = workspacePath(root, ".venv");
      const venvStep = { VIRTUAL_ENV: venv };
      const pathPrefix = [`${venv}/bin`];
      const createVenv = (seed: boolean): string[] => ["uv", "venv", "--allow-existing", ...(seed ? ["--seed"] : []), "--python", IMAGE_PYTHON, venv];
      const common = { UV_CACHE_DIR: `${CACHE_TARGET}/uv`, UV_LINK_MODE: "copy", UV_PYTHON_DOWNLOADS: "never", UV_NO_PROGRESS: "1", UV_TOOL_DIR: "/tmp/uv-tools", UV_PROJECT_ENVIRONMENT: venv };
      const uvx = (manager: string): string[] => ["uvx", "--python", IMAGE_PYTHON, "--from", UVX_MANAGERS[manager] as string, manager];
      switch (info.manager) {
        case "uv": {
          // A pyproject.toml with only tool settings ([tool.ruff], [tool.pytest...]) and no lockfile declares no
          // dependency: the unit is the image's Python in an empty virtual environment.
          const pyproject = options.read?.("pyproject.toml");
          if (!locked && (pyproject === undefined || !/^\s*\[project\]\s*$/m.test(pyproject))) {
            return { ok: true, recipe: { ...base, manager: "uv", target: venv, commands: [createVenv(false)], installEnv: common, stepEnv: venvStep, pathPrefix } };
          }
          return {
            ok: true,
            recipe: { ...base, manager: "uv", target: venv, commands: [createVenv(false), ["uv", "sync", ...(locked ? [governed ? "--locked" : "--frozen"] : []), "--all-extras", "--all-groups"]], installEnv: common, stepEnv: venvStep, pathPrefix },
          };
        }
        case "poetry":
          return {
            ok: true,
            recipe: {
              ...base,
              manager: "poetry",
              target: venv,
              commands: [createVenv(true), ...(governed ? [[...uvx("poetry"), "check", "--lock"]] : []), [...uvx("poetry"), "sync", "--no-root", "--all-extras", "--all-groups"]],
              installEnv: { ...common, POETRY_VIRTUALENVS_IN_PROJECT: "true", POETRY_VIRTUALENVS_CREATE: "true", POETRY_CACHE_DIR: `${CACHE_TARGET}/poetry`, POETRY_NO_INTERACTION: "1" },
              stepEnv: venvStep,
              pathPrefix,
            },
          };
        case "pdm":
          return {
            ok: true,
            recipe: {
              ...base,
              manager: "pdm",
              target: venv,
              commands: [createVenv(true), [...uvx("pdm"), locked ? "sync" : "install", "--no-self", "-G", ":all"]],
              installEnv: { ...common, PDM_CACHE_DIR: `${CACHE_TARGET}/pdm`, PDM_NON_INTERACTIVE: "1", PDM_CHECK_UPDATE: "false" },
              stepEnv: venvStep,
              pathPrefix,
            },
          };
        case "pipenv":
          return {
            ok: true,
            recipe: {
              ...base,
              manager: "pipenv",
              target: venv,
              commands: [createVenv(true), [...uvx("pipenv"), locked ? "sync" : "install", "--dev"]],
              installEnv: { ...common, PIPENV_VENV_IN_PROJECT: "1", PIPENV_CACHE_DIR: `${CACHE_TARGET}/pipenv`, PIPENV_NOSPIN: "1", PIPENV_YES: "1" },
              stepEnv: venvStep,
              pathPrefix,
            },
          };
        case "pip": {
          const requirements = options.files.filter((n) => /^requirements.*\.txt$/.test(n)).sort();
          if (requirements.length === 0) return notReady("deps_not_ready_no_manager", params);
          return {
            ok: true,
            recipe: { ...base, manager: "pip", target: venv, commands: [createVenv(false), ["uv", "pip", "install", "--python", `${venv}/bin/python`, ...requirements.flatMap((f) => ["-r", f])]], installEnv: common, stepEnv: venvStep, pathPrefix },
          };
        }
      }
      break;
    }
    case "node": {
      const modules = workspacePath(root, "node_modules");
      const pathPrefix = [`${modules}/.bin`];
      const common = { npm_config_cache: `${CACHE_TARGET}/npm`, COREPACK_HOME: `${CACHE_TARGET}/corepack`, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" };
      const recipe = (manager: string, commands: string[][], env: Record<string, string> = {}): RecipeResult => ({ ok: true, recipe: { ...base, manager, target: modules, commands, installEnv: { ...common, ...env }, stepEnv: {}, pathPrefix } });
      if (custom && (info.manager === "bun" || info.state === "unsupported")) return recipe("custom", [["sh", "-c", custom]]);
      switch (info.manager) {
        case "npm":
          return recipe("npm", [locked ? ["npm", "ci"] : ["npm", "install", "--no-package-lock"]]);
        case "pnpm":
          return recipe("pnpm", [["pnpm", "install", locked ? "--frozen-lockfile" : "--no-lockfile", "--store-dir", `${CACHE_TARGET}/pnpm-store`, "--config.confirmModulesPurge=false", "--reporter=append-only"]]);
        case "yarn":
          if (info.variant === "berry") {
            return recipe("yarn", [["yarn", "install", ...(locked ? ["--immutable"] : ["--no-immutable"])]], {
              YARN_NODE_LINKER: "node-modules",
              YARN_GLOBAL_FOLDER: `${CACHE_TARGET}/yarn-berry`,
              YARN_ENABLE_GLOBAL_CACHE: "true",
              YARN_ENABLE_TELEMETRY: "0",
              YARN_ENABLE_PROGRESS_BARS: "0",
            });
          }
          return recipe("yarn", [["yarn", "install", locked ? "--frozen-lockfile" : "--no-lockfile", "--non-interactive", "--no-progress"]], { YARN_CACHE_FOLDER: `${CACHE_TARGET}/yarn` });
      }
      break;
    }
    case "go": {
      const target = `${DEPS_MOUNT_ROOT}/${unit.id}`;
      // -modcacherw: the module cache stays deletable, so a volume can be emptied before a reinstall.
      const goEnv = { GOMODCACHE: `${target}/gomod`, GOCACHE: `${target}/gocache`, GOFLAGS: governed ? "-modcacherw -mod=readonly" : "-modcacherw", GOTOOLCHAIN: "local" };
      return {
        ok: true,
        recipe: { ...base, manager: "go", target, commands: [["go", "mod", "download"],...(governed ? [["go", "mod", "verify"]] : [])], installEnv: goEnv, stepEnv: { ...goEnv, GOPROXY: "off" }, pathPrefix: [] },
      };
    }
    case "rust": {
      const target = `${DEPS_MOUNT_ROOT}/${unit.id}`;
      const cargoEnv = { CARGO_HOME: `${target}/cargo-home`, CARGO_TARGET_DIR: `${target}/target` };
      return {
        ok: true,
        recipe: { ...base, manager: "cargo", target, commands: [["cargo", "fetch", ...(locked ? ["--locked"] : [])]], installEnv: { ...cargoEnv, CARGO_TERM_PROGRESS_WHEN: "never" }, stepEnv: { ...cargoEnv, CARGO_NET_OFFLINE: "true" }, pathPrefix: [] },
      };
    }
    case "dotnet": {
      const target = `${DEPS_MOUNT_ROOT}/${unit.id}`;
      // obj/ and bin/ of the projects go to the volume, one folder per project (dotnetBuildProps).
      const dotnetEnv = { NUGET_PACKAGES: `${target}/nuget`, CustomBeforeDirectoryBuildProps: `${target}/${DOTNET_BUILD_PROPS}`, DOTNET_CLI_HOME: "/tmp", DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1" };
      const solutions = options.files.filter((n) => /\.(sln|slnx)$/.test(n)).sort();
      const projects = options.files.filter((n) => /\.(csproj|fsproj|vbproj)$/.test(n)).sort();
      const what = solutions.length === 1 ? [solutions[0] as string] : solutions.length === 0 && projects.length === 1 ? [projects[0] as string] : [];
      const registryArgs = options.registry ? ["--configfile", `${CREDENTIALS_DIR}/nuget.config`] : [];
      return {
        ok: true,
        recipe: {
          ...base,
          manager: "dotnet",
          target,
          commands: [["dotnet", "restore", ...what, ...(locked ? ["--locked-mode"] : []), ...registryArgs]],
          installEnv: { ...dotnetEnv, NUGET_HTTP_CACHE_PATH: `${CACHE_TARGET}/nuget-http` },
          // dotnet refuses to start without an existing HOME (NuGet migrations); the step's HOME is /tmp, which exists.
          stepEnv: { ...dotnetEnv, HOME: "/tmp" },
          pathPrefix: [],
          files: { [DOTNET_BUILD_PROPS]: dotnetBuildProps(target) },
        },
      };
    }
  }
  return notReady("deps_not_ready_unsupported", { ...params, manager: info.manager ?? "-" });
}

/** Names of the files directly in a folder of the analyzed tree (empty when it cannot be read). */
export function filesIn(projectDir: string, root: string): string[] {
  try {
    return fs
      .readdirSync(path.join(projectDir, ...(root === "." ? [] : root.split("/"))), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
