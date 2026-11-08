// Contracts shared by the two gates (V2): which gate a run belongs to, what identifies a run and the source it judged,
// how a sequence links the runs of both gates, what scope a run examined and what binds attached evidence to the state
// it describes. Every record is versioned (schemaVersion) and has a JSON Schema in jgates/schemas/gates/; read
// persisted records only through the versioned readers of ./read.ts, which migrate records written without a version.

/** quality: deterministic, token-free verification. semantic: model reasoning and investigation. Never a third one. */
export const GATE_KINDS = ["quality", "semantic"] as const;
export type GateKind = (typeof GATE_KINDS)[number];

/** The record kinds of this module, each with its own schema file and current version. */
export const GATE_RECORD_KINDS = ["source-identity", "run-identity", "sequence", "scope", "evidence-binding"] as const;
export type GateRecordKind = (typeof GATE_RECORD_KINDS)[number];

/** Current schemaVersion of each record kind; a reader refuses a newer version instead of guessing. */
export const GATE_RECORD_VERSIONS: Readonly<Record<GateRecordKind, number>> = {
  "source-identity": 1,
  "run-identity": 1,
  sequence: 1,
  scope: 1,
  "evidence-binding": 1,
};

/**
 * How the source identity was obtained. git-working-tree: a Git checkout as it is, dirty and untracked files included;
 * git-commit: a commit alone (no local changes); directory: a folder without Git, identified by its input manifest;
 * legacy-analyzed: derived from the `analyzed` block of a result written before V2 (the dirty contents are unknown).
 */
export type SourceBasis = "git-working-tree" | "git-commit" | "directory" | "legacy-analyzed";

/** The repository a source belongs to, without any remote URL (those may carry credentials). */
export interface SourceRepository {
  /** sha256 of the root commits of the history (the same in every clone), or of the canonical work-tree path. */
  id: string;
  idBasis: "root-commits" | "path";
  /** Absolute root of the work tree when the identity was taken (informative; not part of `id` for root-commits). */
  root: string;
  /** The workspace inside the work tree ("" at the root, otherwise "sub/dir/"). */
  prefix: string;
}

/** Repository + commit + dirty-content identity of the source a run judged. */
export interface SourceIdentity {
  schemaVersion: 1;
  /** sha256 of what decides the content: repository, prefix, commit and dirty contents (or the inputs without Git). */
  id: string;
  basis: SourceBasis;
  repository: SourceRepository | null;
  /** Commit checked out (null without Git or on an unborn branch). */
  commit: string | null;
  /** The source had changes that are not in the commit (null when unknown: no Git). */
  dirty: boolean | null;
  /** sha256 of the dirty paths and their contents (tracked changes and untracked files); null when clean or unknown. */
  dirtyContentHash: string | null;
  /** Number of dirty paths the hash covers. */
  dirtyPaths: number;
  /** Hash of the input manifest (every file the steps read), when it was taken; null for a commit alone. */
  inputsHash: string | null;
  /** false: the Git status or the input manifest was truncated, so the identity does not cover every file. */
  traceable: boolean;
}

/** One stage of a run as its identity records it: the id and the final state, never the evidence. */
export interface GateRunStage {
  id: string;
  state: string;
}

export type GateDecision = "passed" | "failed" | "incomplete" | "invalid" | "cancelled";

/** What identifies one run of one gate. A run ID never belongs to two gates. */
export interface GateRunIdentity {
  schemaVersion: 1;
  gate: GateKind;
  /** Quality: run_..., Semantic: sem_... (disjoint namespaces, see ./ids.ts). */
  runId: string;
  /** Hash of the configuration in effect (null when the run did not record one). */
  configHash: string | null;
  source: SourceIdentity;
  plan: { hash: string | null; source: string | null };
  stages: GateRunStage[];
  outcome: { decision: GateDecision; complete: boolean; reduced: boolean; exitCode: number | null; partial: boolean };
  /** Paths relative to the run folder. */
  artifacts: { result: string | null; logs: string[]; outputs: string[]; plan?: string; events?: string };
  /** Set when the identity was migrated from an older record (a result.json written before V2). */
  migratedFrom?: "result-v1-without-gate";
}

/** A link from a sequence to one run. It carries no decision: the run's own record keeps it. */
export interface SequenceRunRef {
  gate: GateKind;
  runId: string;
}

export type SequenceStatus = "pending" | "running" | "awaiting-advancement" | "advanced" | "paused" | "stopped" | "completed" | "cancelled";

/**
 * Coordination record of a selection of gates: the ordered run references and whether the next gate may start. It
 * never rewrites the decision of either run.
 */
export interface SequenceRecord {
  schemaVersion: 1;
  /** seq_... */
  sequenceId: string;
  createdAt: string;
  updatedAt?: string;
  /** The gates selected, in execution order (Quality before Semantic). */
  selectedGates: GateKind[];
  /** The runs started so far, in execution order; one per gate. */
  runs: SequenceRunRef[];
  /**
   * quality-approved: the next gate starts only after a Quality run that passed, is complete, not reduced, valid and
   * of the same source identity. none: a single gate, nothing to advance.
   */
  advancement: { condition: "quality-approved" | "none"; sourceId?: string };
  status: SequenceStatus;
  /** Why the sequence paused, stopped or was cancelled (required then). */
  reason?: { code: string; message: string };
}

export type ScopeMode = "full" | "selected" | "incremental";

export interface ScopeSubject {
  kind: "path" | "subsystem";
  value: string;
}

/** A resolved Git identity of a scope end (base or target). */
export interface ScopeEnd {
  ref: string | null;
  commit: string | null;
  /** Source identity id of that end (the target includes its dirty inputs). */
  sourceId: string | null;
}

export interface ScopeDirtyInput {
  path: string;
  /** added, modified, removed or untracked. */
  change: "added" | "modified" | "removed" | "untracked";
  sha256: string | null;
}

export interface ScopeUnit {
  /** A path, symbol or subsystem id. */
  id: string;
  /** Why the unit was selected, examined or omitted. */
  reason: string;
}

/** A reused unit always names the run its evidence came from. */
export interface ScopeReusedUnit extends ScopeUnit {
  evidence: { runId: string; gate: GateKind };
}

/** What a run was asked to examine and what it actually examined, independent of rigor and budget. */
export interface ScopeSpec {
  schemaVersion: 1;
  mode: ScopeMode;
  subjects: ScopeSubject[];
  exclusions: string[];
  resolved: { base: ScopeEnd | null; target: ScopeEnd; dirtyInputs: ScopeDirtyInput[] };
  baselineRunId: string | null;
  context: {
    allowed: Array<{ kind: "path" | "subsystem" | "symbol"; value: string; reason: string }>;
    expansion: { maxFiles: number; maxDepth: number; maxBytes?: number };
  };
  units: { effective: ScopeUnit[]; examined: ScopeUnit[]; reused: ScopeReusedUnit[]; omitted: ScopeUnit[] };
}

export type EvidenceFreshness = "current" | "stale" | "unknown";

/** Binds attached or reused evidence to the identities it depends on, so it never asserts current coverage silently. */
export interface EvidenceBinding {
  schemaVersion: 1;
  origin: { gate: GateKind; runId: string; producedAt: string | null; kind: string };
  identities: {
    source: SourceIdentity;
    config: string | null;
    dependency: string | null;
    method: string | null;
    backend: string | null;
    policy: string | null;
  };
  freshness: { state: EvidenceFreshness; checkedAt: string; reason?: string };
}

/** Each record kind and its type, for the generic readers. */
export interface GateRecordTypes {
  "source-identity": SourceIdentity;
  "run-identity": GateRunIdentity;
  sequence: SequenceRecord;
  scope: ScopeSpec;
  "evidence-binding": EvidenceBinding;
}
