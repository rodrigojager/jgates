// Which units (discovered components) an instance of the build-check adapter checks, and the exact commands for them.
// A unit is eligible only with the evidence the project's own checker needs (a tsconfig.json, a mypy or pyright
// configuration, go.mod, Cargo.toml, a project file); a component without it is listed as skipped with the reason and
// is never counted as checked.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { discoverWorkspace, type Inventory } from "../../core/discovery/index.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { CHECKER_ENV, probeChecker, type Checker, type CheckerProbe } from "./probe.js";

/** The lowest version of each checker the adapter supports. */
export const MINIMUM: Record<Checker, string> = { tsc: "4.5.0", mypy: "1.0.0", pyright: "1.1.300", go: "1.18.0", cargo: "1.60.0", dotnet: "6.0.0" };

/** The discovery languages each checker serves. */
export const LANGUAGES: Record<Checker, string[]> = { tsc: ["typescript"], mypy: ["python"], pyright: ["python"], go: ["go"], cargo: ["rust"], dotnet: ["csharp"] };

const RUN_DIR = "{runDir}";

export interface UnitStep {
  id: string;
  label: string;
  executable: string;
  args: string[];
  env: Record<string, string>;
  /** Run only when the previous step of the unit finished clean (go vet repeats the compile errors of go build). */
  onlyAfterClean?: boolean;
}

export interface BuildUnit {
  component: string;
  root: string;
  language: string;
  checker: Checker;
  /** The file that justifies the unit, relative to the workspace. */
  config: string;
  version: string | null;
  available: boolean;
  /** Why the unit cannot run (the checker is missing or too old). */
  reason: string | null;
  steps: UnitStep[];
}

export interface SkippedUnit {
  component: string;
  root: string;
  language: string;
  reason: string;
}

export interface UnitPlan {
  units: BuildUnit[];
  skipped: SkippedUnit[];
}

export interface UnitSettings {
  checker: Checker | null;
  tsconfig: string | null;
  /** mypy: "defaults" checks a component without a mypy configuration with mypy's defaults. Absent: "skip". */
  withoutConfig?: "skip" | "defaults";
}

/** mypy's defaults for a component without a configuration: no third-party stub errors, no virtual environments. */
export const MYPY_DEFAULT_ARGS = ["--ignore-missing-imports", "--exclude", "(^|/)(venv|env|build|dist)/"];

const exists = (abs: string): boolean => {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
};
const readText = (abs: string): string => {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return "";
  }
};
const joinRel = (root: string, name: string): string => (root === "." ? name : `${root}/${name}`);
const slug = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "_");

/** The mypy / pyright configuration file of a Python component (relative to the component) and its text, or null. */
export function pythonConfig(dir: string, checker: "mypy" | "pyright"): { file: string; text: string } | null {
  const pick = (file: string, needs: RegExp | null): { file: string; text: string } | null => {
    const abs = path.join(dir, file);
    if (!exists(abs)) return null;
    const text = readText(abs);
    return needs === null || needs.test(text) ? { file, text } : null;
  };
  if (checker === "mypy") {
    return pick("mypy.ini", null) ?? pick(".mypy.ini", null) ?? pick("pyproject.toml", /^\s*\[tool\.mypy[\].]/m) ?? pick("setup.cfg", /^\s*\[mypy[\]:]/m) ?? pick("tox.ini", /^\s*\[mypy[\]:]/m);
  }
  return pick("pyrightconfig.json", null) ?? pick("pyproject.toml", /^\s*\[tool\.pyright[\].]/m);
}

interface Candidate {
  id: string;
  componentRoot: string;
  language: string | null;
  evidencePaths: string[];
}

/** Everything that decides the commands of one unit: its folder, its configuration, and the settings. */
function configFor(checker: Checker, workspace: string, c: Candidate, settings: UnitSettings): { config: string; text: string } | { skip: string } {
  const t = translator("build-check");
  const dir = c.componentRoot === "." ? workspace : path.join(workspace, ...c.componentRoot.split("/"));
  switch (checker) {
    case "tsc": {
      const name = settings.tsconfig ?? "tsconfig.json";
      return exists(path.join(dir, ...name.split("/"))) ? { config: joinRel(c.componentRoot, name), text: "" } : { skip: t("build_check_skip_no_tsconfig", { file: name }) };
    }
    case "mypy":
    case "pyright": {
      const found = pythonConfig(dir, checker);
      if (found) return { config: joinRel(c.componentRoot, found.file), text: found.text };
      // mypy with its defaults where the instance asks for it, unless the component chose pyright instead.
      if (checker === "mypy" && settings.withoutConfig === "defaults") {
        return pythonConfig(dir, "pyright") ? { skip: t("build_check_skip_pyright_configured") } : { config: "", text: "" };
      }
      return { skip: t("build_check_skip_no_python_config", { checker }) };
    }
    case "go":
      return exists(path.join(dir, "go.mod")) ? { config: joinRel(c.componentRoot, "go.mod"), text: "" } : { skip: t("build_check_skip_no_file", { file: "go.mod" }) };
    case "cargo":
      return exists(path.join(dir, "Cargo.toml")) ? { config: joinRel(c.componentRoot, "Cargo.toml"), text: "" } : { skip: t("build_check_skip_no_file", { file: "Cargo.toml" }) };
    case "dotnet": {
      const project = c.evidencePaths.find((p) => /\.csproj$/i.test(p) && path.posix.dirname(p) === (c.componentRoot === "." ? "." : c.componentRoot));
      return project ? { config: project, text: "" } : { skip: t("build_check_skip_no_file", { file: "*.csproj" }) };
    }
  }
}

/** The steps of one unit; the paths in args are relative to the unit's folder. */
function stepsFor(checker: Checker, probe: CheckerProbe, unitId: string, config: { config: string; text: string }, settings: UnitSettings): UnitStep[] {
  const executable = probe.executable as string;
  const cache = `${RUN_DIR}/cache/build-check/${checker}/${slug(unitId)}`;
  const file = config.config.split("/").pop() as string;
  switch (checker) {
    case "tsc":
      return [{ id: "tsc", label: "tsc --noEmit", executable, args: [...probe.prefix, "--noEmit", "-p", settings.tsconfig ?? file, "--pretty", "false"], env: { CI: "1", NO_COLOR: "1" } }];
    case "mypy": {
      // A configuration that names its own targets (files, packages, modules) is not overridden by ".".
      const ownTargets = /^\s*(files|packages|modules)\s*=/m.test(config.text);
      // No configuration file (withoutConfig: defaults): mypy's defaults plus MYPY_DEFAULT_ARGS.
      const defaults = config.config === "" ? MYPY_DEFAULT_ARGS : [];
      return [{ id: "mypy", label: defaults.length > 0 ? "mypy (defaults)" : "mypy", executable, args: ["--show-column-numbers", "--no-error-summary", "--no-pretty", "--no-color-output", "--cache-dir", cache, ...defaults, ...(ownTargets ? [] : ["."])], env: { NO_COLOR: "1", PYTHONDONTWRITEBYTECODE: "1" } }];
    }
    case "pyright":
      return [{ id: "pyright", label: "pyright", executable, args: ["--outputjson"], env: { NO_COLOR: "1", PYRIGHT_PYTHON_IGNORE_WARNINGS: "1", PYTHONDONTWRITEBYTECODE: "1" } }];
    case "go": {
      // The run never reaches the network or downloads a toolchain: GOPROXY=off, GOTOOLCHAIN=local.
      const env = { GOPROXY: "off", GOTOOLCHAIN: "local", NO_COLOR: "1" };
      return [
        { id: "build", label: "go build ./...", executable, args: ["build", "-o", `${cache}/`, "./..."], env },
        { id: "vet", label: "go vet ./...", executable, args: ["vet", "./..."], env, onlyAfterClean: true },
      ];
    }
    case "cargo":
      return [{ id: "check", label: "cargo check", executable, args: ["check", "--message-format", "json", "--offline", "--color", "never"], env: { CARGO_TARGET_DIR: `${cache}/target`, CARGO_TERM_COLOR: "never", NO_COLOR: "1" } }];
    case "dotnet":
      return [
        {
          id: "build",
          label: "dotnet build",
          executable,
          args: ["build", file, "-nologo", "-v:q", "-consoleloggerparameters:NoSummary", "-nodeReuse:false", "-p:UseSharedCompilation=false"],
          env: { DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_CLI_UI_LANGUAGE: "en", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1", MSBUILDDISABLENODEREUSE: "1", VSLANG: "1033", NO_COLOR: "1" },
        },
      ];
  }
}

function problemOf(checker: Checker, probe: CheckerProbe): string | null {
  const t = translator("build-check");
  if (probe.problem === "not_found") return t(`build_check_missing_${checker}`, { detail: probe.detail });
  if (probe.problem === "no_answer") return t("build_check_probe_failed", { checker, path: probe.detail });
  if (probe.version !== null && satisfiesRange(probe.version, `>=${MINIMUM[checker]}`) !== true) {
    return translator("prepare")("prepare_incompatible", { tool: checker, version: probe.version, range: `>=${MINIMUM[checker]}`, what: "build-check" });
  }
  return null;
}

/** The units of an instance: the discovered components of the checker's languages that carry the evidence. */
export function planUnits(opts: { dir: string; env: NodeJS.ProcessEnv; checker: Checker; componentRoot: string | null; settings: UnitSettings; skipWorkspace?: boolean; inventory?: Inventory }): UnitPlan {
  const { dir, env, checker, settings } = opts;
  // The plan's own discovery when it has it (the same project and settings): never a second walk of the tree.
  const inventory = opts.inventory ?? discoverWorkspace(dir).inventory;
  const candidates = inventory.classifications.filter((c) => c.approvable && c.language !== null && LANGUAGES[checker].includes(c.language) && (opts.componentRoot === null || opts.componentRoot === c.componentRoot));
  const units: BuildUnit[] = [];
  const skipped: SkippedUnit[] = [];
  for (const c of candidates) {
    const found = configFor(checker, dir, c, settings);
    if ("skip" in found) {
      skipped.push({ component: c.id, root: c.componentRoot, language: c.language as string, reason: found.skip });
      continue;
    }
    const probe = probeChecker(checker, dir, c.componentRoot, env, opts.skipWorkspace === true);
    const reason = problemOf(checker, probe);
    units.push({
      component: c.id,
      root: c.componentRoot,
      language: c.language as string,
      checker,
      config: found.config,
      version: probe.version,
      available: reason === null && probe.executable !== null,
      reason,
      steps: reason === null && probe.executable !== null ? stepsFor(checker, probe, c.id, found, settings) : [],
    });
  }
  return { units, skipped };
}

export { CHECKER_ENV };
