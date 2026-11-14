// Client of the first-run wizard routes (src/server/routes/setup.ts). The state lives on the server: every answer
// carries the whole view, so the screen never keeps its own copy of the step.
import { api } from "../../api";
import type { EnvironmentReason } from "../../api/environment";
import { getLocale } from "../../i18n";
import type { MascotSnapshot } from "../../../../src/core/mascots/index";

export const STEPS = ["docker", "tools", "project", "profile", "dependencies", "review"] as const;
export type StepId = (typeof STEPS)[number];

export interface JobRef {
  id: string;
  kind?: string;
  state: "running" | "done" | "failed" | "unknown";
  known: boolean;
}

export interface SetupView {
  open: boolean;
  started: boolean;
  /** Opened again on purpose (#/setup) once the project had its configuration: the overview stays the overview. */
  reopened?: boolean;
  configured: boolean;
  setup: {
    step: StepId;
    completed: boolean;
    steps: Array<{ id: StepId; index: number; state: "done" | "skipped" | "current" | "pending"; reachable: boolean }>;
    choices: { components: Array<{ id: string; language?: string; framework?: string; manager?: string }>; services: { use: boolean; compose: string[] } | null; profile: string | null };
    jobs: { pull: JobRef | null; data: JobRef | null; dependencies: JobRef | null };
    dependencies: "idle" | "queued" | "started" | "skipped";
    run: string | null;
  };
}

export interface Reason extends EnvironmentReason {
  recipe?: { id: string; available: boolean; commands?: string[]; reason?: string; sudo?: boolean };
}

export interface Requirement {
  id: "engine" | "memory" | "disk" | "cpus";
  state: "ok" | "warn" | "error" | "unknown";
  blocking: boolean;
  value: number | string | null;
  need: number | null;
  unit: "mb" | "count" | null;
  message: string;
}

export type RuntimeId = "docker" | "podman" | "custom";

export interface RuntimeInfo {
  /** The executable in use. */
  current: string;
  selected: RuntimeId;
  /** The path of another executable, when that is the choice. */
  path: string | null;
  source: "env" | "preference" | "default";
  /** JGATES_CONTAINER_RUNTIME, when it is set: it wins over the choice. */
  envOverride: string | null;
  options: Array<{ id: RuntimeId; found: string | null }>;
}

export interface DockerCheck {
  ready: boolean;
  state: "ready" | "not-installed" | "stopped" | "low-memory" | "unsupported";
  mode: "container" | "in-image";
  facts: { serverVersion: string | null; os: string | null; arch: string | null; memoryMb: number | null; cpus: number | null; diskFreeMb?: number | null } | null;
  requirements: Requirement[];
  runtime: RuntimeInfo;
  reasons: Reason[];
  command: string;
}

export interface RuntimeTest {
  ok: boolean;
  version: string | null;
  message: string;
  details: string | null;
}

export interface ImageTool {
  name: string;
  version: string;
  license: string | null;
  purpose: string | null;
  purposeText: string | null;
}

export interface SecurityDatabase {
  id: string;
  name: string;
  source: string;
  sizeBytes: number;
  approximate: boolean;
  usedBy: string;
  state: "fresh" | "stale" | "missing";
  fetchedAt: string | null;
}

export interface ToolsInfo {
  mode: "container" | "in-image";
  image: { state: "ready" | "missing" | "version-mismatch" | "unknown"; name: string; reference: string; version: string | null; sizeBytes: number; downloadBytes: number; diskBytes: number; tools: ImageTool[] };
  totals: { downloadBytes: number; diskBytes: number; pendingDownloadBytes: number; pendingDiskBytes: number };
  disk: { freeMb: number | null; requiredMb: number; freeBytes: number | null };
  data: { state: "fresh" | "stale" | "missing"; volume: string; databases: SecurityDatabase[] };
  jobs: { pull: JobRef | null; data: JobRef | null };
  reasons: Reason[];
  command: string;
}

export type FieldState = "declared" | "detected" | "ambiguous" | "unknown" | "none" | "unsupported" | "found" | "missing";

export interface ProjectComponent {
  id: string;
  root: string;
  status: string;
  reasonCode: string;
  language: string | null;
  framework: string | null;
  /** "Projeto Python na pasta raiz". */
  sentence: string;
  fields: Record<"language" | "framework" | "manager" | "lockfile", { state: FieldState; reason: string | null }>;
  evidence: string[];
  dependencies: {
    ecosystem: string;
    state: string;
    manager: string | null;
    candidates: string[];
    lockfile: string | null;
    languageVersion: string | null;
    languageVersionSource: string | null;
    note: string | null;
  } | null;
}

export interface ProjectInfo {
  components: ProjectComponent[];
  vocabulary: Array<{ id: string; label: string; supported: boolean; frameworks: Array<{ id: string; label: string }>; managers: string[] }>;
  compose: { files: string[]; services: Array<{ name: string; image: string | null; role: string | null; hostEffects: string[] }> };
  servicesDefault: boolean;
  command: string;
}

export interface DraftProfile {
  id: string;
  ref: string;
  label: string | null;
  description: string | null;
  extends: string | null;
  /** One of the three starter profiles (Essencial, Equilibrado, Rigoroso). */
  starter: boolean;
  /** The count is in plan steps, the unit of the plan and of the review. */
  unit: "steps";
  total: number;
  categories: Array<{ id: string; count: number }>;
  error: string | null;
}

/** Step 4: the profiles of the wizard's draft (ADR-0008), the selected one's plan and the mascots. */
export interface ProfilesInfo {
  recommended: string;
  selected: string | null;
  toolsReady: boolean;
  profiles: DraftProfile[];
  plan: ({ profile: { id: string } } & Record<string, unknown>) | null;
  mascots: MascotSnapshot | null;
  error: { code: string; message: string; fix: string | null } | null;
  categoryOrder: string[];
  draft: { mode: "new" | "existing"; edited: boolean; chosen: boolean };
}

/** One profile of the draft as Configuração > Perfil reads it (categories, selectors, universe, editable). */
export type DraftProfileView = Record<string, any> & { profile: { ref: string; id: string; editable: boolean }; categories: any[]; selectors?: any[]; universe: { components: string[]; tools: string[] } };

export interface DependencyUnit {
  unit: string;
  components: string[];
  installRoot: string;
  ecosystem: string;
  manager: string | null;
  lockfile: string | null;
  languageVersion: string | null;
  languageVersionSource: string | null;
  note: string | null;
  state: string;
  /** What the preparation installs: from the lockfile (frozen) or from the manifest, the files and the commands. */
  install: { mode: "frozen" | "manifest"; files: string[]; commands: string[] } | null;
  /** Why this unit cannot be prepared, when it cannot. */
  blocked: string | null;
  /** Where it goes: the unit's volume (its name once prepared), mounted at `target` in the checks; never the project. */
  volume: { name: string | null; prefix: string; target: string | null };
  /** The network the install uses: the package registry, only while installing. */
  network: { kind: "bridge"; registry: string | null; private: boolean };
}

export interface DependenciesInfo {
  units: DependencyUnit[];
  imageReady: boolean;
  dependencies: SetupView["setup"]["dependencies"];
  jobs: { pull: JobRef | null; dependencies: JobRef | null };
}

const locale = (): string => getLocale();
const q = (): string => `?locale=${encodeURIComponent(locale())}`;

export const fetchSetup = (): Promise<SetupView> => api<SetupView>("GET", "/api/setup");
export const gotoStep = (step: StepId): Promise<SetupView> => api<SetupView>("PUT", "/api/setup", { step, locale: locale() });
export const advance = (step: StepId, payload: Record<string, unknown> = {}): Promise<SetupView & { written: string[]; run?: { id: string } }> =>
  api("POST", "/api/setup/advance", { step, locale: locale(), ...payload });
export const fetchDocker = (): Promise<DockerCheck> => api<DockerCheck>("GET", `/api/setup/docker${q()}`);
export const saveRuntime = (runtime: RuntimeId, path?: string): Promise<{ runtime: RuntimeInfo }> => api("PUT", "/api/setup/runtime", { runtime, ...(path ? { path } : {}), locale: locale() });
export const testRuntime = (path: string): Promise<RuntimeTest> => api<RuntimeTest>("POST", "/api/setup/runtime/test", { path, locale: locale() });
export const fetchTools = (): Promise<ToolsInfo> => api<ToolsInfo>("GET", `/api/setup/tools${q()}`);
export const startDownloads = (): Promise<SetupView> => api<SetupView>("POST", "/api/setup/downloads", { locale: locale() });
export const fetchProject = (): Promise<ProjectInfo> => api<ProjectInfo>("GET", `/api/setup/project${q()}`);
export const fetchProfiles = (): Promise<ProfilesInfo> => api<ProfilesInfo>("GET", "/api/setup/profiles");
export const fetchDraftProfile = (profile: string): Promise<DraftProfileView> => api<DraftProfileView>("GET", `/api/setup/profile?profile=${encodeURIComponent(profile)}`);
export const chooseDraftProfile = (profile: string): Promise<{ selected: string | null; view: DraftProfileView }> => api("PUT", "/api/setup/profile/choice", { profile });
export const writeDraftSelection = (profile: string, changes: Array<{ selector: string; enabled: boolean; when?: "available" | null }>): Promise<{ view: DraftProfileView }> =>
  api("PUT", "/api/setup/profile/selection", { profile, changes });
export const createDraftProfile = (body: { id: string; from: string; label?: string; description?: string }): Promise<{ id: string; view: DraftProfileView }> => api("POST", "/api/setup/profile", body);
export const discardDraft = (): Promise<{ selected: string | null }> => api("DELETE", "/api/setup/profile/draft");
export const previewConfig = (): Promise<{ mode: "new" | "existing"; files: Array<{ file: string; exists: boolean; before: string | null; text: string }> }> => api("POST", "/api/setup/config/preview", {});
export const fetchDependencies = (): Promise<DependenciesInfo> => api<DependenciesInfo>("GET", `/api/setup/dependencies${q()}`);
export const prepareDependencies = (): Promise<SetupView> => api<SetupView>("POST", "/api/setup/dependencies", { locale: locale() });
export const reopenSetup = (step: StepId = "docker"): Promise<SetupView> => api<SetupView>("POST", "/api/setup/reopen", { step, locale: locale() });
export const closeSetup = (): Promise<SetupView> => api<SetupView>("POST", "/api/setup/close", { locale: locale() });

export { formatSize as formatBytes } from "../../components/format";
