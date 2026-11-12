// The first-run wizard (PLAN-guided-ux.md section 3): six steps (Docker, Ferramentas, Projeto, Perfil, Dependências,
// Revisão) whose progress lives on the server, in the data folder of the workspace (never in the project), so closing the
// browser or restarting `jgates ui` resumes at the same step. The downloads run as the environment's preparation jobs
// and go on in the background while the person goes through the next steps; the dependencies chain after the image.
// Every check reads the machine fresh: a Docker installed while the page is open is seen at the next check.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BuiltinError } from "../../builtin/index.js";
import { patchYamlText, readRevision, YamlPatchError, type YamlEdit } from "../../core/codecs/yaml/index.js";
import { CONFIG_DIR, FRAGMENT_FILES, ROOT_FILE, parseYamlText, validateDocument } from "../../core/config/load/index.js";
import { discoverCompose } from "../../core/discovery/compose.js";
import { buildVocabulary, discoverWorkspace, loadWorkspaceSettings, WORKSPACE_FILE, type Classification, type DeclaredComponent } from "../../core/discovery/index.js";
import { installUnits } from "../../core/deps/index.js";
import { detectEngine, inspectImageSync } from "../../core/engine/index.js";
import { refreshPath } from "../../core/env-refresh/index.js";
import { workspaceDir } from "../../core/home/index.js";
import { DEFAULT_PROFILE, STARTER_PROFILES, existingConfigFiles, planInit, writeInit } from "../../core/init/index.js";
import { collectStatus, diskRequirement, engineContextOf, engineReason, type LifecycleReason } from "../../core/lifecycle/index.js";
import { buildPlan, type Plan } from "../../core/plan/index.js";
import { cachedProject, projectInventory } from "../../core/cache/project.js";
import { discoverFor } from "../../core/config/resolve/index.js";
import { withEngineFacts } from "../../core/engine/facts.js";
import { stepMode } from "../../core/runner/in-image.js";
import { readToolsImagePin, toolsImageTarget } from "../../core/tools-image/index.js";
import { getLocale, normalizeLocale, translator } from "../../i18n/index.js";
import { HttpError, refuse } from "../http.js";
import { jobView } from "../runs.js";
import type { RouteDefinition, ServerContext } from "../types.js";
import { environmentJob, runningEnvironmentJob, startEnvironmentJob, type EnvironmentJobView } from "./environment.js";
import { PLAN_HASH_PATTERN, findPlan } from "./plans.js";

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
  startedAt: string;
  updatedAt: string;
}

const LOCALE = { type: "string", enum: ["en", "pt-BR"] };
const LOCALE_QUERY = { type: "object", properties: { locale: LOCALE }, additionalProperties: false };
const STEP = { type: "string", enum: [...SETUP_STEPS] };
const NAME = { type: "string", minLength: 1, maxLength: 60, pattern: "^[A-Za-z0-9][A-Za-z0-9._+#-]*$" };

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
  return state !== null && !state.completed;
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

async function engineCheck(locale?: string): Promise<Record<string, unknown>> {
  refreshPath({ force: true });
  if (stepMode(process.env) === "in-image") return { ready: true, state: "ready", mode: "in-image", facts: null, reasons: [], command: "jgates setup" };
  const detection = await detectEngine({ requiredDiskMb: 0 }, engineContextOf(process.env));
  const reason = engineReason(detection, locale);
  const state = reason === null ? "ready" : reason.code === "ENGINE_NOT_INSTALLED" ? "not-installed" : reason.code === "ENGINE_STOPPED" ? "stopped" : reason.code === "ENGINE_LOW_MEMORY" ? "low-memory" : "unsupported";
  const { serverVersion, os: engineOs, arch, memoryMb, cpus } = detection.facts;
  // Too little memory does not stop the first steps: the plan says which checks need more.
  const ready = reason === null || reason.code === "ENGINE_LOW_MEMORY";
  return { ready, state, mode: "container", facts: { serverVersion, os: engineOs, arch, memoryMb, cpus }, reasons: reason ? [reason] : [], command: "jgates setup" };
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

const component = (c: Classification) => ({
  id: c.id,
  root: c.componentRoot,
  status: c.classificationStatus,
  reasonCode: c.reasonCode,
  language: c.language,
  framework: c.framework,
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

function projectInfo(server: ServerContext, state: SetupState): Record<string, unknown> {
  const inventory = projectInventory(server.projectDir);
  const shown = inventory.classifications.filter((c) => c.classificationStatus !== "ignored");
  // The ambiguous ones first: they are the ones that need the person.
  const ordered = [...shown.filter((c) => c.classificationStatus === "ambiguous" || c.dependencies?.state === "ambiguous"), ...shown.filter((c) => !(c.classificationStatus === "ambiguous" || c.dependencies?.state === "ambiguous"))];
  const compose = discoverCompose(server.projectDir);
  const existing = configured(server) ? servicesOfConfig(server) : null;
  return {
    schemaVersion: 1,
    status: "OK",
    components: ordered.map(component),
    vocabulary: buildVocabulary().languages,
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

// ---- step 4: the profile and the configuration ----------------------------------------------------------------------

interface ConfigFile {
  file: string;
  exists: boolean;
  before: string | null;
  text: string;
}

/** The files step 4 writes: new ones as `jgates init` writes them, or the profile (and services) patched into jgates.yml. */
function configFiles(server: ServerContext, profile: string, services: SetupState["choices"]["services"]): { files: ConfigFile[]; hash: string | null } {
  const rootAbs = path.join(server.projectDir, ROOT_FILE);
  const root = readRevision(rootAbs);
  if (root.exists) {
    const edits: YamlEdit[] = [{ op: "set", path: ["selection", "profile"], value: profile }];
    if (services?.use && services.compose.length > 0 && !servicesOfConfig(server)) edits.push({ op: "set", path: ["services", "compose"], value: services.compose });
    if (services && !services.use && servicesOfConfig(server)) edits.push({ op: "delete", path: ["services"] });
    const text = patchYamlText(root.text, edits).text;
    return { files: [{ file: ROOT_FILE, exists: true, before: root.text, text }], hash: root.hash };
  }
  const plan = planInit(server.projectDir, profile);
  const files = plan.files.map((f) => {
    let text = f.text;
    if (f.file === ROOT_FILE && services?.use && services.compose.length > 0) text = patchYamlText(text, [{ op: "set", path: ["services", "compose"], value: services.compose }]).text;
    const exists = fs.existsSync(path.join(server.projectDir, f.file));
    return { file: f.file, exists, before: exists ? fs.readFileSync(path.join(server.projectDir, f.file), "utf8") : null, text };
  });
  return { files, hash: null };
}

function writeConfig(server: ServerContext, profile: string, services: SetupState["choices"]["services"], locale?: string): string[] {
  const t = translator("setup", locale);
  const { files, hash } = configFiles(server, profile, services);
  const root = files.find((f) => f.file === ROOT_FILE);
  if (root) assertValid("root", root.text, ROOT_FILE, locale);
  if (hash !== null) {
    writeChecked(path.join(server.projectDir, ROOT_FILE), hash, (root as ConfigFile).text, locale);
    return [ROOT_FILE];
  }
  // A new configuration: the same files as `jgates init`, never over a file that exists.
  const clash = existingConfigFiles(server.projectDir).filter((f) => files.some((x) => x.file === f));
  if (clash.length > 0) throw new HttpError(409, "CONFIG_EXISTS", t("setup_config_exists", { files: clash.join(", ") }), t("setup_config_exists_fix"));
  try {
    return writeInit(server.projectDir, { profile, templates: [], components: [], files: files.map((f) => ({ file: f.file, text: f.text })) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, "CONFIG_EXISTS", t("setup_config_exists", { files: ROOT_FILE }), t("setup_config_exists_fix"));
    throw error;
  }
}

type ProfileCount = { id: string; unit: "steps"; total: number; categories: Array<{ id: string; count: number }>; error: string | null };

/**
 * "O que roda" of each starter profile, in one pass: one discovery for the three plans, kept in the project cache until
 * the project's files change (core/cache/project.ts). Runs inside withEngineFacts: the plans read the engine from its
 * cached facts.
 */
function profileCounts(server: ServerContext): ProfileCount[] {
  return cachedProject(`setup-profiles:${getLocale()}`, [server.projectDir], () => computeProfileCounts(server));
}

/** The items of the real plan by category (a plan of a temporary copy of the configuration when there is none yet). */
function computeProfileCounts(server: ServerContext): ProfileCount[] {
  let configDir: string | undefined;
  let temp: string | null = null;
  if (!configured(server)) {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-setup-plan-"));
    const fragments = path.join(server.projectDir, CONFIG_DIR);
    if (fs.existsSync(fragments)) fs.cpSync(fragments, path.join(temp, CONFIG_DIR), { recursive: true });
    for (const f of planInit(server.projectDir, DEFAULT_PROFILE).files) {
      fs.mkdirSync(path.dirname(path.join(temp, f.file)), { recursive: true });
      fs.writeFileSync(path.join(temp, f.file), f.text, "utf8");
    }
    configDir = temp;
  }
  try {
    // One discovery for the three plans (the temporary configuration has the project's own discovery settings).
    const inventory = configDir ? discoverFor(server.projectDir, configDir) : projectInventory(server.projectDir);
    return STARTER_PROFILES.map((id) => {
      let result;
      try {
        result = buildPlan(server.projectDir, { profile: id, compare: false, home: server.home, version: server.version, inventory, ...(configDir ? { configDir } : {}) });
      } catch (error) {
        if (error instanceof BuiltinError) return { id, unit: "steps", total: 0, categories: [], error: error.message };
        throw error;
      }
      if (!result.ok) return { id, unit: "steps", total: 0, categories: [], error: result.error.message };
      const counts = new Map<string, number>();
      for (const item of result.plan.groups.willRun) counts.set(item.category ?? "custom", (counts.get(item.category ?? "custom") ?? 0) + 1);
      return { id, unit: "steps", total: result.plan.groups.willRun.length, categories: [...counts].map(([category, count]) => ({ id: category, count })), error: null };
    });
  } finally {
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  }
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

function dependencyUnits(server: ServerContext): Array<Record<string, unknown>> {
  const inventory = projectInventory(server.projectDir);
  const { units } = installUnits(inventory.classifications.filter((c) => c.approvable));
  return units.map((u) => ({
    unit: u.id,
    components: u.components,
    installRoot: u.installRoot,
    ecosystem: u.info.ecosystem,
    manager: u.info.manager,
    lockfile: u.info.lockfile,
    languageVersion: u.info.language.version,
    languageVersionSource: u.info.language.source,
    note: u.info.note,
  }));
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
        profile: { enum: [...STARTER_PROFILES] },
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
        const check = await engineCheck(locale);
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
        const profile = b.profile ?? (configured(server) ? selectedProfile(server) : null);
        if (!profile) throw new HttpError(422, "PROFILE_REQUIRED", t("setup_profile_required"), null);
        if (b.profile) written.push(...writeConfig(server, profile, state.choices.services, locale));
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
      return { status: 200, json: { schemaVersion: 1, status: "OK", ...(await engineCheck(localeOf(query.locale))) } };
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
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          mode: status.mode,
          image: { state: status.image.state, reference: status.image.reference, version: status.image.version, sizeBytes: pin.sizeBytes },
          disk: { freeMb: status.disk.freeMb, requiredMb: need.totalMb },
          data: { state: status.data.state, databases: status.data.databases },
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
    handler({ server }) {
      guard(server);
      return { status: 200, json: projectInfo(server, current(server)) };
    },
  },
  {
    // Step 4: the starter profiles with what each one runs in this project, by category, and the recommended one.
    method: "GET",
    path: "/api/setup/profiles",
    timeoutMs: 120_000,
    async handler({ server }) {
      guard(server);
      // The image and the plans read the engine from its cached facts, never with a blocking call.
      const { ready, profiles } = await withEngineFacts(() => ({ ready: imageReady(), profiles: profileCounts(server) }), { prime: { version: server.version } });
      const selected = configured(server) ? selectedProfile(server) : null;
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: "OK",
          // Rigoroso when the tools are there (everything it asks for can run); the default profile otherwise.
          recommended: ready ? "strict" : DEFAULT_PROFILE,
          selected,
          toolsReady: ready,
          profiles,
          command: "jgates init --profile <perfil>",
        },
      };
    },
  },
  {
    // Step 4: the files the chosen profile would write, before anything is written.
    method: "POST",
    path: "/api/setup/config/preview",
    body: { type: "object", properties: { profile: { enum: [...STARTER_PROFILES] } }, required: ["profile"], additionalProperties: false },
    handler({ body, server }) {
      guard(server);
      const { files } = configFiles(server, (body as { profile: string }).profile, current(server).choices.services);
      return { status: 200, json: { schemaVersion: 1, status: "OK", files } };
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
      const units = dependencyUnits(server);
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
    body: { type: "object", additionalProperties: false },
    handler({ server }) {
      guard(server);
      const state = readState(server) ?? freshState();
      return { status: 200, json: view(server, writeState(server, { ...state, completed: false, step: "docker", run: null })) };
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
