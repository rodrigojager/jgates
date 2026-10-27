import type { Disabled, Decision, StageResult, StageState } from "../contract/index.js";
import type { CacheSubject } from "../cache/index.js";
import type { RunStep } from "../runner/executor.js";
import type { Provenance, SemanticPromptsProvenance } from "../provenance/index.js";
import type { AnalyzedState } from "./analysis.js";

/** A step that can be served from the cache of results: it says what its result depends on. */
export type CacheableStep = RunStep & { cacheSubject?: CacheSubject };

export type StageKind = "composite" | "subcheck" | "evidence" | "step";

/** Why a stage never ran: a prerequisite was absent, a step it depends on failed, --fail-fast or a cancellation. */
export type NotRunCause = "preflight" | "dependency" | "fail-fast" | "cancelled";

/** How the step that produced a stage was executed ($defs.execution). */
export interface StageExecution {
  /** Executor step the stage belongs to (one step per invocation of the plan). */
  step: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** Facts of the last process of the step. */
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  cancelled?: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
  logTruncated?: boolean;
  /** Number of processes the step started. */
  processes?: number;
  notRun?: { cause: NotRunCause; detail: string; steps?: string[]; problems?: Array<{ code: string; message: string }> };
}

/** Whether the stage was run or served from the cache of results, and why ($defs.stageCache). */
export interface StageCacheInfo {
  /** reused: served from a previous run; executed: ran and may be reused next time; uncacheable: never reused, see code and reason. */
  status: "reused" | "executed" | "uncacheable";
  /** reused: the run that produced the result and when it was stored. */
  runId?: string;
  at?: string;
  key?: string;
  /** uncacheable: why the inputs are not demonstrable. */
  code?: string;
  reason?: string;
}

/** Stage as written in result.json (schemas/result/result.schema.json, $defs.stage). */
export interface ResultStage extends StageResult {
  label?: string;
  kind?: StageKind;
  /** Composite stage this one belongs to. */
  parentId?: string;
  adapter?: string;
  /** Status in the tool's own vocabulary, for traceability. */
  nativeStatus?: string;
  /** Number of findings attributed to this stage. */
  findings?: number;
  execution?: StageExecution;
  cache?: StageCacheInfo;
  /** What the analysis read besides the code, as the tool reports it (the vulnerability database of a scanner). */
  analysisInput?: StageAnalysisInput;
}

/** $defs.stage.analysisInput: the vulnerability database a scanner used (source, date when the tool says it). */
export interface StageAnalysisInput {
  database?: {
    source: string;
    updatedAt: string | null;
    nextUpdate?: string | null;
    downloadedAt?: string | null;
    /** false: the tool does not report the date of its data; only the source is known. */
    reported: boolean;
    networkRequired: boolean;
  };
}

export type NormalizedSeverity = "critical" | "high" | "medium" | "low" | "info" | "unknown";
export type BlockingReason = "critical" | "blocking-category" | "blocking-tool" | "score-below-threshold" | "legacy-verdict";

/** Finding as written in result.json ($defs.finding). Never carries raw evidence. */
export interface ResultFinding {
  stageId: string;
  tool: string;
  toolVersion?: string;
  ruleId: string;
  category?: string;
  severity: string;
  normalizedSeverity: NormalizedSeverity;
  message: string;
  location?: { path: string; line?: number; column?: number };
  fingerprint?: string;
  origin?: string;
  blocking: boolean;
  blockingReason?: BlockingReason;
  waived: boolean;
  waiverReason?: string;
  /** Fingerprint the tool or the sidecar gave (kept so old waiver files still match). */
  nativeFingerprint?: string;
  fingerprintVersion?: number;
  /** Masked evidence, never the raw value. */
  evidence?: string;
  remediation?: string;
  docsUrl?: string;
  waiverId?: string;
  /** Against the baseline run: new or kept. */
  baselineState?: "new" | "unchanged";
}

export interface ResultMetric {
  id: string;
  label?: string;
  unit: "percent" | "count" | "bytes" | "ms" | "ratio" | "lines";
  /** Absent only when `measured` is false: a metric that was not measured has no value (never 0). */
  value?: number;
  /** false: the tool could not measure it (no report, plugin missing); `reason` says why and there is no value. */
  measured?: boolean;
  reason?: string;
  numerator?: number;
  denominator?: number;
  component?: string;
  /** What the numbers count: "lines", "lines+branches"... */
  basis?: string;
  /** What was left out of the measurement (excluded lines, omitted paths, the measured source). */
  exclusions?: string[];
  /** Format of the report the numbers came from. */
  format?: string;
  scope: string;
  origin: string;
  scoreAppliesTo?: "changed-files" | "entire-project" | "selected-paths";
}

export interface BaselineComparison {
  runId: string;
  comparable: boolean;
  warnings: Array<{ code: string; message: string }>;
  new: number;
  kept: number;
  resolved: Array<{ fingerprint: string; ruleId: string; tool?: string; path?: string }>;
}

export interface ResultRequirement {
  id: string;
  required: boolean;
  reason?: string;
}

export interface ResultDisabled extends Disabled {
  reason?: string;
}

/** What the dependency extractor of an architecture check could see (result.architecture): coverage, never silence. */
export interface ArchitectureCoverageRecord {
  /** Adapter that extracted the graph. */
  tool: string;
  status: "complete" | "partial" | "empty";
  /** true only when the graph is complete: then the absence of findings is the absence of violations. */
  verified: boolean;
  nodes: number;
  edges: number;
  /** Dependencies the extractor saw but could not resolve to a node. */
  unresolved: number;
  unresolvedSample: Array<{ from: string; specifier: string; reason?: string }>;
  reason?: string;
}

/** What an adapter hands back to the run. */
export interface AdapterOutput {
  stages: ResultStage[];
  requirements: ResultRequirement[];
  disabled: ResultDisabled[];
  findings: ResultFinding[];
  /** Measurements of the adapter (tests that ran, coverage with its denominator); they land in result.metrics. */
  metrics?: ResultMetric[];
  /** Coverage of the dependency graph an architecture check judged. */
  architecture?: ArchitectureCoverageRecord[];
  /** Paths relative to the run folder. */
  logs: string[];
  outputs: string[];
}

export interface AdapterContext {
  workspacePath: string;
  runDir: string;
  logsDir: string;
  outputsDir: string;
  env: NodeJS.ProcessEnv;
  /** Aborted when the run is cancelled; runSpec already follows it through the execution scope. */
  signal?: AbortSignal;
}

export interface WorkspaceChanges {
  checked: boolean;
  truncated?: boolean;
  added: string[];
  modified: string[];
  removed: string[];
  /** The same files with the step that left them, when known (absent when the manifest was truncated). */
  entries?: WorkspaceChangeEntry[];
}

/** `git status` of the workspace: tracked changes (porcelain XY code) and untracked files that are not ignored. */
export interface GitStatusRecord {
  tracked: Array<{ path: string; status: string }>;
  untracked: string[];
  truncated: boolean;
}

export interface WorkspaceGitStatus {
  /** The workspace is a Git work tree; when false both records are null. */
  repository: boolean;
  before: GitStatusRecord | null;
  after: GitStatusRecord | null;
  /** The status after the run differs from the status before it. */
  changed: boolean;
}

export interface WorkspaceChangeEntry {
  path: string;
  change: "added" | "modified" | "removed";
  /** Id of the step after which the change was first seen; null when it cannot be told. */
  stage: string | null;
}

/** The result document (one per run): result.json and the --json stdout. */
/** The semantic review of a run (schemas/result $.semantic). It never feeds the decision. */
export interface ResultSemantic {
  requested: true;
  /** blocked: masking.onMatch is block and the masking found something; nothing was sent. */
  state: "completed" | "not-configured" | "unavailable" | "timeout" | "budget-exhausted" | "blocked";
  separateFromDecision: true;
  provider: string | null;
  model: string | null;
  scope: string | null;
  limits: { timeoutSeconds: number; maxContextChars: number; maxCalls: number } | null;
  cost: { reported: boolean; perCall: number | null; total: number | null };
  calls: number;
  durationMs?: number;
  reason?: string;
  /** Why nothing was sent, when the masking decided it: MASKING_COMMAND_FAILED, MASKING_UNRESOLVED or MASKING_BLOCKED. */
  code?: string;
  context?: Record<string, unknown>;
  conclusion?: Record<string, unknown>;
  /** The prompts in effect (sha256 of each and of both); copied by the run into $.provenance.semanticPrompts. */
  prompts?: SemanticPromptsProvenance;
  /**
   * The provider fields in effect, each with where it came from: the project (jgates.yml), the user's preferences
   * (a provider's preference or a named connection; never read by jgates ci) or the provider's default.
   */
  effective?: SemanticEffective;
}

export interface SemanticFieldValue {
  value: string | null;
  origin: "project" | "user" | "default" | "unset";
}

export interface SemanticEffective {
  provider: string;
  kind: "provider" | "connection" | "other" | "unknown";
  preferences: "used" | "ignored";
  baseUrl: SemanticFieldValue;
  model: SemanticFieldValue;
  apiKeyEnv: SemanticFieldValue;
  /** Names of the extra headers of a connection (never a credential). */
  headers: string[];
  allowInsecureHttp: boolean;
}

/** Runs the review after the decision is computed; whatever it returns or throws, the decision stays. */
export type SemanticHook = (context: { workspacePath: string; runDir: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }) => Promise<ResultSemantic>;

/** The CI policy a governed run (`jgates ci`) used ($.policy): the bundle hash, its files and where it came from. */
export interface ResultPolicy {
  /** sha256 of the canonical manifest of the bundle (the value JGATES_POLICY_SHA256 must hold). */
  sha256: string;
  /** The bundle files, policy-relative with "/", in manifest order. */
  files: Array<{ path: string; sha256: string; size: number }>;
  /** Absolute policy folder and how it was named (--policy or JGATES_POLICY_DIR). */
  source: { dir: string; from: "option" | "env" };
  /** The quality policy handed to the bridge: the policy's file, or the built-in default when the policy has none. */
  qualityPolicy: { file: string | null; sha256: string };
  /** execution.trustSelfReported of the policy: whether a self-reported stage may satisfy its requirement. */
  trustSelfReported?: boolean;
}

export interface RunResult {
  schemaVersion: 1;
  runId: string;
  tool: "jgates";
  version: string;
  startedAt: string;
  finishedAt: string;
  workspace: { id: string; path: string; name?: string };
  runDir: string;
  selection: {
    adapter: string;
    options: Record<string, string | number | boolean>;
    overrides: Array<{ id: string; reason: string }>;
    /** The plan this run executed. */
    planHash?: string;
    /** built: assembled for this run; file: received with --plan; options: assembled from the option flags (no jgates.yml). */
    planSource?: "built" | "file" | "options";
    profile?: string | null;
    scope?: string;
    request?: Record<string, unknown>;
    planOverrides?: Array<Record<string, unknown>>;
  };
  decision: Decision;
  complete: boolean;
  reduced: boolean;
  exitCode: number;
  summary?: string;
  requirements: ResultRequirement[];
  stages: ResultStage[];
  findings: ResultFinding[];
  metrics?: ResultMetric[];
  /** Coverage of the architecture graph (complete, partial or empty) with the dependencies left unresolved. */
  architecture?: ArchitectureCoverageRecord[];
  baseline?: BaselineComparison;
  /** Optional semantic review, apart from the decision; present only when the run asked for it. */
  semantic?: ResultSemantic;
  unsatisfied: Array<{ requirementId: string; state: StageState | "missing" }>;
  warnings: Array<{ stageId: string; state: StageState }>;
  blockingViolations: number;
  disabled: ResultDisabled[];
  workspaceChanges: WorkspaceChanges;
  /** Git status of the workspace before and after the run, next to the file manifest (absent while the run is going). */
  workspaceGit?: WorkspaceGitStatus;
  artifacts: { result: string; logs: string[]; outputs: string[]; plan?: string; events?: string };
  /**
   * true in the copies written while the run is still going. A result.json that stays partial belongs to a run whose
   * process died: its decision is never passed (fail-closed).
   */
  partial?: boolean;
  /** Why the run stopped before running everything (a cancellation or --fail-fast). */
  stopped?: { cause: "cancelled" | "fail-fast"; stepId?: string; detail: string };
  /** What the run analyzed: target, snapshot, Git state, input manifest, hashes, identity and what it approves. */
  analyzed?: AnalyzedState;
  provenance?: Provenance;
  /** Governed runs only: the CI policy the run was held to. */
  policy?: ResultPolicy;
}
