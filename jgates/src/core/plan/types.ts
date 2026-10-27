import type { LayerName } from "../config/resolve/index.js";
import type { LockInfo, SelectionDecision, SelectionIssue, SelectionReason } from "../selection/index.js";

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
  groups: { willRun: PlanItem[]; notApplicableOrDisabled: PlanItem[]; uncoveredRequirements: UncoveredRequirement[] };
  requirements: PlanRequirement[];
  network: { policy: string; required: boolean; items: string[] };
  /** The rules of .jgates/architecture.yml with their state and where it is decided; null without the file. */
  architecture?: PlanArchitecture | null;
  inputs: { configFiles: Array<{ file: string; sha256: string | null }>; inventoryHash: string; configHash: string };
  approvable: boolean;
  blocked: PlanBlocker | null;
  blockers: PlanBlocker[];
  warnings: Array<{ code: string; message: string }>;
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
}

export interface PlanError {
  code: string;
  message: string;
  fix?: string | null;
}

export type BuildPlanResult =
  | { ok: true; plan: Plan }
  | { ok: false; error: PlanError; errors: Array<PlanError | SelectionIssue>; diagnostics: unknown[] };
