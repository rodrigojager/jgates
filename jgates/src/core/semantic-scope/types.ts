// Types of the Semantic scope engine. The persisted scope contract is the gate record ScopeSpec (core/gates, schema
// schemas/gates/scope.schema.json); a resolution wraps it with what a person or a screen needs to judge it before any
// model work: the impact/context proposal with reasons, the unknowns, the exclusions, the reuse of prior evidence, the
// inherited coverage and the completion counts. Scope is independent of purpose, rigor and budget: none of them is an
// input of a resolution, so changing them never changes the resolved scope (scopeHash).
import type { ScopeMode, ScopeSpec, ScopeSubject } from "../gates/types.js";

/** What a Semantic module is for. Both use the same scope controls (controls.ts). */
export const SEMANTIC_PURPOSES = ["general-review", "security"] as const;
export type SemanticPurpose = (typeof SEMANTIC_PURPOSES)[number];

export const SEMANTIC_RIGORS = ["quick", "standard", "deep"] as const;
export type SemanticRigor = (typeof SEMANTIC_RIGORS)[number];

/** strict: only the previewed context may be read. bounded: automatic expansion inside the limits, each one recorded. */
export const CONTEXT_POLICIES = ["strict", "bounded"] as const;
export type ContextPolicy = (typeof CONTEXT_POLICIES)[number];

export interface ContextLimits {
  maxFiles: number;
  maxDepth: number;
  maxBytes: number;
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = { maxFiles: 25, maxDepth: 1, maxBytes: 2_000_000 };

/** What the caller asks (CLI flags, API body). Everything is optional except what the mode needs. */
export interface ScopeRequest {
  /** full (recommended, the default), selected or incremental. */
  mode?: ScopeMode;
  /** Selected: paths (files, folders or globs) and subsystems (layers of .jgates/architecture.yml). */
  subjects?: ScopeSubject[];
  /** Globs never examined nor read as context (strict exclusions). */
  exclusions?: string[];
  /** Incremental: the comparison anchor (a Git reference); required. */
  base?: string | null;
  /** Incremental: the target reference (HEAD by default). */
  target?: string | null;
  /** Incremental: dirty and untracked changes of the working tree to include ("none" by default, "all", or paths). */
  dirty?: "none" | "all" | string[];
  /** A prior Semantic run whose ledger may be reused after current checks ("latest" or a sem_ ID). */
  baseline?: string | null;
  context?: { policy?: ContextPolicy; maxFiles?: number; maxDepth?: number; maxBytes?: number; allow?: string[] };
}

/** Machine code plus human text: tests and screens rely on the code, people read the message. */
export interface Reason {
  code: string;
  message: string;
  /** The file the relation goes through (the changed file a context file imports, for example). */
  via?: string;
}

export type ChangeKind = "added" | "modified" | "renamed" | "removed" | "untracked" | "unchanged";

export type FileCategory = "shared-guard" | "contract" | "configuration" | "dependency-manifest" | "code" | "other";

export interface ScopeSubjectEntry {
  path: string;
  change: ChangeKind;
  previousPath?: string;
  categories: FileCategory[];
  reasons: Reason[];
  /** examine: sent to the review now; reused: compatible prior evidence carries it (not re-examined). */
  disposition: "examine" | "reused";
}

export type ContextRelation = "importer" | "imported" | "dependency-user" | "explicit";

export interface ScopeContextEntry {
  path: string;
  relation: ContextRelation;
  depth: number;
  bytes: number;
  categories: FileCategory[];
  reasons: Reason[];
}

export type UnknownCode =
  | "DYNAMIC_IMPORT"
  | "COMPUTED_REQUIRE"
  | "UNPARSEABLE"
  | "UNRESOLVED_IMPORT"
  | "FILE_TOO_LARGE"
  | "GRAPH_LIMIT"
  | "DEPENDENCY_CHANGE_UNMAPPED"
  | "CONFIG_CONSUMERS_UNKNOWN"
  | "STATUS_TRUNCATED";

export interface ScopeUnknown {
  code: UnknownCode;
  path: string;
  detail: string;
  message: string;
}

export interface ReuseEntry {
  id: string;
  reasons: Reason[];
  evidence?: { runId: string; gate: "semantic" };
}

export interface ReuseReport {
  baselineRunId: string | null;
  /** Units whose prior evidence was checked against the current source and still holds. */
  reused: ReuseEntry[];
  /** Units whose prior evidence no longer holds (content, protection, dependency, configuration or method changed). */
  invalidated: ReuseEntry[];
  /** Prior units never carried: unresolved, with findings or not examined. They return to the plan when in scope. */
  notCarried: ReuseEntry[];
}

export interface InheritedCoverage {
  /** none: nothing is inherited (no baseline, or nothing of it holds now). partial: some units carried with evidence. */
  state: "none" | "partial";
  code: string;
  message: string;
  baselineRunId: string | null;
  /** Units carried from the baseline (inside and outside the current region). */
  units: number;
}

/** How the target is read (for the access guard and the fingerprints of a run). */
export interface TargetDescription {
  kind: "working-tree" | "commit" | "directory";
  commit: string | null;
  /** Dirty paths laid over the commit (incremental with selected dirty inputs). */
  overlay: string[];
}

export interface ScopeBlocker {
  code: string;
  message: string;
}

export interface ExtractorInfo {
  id: string;
  languages: Array<{ language: string; method: "ast" | "regex" }>;
  limitations: Array<{ code: string; message: string }>;
  /** Never true: the impact map is a bounded, deterministic proposal, not a proof of completeness. */
  exhaustive: false;
}

export interface SemanticScopeResolution {
  schemaVersion: 1;
  /** sha256 of what was resolved (spec, subjects, context, unknowns, reuse); never of purpose, rigor, budget or time. */
  scopeHash: string;
  mode: ScopeMode;
  /** Repository identity of the target (root commits or path), to refuse a baseline of another repository. */
  repositoryId: string | null;
  /** The gate record (validated against schemas/gates/scope.schema.json). */
  spec: ScopeSpec;
  target: TargetDescription;
  subjects: ScopeSubjectEntry[];
  context: ScopeContextEntry[];
  impact: {
    extractor: ExtractorInfo;
    changes: Array<{ path: string; change: ChangeKind; previousPath?: string; categories: FileCategory[] }>;
    unknowns: ScopeUnknown[];
    /** Context the limits or the strict policy kept out: recommended, never read silently. */
    recommendedExpansion: Array<{ path: string; reasons: Reason[] }>;
  };
  exclusions: { patterns: string[]; excluded: Array<{ path: string; reason: Reason }> };
  policy: { context: ContextPolicy } & ContextLimits;
  reuse: ReuseReport;
  inheritedCoverage: InheritedCoverage;
  /** Scope completion is separate from repository coverage. */
  completion: {
    repositoryFiles: number;
    subjects: number;
    toExamine: number;
    reused: number;
    context: number;
    excluded: number;
    /** scope-only: conclusions hold only for the declared and examined scope. */
    claim: "scope-only" | "repository-applicable";
  };
  /** true when the files a context-only review reads on disk are the target's content. */
  workingTreeMatchesTarget: boolean;
  blockers: ScopeBlocker[];
  warnings: ScopeBlocker[];
}
