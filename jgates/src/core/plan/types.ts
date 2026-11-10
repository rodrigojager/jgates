import type { ReasonAction } from "../reasons/index.js";
import type { LayerName } from "../config/resolve/index.js";
import type { CheckCondition, LockInfo, SelectionDecision, SelectionIssue, SelectionReason } from "../selection/index.js";

/**
 * Reviewable plan.
 *
 * Planning reads the configuration, the discovery and the selection; it installs nothing, starts no scanner and
 * writes nothing in the workspace. Everything below `planHash`, `createdAt` and `changes` is the hashed body: the
 * same configuration, inventory, selection and versions always give the same hash.
 */

export const PLAN_SCHEMA_VERSION = 1;
export const PLAN_KIND = "jgates-plan";

export type PlanScopeKind = "changed" | "full" | "paths";
export const PLAN_SCOPES: readonly PlanScopeKind[] = ["changed", "full", "paths"];

/** Where the on/off state of an item came from; "run" is "only this run" (--skip, --only). */
export type StateOrigin = "defaults" | "template" | "profile" | "project" | "run" | "policy";

export type RequirementLevel = "required" | "conditional" | "optional";

export interface PlanRequest {
  profile: string | null;
  scope: PlanScopeKind;
  paths: string[];
  base: string | null;
  head: string | null;
  skip: string[];
  only: string[];
  templates: string[];
}

export interface PlanOrigin {
  kind: StateOrigin | "none";
  selector: string | null;
  layer: LayerName | null;
  source: string | null;
  file: string | null;
  path: string | null;
  pointer: string | null;
}

export interface Inclusion {
  /** template: an active template entry declared the tool; project: a project file did; adapter: the adapter's own default. */
  kind: "template" | "project" | "adapter";
  /** Template entry id (jgates.yml templates) for kind template. */
  entry: string | null;
  source: string;
  file: string | null;
  /** Activation reason of the template entry (ALWAYS, DETECTED, REQUESTED), or null. */
  reason: string | null;
  matched: string[];
}

export interface PlanComponentRef {
  id: string;
  root: string;
  language: string | null;
}

export interface PlanCommand {
  /** Shared by every item one process runs (the bridge runs once for all its subchecks). */
  invocation: string;
  executable: string;
  args: string[];
  /** "{runDir}" is the run folder, created by the runner outside the workspace. */
  cwd: string;
  env: Record<string, string>;
  /** JSON document written to stdin (the bridge request). */
  stdin: Record<string, unknown> | null;
  /**
   * Present when the instance runs on the container runner (tools.yml `runner: container`): executable and args are
   * then the command inside the image, with container paths (/workspace, /output); cwd stays the host folder.
   */
  container?: PlanContainer;
}

/** How the container runner starts the command: runtime, image by digest, network and the exact mounts. */
export interface PlanContainer {
  /** Container runtime client on the host (docker). */
  runtime: string;
  /** Image pinned by digest (name@sha256:... or sha256:...). */
  image: string;
  network: "none" | "bridge";
  /** Host folders ({workspace}, {runDir}/...) and where the container sees them; only the output is writable. */
  mounts: Array<{ source: string; target: string; readOnly: boolean }>;
}

export interface PlanItemState {
  enabled: boolean;
  origin: StateOrigin | null;
  /** Readable origin, for example "só esta execução". */
  originLabel: string;
  reason: SelectionReason | "ONLY_EXCLUDED";
  decision: SelectionDecision | null;
  overridden: SelectionDecision[];
  /** Decided by --skip or --only: valid only for this plan, nothing was written. */
  runOnly: boolean;
  locked: LockInfo[];
  /** "available": switched on only where available; with its tool missing it is off with reason NOT_AVAILABLE_HERE. */
  when?: CheckCondition;
}

export interface PlanItem {
  /** Stable id: <tool instance>#<capability>. */
  id: string;
  /** Semantic identity (what runs and how): equal items are deduplicated by it. */
  identity: string;
  tool: string;
  adapter: string | null;
  subcheck: string | null;
  label: string;
  category: string | null;
  capabilities: string[];
  components: PlanComponentRef[];
  languages: string[];
  granularity: "workspace" | "component";
  scope: { requested: PlanScopeKind; effective: PlanScopeKind; context: string[] };
  requirement: RequirementLevel;
  conditions: string[];
  limitations: string[];
  reason: { code: string; message: string };
  origin: PlanOrigin;
  includedBy: Inclusion[];
  state: PlanItemState;
  command: PlanCommand | null;
  runtime: { name: string; interpreter: string | null; available: boolean } | null;
  versions: { adapter: string | null; tool: string | null; toolVersion: string | null; rules: string | null };
  configFiles: Array<{ file: string; sha256: string | null }>;
  network: boolean;
  /** What the step container gets: `none` (`--network none`) unless the item declares network (`bridge`). */
  networkKind?: "none" | "bridge";
  /** Why: the declaration that grants network, or that none was declared. */
  networkReason?: string;
  effects: { readsCode: boolean; writesOutputs: boolean; mayChangeCode: boolean; executesProjectCode: boolean; workspaceWrites: string[] };
  limits: { timeoutSeconds: number };
  output: { format: string; schema: string | null };
  dependsOn: string[];
  availability: { status: "available" | "unavailable" | "not_executable"; reason: string | null };
  /**
   * Bridge only: what a "skipped" answer means, and whether the bridge process runs the subcheck at all. For a scanner
   * whose configuration file can be chosen (gitleaks, trivy, osv-scanner), effectiveCommand is the argv the sidecar
   * runs, with the chosen file (workspace-relative) or the package file ({sidecarConfig}/...), the run folder as
   * {runDir} and the workspace root as ".".
   */
  bridge: {
    skipMeans: "not_applicable" | "blocked";
    invoked: boolean;
    effectiveCommand?: { executable: string; args: string[]; cwd: string; config: { source: "project" | "package"; file: string } };
  } | null;
}

export type UncoveredReason = "DISABLED_FOR_RUN" | "NO_EXECUTABLE_CHECK" | "CHECKS_DISABLED" | "EVIDENCE_MISSING";

export interface PlanRequirement {
  selector: string;
  kind: "capability" | "lock";
  category: string | null;
  /** The decision that makes it a requirement (profile, template, project or policy), without this run's flags. */
  requiredBy: SelectionDecision | LockInfo | null;
  coveredBy: string[];
  /**
   * "available": the capability is on only where a check for it is available (a check entry with
   * `when: available`, for example in builtin:strict). Uncovered, it goes to groups.notApplicableRequirements and
   * never blocks. Absent: required, and uncovered it is an uncoveredRequirements entry that blocks (fail-closed).
   */
  when?: CheckCondition;
}

/**
 * Why a capability enabled "when available" has no check in this project (never a blocker):
 * - NO_TOOL: JGates has no adapter for the capability at all;
 * - NO_TOOL_FOR_LANGUAGES: adapters exist, none supports the languages of the project's components;
 * - SETUP_REQUIRED: an adapter applies but no instance of it is declared here (evidence files, template, target URL,
 *   OpenAPI file... see `adapters[].prerequisites` and `action`);
 * - TOOL_MISSING: an instance is declared and on, but its tool is not available on this machine (prepare it);
 * - CHECKS_DISABLED / DISABLED_FOR_RUN: the checks that would cover it are off (saved setting / --skip, --only);
 * - EVIDENCE_MISSING: the only check claiming it has no verifiable evidence contract (generic command).
 */
export type NotApplicableReason = "NO_TOOL" | "NO_TOOL_FOR_LANGUAGES" | "SETUP_REQUIRED" | "TOOL_MISSING" | "CHECKS_DISABLED" | "DISABLED_FOR_RUN" | "EVIDENCE_MISSING";

/** An adapter of JGates that covers the capability, and whether it can apply to this project's languages. */
export interface NotApplicableAdapter {
  /** Adapter id (ruff, mutation, zap...). */
  id: string;
  /** Display name of the adapter (manifest, not translated). */
  label: string;
  /** Languages the adapter is limited to; null: any language. */
  languages: string[] | null;
  /** True when it supports one of the project's languages (or any language). */
  applicable: boolean;
  /** What must exist outside JGates for it to run here (manifest text, English). */
  prerequisites: string[];
  /** Official setup (or acquisition) links. */
  docs: string[];
}

/**
 * The one action that would enable the check here, for the UI to offer as a control or a link:
 * - none: nothing to do in the project ("JGates has no tool for this stack yet");
 * - prepare-tool: prepare or install the tool of `tools` (instances) of `adapter` (prerequisites / doctor screens);
 * - add-files: add one of `files` so the built-in `template` activates (templateState "absent": also add the template
 *   to jgates.yml templates);
 * - add-template: add the built-in `template` (a "builtin:<id>" reference, templateState "absent") to the templates
 *   of jgates.yml, as `{ id: <id>, source: <template>, activation: detected }`; nothing else is needed from the
 *   project: the template needs no evidence file, or its evidence already exists (`files`: the ones found). The
 *   template brings the instance with sensible defaults; the next plan runs the check, or reports TOOL_MISSING with
 *   a prepare-tool action when the tool is not installed;
 * - configure-tool: declare or configure an instance of `adapter` in .jgates/tools.yml with the settings JGates cannot
 *   guess, named in `settings` (target: the URL of a running application; baseRef: the reference revision of the
 *   OpenAPI file...). `template` (with its templateState) is the built-in template that declares the instance, when
 *   one exists, and `files` the evidence it also needs (an OpenAPI file...). Without `settings`, declare an instance;
 * - enable-check: turn on the checks of `tools`, switched off by a saved setting or by this run's flags.
 * Unused fields are null or empty lists, so the shape is the same for every kind.
 */
export interface NotApplicableAction {
  kind: "none" | "prepare-tool" | "add-files" | "add-template" | "configure-tool" | "enable-check";
  adapter: string | null;
  tools: string[];
  template: string | null;
  templateState: "active" | "declared" | "absent" | null;
  files: string[];
  docs: string[];
  /**
   * configure-tool: the settings of the `adapter` instance (tools.<id>.<setting> in .jgates/tools.yml) that must be
   * set, for example ["target"] (schemathesis, zap) or ["baseRef"] (oasdiff; baseSpec is the file alternative).
   * Empty for the other kinds; absent in plans written before it existed, read it as [].
   */
  settings?: string[];
  /**
   * configure-tool on a declared instance (`tools`): after the settings are set, the tool itself must still be
   * prepared, because it is not available on this machine either (configure first, then prepare). Absent: false.
   */
  prepareNext?: boolean;
}

/**
 * A requirement enabled "when available" that no check covers in this project: shown apart from the uncovered
 * requirements, as "not applicable here", with the reason and the action. It never blocks the plan, never makes it
 * reduced and never counts against approval. JSON example (groups.notApplicableRequirements[i]):
 *
 * {
 *   "selector": "capability:mutation", "kind": "capability", "category": "tests",
 *   "requiredBy": { "selector": "capability:mutation", "value": true, "layer": "profile", "source": "builtin:strict", ..., "when": "available" },
 *   "coveredBy": [], "when": "available",
 *   "label": "Mutação", "reasonCode": "SETUP_REQUIRED",
 *   "message": "Ainda não se aplica a este projeto: Mutação é verificada por ... pelo template builtin:python-mutmut, que não está nos templates do jgates.yml. ...",
 *   "languages": ["python"],
 *   "adapters": [{ "id": "mutation", "label": "Mutation testing (Stryker, mutmut)", "languages": ["javascript", "typescript", "python"], "applicable": true, "prerequisites": ["mutmut 3.x ..."], "docs": ["https://..."] }],
 *   "candidates": [], "disabledBy": null,
 *   "action": { "kind": "add-template", "adapter": "mutation", "tools": [], "template": "builtin:python-mutmut", "templateState": "absent", "files": ["pyproject.toml"], "docs": ["https://..."], "settings": [] }
 * }
 */
export interface NotApplicableRequirement extends PlanRequirement {
  when: CheckCondition;
  /** Readable name of the capability in the current language (the selector for a non-capability). */
  label: string;
  reasonCode: NotApplicableReason;
  /** Human sentence in the current language: why not applicable here and what would enable it. */
  message: string;
  /** Languages of the project's approvable components that were considered. */
  languages: string[];
  /** JGates adapters covering the capability (empty for NO_TOOL). */
  adapters: NotApplicableAdapter[];
  /** Items that would cover it when on and available (disabled or with the tool missing). */
  candidates: string[];
  /** CHECKS_DISABLED / DISABLED_FOR_RUN: what turned the covering checks off. */
  disabledBy: SelectionDecision | null;
  action: NotApplicableAction;
}

export interface UncoveredRequirement extends PlanRequirement {
  reason: UncoveredReason;
  message: string;
  /** What turned the covering checks off (the strongest decision), when known. */
  disabledBy: SelectionDecision | null;
  runOnly: boolean;
  /** Items that would cover it when on. */
  candidates: string[];
}

export interface TemplateIncompatibility {
  code: "TEMPLATE_INCOMPATIBLE";
  template: string;
  source: string;
  activation: string;
  match: { languages: string[]; frameworks: string[] };
  components: Array<{ id: string; language: string | null; framework: string | null }>;
  message: string;
}

export interface SelectionOverride {
  source: "--skip" | "--only";
  /** null for what --only left out. */
  selector: string | null;
  value: boolean;
  /** Items whose state changed because of it, relative to the plan without the flags. */
  items: string[];
}

export interface PlanBlocker {
  code: string;
  message: string;
  items?: string[];
  /** The one action that clears the blocker (reasons catalogue), with its label in the language of the plan. */
  action?: ReasonAction;
  /** Raw engine text, for a "Details" fold; never the main text. */
  details?: string;
}

export interface PlanBody {
  schemaVersion: 1;
  kind: typeof PLAN_KIND;
  workspace: { path: string; id: string };
  versions: { jgates: string; detector: string; adapters: Record<string, string>; tools: Record<string, string | null> };
  profile: { id: string; label: string | null; chain: Array<{ id: string; file: string; path: string }> } | null;
  scope: { requested: PlanScopeKind; effective: PlanScopeKind; paths: string[]; base: string | null; head: string | null; note: string | null };
  selection: { request: PlanRequest; overrides: SelectionOverride[]; reduced: boolean };
  components: Array<{ id: string; root: string; language: string | null; framework: string | null; status: string; approvable: boolean; templates: string[] }>;
  templates: { active: Array<{ id: string; source: string; reason: string; matched: string[]; chain: string[]; support?: { level: string; uncovered: string[] } }>; inactive: Array<{ id: string; source: string; reason: string }> };
  incompatibilities: TemplateIncompatibility[];
  invocations: Array<{ id: string; adapter: string; command: PlanCommand; subchecks: string[]; runsAnyway: string[]; contract?: Record<string, unknown> }>;
  /**
   * willRun: items that run. notApplicableOrDisabled: items that do not (off, superseded, or on "when available" with
   * the tool missing: reason.code NOT_AVAILABLE_HERE, state.when "available"). uncoveredRequirements: required
   * capabilities without a check (blockers). notApplicableRequirements: capabilities on "when available" without a
   * check here (never blockers); absent in plans written before it existed, read it as [].
   */
  groups: { willRun: PlanItem[]; notApplicableOrDisabled: PlanItem[]; uncoveredRequirements: UncoveredRequirement[]; notApplicableRequirements?: NotApplicableRequirement[] };
  requirements: PlanRequirement[];
  network: { policy: string; required: boolean; items: string[] };
  /** The rules of .jgates/architecture.yml with their state and where it is decided; null without the file. */
  architecture?: PlanArchitecture | null;
  inputs: { configFiles: Array<{ file: string; sha256: string | null }>; inventoryHash: string; configHash: string; container?: ContainerInputs };
  approvable: boolean;
  blocked: PlanBlocker | null;
  blockers: PlanBlocker[];
  warnings: Array<{ code: string; message: string }>;
}

/**
 * What a container-first run depends on besides the files: the tools image, the extension images, the dependency
 * volumes' keys, the advisory data and the compose services selected. Part of the plan hash and recorded in the
 * provenance of every result (present only when container-first checks are on).
 */
export interface ContainerInputs {
  /** Content digest (image id) of the tools image; null when the engine did not have it. */
  toolsImage: string | null;
  extensionImages: Array<{ name: string; digest: string }>;
  /** Dependency key per component (hash of lockfiles + interpreter version + image digest). */
  dependencyKeys: Record<string, string>;
  /** Last update time (ISO 8601) per advisory database; null when never updated. */
  dataTimestamps: Record<string, string | null>;
  /** Names of the compose services the plan selected. */
  services: string[];
}

export interface PlanChanges {
  previousHash: string;
  previousCreatedAt: string | null;
  same: boolean;
  profile: { from: string | null; to: string | null } | null;
  items: {
    added: string[];
    removed: string[];
    changed: Array<{ id: string; fields: Array<{ field: string; from: unknown; to: unknown }> }>;
  };
  configFiles: { added: string[]; removed: string[]; changed: string[] };
  versions: Array<{ field: string; from: unknown; to: unknown }>;
  network: { from: boolean; to: boolean } | null;
}

export interface PlanArchitectureRule {
  id: string;
  kind: string;
  enabled: boolean;
  blocking: boolean;
  owner: string;
  origin: { file: string; path: string };
}

export interface PlanArchitecture {
  file: string;
  rules: PlanArchitectureRule[];
}

export interface Plan extends PlanBody {
  planHash: string;
  createdAt: string;
  /** Difference from the previous plan of the workspace (not part of the hash); null when there is none. */
  changes: PlanChanges | null;
}

export interface BuildPlanOptions {
  profile?: string;
  scope?: PlanScopeKind;
  paths?: string[];
  base?: string;
  head?: string;
  skip?: string[];
  only?: string[];
  /** Template entries with activation manual (or detected) that this plan forces on. */
  templates?: string[];
  /** JGates version (defaults to the package version). */
  version?: string;
  env?: NodeJS.ProcessEnv;
  /** JGates data folder; the previous plan is read from it. Defaults to resolveHome(env). */
  home?: string;
  /** Compare with the previous plan of the workspace (default true). */
  compare?: boolean;
  now?: Date;
  /**
   * Folder whose jgates.yml and .jgates/ are used instead of the workspace's own configuration (a CI policy): the
   * workspace gives only the files to analyze. Configuration files of the plan are then relative to this folder.
   */
  configDir?: string;
  /**
   * Governed (CI) bridge: the bridge runs in its complete mode with this quality policy (a file path, `{runDir}` allowed,
   * and its sha256), so the analyzed project's own quality policy file is never read.
   */
  bridgePolicy?: { file: string; sha256: string };
  /** Container-first inputs the planning does not read itself yet (extension images, dependency keys, data timestamps, services); the tools image is read from the engine. */
  container?: Partial<ContainerInputs>;
}

export interface PlanError {
  code: string;
  message: string;
  fix?: string | null;
}

export type BuildPlanResult =
  | { ok: true; plan: Plan }
  | { ok: false; error: PlanError; errors: Array<PlanError | SelectionIssue>; diagnostics: unknown[] };
