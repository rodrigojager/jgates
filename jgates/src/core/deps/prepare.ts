// Preparing the dependencies of an install unit in the engine (PLAN-dependencies.md sections 4 and 5). Each key has its
// own volume, `jgates-<ws>-deps-<unit>-<key12>`: the same key is reused without starting anything; a new key installs
// into a fresh volume, and only a successful install makes it the unit's volume (the record on the host) and removes the
// older ones (selected by label). A failed install removes only the fresh volume: the previous good one is kept.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import {
  EngineError,
  IMAGE_USER,
  dependencyVolumeName,
  engineLabels,
  ensureVolume,
  listManaged,
  removeVolume,
  runInEngine,
  sourceVolumeName,
  type EngineContext,
  type EngineMount,
} from "../engine/index.js";
import { resolveReason } from "../reasons/index.js";
import type { DependencySettings } from "./config.js";
import { maskSecrets, registryScript, resolveRegistry, type ResolvedRegistry } from "./credentials.js";
import { dependencyKey, shortKey } from "./key.js";
import { CACHE_TARGET, MARKER_FILE, filesIn, recipeFor, type InstallRecipe } from "./recipes.js";
import { readDepsState, updateDepsState } from "./state.js";
import type { InstallUnit } from "./units.js";

export const LABEL_DEPS_UNIT = "org.jgates.deps.unit";
export const LABEL_DEPS_KEY = "org.jgates.deps.key";
/** The package-manager cache shared by every workspace (uv, npm, pnpm, yarn, corepack, NuGet HTTP cache). */
export const DEFAULT_CACHE_VOLUME = "jgates-cache";
export const DEPS_FAILED = "DEPENDENCIES_FAILED";
export const DEPS_NOT_READY = "DEPENDENCIES_NOT_READY";
const UP_TO_DATE = "jgates-deps: up to date";
const INSTALLED = "jgates-deps: installed";

export type UnitStatus = "installed" | "reused" | "failed" | "not-ready";

/** What became of one unit: the facts the run, the CLI and the UI show (never a token). */
export interface UnitOutcome {
  unit: string;
  components: string[];
  installRoot: string;
  ecosystem: string;
  manager: string | null;
  status: UnitStatus;
  code: typeof DEPS_FAILED | typeof DEPS_NOT_READY | null;
  /** The text of the state, in the current language ("Dependências em dia (reaproveitadas)"...). */
  message: string;
  /** Engine or manager output of a failure (masked), for a "Details" fold. */
  details: string | null;
  key: string | null;
  volume: string | null;
  /** Where the volume is mounted in the deps container and the steps. */
  target: string | null;
  /** Volumes of the unit removed after a successful install (the previous ones). */
  removedVolumes: string[];
  /** The good volume a failed install left in place, when there is one. */
  keptVolume: string | null;
  mode: InstallRecipe["mode"] | null;
  /** "sem lockfile" note of a local install from the manifest. */
  note: string | null;
  registry: { url: string; tokenSecret: string | null; source: "env" | "vault" | null } | null;
  /** Log of the install, relative to the log root given (the run folder). */
  log: string | null;
  durationMs: number;
  /** The recipe of a prepared unit (the steps' environment comes from it). */
  recipe: InstallRecipe | null;
}

export interface UnitPlan {
  unit: InstallUnit;
  recipe: InstallRecipe | null;
  key: string | null;
  volume: string | null;
  /** Why it cannot be installed: the reason key of the deps catalogue and its parameters. */
  blocked: { reasonKey: string; params: Record<string, string> } | null;
  registry: ResolvedRegistry | null;
}

export interface UnitPlanInput {
  /** The analyzed tree (project folder or snapshot of a commit). */
  projectDir: string;
  workspace: string;
  imageId: string | null;
  governed: boolean;
  settings: DependencySettings;
  /** Environment the registry secrets are looked up in (then the key store, unless `vault` is false). */
  env: NodeJS.ProcessEnv;
  vault: boolean;
}

/** The recipe, key and volume of a unit (no engine call): what planning, status and prepare share. */
export function planUnit(unit: InstallUnit, input: UnitPlanInput): UnitPlan {
  const settingsRegistry = input.settings.registries[unit.info.ecosystem];
  const resolved = resolveRegistry(settingsRegistry, { env: input.env, vault: input.vault });
  const registry = resolved.ok ? resolved.registry : null;
  const rootDir = path.join(input.projectDir, ...(unit.installRoot === "." ? [] : unit.installRoot.split("/")));
  const read = (name: string): string | undefined => {
    try {
      return fs.readFileSync(path.join(rootDir, name), "utf8");
    } catch {
      return undefined;
    }
  };
  const result = recipeFor(unit, { governed: input.governed, files: filesIn(input.projectDir, unit.installRoot), installCommand: input.settings.installCommand, registry, read });
  if (!result.ok) return { unit, recipe: null, key: null, volume: null, blocked: { reasonKey: result.reasonKey, params: result.params }, registry };
  const key = dependencyKey({ projectDir: input.projectDir, unit, recipe: result.recipe, imageId: input.imageId, governed: input.governed, registryUrl: settingsRegistry?.url ?? null });
  const volume = `${dependencyVolumeName(input.workspace, unit.id)}-${shortKey(key)}`;
  if (!resolved.ok) return { unit, recipe: result.recipe, key, volume, blocked: { reasonKey: "deps_not_ready_secret", params: { unit: unit.id, secret: resolved.secret } }, registry: null };
  return { unit, recipe: result.recipe, key, volume, blocked: null, registry };
}

const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/** The shell of the deps container: reuse when the marker holds the key, otherwise empty the volume, install, then write the marker. */
export function installScript(unit: InstallUnit, recipe: InstallRecipe, registry: ResolvedRegistry | null): string {
  const cwd = path.posix.join("/workspace", unit.installRoot === "." ? "" : unit.installRoot);
  return [
    "set -eu",
    'mkdir -p "$HOME"',
    `target=${quote(recipe.target)}`,
    `marker="$target/${MARKER_FILE}"`,
    `if [ -f "$marker" ] && grep -q "\\"key\\": \\"$JGATES_DEPS_KEY\\"" "$marker"; then echo ${quote(UP_TO_DATE)}; exit 0; fi`,
    'find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf {} +',
    ...registryScript(unit.info.ecosystem, unit.info.manager, unit.info.variant, registry),
    `cd ${quote(cwd)}`,
    ...recipe.commands.flatMap((argv) => [`echo ${quote(`+ ${argv.join(" ")}`)}`, argv.map(quote).join(" ")]),
    `printf '{"key": "%s", "unit": "%s", "manager": "%s", "installedAt": "%s"}\\n' "$JGATES_DEPS_KEY" ${quote(unit.id)} ${quote(recipe.manager)} "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$marker"`,
    `echo ${quote(INSTALLED)}`,
  ].join("\n");
}

export interface PrepareInput extends UnitPlanInput {
  home: string;
  version: string;
  run?: string;
  imageId: string;
  engine: EngineContext;
  /** The package cache volume (default jgates-cache). */
  cacheVolume?: string;
  /** Extra labels of every object created (development tests mark theirs). */
  extraLabels?: Record<string, string>;
  /** Folder the install logs are written to, and the root their relative names start from. */
  logs?: { dir: string; root: string };
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => Date;
}

function outcomeBase(unit: InstallUnit): Omit<UnitOutcome, "status" | "code" | "message"> {
  return {
    unit: unit.id,
    components: unit.components,
    installRoot: unit.installRoot,
    ecosystem: unit.info.ecosystem,
    manager: unit.info.manager,
    details: null,
    key: null,
    volume: null,
    target: null,
    removedVolumes: [],
    keptVolume: null,
    mode: null,
    note: unit.info.note,
    registry: null,
    log: null,
    durationMs: 0,
    recipe: null,
  };
}

/** The outcome of a unit that cannot be installed (no engine call). */
export function notReadyOutcome(plan: UnitPlan): UnitOutcome {
  const t = translator("deps");
  const why = plan.blocked ? t(plan.blocked.reasonKey, plan.blocked.params) : "-";
  return {
    ...outcomeBase(plan.unit),
    status: "not-ready",
    code: DEPS_NOT_READY,
    message: `${resolveReason(DEPS_NOT_READY, { component: plan.unit.components.join(", ") }).message} ${why}`,
    details: why,
    key: plan.key,
    volume: plan.volume,
  };
}

function writeLog(input: PrepareInput, unit: InstallUnit, text: string): string | null {
  if (!input.logs) return null;
  try {
    fs.mkdirSync(input.logs.dir, { recursive: true });
    const file = path.join(input.logs.dir, `deps-${unit.id}.log`);
    fs.writeFileSync(file, text);
    return path.relative(input.logs.root, file).split(path.sep).join("/");
  } catch {
    return null;
  }
}

/** Installs (or reuses) the dependencies of one unit; the source volume must already hold the project. Never throws. */
export async function prepareUnit(unit: InstallUnit, input: PrepareInput): Promise<UnitOutcome> {
  const t = translator("deps");
  const started = Date.now();
  const now = input.now ?? (() => new Date());
  const plan = planUnit(unit, input);
  if (plan.blocked || !plan.recipe || !plan.key || !plan.volume) return notReadyOutcome(plan);
  const { recipe, key, volume, registry } = plan;
  const secrets = [registry?.token];
  const base = {
    ...outcomeBase(unit),
    key,
    volume,
    target: recipe.target,
    mode: recipe.mode,
    manager: recipe.manager,
    recipe,
    registry: registry ? { url: registry.url, tokenSecret: registry.tokenSecret, source: registry.source } : null,
  };
  const context = input.engine;
  const extra = input.extraLabels ?? {};
  // Containers carry the run label (a cancel kills them); volumes outlive the run that created them, so they do not.
  const labels = (kind: "deps" | "helper", withWorkspace = true, unitLabels = true, withRun = true) =>
    engineLabels({
      kind,
      version: input.version,
      ...(withWorkspace ? { workspace: input.workspace } : {}),
      ...(input.run && withRun ? { run: input.run } : {}),
      extra: { ...extra, ...(unitLabels ? { [LABEL_DEPS_UNIT]: unit.id, [LABEL_DEPS_KEY]: key } : {}) },
    });
  const state = readDepsState(input.home, input.workspace);
  const record = state.units[unit.id];
  const header = [
    t("deps_log_title", { unit: unit.id, components: unit.components.join(", ") }),
    t("deps_log_recipe", { manager: recipe.manager, mode: recipe.mode, root: unit.installRoot, target: recipe.target }),
    t("deps_log_key", { key, volume }),
    ...(registry ? [t("deps_log_registry", { url: registry.url, secret: registry.tokenSecret ?? "-" })] : []),
    ...recipe.commands.map((c) => `$ ${c.join(" ")}`),
  ].join("\n");

  try {
    const scope = { kind: "deps" as const, workspace: input.workspace, extraLabels: { ...extra, [LABEL_DEPS_UNIT]: unit.id } };
    const existing = await listManaged("volume", scope, context);
    if (record && record.key === key && record.volume === volume && existing.some((v) => v.name === volume)) {
      const log = writeLog(input, unit, `${header}\n${t("deps_log_reused")}\n`);
      return { ...base, status: "reused", code: null, message: t("deps_reused"), log, durationMs: Date.now() - started };
    }
    await ensureVolume(volume, { labels: labels("deps", true, true, false), helperLabels: labels("helper"), image: input.imageId }, context);
    const cacheVolume = input.cacheVolume ?? DEFAULT_CACHE_VOLUME;
    await ensureVolume(cacheVolume, { labels: labels("deps", false, false, false), helperLabels: labels("helper", true, false), image: input.imageId }, context);
    const mounts: EngineMount[] = [
      { type: "volume", source: sourceVolumeName(input.workspace), target: "/workspace" },
      { type: "volume", source: volume, target: recipe.target },
      { type: "volume", source: cacheVolume, target: CACHE_TARGET },
    ];
    const result = await runInEngine(
      {
        image: input.imageId,
        command: ["sh", "-c", installScript(unit, recipe, registry)],
        labels: labels("deps"),
        user: IMAGE_USER,
        network: "bridge",
        mounts,
        workdir: "/workspace",
        env: { ...recipe.installEnv, JGATES_DEPS_KEY: key, JGATES_DEPS_MARKER: `${recipe.target}/${MARKER_FILE}` },
        resources: { memoryMb: 4096, cpus: 2, pids: 4096, tmpfsMb: 1024 },
        tmpExec: true,
        // The token goes through standard input only (never an argument or a --env of docker run).
        stdin: registry?.token ? `${registry.token}\n` : null,
        timeoutMs: input.timeoutMs ?? 1_200_000,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      context,
    );
    const output = maskSecrets(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`, secrets);
    const ok = result.exitCode === 0 && !result.cancelled && !result.timedOut;
    const log = writeLog(input, unit, `${header}\n${output}\n${ok ? "" : t("deps_log_failed", { exit: String(result.exitCode ?? "-") })}\n`);
    if (!ok) throw Object.assign(new EngineError(t("deps_install_failed", { exit: String(result.exitCode ?? (result.timedOut ? "timeout" : "-")) }), lastLines(output)), { log });
    const status: UnitStatus = result.stdout.includes(UP_TO_DATE) && !result.stdout.includes(INSTALLED) ? "reused" : "installed";
    updateDepsState(input.home, input.workspace, (s) => {
      s.units[unit.id] = { volume, key, manager: recipe.manager, installRoot: unit.installRoot, installedAt: now().toISOString() };
      delete s.failures[unit.id];
    });
    // The older volumes of the unit go only now, selected by label (a volume another run still uses is left for later).
    const removed: string[] = [];
    for (const old of existing.filter((v) => v.name !== volume)) {
      try {
        await removeVolume(old.id, context);
        removed.push(old.name);
      } catch {
        // Left in place; the next successful install or `jgates deps clean` removes it.
      }
    }
    return { ...base, status, code: null, message: status === "reused" ? t("deps_reused") : t("deps_installed"), removedVolumes: removed, log, durationMs: Date.now() - started };
  } catch (error) {
    const message = maskSecrets(error instanceof Error ? error.message : String(error), secrets);
    const details = maskSecrets(error instanceof EngineError ? error.details : "", secrets);
    const log = (error as { log?: string | null }).log ?? writeLog(input, unit, `${header}\n${message}\n${details}\n`);
    // Only the fresh volume goes; the unit's good volume (the record's) is never touched by a failure.
    if (volume !== record?.volume) await removeVolume(volume, context).catch(() => undefined);
    try {
      updateDepsState(input.home, input.workspace, (s) => {
        s.failures[unit.id] = { key, at: now().toISOString(), code: DEPS_FAILED, message };
      });
    } catch {
      // The record is a convenience; the outcome below is what the run reports.
    }
    return {
      ...base,
      status: "failed",
      code: DEPS_FAILED,
      message: `${resolveReason(DEPS_FAILED, { component: unit.components.join(", ") }).message} ${message}`,
      details: details || message,
      keptVolume: record && record.volume !== volume ? record.volume : null,
      log,
      durationMs: Date.now() - started,
    };
  }
}

function lastLines(text: string, count = 25): string {
  return text.trim().split(/\r?\n/).slice(-count).join("\n");
}
