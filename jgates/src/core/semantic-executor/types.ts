// Types of the bounded investigation executor. JGates owns the stages, the budgets, the lifecycle, the events, the
// artifacts and their validation; a backend (a provider tool loop or a wrapped agent CLI) only talks to the model
// inside those limits. A Semantic module is a list of stages, each a responsibility with its own fresh context(s).
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
}

export interface ArtifactCheck {
  ok: boolean;
  problems: string[];
  /** The accepted value (claims that failed their checks are dropped and listed in `problems`). */
  value?: Record<string, unknown>;
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
}

export interface InvestigationModule {
  id: string;
  version: string;
  title: string;
  /** What the investigation looks for (the module part of the system prompt). */
  objective: string;
  stages: InvestigationStageSpec[];
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
