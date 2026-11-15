// Types of the bounded investigation executor. JGates owns the stages, the budgets, the lifecycle, the events, the
// artifacts and their validation; a backend (a provider tool loop or a wrapped agent CLI) only talks to the model
// inside those limits. A Semantic module is a list of stages, each a responsibility with its own fresh context(s).
import type { ScopeRunPreparation, SemanticRigor } from "../semantic-scope/index.js";

export type FindingSeverity = "blocking" | "important" | "suggestion" | "nit";
export const FINDING_SEVERITIES: readonly FindingSeverity[] = ["blocking", "important", "suggestion", "nit"];

export type Confirmation = "confirmed" | "needs-validation" | "rejected";
export const CONFIRMATIONS: readonly Confirmation[] = ["confirmed", "needs-validation", "rejected"];

/**
 * explore: discovery work (reconnaissance, hunting) spent from the share left after the validation reserve.
 * validate: required validation (refutation, verification) that may also spend the reserve set aside before hunting.
 */
export type StageRole = "explore" | "validate";

/** The artifact a context must end with; nothing a model says about its progress counts until its artifact validates. */
export type ArtifactContract =
  | { kind: "exploration" }
  | { kind: "verdict" }
  | {
      kind: "custom";
      /** The JSON shape shown to the model. */
      shape: string;
      validate(value: Record<string, unknown>, context: ArtifactCheckContext): ArtifactCheck;
      /**
       * Host work that follows a valid artifact and decides what it contributes (post-patch validation runs the
       * reproducer in containers here): it receives the accepted check and returns the check the executor applies.
       * Asynchronous, so the run's process keeps serving its timers and cancellation while it works; nothing a model
       * says is involved. A failure makes the artifact invalid.
       */
      settle?(check: ArtifactCheck, context: ArtifactCheckContext, signal: AbortSignal): Promise<ArtifactCheck>;
    };

export interface ArtifactCheckContext {
  /** Workspace-relative files this context actually saw (read, matched by a search, or given in its brief). */
  seen: ReadonlySet<string>;
  /** The candidate a per-candidate context examines. */
  candidate: Candidate | null;
  /** Whether a workspace-relative path may be read at all (the guard's answer, never recorded). */
  readable(path: string): boolean;
  /** Line count of a readable file (null when unknown). */
  lines(path: string): number | null;
  /** The accepted artifacts of the earlier one-context stages, by stage ID (absent in a direct validation call). */
  accepted?: Readonly<Record<string, Record<string, unknown>>>;
  /** The canonical ID of the context (lowercase, safe as an agent ID). */
  agentId?: string;
  /** Host facts of the run (absent in a direct validation call). */
  run?: ModuleRunFacts;
}

/** What the host gives a module about the run: its folder, its resolved scope and rigor, host-only reads. */
export interface ModuleRunFacts {
  runDir: string;
  scope: ScopeRunPreparation;
  rigor: SemanticRigor;
  /** Reads a readable workspace file for the host (null when it cannot be read); never sent to a model. */
  readFile(path: string): string | null;
  /** The inputs the module's applicability check established for this run (absent when the module has no check). */
  inputs?: Readonly<Record<string, unknown>> | undefined;
}

/** What a module's applicability check may look at before any context starts (host-only; nothing is sent). */
export interface ModuleApplicabilityInput {
  scope: ScopeRunPreparation;
  rigor: SemanticRigor;
  runDir: string;
  workspacePath: string;
  env: NodeJS.ProcessEnv;
  /** Workspace-relative files the run may read. */
  readableFiles(): string[];
  readable(path: string): boolean;
  /** Reads a readable workspace file for the host (masked like any read; null when it cannot be read). */
  readFile(path: string): string | null;
}

/**
 * The answer of an applicability check. applicable: the inputs the stages need (given back to brief, validation and
 * finalize) and an optional summary kept in the investigation record. Not applicable: the input that is missing and why;
 * no context starts, nothing is sent, and the outcome is unavailable (never favorable) with code METHOD_NOT_APPLICABLE.
 */
export type ModuleApplicability =
  | { applicable: true; inputs?: Record<string, unknown>; record?: Record<string, unknown> }
  | { applicable: false; code: string; missing: string; reason: string };

/**
 * The answer of a prerequisites check: null when the machine has what the run needs; a code with the missing input
 * (the method is not applicable); or narrowed inputs (the machine serves only part of them: the run goes on with those,
 * and `record` is added to the applicability record).
 */
export type ModulePrerequisites = { code: string; missing: string; reason: string } | { inputs: Record<string, unknown>; record?: Record<string, unknown> } | null;

/** A candidate a custom artifact contributes (the executor applies it like a reported one). */
export interface ArtifactCandidate {
  title: string;
  /** Workspace-relative. */
  path: string;
  line: number | null;
  severity: FindingSeverity;
  category: string;
  rationale: string;
  /** The module's structured record of the candidate (kept with the candidate, shown to its validators). */
  details?: Record<string, unknown>;
}

/** A verdict a custom per-candidate artifact contributes (the executor applies it like a built-in verdict). */
export interface ArtifactVerdict {
  confirmation: Confirmation;
  reason: string;
  evidence: Evidence[];
  /** The validator's corrected severity (applied by a deciding stage only). */
  severity?: FindingSeverity;
  /** The validator's corrected record (replaces the candidate's details when the verdict is applied). */
  details?: Record<string, unknown>;
  /** Verification stage: a material change that a further independent verification must settle before it applies. */
  disputes?: string;
}

export interface ArtifactCheck {
  ok: boolean;
  problems: string[];
  /** The accepted value (claims that failed their checks are dropped and listed in `problems`). */
  value?: Record<string, unknown>;
  /** Custom artifacts: candidates to add (their paths must be readable, their lines must exist). */
  candidates?: ArtifactCandidate[];
  /** Custom artifacts: workspace-relative files the context examined (only files it saw count). */
  examined?: string[];
  /** Custom artifacts: what the context could not examine. */
  gaps?: Array<{ path?: string; reason: string }>;
  /** Custom artifacts of a per-candidate stage: the verdict on the candidate. */
  verdict?: ArtifactVerdict;
}

export interface InvestigationStageSpec {
  id: string;
  label: string;
  role: StageRole;
  /** A required stage that does not finish leaves the investigation incomplete. */
  required: boolean;
  /** once: one context for the stage; per-candidate: one fresh context per open candidate (independent judgement). */
  contexts: "once" | "per-candidate";
  /** What this responsibility does (the stage part of the system prompt). */
  instructions: string;
  /** Offers the report_candidate tool (candidates may also be listed in an exploration artifact). */
  reportsCandidates?: boolean;
  artifact: ArtifactContract;
  /** Largest number of model turns of one context (rigor default when absent). */
  maxTurns?: number;
  /**
   * Fresh verification of decided records (per-candidate only): one fresh context per confirmed or needs-validation
   * candidate. A verdict equal to the record verifies it; a demotion of confirmed to needs-validation applies; any
   * other change (or a verdict that disputes it) leaves the candidate unresolved until a further verification.
   */
  verify?: boolean;
  /**
   * Per-candidate only. false: the stage prepares a later deciding stage instead of deciding (confirm-by-reproduction
   * writes and executes a reproducer per finding): a valid artifact without a verdict leaves its candidate open for the
   * next stage, and a verdict the artifact does carry (decided by the module's host work, never by the model alone)
   * applies. Absent or true: a valid artifact without a verdict leaves the candidate unresolved.
   */
  decides?: boolean;
}

/** What a module may add to the brief of one context (host-validated material of earlier stages, prior runs). */
export interface ModuleBriefInput {
  stage: InvestigationStageSpec;
  candidate: Candidate | null;
  accepted: Readonly<Record<string, Record<string, unknown>>>;
  candidates: readonly Candidate[];
  scope: ScopeRunPreparation;
  rigor: SemanticRigor;
  runDir: string;
  /** Whether a workspace-relative path may be read (the guard's answer, never recorded). */
  readable(path: string): boolean;
  /** Reads a readable workspace file for the host (null when it cannot be read); never sent to a model. */
  readFile(path: string): string | null;
  /** The inputs the module's applicability check established for this run. */
  inputs?: Readonly<Record<string, unknown>>;
}

export interface ModuleFinalizeInput {
  stages: ReadonlyArray<{ id: string; state: string; required: boolean; reason?: string; contexts: ReadonlyArray<{ label: string; agentId: string; candidate: string | null; status: string; accepted?: Record<string, unknown> }> }>;
  accepted: Readonly<Record<string, Record<string, unknown>>>;
  candidates: readonly Candidate[];
  scope: ScopeRunPreparation;
  rigor: SemanticRigor;
  runDir: string;
  budget: { limits: BudgetLimits; reserve: BudgetReserve; exhausted: { dimension: string; stage: string; message: string } | null };
  usage: { calls: number };
  /** Workspace-relative files the investigation read. */
  read: readonly string[];
  readable(path: string): boolean;
  /** Reads a readable workspace file for the host (masked like any read; null when it cannot be read). */
  readFile(path: string): string | null;
  now: Date;
  /** The inputs the module's applicability check established for this run. */
  inputs?: Readonly<Record<string, unknown>>;
}

export interface ModuleFinalizeOutput {
  /** Files written under the run folder (relative paths under evidence/). */
  files: Array<{ path: string; content: string }>;
  /** Coverage gaps the module's own records show (added to the investigation's coverage). */
  gaps?: Array<{ code: string; reason: string; path?: string }>;
  /** A summary kept in the investigation record (module.report). */
  report?: Record<string, unknown>;
}

export interface InvestigationModule {
  id: string;
  version: string;
  title: string;
  /** What the investigation looks for (the module part of the system prompt). */
  objective: string;
  stages: InvestigationStageSpec[];
  /**
   * The method also exists as a context-only review: a provider without a tool-enabled backend (a command provider)
   * keeps running that review, with its advisory behavior, instead of ending unavailable.
   */
  contextReviewFallback?: boolean;
  /** Pinned upstream material the module adapts (kept in the investigation record). */
  provenance?: Record<string, unknown>;
  /** The least the budget must fund before any context starts: exploration calls and reserved validation calls. */
  minimum?: { exploreCalls: number; reserveCalls: number };
  /**
   * Whether the method applies to this run, decided by the host before any context starts (a comparison baseline, a
   * confirmed root cause, configuration files...). Absent: the module always applies.
   */
  applicability?(input: ModuleApplicabilityInput): ModuleApplicability;
  /**
   * What the run itself needs from the machine (a container engine and the tools image for a method that executes
   * tests), asked by the executor after an applicable answer and before any context starts: null when it is there,
   * otherwise the method is not applicable with that code. Asynchronous and only asked by a run, never by a plan
   * preview (a request handler of the local server never waits for the engine, ADR-0010).
   */
  prerequisites?(input: ModuleApplicabilityInput & { inputs: Readonly<Record<string, unknown>>; signal: AbortSignal }): Promise<ModulePrerequisites>;
  /**
   * Candidates the host establishes before any context starts, from the applicable inputs (the findings of an earlier
   * run that a method re-examines). They are added like reported candidates (readable path, existing line) and the
   * per-candidate stages take them in order. Absent: the stages start without candidates.
   */
  seedCandidates?(input: { inputs: Readonly<Record<string, unknown>> }): ArtifactCandidate[];
  /** Extra brief text for one context (null: nothing to add). */
  brief?(input: ModuleBriefInput): string | null;
  /** Host-side reporting after every stage: structured records, readable report, agent context. */
  finalize?(input: ModuleFinalizeInput): ModuleFinalizeOutput;
}

export interface Evidence {
  path: string;
  line?: number;
  note?: string;
}

export interface Limitation {
  code: string;
  message: string;
  paths?: string[];
}

export type CandidateStatus = "open" | "confirmed" | "rejected" | "needs-validation" | "unresolved";

export interface Candidate {
  id: string;
  title: string;
  /** Workspace-relative. */
  path: string;
  line: number | null;
  severity: FindingSeverity;
  category: string;
  rationale: string;
  reportedBy: { stage: string; context: string };
  status: CandidateStatus;
  /** Only set by a validated verdict (possibly limited to needs-validation by the host). */
  confirmation: Confirmation | null;
  validation: { stage: string; context: string; reason: string; evidence: Evidence[] } | null;
  /** The fresh verification of the decided record (a verify stage). */
  verification?: { stage: string; context: string; outcome: "verified" | "demoted" | "disputed"; confirmation: Confirmation; reason: string; evidence: Evidence[] } | null;
  /** The module's structured record of the candidate (a custom artifact's details). */
  details?: Record<string, unknown>;
  limitations: Limitation[];
  /** Why the candidate stayed open (unresolved) or what limited it. */
  reason?: string;
}

export interface BudgetLimits {
  maxCalls: number;
  /** null: no token limit (usage is still reported). */
  maxTokens: number | null;
  maxSeconds: number;
}

export interface BudgetReserve {
  calls: number;
  tokens: number | null;
  seconds: number;
}

export type BudgetDimension = "calls" | "tokens" | "time";
