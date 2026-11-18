// The first-run wizard (PLAN-guided-ux.md section 3): six steps (Docker, Ferramentas, Projeto, Perfil, Dependências,
// Revisão) whose progress lives on the server, in the data folder of the workspace (never in the project), so closing the
// browser or restarting `jgates ui` resumes at the same step. The downloads run as the environment's preparation jobs
// and go on in the background while the person goes through the next steps; the dependencies chain after the image.
// Every check reads the machine fresh: a Docker installed while the page is open is seen at the next check.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BuiltinError } from "../../builtin/index.js";
import { patchYamlText, readRevision, YamlPatchError, type YamlEdit } from "../../core/codecs/yaml/index.js";
import { CONFIG_DIR, ROOT_FILE, parseYamlText, validateDocument } from "../../core/config/load/index.js";
import { discoverCompose } from "../../core/discovery/compose.js";
import { buildVocabulary, discoverWorkspace, loadWorkspaceSettings, WORKSPACE_FILE, type Classification, type DeclaredComponent } from "../../core/discovery/index.js";
import { installUnits, loadDependencySettings, planUnit, readDepsState } from "../../core/deps/index.js";
import { dependencyVolumeName, detectEngine, inspectImageSync, type EngineDetection } from "../../core/engine/index.js";
import { NAMED_RUNTIMES, readRuntimePreference, resolveRuntime, validRuntimeValue } from "../../core/engine/runtime-preference.js";
import { invalidateEngineFacts } from "../../core/engine/facts.js";
import { DATA_VOLUME, DATABASE_IDS } from "../../core/data/index.js";
import { managersOfLanguage } from "../../core/discovery/dependencies.js";
import { formatMegabytes } from "../../core/reasons/index.js";
import { findOnPath } from "../../core/runner/path-lookup.js";
import { DATABASE_ABOUT, toolAboutTable } from "../../core/tools-image/about.js";
import { imageToolCatalogue } from "../../core/tools-image/catalogue.js";
import { readPreferences, writePreferences } from "./preferences.js";
import { refreshPath } from "../../core/env-refresh/index.js";
import { workspaceDir } from "../../core/home/index.js";
import { DEFAULT_PROFILE, PROFILES_FILE, STARTER_PROFILES, existingConfigFiles, planInit, writeInit } from "../../core/init/index.js";
import { workspaceId } from "../../core/ids/index.js";
import { CATEGORY_ORDER, categoryRank, projectMascots } from "../../core/mascots/index.js";
import { createProfile, listProfiles, setDefaultProfile, setProfileChecks } from "../../core/profiles/index.js";
import { collectStatus, diskRequirement, engineContextOf, engineReason, type LifecycleReason } from "../../core/lifecycle/index.js";
import { buildPlan, type Plan } from "../../core/plan/index.js";
import { cachedProject, invalidateProjectCache, projectInventory } from "../../core/cache/project.js";
import { withEngineFacts } from "../../core/engine/facts.js";
import { stepMode } from "../../core/runner/in-image.js";
import { readToolsImagePin, toolsImageTarget } from "../../core/tools-image/index.js";
import { getLocale, normalizeLocale, translator } from "../../i18n/index.js";
import { HttpError, refuse } from "../http.js";
import { jobView } from "../runs.js";
import type { RouteDefinition, ServerContext } from "../types.js";
import { environmentJob, runningEnvironmentJob, startEnvironmentJob, type EnvironmentJobView } from "./environment.js";
import { PLAN_HASH_PATTERN, findPlan } from "./plans.js";
import { planAvailability, sourceProfileView, type ConfigSource } from "./config.js";
import { guard as profileGuard } from "./profiles.js";

export const SETUP_STEPS = ["docker", "tools", "project", "profile", "dependencies", "review"] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];

/** A correction of a detected component, written to .jgates/workspace.yml when step 3 is confirmed. */
interface ComponentChoice {
  id: string;
  language?: string;
  framework?: string;
  manager?: string;
}

interface SetupState {
  schemaVersion: 1;
  /** The step on screen. */
  step: SetupStepId;
  /** The wizard ended (first run started, or closed by the person once the project had a configuration). */
  completed: boolean;
  done: SetupStepId[];
  skipped: SetupStepId[];
  choices: {
    components: ComponentChoice[];
    services: { use: boolean; compose: string[] } | null;
    profile: string | null;
  };
  /** Ids of the environment jobs the wizard started (they live in the server's memory: unknown after a restart). */
  jobs: { pull: string | null; data: string | null; dependencies: string | null };
  /** idle; queued: starts when the image is there; started: its job ran or runs; skipped by the person. */
  dependencies: "idle" | "queued" | "started" | "skipped";
  run: string | null;
  /** Opened again on purpose (#/setup) after the project had its configuration: it does not take over the overview. */
  reopened?: boolean;
  startedAt: string;
  updatedAt: string;
}

const LOCALE = { type: "string", enum: ["en", "pt-BR"] };
const LOCALE_QUERY = { type: "object", properties: { locale: LOCALE }, additionalProperties: false };
const STEP = { type: "string", enum: [...SETUP_STEPS] };
const NAME = { type: "string", minLength: 1, maxLength: 60, pattern: "^[A-Za-z0-9][A-Za-z0-9._+#-]*$" };
/** A profile of the draft (its id) or a starter one (builtin:<id>). */
const PROFILE_REF = "^(builtin:)?[a-z0-9][a-z0-9._-]{0,127}$";
const PROFILE_ID = "^[a-z0-9][a-z0-9._-]{0,127}$";
const SELECTOR = "^(category|capability|tool|rule|pii|architecture|component):[A-Za-z0-9._/:-]+$";

const now = (): string => new Date().toISOString();

function freshState(): SetupState {
  const at = now();
  return {
    schemaVersion: 1,
    step: "docker",
    completed: false,
    done: [],
    skipped: [],
    choices: { components: [], services: null, profile: null },
    jobs: { pull: null, data: null, dependencies: null },
    dependencies: "idle",
    run: null,
    startedAt: at,
    updatedAt: at,
  };
}

const stateFile = (server: ServerContext): string => path.join(workspaceDir(server.home, server.workspace.id), "setup.json");

/** The saved state, or null when the wizard never started in this workspace (a damaged file counts as never started). */
function readState(server: ServerContext): SetupState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(server), "utf8")) as Partial<SetupState>;
    if (raw.schemaVersion !== 1 || !SETUP_STEPS.includes(raw.step as SetupStepId)) return null;
    const base = freshState();
    return {
      ...base,
      ...raw,
      done: (raw.done ?? []).filter((s) => SETUP_STEPS.includes(s)),
      skipped: (raw.skipped ?? []).filter((s) => SETUP_STEPS.includes(s)),
      choices: { ...base.choices, ...(raw.choices ?? {}) },
      jobs: { ...base.jobs, ...(raw.jobs ?? {}) },
    } as SetupState;
  } catch {
    return null;
  }
}

/** Writes the state (temporary file, then rename: a crash never leaves half a file). */
function writeState(server: ServerContext, state: SetupState): SetupState {
  const file = stateFile(server);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...state, updatedAt: now() };
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}

const configured = (server: ServerContext): boolean => fs.existsSync(path.join(server.projectDir, ROOT_FILE));

/** Open: the overview shows the wizard. A project without jgates.yml always has it; one with it, while a started wizard has not ended. */
function isOpen(server: ServerContext, state: SetupState | null): boolean {
  if (server.policyMode) return false;
  if (!configured(server)) return true;
  return state !== null && !state.completed && state.reopened !== true;
}

const indexOf = (step: SetupStepId): number => SETUP_STEPS.indexOf(step);
const settled = (state: SetupState, step: SetupStepId): boolean => state.done.includes(step) || state.skipped.includes(step);
/** A step can be shown when every step before it is done or skipped. */
const reachable = (state: SetupState, step: SetupStepId): boolean => SETUP_STEPS.slice(0, indexOf(step)).every((s) => settled(state, s));

function jobState(server: ServerContext, id: string | null): (EnvironmentJobView & { known: true }) | { id: string; known: false; state: "unknown" } | null {
  if (!id) return null;
  const job = environmentJob(server, id);
  return job ? { ...job, known: true } : { id, known: false, state: "unknown" };
}

function view(server: ServerContext, state: SetupState | null): Record<string, unknown> {
  const s = state ?? freshState();
  return {
    schemaVersion: 1,
    status: "OK",
    open: isOpen(server, state),
    started: state !== null,
    reopened: s.reopened === true,
    configured: configured(server),
    policyMode: server.policyMode,
    setup: {
      step: s.step,
      completed: s.completed,
      steps: SETUP_STEPS.map((id, index) => ({
        id,
        index: index + 1,
        state: s.done.includes(id) ? "done" : s.skipped.includes(id) ? "skipped" : id === s.step ? "current" : "pending",
        reachable: reachable(s, id),
      })),
      choices: s.choices,
      jobs: { pull: jobState(server, s.jobs.pull), data: jobState(server, s.jobs.data), dependencies: jobState(server, s.jobs.dependencies) },
      dependencies: s.dependencies,
      run: s.run,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
    },
  };
}

function current(server: ServerContext): SetupState {
  return readState(server) ?? freshState();
}

function guard(server: ServerContext, locale?: string): void {
  if (server.policyMode) throw new HttpError(409, "POLICY_MODE", translator("setup", locale)("setup_policy_mode"), null);
}

/** Marks a step done (or skipped) and moves to the next one. */
function settle(state: SetupState, step: SetupStepId, how: "done" | "skipped"): SetupState {
  const done = state.done.filter((s) => s !== step);
  const skipped = state.skipped.filter((s) => s !== step);
  (how === "done" ? done : skipped).push(step);
  const next = SETUP_STEPS[indexOf(step) + 1] ?? step;
  return { ...state, done, skipped, step: next };
}

// ---- step 1: the engine ----------------------------------------------------------------------------------------------

/** What the machine should have (PLAN-guided-flows.md section 2): each step is limited to 4 GB and 2 CPUs. */
export const MACHINE_NEEDS = { memoryMb: 8192, diskMb: 15 * 1024, cpus: 2 } as const;
/** An engine given 8 GB reports a little less (the VM keeps some): the same margin as the engine's own memory check. */
const MEMORY_MARGIN = 0.9;

type RequirementState = "ok" | "warn" | "error" | "unknown";
interface Requirement {
  id: "engine" | "memory" | "disk" | "cpus";
  state: RequirementState;
  /** Only the engine blocks the wizard: too little memory, disk or CPUs is a warning that names what may not run. */
  blocking: boolean;
  /** The measured value: MB for memory and disk, a count for CPUs, the engine version for the engine. */
  value: number | string | null;
  need: number | null;
  unit: "mb" | "count" | null;
  message: string;
}

function requirements(detection: EngineDetection | null, locale?: string): Requirement[] {
  const t = translator("setup", locale);
  const mb = (value: number) => formatMegabytes(value, locale);
  if (detection === null) return [];
  const facts = detection.facts;
  const engineState: RequirementState = facts.running ? (detection.code === "UNSUPPORTED_PLATFORM" ? "error" : "ok") : "error";
  const engine: Requirement = {
    id: "engine",
    state: engineState,
    blocking: true,
    value: facts.serverVersion,
    need: null,
    unit: null,
    message: facts.running ? (engineState === "ok" ? t("setup_req_engine_ok", { version: facts.serverVersion ?? "?" }) : t("setup_req_engine_unsupported", { platform: `${facts.os ?? "?"}/${facts.arch ?? "?"}` })) : facts.installed ? t("setup_req_engine_stopped") : t("setup_req_engine_missing"),
  };
  if (!facts.running) return [engine];
  const memoryState: RequirementState = facts.memoryMb === null ? "unknown" : facts.memoryMb >= MACHINE_NEEDS.memoryMb * MEMORY_MARGIN ? "ok" : "warn";
  const diskState: RequirementState = facts.diskFreeMb === null ? "unknown" : facts.diskFreeMb >= MACHINE_NEEDS.diskMb ? "ok" : "warn";
  const cpuState: RequirementState = facts.cpus === null ? "unknown" : facts.cpus >= MACHINE_NEEDS.cpus ? "ok" : "warn";
  return [
    engine,
    {
      id: "memory",
      state: memoryState,
      blocking: false,
      value: facts.memoryMb,
      need: MACHINE_NEEDS.memoryMb,
      unit: "mb",
      message: memoryState === "unknown" ? t("setup_req_unknown") : memoryState === "ok" ? t("setup_req_memory_ok", { have: mb(facts.memoryMb ?? 0), need: mb(MACHINE_NEEDS.memoryMb) }) : t("setup_req_memory_low", { have: mb(facts.memoryMb ?? 0), need: mb(MACHINE_NEEDS.memoryMb) }),
    },
    {
      id: "disk",
      state: diskState,
      blocking: false,
      value: facts.diskFreeMb,
      need: MACHINE_NEEDS.diskMb,
      unit: "mb",
      message: diskState === "unknown" ? t("setup_req_unknown") : diskState === "ok" ? t("setup_req_disk_ok", { have: mb(facts.diskFreeMb ?? 0), need: mb(MACHINE_NEEDS.diskMb) }) : t("setup_req_disk_low", { have: mb(facts.diskFreeMb ?? 0), need: mb(MACHINE_NEEDS.diskMb) }),
    },
    {
      id: "cpus",
      state: cpuState,
      blocking: false,
      value: facts.cpus,
      need: MACHINE_NEEDS.cpus,
      unit: "count",
      message: cpuState === "unknown" ? t("setup_req_unknown") : cpuState === "ok" ? t("setup_req_cpus_ok", { have: facts.cpus ?? 0, need: MACHINE_NEEDS.cpus }) : t("setup_req_cpus_low", { have: facts.cpus ?? 0, need: MACHINE_NEEDS.cpus }),
    },
  ];
}

/** The runtimes the wizard offers, which of them is on the PATH, the one in use and where that choice came from. */
function runtimeInfo(home: string): Record<string, unknown> {
  const { runtime, source } = resolveRuntime(process.env);
  // The choice shown is the person's (the preference, docker by default), even while the variable overrides it.
  const chosen = readRuntimePreference(home) ?? "docker";
  const named = (NAMED_RUNTIMES as readonly string[]).includes(chosen);
  return {
    current: runtime,
    selected: named ? chosen : "custom",
    path: named ? null : chosen,
    source,
    envOverride: source === "env" ? runtime : null,
    options: [...NAMED_RUNTIMES.map((id) => ({ id, found: findOnPath(id, process.env) })), { id: "custom", found: null }],
  };
}

async function engineCheck(home: string, locale?: string): Promise<Record<string, unknown>> {
  refreshPath({ force: true });
  if (stepMode(process.env) === "in-image") return { ready: true, state: "ready", mode: "in-image", facts: null, requirements: [], runtime: runtimeInfo(home), reasons: [], command: "jgates setup" };
  // The free disk is read from the disk the engine stores on, as the host sees it (no helper container: this check runs
  // every 3 s while the engine is missing, and it must never start anything).
  const detection = await detectEngine({ requiredDiskMb: 1 }, engineContextOf(process.env));
  const reason = engineReason(detection, locale);
  const state = reason === null ? "ready" : reason.code === "ENGINE_NOT_INSTALLED" ? "not-installed" : reason.code === "ENGINE_STOPPED" ? "stopped" : reason.code === "ENGINE_LOW_MEMORY" ? "low-memory" : "unsupported";
  const { serverVersion, os: engineOs, arch, memoryMb, cpus, diskFreeMb } = detection.facts;
  // Too little memory does not stop the first steps: the plan says which checks need more.
  const ready = reason === null || reason.code === "ENGINE_LOW_MEMORY";
  return {
    ready,
    state,
    mode: "container",
    facts: { serverVersion, os: engineOs, arch, memoryMb, cpus, diskFreeMb },
    requirements: requirements(detection, locale),
    runtime: runtimeInfo(home),
    reasons: reason ? [reason] : [],
    command: "jgates setup",
  };
}

/** "Testar" of another executable: asks that executable for the engine's info, without saving anything. */
async function testRuntime(executable: string, locale?: string): Promise<Record<string, unknown>> {
  const t = translator("setup", locale);
  const detection = await detectEngine({ requiredDiskMb: 0, requiredMemoryMb: 0 }, { runtime: executable, runnerOptions: { parentEnv: process.env } });
  const facts = detection.facts;
  const ok = facts.running && detection.code !== "UNSUPPORTED_PLATFORM";
  const message = ok
    ? t("setup_runtime_test_ok", { version: facts.serverVersion ?? "?" })
    : facts.running
      ? t("setup_req_engine_unsupported", { platform: `${facts.os ?? "?"}/${facts.arch ?? "?"}` })
      : facts.installed
        ? t("setup_req_engine_stopped")
        : t("setup_runtime_test_missing", { path: executable });
  return { ok, version: facts.serverVersion, message, details: detection.details || null };
}

// ---- step 2: the tools image and the advisory data ------------------------------------------------------------------

const chained = new WeakMap<ServerContext, Set<string>>();

/** Once per pull job: after it ends well, start the advisory data and the queued dependencies. */
function afterPull(server: ServerContext, pullId: string, finished: Promise<boolean>, locale?: string): void {
  let seen = chained.get(server);
  if (!seen) {
    seen = new Set();
    chained.set(server, seen);
  }
  if (seen.has(pullId)) return;
  seen.add(pullId);
  void finished.then((ok) => {
    if (!ok) return;
    let state = readState(server);
    if (!state) return;
    if (state.jobs.data === null || environmentJob(server, state.jobs.data)?.state !== "running") {
      state = { ...state, jobs: { ...state.jobs, data: startEnvironmentJob(server, "data", locale).job.id } };
    }
    if (state.dependencies === "queued") {
      state = { ...state, dependencies: "started", jobs: { ...state.jobs, dependencies: startEnvironmentJob(server, "dependencies", locale).job.id } };
    }
    writeState(server, state);
  });
}

/** Starts (or joins) the image pull; the advisory data follows it, because its refresh runs in the image. */
function ensureDownloads(server: ServerContext, state: SetupState, locale?: string): SetupState {
  // Inside the tools image there is nothing to download.
  if (stepMode(process.env) === "in-image") return state;
  const pull = state.jobs.pull ? environmentJob(server, state.jobs.pull) : null;
  if (pull && pull.state !== "failed") {
    return state;
  }
  const started = startEnvironmentJob(server, "pull", locale);
  afterPull(server, started.job.id, started.finished, locale);
  return { ...state, jobs: { ...state.jobs, pull: started.job.id } };
}

/** Whether the tools image is there; inside withEngineFacts only (the inspect comes from the cached engine facts). */
function imageReady(): boolean {
  if (stepMode(process.env) === "in-image") return true;
  const target = toolsImageTarget(process.env, readToolsImagePin());
  return inspectImageSync(target.reference, engineContextOf(process.env)) !== null;
}

/** imageReady for a handler: read before any action, so an action never runs twice while the engine is asked. */
const imageReadyNow = (server: ServerContext): Promise<boolean> => withEngineFacts(() => imageReady(), { prime: { version: server.version, data: false, codeql: false } });

// ---- step 3: the project --------------------------------------------------------------------------------------------

type FieldState = "declared" | "detected" | "ambiguous" | "unknown" | "none" | "unsupported" | "found" | "missing";

/** The state of each fact of a component, with a sentence for the ones that need the person (D26, PLAN-guided-flows section 2). */
function componentFields(c: Classification, labels: Map<string, string>, t: (key: string, params?: Record<string, string | number>) => string): Record<string, { state: FieldState; reason: string | null }> {
  const origin: FieldState = c.classificationStatus === "explicit" ? "declared" : c.classificationStatus === "ambiguous" ? "ambiguous" : "detected";
  const deps = c.dependencies;
  const language = c.language === null ? { state: "unknown" as const, reason: t("setup_field_language_unknown") } : { state: origin, reason: origin === "ambiguous" ? t("setup_field_ambiguous") : null };
  const framework = c.framework === null ? { state: "none" as const, reason: null } : { state: origin, reason: null };
  const manager = !deps
    ? { state: "none" as const, reason: c.language ? t("setup_field_manager_none", { language: labels.get(c.language) ?? c.language }) : null }
    : deps.state === "ambiguous"
      ? { state: "ambiguous" as const, reason: t("setup_field_manager_ambiguous", { managers: deps.candidates.join(", ") }) }
      : deps.state === "unsupported"
        ? { state: "unsupported" as const, reason: t("setup_field_manager_unsupported") }
        : { state: deps.chosenBy === "workspace-config" ? ("declared" as const) : ("detected" as const), reason: null };
  const lockfile = !deps ? { state: "none" as const, reason: null } : deps.lockfile ? { state: "found" as const, reason: null } : { state: "missing" as const, reason: t("setup_field_lockfile_missing") };
  return { language, framework, manager, lockfile };
}

/** "Projeto Python na pasta raiz": what the component is, in words. */
function componentSentence(c: Classification, labels: Map<string, string>, frameworks: Map<string, string>, t: (key: string, params?: Record<string, string | number>) => string): string {
  const where = c.componentRoot === "." ? t("setup_sentence_root") : t("setup_sentence_folder", { folder: c.componentRoot });
  const language = c.language ? (labels.get(c.language) ?? c.language) : null;
  const framework = c.framework ? (frameworks.get(c.framework) ?? c.framework) : null;
  if (!language) return t("setup_sentence_unknown", { where });
  return framework ? t("setup_sentence_framework", { language, framework, where }) : t("setup_sentence", { language, where });
}

const component = (c: Classification, words?: { labels: Map<string, string>; frameworks: Map<string, string>; t: (key: string, params?: Record<string, string | number>) => string }) => ({
  id: c.id,
  root: c.componentRoot,
  status: c.classificationStatus,
  reasonCode: c.reasonCode,
  language: c.language,
  framework: c.framework,
  ...(words ? { sentence: componentSentence(c, words.labels, words.frameworks, words.t), fields: componentFields(c, words.labels, words.t) } : {}),
  evidence: c.evidencePaths.slice(0, 3),
  dependencies: c.dependencies
    ? {
        ecosystem: c.dependencies.ecosystem,
        state: c.dependencies.state,
        manager: c.dependencies.manager,
        candidates: c.dependencies.candidates,
        lockfile: c.dependencies.lockfile,
        installRoot: c.dependencies.installRoot,
        languageVersion: c.dependencies.language.version,
        languageVersionSource: c.dependencies.language.source,
        note: c.dependencies.note,
      }
    : null,
});

function projectInfo(server: ServerContext, state: SetupState, locale?: string): Record<string, unknown> {
  const inventory = projectInventory(server.projectDir);
  const shown = inventory.classifications.filter((c) => c.classificationStatus !== "ignored");
  // The ambiguous ones first: they are the ones that need the person.
  const ordered = [...shown.filter((c) => c.classificationStatus === "ambiguous" || c.dependencies?.state === "ambiguous"), ...shown.filter((c) => !(c.classificationStatus === "ambiguous" || c.dependencies?.state === "ambiguous"))];
  const compose = discoverCompose(server.projectDir);
  const existing = configured(server) ? servicesOfConfig(server) : null;
  const languages = buildVocabulary().languages;
  const labels = new Map(languages.map((l) => [l.id, l.label]));
  const frameworks = new Map(languages.flatMap((l) => l.frameworks.map((f) => [f.id, f.label] as [string, string])));
  const words = { labels, frameworks, t: translator("setup", locale) };
  return {
    schemaVersion: 1,
    status: "OK",
    components: ordered.map((c) => component(c, words)),
    // Each language with the managers JGates installs with: the manager select follows the chosen language (D26).
    vocabulary: languages.map((l) => ({ ...l, managers: [...managersOfLanguage(l.id)] })),
    compose: { files: compose.files, services: compose.services.map((s) => ({ name: s.name, image: s.image, role: s.role, hostEffects: s.hostEffects.map((e) => e.kind) })) },
    // The checkbox starts checked when compose files exist (the complete path), or as the configuration already says.
    servicesDefault: existing !== null ? existing : compose.files.length > 0,
    choices: state.choices,
    command: "jgates discover",
  };
}

function servicesOfConfig(server: ServerContext): boolean {
  try {
    const parsed = parseYamlText(fs.readFileSync(path.join(server.projectDir, ROOT_FILE), "utf8"), ROOT_FILE);
    const value = parsed.value as { services?: unknown } | undefined;
    return value?.services !== undefined && value.services !== null;
  } catch {
    return false;
  }
}

/** Writes the corrections into .jgates/workspace.yml (components[] by id), validated before anything is written. */
function writeComponentChoices(server: ServerContext, choices: ComponentChoice[], locale?: string): string[] {
  const t = translator("setup", locale);
  const { inventory } = discoverWorkspace(server.projectDir);
  const byId = new Map(inventory.classifications.map((c) => [c.id, c]));
  const { settings } = loadWorkspaceSettings(server.projectDir);
  const declared: DeclaredComponent[] = [...settings.components];
  let changed = false;
  for (const choice of choices) {
    const found = byId.get(choice.id);
    if (!found) throw new HttpError(422, "COMPONENT_UNKNOWN", t("setup_component_unknown", { id: choice.id }), t("setup_component_unknown_fix"));
    const language = choice.language ?? found.language ?? undefined;
    const framework = choice.framework ?? found.framework ?? undefined;
    const manager = choice.manager ?? found.dependencies?.manager ?? undefined;
    const differs = language !== (found.language ?? undefined) || framework !== (found.framework ?? undefined) || manager !== (found.dependencies?.manager ?? undefined);
    if (!differs) continue;
    changed = true;
    const at = declared.findIndex((d) => d.id === choice.id);
    const before = at >= 0 ? declared[at] : undefined;
    const entry: DeclaredComponent = {
      ...(before ?? {}),
      id: choice.id,
      path: before?.path ?? found.componentRoot,
      ...(language ? { language } : {}),
      ...(framework ? { framework } : {}),
      ...(manager ? { dependencies: { ...(before?.dependencies ?? {}), manager } } : {}),
    };
    if (at >= 0) declared[at] = entry;
    else declared.push(entry);
  }
  if (!changed) return [];
  const abs = path.join(server.projectDir, WORKSPACE_FILE);
  const revision = readRevision(abs);
  const seed = "schemaVersion: 1\n";
  const edits: YamlEdit[] = [{ op: "set", path: ["components"], value: declared }];
  let text: string;
  try {
    text = patchYamlText(revision.exists ? revision.text : seed, edits).text;
  } catch (error) {
    if (error instanceof YamlPatchError) throw new HttpError(422, error.code, error.message);
    throw error;
  }
  assertValid("workspace", text, WORKSPACE_FILE, locale);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  writeChecked(abs, revision.hash, text, locale);
  return [WORKSPACE_FILE];
}

function assertValid(kind: "workspace" | "root", text: string, file: string, locale?: string): void {
  const parsed = parseYamlText(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, file);
  const problems = [...parsed.diagnostics, ...(parsed.value === undefined ? [] : validateDocument(kind, parsed.value, file, { doc: parsed.doc, lineCounter: parsed.lineCounter }))];
  if (problems.length > 0) throw new HttpError(422, "CONFIG_INVALID", translator("setup", locale)("setup_config_invalid", { file, message: problems[0]?.message ?? "" }), null);
}

/** Writes a file only if it is still the revision that was read (another editor may have saved meanwhile). */
function writeChecked(abs: string, hash: string | null, text: string, locale?: string): void {
  const latest = readRevision(abs);
  if (latest.hash !== hash) throw new HttpError(409, "REVISION_CONFLICT", translator("setup", locale)("setup_config_conflict", { file: path.basename(abs) }), translator("setup", locale)("setup_config_conflict_fix"));
  fs.writeFileSync(abs, text, "utf8");
}

// ---- step 4: the profile, edited in a draft until the step is confirmed (ADR-0008) ------------------------------------
//
// The profile step embeds the profile editor: switches per check, a profile created from another one and customized,
// before jgates.yml exists. Every change goes to a draft configuration folder in the data folder of the workspace
// (`setup-draft/`, beside setup.json), never to the project. The draft owns jgates.yml and the file that holds the
// profiles; the rest of the configuration (.jgates/*, files named in `extends`) mirrors the project, so the views,
// the plans and the counts are computed as for the project with `configDir` pointing at the draft. Confirming the step
// writes the owned files that differ into the project (new ones as `jgates init` writes them, existing ones only if
// they are still the revision the draft started from) and drops the draft.

interface ConfigFile {
  file: string;
  exists: boolean;
  before: string | null;
  text: string;
}

interface DraftMeta {
  schemaVersion: 1;
  /** "new": the project had no jgates.yml when the draft started (it holds init's files); "existing": a copy of its files. */
  mode: "new" | "existing";
  /** The files the draft owns (jgates.yml and the file of the profiles); everything else mirrors the project. */
  owned: string[];
  /** Revision of each owned file in the project when the draft started (null: it did not exist). */
  base: Record<string, string | null>;
  /** Revision of each owned file of the draft when it started: a draft whose files still match was not edited. */
  seed: Record<string, string | null>;
  /** The person picked a profile: the draft no longer follows the recommended one. */
  chosen: boolean;
}

interface Draft {
  dir: string;
  meta: DraftMeta;
}

/** The draft configuration folder and its record, beside setup.json. */
const draftDirOf = (server: ServerContext): string => path.join(workspaceDir(server.home, server.workspace.id), "setup-draft");
const draftMetaFile = (server: ServerContext): string => path.join(workspaceDir(server.home, server.workspace.id), "setup-draft.json");
const draftSource = (server: ServerContext, draft: Draft): ConfigSource => ({ projectDir: server.projectDir, configDir: draft.dir });
const hashIn = (dir: string, file: string): string | null => readRevision(path.join(dir, file)).hash;
const readText = (abs: string): string | null => {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
};

function readDraftMeta(server: ServerContext): DraftMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(draftMetaFile(server), "utf8")) as Partial<DraftMeta>;
    if (raw.schemaVersion !== 1 || (raw.mode !== "new" && raw.mode !== "existing") || !Array.isArray(raw.owned)) return null;
    return { schemaVersion: 1, mode: raw.mode, owned: raw.owned.filter((f) => typeof f === "string"), base: raw.base ?? {}, seed: raw.seed ?? {}, chosen: raw.chosen === true };
  } catch {
    return null;
  }
}

function writeDraftMeta(server: ServerContext, meta: DraftMeta): void {
  const file = draftMetaFile(server);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

function dropDraft(server: ServerContext): void {
  fs.rmSync(draftDirOf(server), { recursive: true, force: true });
  fs.rmSync(draftMetaFile(server), { force: true });
  invalidateProjectCache();
}

/** The file that holds the project's profiles (`.jgates/profiles.yml` unless the configuration keeps them elsewhere). */
function profilesFileOf(projectDir: string): string {
  try {
    return listProfiles(projectDir).profiles.find((p) => p.origin === "project")?.file ?? PROFILES_FILE;
  } catch {
    return PROFILES_FILE;
  }
}

/** Relative paths of the files under `rel` of `dir` (at most a few levels, plain files only). */
function filesUnder(dir: string, rel: string, depth = 0, out: string[] = []): string[] {
  if (depth > 6) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, ...rel.split("/")), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) filesUnder(dir, child, depth + 1, out);
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/** The project files `extends` of the draft's jgates.yml names outside .jgates (relative, inside the project). */
function extendedFiles(draftDir: string): string[] {
  const text = readText(path.join(draftDir, ROOT_FILE));
  if (text === null) return [];
  try {
    const value = parseYamlText(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, ROOT_FILE).value as { extends?: unknown } | undefined;
    const list = Array.isArray(value?.extends) ? value.extends : [];
    return list.filter((e): e is string => typeof e === "string" && !path.isAbsolute(e) && !e.split(/[\\/]/).includes("..")).map((e) => e.replace(/\\/g, "/").replace(/^\.\//, ""));
  } catch {
    return [];
  }
}

const MIRROR_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Makes the draft's other configuration files the project's: .jgates/* and the files `extends` names, copied when they
 * differ (so the cached views stay valid while nothing changed), and removed when the project no longer has them.
 */
function mirrorProject(server: ServerContext, draft: Draft): void {
  const owned = new Set(draft.meta.owned);
  const wanted = new Set<string>([...filesUnder(server.projectDir, CONFIG_DIR), ...extendedFiles(draft.dir).filter((f) => fs.existsSync(path.join(server.projectDir, f)))]);
  for (const file of owned) wanted.delete(file);
  for (const file of wanted) {
    const from = path.join(server.projectDir, ...file.split("/"));
    const to = path.join(draft.dir, ...file.split("/"));
    let bytes: Buffer;
    try {
      if (fs.statSync(from).size > MIRROR_MAX_BYTES) continue;
      bytes = fs.readFileSync(from);
    } catch {
      continue;
    }
    let same = false;
    try {
      same = fs.readFileSync(to).equals(bytes);
    } catch {
      same = false;
    }
    if (same) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, bytes);
  }
  for (const file of filesUnder(draft.dir, "")) {
    if (!owned.has(file) && !wanted.has(file)) fs.rmSync(path.join(draft.dir, ...file.split("/")), { force: true });
  }
}

/** A new draft: the project's own files when it has jgates.yml, otherwise the files `jgates init --profile <profile>` would write. */
function seedDraft(server: ServerContext, profile: string): Draft {
  dropDraft(server);
  const dir = draftDirOf(server);
  fs.mkdirSync(dir, { recursive: true });
  let meta: DraftMeta;
  if (configured(server)) {
    const owned = [...new Set([ROOT_FILE, profilesFileOf(server.projectDir)])];
    for (const file of owned) {
      const text = readText(path.join(server.projectDir, ...file.split("/")));
      if (text === null) continue;
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text, "utf8");
    }
    meta = { schemaVersion: 1, mode: "existing", owned, base: Object.fromEntries(owned.map((f) => [f, hashIn(server.projectDir, f)])), seed: {}, chosen: false };
  } else {
    const files = planInit(server.projectDir, profile).files;
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, f.file)), { recursive: true });
      fs.writeFileSync(path.join(dir, f.file), f.text, "utf8");
    }
    const owned = files.map((f) => f.file);
    meta = { schemaVersion: 1, mode: "new", owned, base: Object.fromEntries(owned.map((f) => [f, hashIn(server.projectDir, f)])), seed: {}, chosen: false };
  }
  meta.seed = Object.fromEntries(meta.owned.map((f) => [f, hashIn(dir, f)]));
  writeDraftMeta(server, meta);
  const draft = { dir, meta };
  mirrorProject(server, draft);
  return draft;
}

/** Whether the draft holds a change of the person (an owned file differs from what the draft started with). */
const edited = (draft: Draft): boolean => draft.meta.owned.some((f) => hashIn(draft.dir, f) !== (draft.meta.seed[f] ?? null));

/**
 * The draft of this workspace, started when there is none. A draft of the other kind (the project got or lost its
 * jgates.yml meanwhile), or an untouched draft of files the project changed since, starts again from the project.
 */
function openDraft(server: ServerContext, profile: string): Draft {
  const meta = readDraftMeta(server);
  const dir = draftDirOf(server);
  if (!meta || !fs.existsSync(path.join(dir, ROOT_FILE))) return seedDraft(server, profile);
  const draft = { dir, meta };
  if ((meta.mode === "existing") !== configured(server)) return seedDraft(server, profile);
  if (meta.mode === "existing" && !edited(draft) && meta.owned.some((f) => hashIn(server.projectDir, f) !== (meta.base[f] ?? null))) return seedDraft(server, profile);
  mirrorProject(server, draft);
  return draft;
}

/** The profile the draft's jgates.yml selects (null when it selects none). */
function draftSelected(draft: Draft): string | null {
  try {
    const text = readText(path.join(draft.dir, ROOT_FILE)) ?? "";
    const profile = (parseYamlText(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, ROOT_FILE).value as { selection?: { profile?: unknown } } | undefined)?.selection?.profile;
    return typeof profile === "string" ? profile : null;
  } catch {
    return null;
  }
}

/** Selects `profile` in the draft (a profile of the draft or a starter one). */
function chooseInDraft(server: ServerContext, draft: Draft, profile: string, byPerson: boolean): void {
  if (draftSelected(draft) !== profile) profileGuard(() => setDefaultProfile(draft.dir, profile));
  if (byPerson && !draft.meta.chosen) {
    draft.meta = { ...draft.meta, chosen: true };
    writeDraftMeta(server, draft.meta);
  } else if (!byPerson && draft.meta.mode === "new") {
    // Following the recommendation is not a change of the person's.
    draft.meta = { ...draft.meta, seed: { ...draft.meta.seed, [ROOT_FILE]: hashIn(draft.dir, ROOT_FILE) } };
    writeDraftMeta(server, draft.meta);
  }
  invalidateProjectCache();
}

/** The services chosen at step 3, applied to the draft's jgates.yml as the project will get it. */
function withServices(server: ServerContext, draft: Draft, text: string, services: SetupState["choices"]["services"]): string {
  const edits: YamlEdit[] = [];
  if (draft.meta.mode === "new") {
    if (services?.use && services.compose.length > 0) edits.push({ op: "set", path: ["services", "compose"], value: services.compose });
  } else {
    if (services?.use && services.compose.length > 0 && !servicesOfConfig(server)) edits.push({ op: "set", path: ["services", "compose"], value: services.compose });
    if (services && !services.use && servicesOfConfig(server)) edits.push({ op: "delete", path: ["services"] });
  }
  return edits.length > 0 ? patchYamlText(text, edits).text : text;
}

/** The files confirming the step writes: the draft's owned files as the project will hold them. */
function draftFiles(server: ServerContext, draft: Draft, services: SetupState["choices"]["services"], selection?: string): ConfigFile[] {
  return draft.meta.owned.flatMap((file) => {
    let text = readText(path.join(draft.dir, ...file.split("/")));
    if (text === null) return [];
    if (file === ROOT_FILE) {
      if (selection && draftSelected(draft) !== selection) text = patchYamlText(text, [{ op: "set", path: ["selection", "profile"], value: selection }]).text;
      text = withServices(server, draft, text, services);
    }
    const before = readText(path.join(server.projectDir, ...file.split("/")));
    return [{ file, exists: before !== null, before, text }];
  });
}

/** Writes the draft into the project: init's files for a new configuration, otherwise each owned file that changed. */
function writeDraft(server: ServerContext, draft: Draft, services: SetupState["choices"]["services"], locale?: string): string[] {
  const t = translator("setup", locale);
  const files = draftFiles(server, draft, services);
  const root = files.find((f) => f.file === ROOT_FILE);
  if (root) assertValid("root", root.text, ROOT_FILE, locale);
  if (draft.meta.mode === "new") {
    // A new configuration: the same files as `jgates init`, never over a file that exists.
    const clash = existingConfigFiles(server.projectDir).filter((f) => files.some((x) => x.file === f));
    if (clash.length > 0) throw new HttpError(409, "CONFIG_EXISTS", t("setup_config_exists", { files: clash.join(", ") }), t("setup_config_exists_fix"));
    try {
      return writeInit(server.projectDir, { profile: draftSelected(draft) ?? DEFAULT_PROFILE, templates: [], components: [], files: files.map((f) => ({ file: f.file, text: f.text })) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, "CONFIG_EXISTS", t("setup_config_exists", { files: ROOT_FILE }), t("setup_config_exists_fix"));
      throw error;
    }
  }
  const changed = files.filter((f) => f.before !== f.text);
  // Every file is checked before any is written: another editor may have saved the project meanwhile.
  for (const f of changed) {
    if (readRevision(path.join(server.projectDir, ...f.file.split("/"))).hash !== (draft.meta.base[f.file] ?? null)) {
      throw new HttpError(409, "REVISION_CONFLICT", t("setup_config_conflict", { file: f.file }), t("setup_draft_conflict_fix"));
    }
  }
  for (const f of changed) {
    const abs = path.join(server.projectDir, ...f.file.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    writeChecked(abs, draft.meta.base[f.file] ?? null, f.text, locale);
  }
  return changed.map((f) => f.file);
}

type ProfileCount = {
  id: string;
  ref: string;
  label: string | null;
  description: string | null;
  extends: string | null;
  /** One of the three starter profiles (minimal, standard, strict) of a new configuration. */
  starter: boolean;
  unit: "steps";
  total: number;
  categories: Array<{ id: string; count: number }>;
  error: string | null;
};

/** The categories in one order everywhere: the quality mascot strip's, then the project's own checks. */
export { CATEGORY_ORDER };
const byCategory = <T extends { id: string }>(list: readonly T[]): T[] => [...list].sort((a, b) => categoryRank(a.id) - categoryRank(b.id));

interface DraftPlans {
  profiles: ProfileCount[];
  selected: string | null;
  mascots: ReturnType<typeof projectMascots>;
  plan: ReturnType<typeof planAvailability>;
  error: { code: string; message: string; fix: string | null } | null;
}

/**
 * "O que roda" of every profile of the draft and, for the one it selects, what the plan says about each capability and
 * the mascots: one discovery for all the plans, kept in the project cache until the project or the draft changes.
 * Runs inside withEngineFacts: the plans read the engine from its cached facts.
 */
function draftPlans(server: ServerContext, draft: Draft): DraftPlans {
  return cachedProject(`setup-profiles:${getLocale()}`, [server.projectDir, draft.dir], () => {
    const inventory = projectInventory(server.projectDir, draft.dir);
    const list = listProfiles(draft.dir);
    const selected = draftSelected(draft);
    const own = list.profiles.filter((p) => p.origin === "project");
    const ordered = [...STARTER_PROFILES.flatMap((id) => own.filter((p) => p.id === id)), ...own.filter((p) => !(STARTER_PROFILES as readonly string[]).includes(p.id))];
    // A configuration whose own profiles are not the starters still offers the starters (as built-in profiles).
    const shown = ordered.length > 0 ? ordered : list.profiles.filter((p) => p.origin === "builtin" && (STARTER_PROFILES as readonly string[]).includes(p.id));
    if (selected && !shown.some((p) => p.ref === selected || p.id === selected)) {
      const extra = list.profiles.find((p) => p.ref === selected || p.ref === `builtin:${selected}`);
      if (extra) shown.push(extra);
    }
    let selectedPlan: Plan | null = null;
    let selectedError: DraftPlans["error"] = null;
    const profiles = shown.map((p): ProfileCount => {
      const base = { id: p.id, ref: p.ref, label: p.label, description: p.description, extends: p.extends, starter: (STARTER_PROFILES as readonly string[]).includes(p.id), unit: "steps" as const };
      const isSelected = selected !== null && (p.ref === selected || p.id === selected);
      let result;
      try {
        result = buildPlan(server.projectDir, { profile: p.ref, compare: false, home: server.home, version: server.version, inventory, configDir: draft.dir, configIsProject: true });
      } catch (error) {
        if (error instanceof BuiltinError) {
          if (isSelected) selectedError = { code: "BUILTIN_ERROR", message: error.message, fix: null };
          return { ...base, total: 0, categories: [], error: error.message };
        }
        throw error;
      }
      if (!result.ok) {
        if (isSelected) selectedError = { code: result.error.code, message: result.error.message, fix: result.error.fix ?? null };
        return { ...base, total: 0, categories: [], error: result.error.message };
      }
      if (isSelected) selectedPlan = result.plan;
      const counts = new Map<string, number>();
      for (const item of result.plan.groups.willRun) counts.set(item.category ?? "custom", (counts.get(item.category ?? "custom") ?? 0) + 1);
      return { ...base, total: result.plan.groups.willRun.length, categories: byCategory([...counts].map(([category, count]) => ({ id: category, count }))), error: null };
    });
    return { profiles, selected, mascots: projectMascots({ plan: selectedPlan, invalid: selectedError !== null }), plan: planAvailability(selectedPlan), error: selectedError };
  });
}

/** The view of one profile of the draft (the same as Configuração > Perfil), its categories in the strip's order. */
function draftView(server: ServerContext, draft: Draft, ref: string) {
  const view = profileGuard(() => sourceProfileView(draftSource(server, draft), ref));
  return { ...view, categories: byCategory(view.categories) };
}

const selectedProfile = (server: ServerContext): string | null => {
  try {
    const parsed = parseYamlText(fs.readFileSync(path.join(server.projectDir, ROOT_FILE), "utf8"), ROOT_FILE);
    const profile = (parsed.value as { selection?: { profile?: unknown } } | undefined)?.selection?.profile;
    return typeof profile === "string" ? profile : null;
  } catch {
    return null;
  }
};

// ---- step 5: the dependencies ---------------------------------------------------------------------------------------

/** Starts the dependencies now when the image is there, or queues them after the pull (starting the pull if needed). */
function ensureDependencies(server: ServerContext, state: SetupState, ready: boolean, locale?: string): SetupState {
  const running = state.jobs.dependencies ? environmentJob(server, state.jobs.dependencies) : null;
  if (running?.state === "running") return { ...state, dependencies: "started" };
  const pull = runningEnvironmentJob(server, "pull");
  if (pull) {
    afterPull(server, pull.id, startEnvironmentJob(server, "pull", locale).finished, locale);
    return { ...state, dependencies: "queued", jobs: { ...state.jobs, pull: pull.id } };
  }
  if (!ready) {
    const next = ensureDownloads(server, { ...state, dependencies: "queued" }, locale);
    return next;
  }
  return { ...state, dependencies: "started", jobs: { ...state.jobs, dependencies: startEnvironmentJob(server, "dependencies", locale).job.id } };
}

/** The public registry each ecosystem installs from when .jgates/dependencies.yml names none. */
const DEFAULT_REGISTRY: Record<string, string> = { python: "pypi.org", node: "registry.npmjs.org", go: "proxy.golang.org", rust: "index.crates.io", dotnet: "api.nuget.org" };

const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/**
 * One row per install unit (D27, PLAN-guided-flows.md section 2 step 5): manager, lockfile, what is installed (the
 * recipe's mode, the files it installs from and its commands), where it goes (the unit's volume and where steps mount
 * it, never the project folder) and the network the install uses (the package registry, only while installing).
 */
function dependencyUnits(server: ServerContext, locale?: string): Array<Record<string, unknown>> {
  const inventory = projectInventory(server.projectDir);
  const { units } = installUnits(inventory.classifications.filter((c) => c.approvable));
  const workspace = workspaceId(server.projectDir);
  const settings = loadDependencySettings(server.projectDir);
  const record = readDepsState(server.home, workspace);
  const td = translator("deps", locale);
  return units.map((u) => {
    // No key store lookup here: the registry is named from the settings; its secret is the preparation's business.
    const planned = planUnit(u, { projectDir: server.projectDir, workspace, imageId: null, governed: false, settings, env: process.env, vault: false });
    const recipe = planned.recipe;
    const registryUrl = settings.registries[u.info.ecosystem]?.url ?? null;
    const blocked = planned.blocked && planned.blocked.reasonKey !== "deps_not_ready_secret" ? td(planned.blocked.reasonKey, planned.blocked.params) : null;
    return {
      unit: u.id,
      components: u.components,
      installRoot: u.installRoot,
      ecosystem: u.info.ecosystem,
      manager: u.info.manager,
      lockfile: u.info.lockfile,
      languageVersion: u.info.language.version,
      languageVersionSource: u.info.language.source,
      note: u.info.note,
      install: recipe ? { mode: recipe.mode, files: recipe.keyFiles, commands: recipe.commands.map((argv) => argv.join(" ")) } : null,
      blocked,
      volume: { name: record.units[u.id]?.volume ?? null, prefix: dependencyVolumeName(workspace, u.id), target: recipe?.target ?? null },
      network: { kind: "bridge", registry: registryUrl ? hostOf(registryUrl) : (DEFAULT_REGISTRY[u.info.ecosystem] ?? null), private: registryUrl !== null },
    };
  });
}

// ---- the routes ----------------------------------------------------------------------------------------------------

const localeOf = (value: unknown): string | undefined => normalizeLocale(typeof value === "string" ? value : undefined) ?? undefined;

const componentChoice = {
  type: "object",
  properties: { id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]*$", maxLength: 120 }, language: NAME, framework: NAME, manager: NAME },
  required: ["id"],
  additionalProperties: false,
};

export const routes: RouteDefinition[] = [
  {
    // The wizard: whether the overview shows it, the step on screen, what each step decided and the background jobs.
    method: "GET",
    path: "/api/setup",
    handler({ server }) {
      return { status: 200, json: view(server, readState(server)) };
    },
  },
  {
    // "Voltar", or a click on a step of the stepper: only to a step whose previous ones are settled.
    method: "PUT",
    path: "/api/setup",
    body: { type: "object", properties: { step: STEP, locale: LOCALE }, required: ["step"], additionalProperties: false },
    handler({ body, server }) {
      const b = body as { step: SetupStepId; locale?: string };
      const locale = localeOf(b.locale);
      guard(server, locale);
      const state = current(server);
      if (!reachable(state, b.step)) throw new HttpError(409, "SETUP_STEP_UNREACHABLE", translator("setup", locale)("setup_step_unreachable"), null, { step: state.step });
      return { status: 200, json: view(server, writeState(server, { ...state, step: b.step, completed: false })) };
    },
  },
  {
    // "Continuar" (or "Pular por agora" with skip) of the step on screen; what each step needs is checked here.
    method: "POST",
    path: "/api/setup/advance",
    body: {
      type: "object",
      properties: {
        step: STEP,
        locale: LOCALE,
        skip: { type: "boolean" },
        components: { type: "array", maxItems: 200, items: componentChoice },
        services: { type: "object", properties: { use: { type: "boolean" } }, required: ["use"], additionalProperties: false },
        profile: { type: "string", pattern: PROFILE_REF },
        planHash: { type: "string", pattern: PLAN_HASH_PATTERN },
      },
      required: ["step"],
      additionalProperties: false,
    },
    timeoutMs: 120_000,
    async handler({ body, server }) {
      const b = body as { step: SetupStepId; locale?: string; skip?: boolean; components?: ComponentChoice[]; services?: { use: boolean }; profile?: string; planHash?: string };
      const locale = localeOf(b.locale);
      const t = translator("setup", locale);
      guard(server, locale);
      let state = current(server);
      if (state.step !== b.step) throw new HttpError(409, "SETUP_STEP_MISMATCH", t("setup_step_mismatch"), t("setup_step_mismatch_fix"), { step: state.step });
      if (b.skip && !["dependencies", "review"].includes(b.step)) throw new HttpError(422, "SETUP_SKIP_REFUSED", t("setup_skip_refused"), null);
      const written: string[] = [];
      let run: Record<string, unknown> | null = null;

      if (b.step === "docker") {
        const check = await engineCheck(server.home, locale);
        if (!check.ready) {
          const [reason] = check.reasons as LifecycleReason[];
          throw new HttpError(409, reason?.code ?? "ENGINE_NOT_INSTALLED", reason?.message ?? "", reason?.action.label ?? null, { reasons: check.reasons, engine: check.state });
        }
        // Read again after the check: a background job may have saved the state meanwhile.
        state = settle(current(server), "docker", "done");
      } else if (b.step === "tools") {
        // The wizard does not wait for the download: it goes on in the background (inside the image there is none).
        if (stepMode(process.env) !== "in-image") state = ensureDownloads(server, state, locale);
        state = settle(state, "tools", "done");
      } else if (b.step === "project") {
        const services = b.services ?? { use: false };
        const compose = services.use ? discoverCompose(server.projectDir).files : [];
        written.push(...writeComponentChoices(server, b.components ?? [], locale));
        state = { ...state, choices: { ...state.choices, components: b.components ?? [], services: { use: services.use && compose.length > 0, compose } } };
        state = settle(state, "project", "done");
      } else if (b.step === "profile") {
        // A new configuration needs a choice: the draft's (the step was shown) or the one sent.
        if (!b.profile && !configured(server) && readDraftMeta(server) === null) throw new HttpError(422, "PROFILE_REQUIRED", t("setup_profile_required"), null);
        const draft = openDraft(server, b.profile ?? DEFAULT_PROFILE);
        if (b.profile) chooseInDraft(server, draft, b.profile, true);
        const profile = draftSelected(draft) ?? (configured(server) ? selectedProfile(server) : null);
        if (!profile) throw new HttpError(422, "PROFILE_REQUIRED", t("setup_profile_required"), null);
        // The draft becomes the project's configuration (only the files that differ), then it is gone.
        written.push(...writeDraft(server, draft, state.choices.services, locale));
        dropDraft(server);
        // Read again after the write: a background job may have saved the state meanwhile.
        state = current(server);
        state = { ...state, choices: { ...state.choices, profile } };
        state = settle(state, "profile", "done");
      } else if (b.step === "dependencies") {
        if (b.skip) state = settle({ ...state, dependencies: "skipped" }, "dependencies", "skipped");
        else {
          if (state.dependencies === "idle" || state.dependencies === "skipped") {
            const ready = await imageReadyNow(server);
            // Read again after the engine answered: a background job may have saved the state meanwhile.
            state = ensureDependencies(server, current(server), ready, locale);
          }
          state = settle(state, "dependencies", "done");
        }
      } else {
        if (b.skip) {
          if (!configured(server)) throw new HttpError(409, "NOT_CONFIGURED", t("setup_not_configured"), null);
          state = { ...settle(state, "review", "skipped"), completed: true };
        } else {
          if (!b.planHash) throw new HttpError(422, "PLAN_REQUIRED", t("setup_plan_required"), null);
          const plan: Plan | null = findPlan(server, b.planHash);
          if (!plan) throw refuse(404, "PLAN_NOT_FOUND");
          if (plan.blocked || !plan.approvable) {
            const blockers = plan.blocked ? [plan.blocked, ...plan.blockers] : plan.blockers;
            throw refuse(422, "PLAN_NOT_APPROVABLE", { detail: blockers.map((x) => x.message).join(" ") }, { blockers });
          }
          const active = server.runs.active;
          if (active) throw refuse(409, "RUN_ACTIVE", {}, { run: jobView(active, false) });
          const job = server.runs.start(plan);
          run = jobView(job);
          state = { ...settle(state, "review", "done"), completed: true, run: job.id };
        }
      }
      const saved = writeState(server, state);
      server.log(`setup ${b.step}${b.skip ? " skipped" : ""}${written.length ? ` wrote ${written.join(",")}` : ""}`);
      return { status: 200, json: { ...view(server, saved), written, ...(run ? { run } : {}) } };
    },
  },
  {
    // Step 1: the engine, read fresh at every call (installed or started while the page was open is seen here).
    method: "GET",
    path: "/api/setup/docker",
    query: LOCALE_QUERY,
    timeoutMs: 60_000,
    async handler({ query, server }) {
      if (server.policyMode) guard(server);
      return { status: 200, json: { schemaVersion: 1, status: "OK", ...(await engineCheck(server.home, localeOf(query.locale))) } };
    },
  },
  {
    // Step 2: what the download needs and where it is (image, free disk, advisory data, the jobs).
    method: "GET",
    path: "/api/setup/tools",
    query: LOCALE_QUERY,
    timeoutMs: 60_000,
    async handler({ query, server }) {
      guard(server);
      const locale = localeOf(query.locale);
      refreshPath({ force: true });
      const pin = readToolsImagePin();
      const status = await withEngineFacts(() => collectStatus({ env: process.env, version: server.version, projectDir: server.projectDir, light: true, ...(locale ? { locale } : {}) }), { prime: { version: server.version } });
      const state = current(server);
      const need = diskRequirement(pin);
      const reasons = [...status.reasons, ...status.warnings].filter((r) => r.code.startsWith("IMAGE_") || r.code.startsWith("DATA_") || r.code === "DISK_LOW");
      const t = translator("setup", locale);
      const catalogue = imageToolCatalogue(process.env);
      const aboutTable = toolAboutTable();
      const tools = Object.entries(catalogue?.tools ?? {})
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([name, version]) => {
          const about = aboutTable[name];
          return { name, version, license: about?.license ?? null, purpose: about?.purpose ?? null, purposeText: about ? t(`setup_purpose_${about.purpose.replace(/-/g, "_")}`) : null };
        });
      const ages = new Map(status.data.databases.map((d) => [d.id, d]));
      const databases = DATABASE_IDS.map((id) => {
        const about = DATABASE_ABOUT[id];
        const age = ages.get(id);
        return { id, name: about.name, source: about.source, sizeBytes: about.approxBytes, approximate: true, usedBy: about.usedBy, state: age?.state ?? "missing", fetchedAt: age?.fetchedAt ?? null };
      });
      const dataBytes = databases.reduce((sum, d) => sum + d.sizeBytes, 0);
      // What is already on the machine does not count again: the image when it is there, the data when it is fresh.
      const imageThere = status.mode === "in-image" || status.image.state === "ready";
      const pendingData = databases.filter((d) => d.state !== "fresh").reduce((sum, d) => sum + d.sizeBytes, 0);
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          mode: status.mode,
          image: {
            state: status.image.state,
            name: pin.name,
            reference: status.image.reference,
            version: status.image.version ?? catalogue?.imageVersion ?? pin.imageVersion,
            sizeBytes: pin.sizeBytes,
            downloadBytes: need.compressedBytes,
            diskBytes: need.uncompressedBytes,
            tools,
          },
          totals: { downloadBytes: need.compressedBytes + dataBytes, diskBytes: need.uncompressedBytes + dataBytes, pendingDownloadBytes: (imageThere ? 0 : need.compressedBytes) + pendingData, pendingDiskBytes: (imageThere ? 0 : need.uncompressedBytes) + pendingData },
          disk: { freeMb: status.disk.freeMb, requiredMb: need.totalMb, freeBytes: status.disk.freeMb === null ? null : status.disk.freeMb * 1024 * 1024 },
          data: { state: status.data.state, volume: DATA_VOLUME, databases },
          jobs: { pull: jobState(server, state.jobs.pull), data: jobState(server, state.jobs.data) },
          reasons,
          command: "jgates setup",
        },
      };
    },
  },
  {
    // "Baixar as ferramentas do JGates": the pull starts (or is joined) and the advisory data follows it.
    method: "POST",
    path: "/api/setup/downloads",
    body: { type: "object", properties: { locale: LOCALE }, additionalProperties: false },
    handler({ body, server }) {
      const locale = localeOf((body as { locale?: string }).locale);
      guard(server, locale);
      const state = writeState(server, ensureDownloads(server, current(server), locale));
      return { status: 200, json: view(server, state) };
    },
  },
  {
    // Step 3: the components as discovery sees them, the vocabulary of the selects and the compose files.
    method: "GET",
    path: "/api/setup/project",
    query: LOCALE_QUERY,
    handler({ query, server }) {
      guard(server);
      return { status: 200, json: projectInfo(server, current(server), localeOf(query.locale)) };
    },
  },
  {
    // Step 4: every profile of the draft with what it runs in this project (plan steps, by category), the recommended
    // one, the one the draft selects with what its plan says about each capability and the mascots (ADR-0008).
    method: "GET",
    path: "/api/setup/profiles",
    timeoutMs: 120_000,
    async handler({ server }) {
      guard(server);
      // The image and the plans read the engine from its cached facts, never with a blocking call.
      const ready = await withEngineFacts(() => imageReady(), { prime: { version: server.version } });
      // Rigoroso when the tools are there (everything it asks for can run); the default profile otherwise.
      const recommended = ready ? "strict" : DEFAULT_PROFILE;
      const draft = openDraft(server, recommended);
      // A new configuration follows the recommendation until the person picks a profile.
      if (draft.meta.mode === "new" && !draft.meta.chosen && draftSelected(draft) !== recommended) chooseInDraft(server, draft, recommended, false);
      const plans = await withEngineFacts(() => draftPlans(server, draft), { prime: { version: server.version } });
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          recommended,
          selected: plans.selected,
          toolsReady: ready,
          profiles: plans.profiles,
          // The selected profile's plan: what it says about each capability here, and the quality mascots.
          plan: plans.plan,
          mascots: plans.mascots,
          error: plans.error,
          categoryOrder: CATEGORY_ORDER,
          draft: { mode: draft.meta.mode, edited: edited(draft), chosen: draft.meta.chosen },
          command: "jgates init --profile <perfil>",
        },
      };
    },
  },
  {
    // Step 4: one profile of the draft as Configuração > Perfil shows it (categories, capabilities, tools, rules).
    method: "GET",
    path: "/api/setup/profile",
    query: { type: "object", properties: { profile: { type: "string", pattern: PROFILE_REF } }, additionalProperties: false },
    handler({ query, server }) {
      guard(server);
      const draft = openDraft(server, DEFAULT_PROFILE);
      const ref = query.profile ?? draftSelected(draft) ?? DEFAULT_PROFILE;
      return { status: 200, json: draftView(server, draft, ref) };
    },
  },
  {
    // Step 4: the profile the draft selects (a radio card). Nothing is written to the project.
    method: "PUT",
    path: "/api/setup/profile/choice",
    body: { type: "object", properties: { profile: { type: "string", pattern: PROFILE_REF } }, required: ["profile"], additionalProperties: false },
    handler({ body, server }) {
      guard(server);
      const profile = (body as { profile: string }).profile;
      const draft = openDraft(server, DEFAULT_PROFILE);
      chooseInDraft(server, draft, profile, true);
      return { status: 200, json: { schemaVersion: 1, status: "OK", selected: draftSelected(draft), view: draftView(server, draft, profile) } };
    },
  },
  {
    // Step 4: checks turned on or off in a profile of the draft (the switches of the category list).
    method: "PUT",
    path: "/api/setup/profile/selection",
    body: {
      type: "object",
      properties: {
        profile: { type: "string", pattern: PROFILE_ID },
        changes: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: {
            type: "object",
            properties: { selector: { type: "string", pattern: SELECTOR }, enabled: { type: "boolean" }, when: { enum: ["available", null] } },
            required: ["selector", "enabled"],
            additionalProperties: false,
          },
        },
      },
      required: ["profile", "changes"],
      additionalProperties: false,
    },
    handler({ body, server }) {
      guard(server);
      const input = body as { profile: string; changes: Array<{ selector: string; enabled: boolean; when?: "available" | null }> };
      const draft = openDraft(server, DEFAULT_PROFILE);
      const inventory = projectInventory(server.projectDir, draft.dir);
      const result = profileGuard(() => setProfileChecks(draft.dir, input.profile, input.changes, { project: { dir: server.projectDir, inventory } }));
      invalidateProjectCache();
      server.log(`setup draft selection ${input.profile} ${input.changes.length} change(s)`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", id: result.id, changes: result.changes, changed: result.changed, view: draftView(server, draft, input.profile) } };
    },
  },
  {
    // Step 4: "Criar perfil a partir deste": a profile of the draft that extends another one, then customized here.
    method: "POST",
    path: "/api/setup/profile",
    body: {
      type: "object",
      properties: { id: { type: "string", pattern: PROFILE_ID }, from: { type: "string", pattern: PROFILE_REF }, label: { type: "string", maxLength: 120 }, description: { type: "string", maxLength: 400 } },
      required: ["id", "from"],
      additionalProperties: false,
    },
    handler({ body, server }) {
      guard(server);
      const input = body as { id: string; from: string; label?: string; description?: string };
      const draft = openDraft(server, DEFAULT_PROFILE);
      const result = profileGuard(() => createProfile(draft.dir, input.id, { from: input.from, ...(input.label ? { label: input.label } : {}), ...(input.description ? { description: input.description } : {}) }));
      invalidateProjectCache();
      server.log(`setup draft profile created ${result.id}`);
      return { status: 201, json: { schemaVersion: 1, status: "OK", id: result.id, extends: result.extends, view: draftView(server, draft, result.id) } };
    },
  },
  {
    // Step 4: "Desfazer as mudanças": the draft starts again from the project (or from init's files).
    method: "DELETE",
    path: "/api/setup/profile/draft",
    async handler({ server }) {
      guard(server);
      const ready = await withEngineFacts(() => imageReady(), { prime: { version: server.version } });
      dropDraft(server);
      const draft = openDraft(server, ready ? "strict" : DEFAULT_PROFILE);
      server.log("setup draft discarded");
      return { status: 200, json: { schemaVersion: 1, status: "OK", selected: draftSelected(draft) } };
    },
  },
  {
    // Step 4: the files confirming the step would write (the draft as the project will hold it), before anything is written.
    method: "POST",
    path: "/api/setup/config/preview",
    body: { type: "object", properties: { profile: { type: "string", pattern: PROFILE_REF } }, additionalProperties: false },
    handler({ body, server }) {
      guard(server);
      const profile = (body as { profile?: string }).profile;
      const draft = openDraft(server, profile ?? DEFAULT_PROFILE);
      // An existing configuration lists only the files that change.
      const files = draftFiles(server, draft, current(server).choices.services, profile).filter((f) => draft.meta.mode === "new" || f.before !== f.text);
      return { status: 200, json: { schemaVersion: 1, status: "OK", mode: draft.meta.mode, files } };
    },
  },
  {
    // Step 5: one row per install unit (manager, lockfile, language version) with its state.
    method: "GET",
    path: "/api/setup/dependencies",
    query: LOCALE_QUERY,
    timeoutMs: 60_000,
    async handler({ query, server }) {
      guard(server);
      const locale = localeOf(query.locale);
      const units = dependencyUnits(server, locale);
      const status = await withEngineFacts(() => collectStatus({ env: process.env, version: server.version, projectDir: server.projectDir, ...(locale ? { locale } : {}) }), { prime: { version: server.version } });
      const states = new Map((status.workspace?.dependencies ?? []).map((d) => [d.unit, d.state]));
      const state = current(server);
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          units: units.map((u) => ({ ...u, state: states.get(u.unit as string) ?? (status.image.state === "ready" ? "missing" : "not-ready") })),
          imageReady: status.image.state === "ready" || status.mode === "in-image",
          dependencies: state.dependencies,
          jobs: { pull: jobState(server, state.jobs.pull), dependencies: jobState(server, state.jobs.dependencies) },
          command: "jgates deps prepare",
        },
      };
    },
  },
  {
    // "Preparar dependências": now, or as soon as the tools finish downloading (it chains by itself).
    method: "POST",
    path: "/api/setup/dependencies",
    body: { type: "object", properties: { locale: LOCALE }, additionalProperties: false },
    async handler({ body, server }) {
      const locale = localeOf((body as { locale?: string }).locale);
      guard(server, locale);
      const ready = await imageReadyNow(server);
      const state = writeState(server, ensureDependencies(server, current(server), ready, locale));
      return { status: 200, json: view(server, state) };
    },
  },
  {
    // "Refazer a configuração guiada": the wizard opens again with the current values.
    method: "POST",
    path: "/api/setup/reopen",
    // An explicit action ("Abrir o assistente" on #/setup): it starts at the chosen step (one whose previous steps are
    // settled) and, once the project has its configuration, it lives on #/setup only: the overview stays the overview (D13).
    body: { type: "object", properties: { step: STEP, locale: LOCALE }, additionalProperties: false },
    handler({ body, server }) {
      const b = body as { step?: SetupStepId; locale?: string };
      const locale = localeOf(b.locale);
      guard(server, locale);
      const state = readState(server) ?? freshState();
      const step = b.step ?? "docker";
      if (!reachable(state, step)) throw new HttpError(409, "SETUP_STEP_UNREACHABLE", translator("setup", locale)("setup_step_unreachable"), null, { step: state.step });
      return { status: 200, json: view(server, writeState(server, { ...state, completed: false, reopened: configured(server), step, run: null })) };
    },
  },
  {
    // Step 1: the runtime JGates uses (docker, podman, or another executable), saved in the user's preferences: the next
    // engine call of this server and every CLI command of the same data folder use it. JGATES_CONTAINER_RUNTIME still wins.
    method: "PUT",
    path: "/api/setup/runtime",
    body: {
      type: "object",
      properties: { runtime: { enum: [...NAMED_RUNTIMES, "custom"] }, path: { type: "string", minLength: 1, maxLength: 1024 }, locale: LOCALE },
      required: ["runtime"],
      additionalProperties: false,
    },
    handler({ body, server }) {
      const b = body as { runtime: "docker" | "podman" | "custom"; path?: string; locale?: string };
      const locale = localeOf(b.locale);
      const t = translator("setup", locale);
      guard(server, locale);
      let value: string = b.runtime;
      if (b.runtime === "custom") {
        const p = (b.path ?? "").trim();
        if (!validRuntimeValue(p) || (NAMED_RUNTIMES as readonly string[]).includes(p)) throw new HttpError(422, "RUNTIME_PATH_INVALID", t("setup_runtime_path_invalid"), t("setup_runtime_path_invalid_fix"));
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new HttpError(422, "RUNTIME_PATH_MISSING", t("setup_runtime_test_missing", { path: p }), t("setup_runtime_path_invalid_fix"));
        value = p;
      }
      writePreferences(server.home, { ...readPreferences(server.home), containerRuntime: value });
      // The cached engine answers belong to the previous runtime.
      invalidateEngineFacts();
      server.log(`setup runtime ${b.runtime}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", runtime: runtimeInfo(server.home) } };
    },
  },
  {
    // "Testar": whether another executable answers as a container engine, before it is saved.
    method: "POST",
    path: "/api/setup/runtime/test",
    body: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 1024 }, locale: LOCALE }, required: ["path"], additionalProperties: false },
    timeoutMs: 60_000,
    async handler({ body, server }) {
      const b = body as { path: string; locale?: string };
      const locale = localeOf(b.locale);
      guard(server, locale);
      const p = b.path.trim();
      if (!validRuntimeValue(p)) throw new HttpError(422, "RUNTIME_PATH_INVALID", translator("setup", locale)("setup_runtime_path_invalid"), translator("setup", locale)("setup_runtime_path_invalid_fix"));
      return { status: 200, json: { schemaVersion: 1, status: "OK", ...(await testRuntime(p, locale)) } };
    },
  },
  {
    // "Fechar o assistente": only once the project has its configuration (nothing is left half done).
    method: "POST",
    path: "/api/setup/close",
    body: { type: "object", properties: { locale: LOCALE }, additionalProperties: false },
    handler({ body, server }) {
      const locale = localeOf((body as { locale?: string }).locale);
      guard(server, locale);
      if (!configured(server)) throw new HttpError(409, "NOT_CONFIGURED", translator("setup", locale)("setup_not_configured"), null);
      return { status: 200, json: view(server, writeState(server, { ...current(server), completed: true })) };
    },
  },
];
