// What one run analyzed. Before the steps start, the run records the Git state of the workspace (HEAD, branch, tracked and
// untracked changes, dirty) and the input manifest of the folder the steps read: the workspace itself, or, for
// another commit, a snapshot written in JGATES_HOME/workspaces/<id>/snapshots/<runId>. After the steps, the manifest
// is taken again: when an analyzed file changed, the result is stale and is attributed to no state.
import path from "node:path";
import { translator } from "../../i18n/index.js";
import type { Decision } from "../contract/index.js";
import type { Plan } from "../plan/types.js";
import { analysisIdentity, buildProvenance, hashesOfPlan, snapshotIdentity, type AnalysisHashes, type Provenance } from "../provenance/index.js";
import {
  diffInputs,
  gitContext,
  gitFiles,
  materializeCommit,
  removeSnapshot,
  snapshotsDir,
  takeInputManifest,
  workingTreeStatus,
  type CommitSnapshot,
  type GitContext,
  type InputChanges,
  type InputManifest,
  type WorkingTreeStatus,
} from "../snapshot/index.js";

export type AnalysisTarget = "directory" | "working-tree" | "commit";
export type ApprovalCode = "COMMIT_APPROVED" | "DECISION_NOT_PASSED" | "DIRTY_WORKING_TREE" | "INPUTS_CHANGED" | "INPUTS_UNTRACEABLE" | "NO_COMMIT";

/** The `analyzed` block of result.json ($defs.analyzed). */
export interface AnalyzedState {
  target: AnalysisTarget;
  /** Folder the steps read: the workspace, or the snapshot of the commit. */
  path: string;
  /** The analyzed state had changes that are not in the commit (null without Git). */
  dirty: boolean | null;
  snapshot: {
    id: string;
    kind: "in-place" | "git-commit";
    commit: string | null;
    tree: string | null;
    path: string;
    /** The snapshot folder was removed after the run (JGATES_KEEP_SNAPSHOTS=1 keeps it). */
    removed: boolean;
    notMaterialized: Array<{ path: string; kind: string }>;
  };
  git: {
    available: boolean;
    repository: boolean;
    /** HEAD of the user's work tree when the run started. */
    head: string | null;
    branch: string | null;
    base: string | null;
    /** Changes of the work tree included in the analysis (in-place runs only). */
    changes: { tracked: Array<{ path: string; status: string }>; untracked: string[]; truncated: boolean } | null;
  };
  inputs: {
    hash: string;
    files: number;
    bytes: number;
    truncated: boolean;
    excluded: string[];
    lfsPointers: string[];
    /** The manifest was taken again after the steps. */
    verified: boolean;
    after: string | null;
    changes: { added: string[]; modified: string[]; removed: string[] } | null;
  };
  /** An analyzed file changed during the run: the result belongs to no state. */
  stale: boolean;
  hashes: AnalysisHashes | null;
  identity: string;
  approval: { commit: string | null; approved: boolean; code: ApprovalCode; message: string };
}

export interface AnalysisRequest {
  workspacePath: string;
  home: string;
  workspaceId: string;
  runId: string;
  env: NodeJS.ProcessEnv;
  /** Commit to analyze in a snapshot (the plan's scope.head, already resolved); absent: the folder as it is. */
  head?: string | null;
  base?: string | null;
  /** Workspace-relative paths the plan declares as written by the tools (outputs, never inputs). */
  outputs?: string[];
}

export interface PreparedAnalysis {
  request: AnalysisRequest;
  target: AnalysisTarget;
  path: string;
  git: GitContext;
  status: WorkingTreeStatus | null;
  snapshot: CommitSnapshot | null;
  before: InputManifest;
  removed: boolean;
}

/** Outputs a plan declares in the workspace (items' unavoidable workspace writes). */
export function planOutputs(plan: Plan | undefined): string[] {
  if (!plan) return [];
  const out = new Set<string>();
  for (const item of [...plan.groups.willRun, ...plan.groups.notApplicableOrDisabled]) for (const w of item.effects.workspaceWrites) {
    // A declared write may carry a note after the path (".quality/scopes (until ...)"): the path is the first word.
    const first = w.trim().split(/\s+/)[0];
    if (first) out.add(first);
  }
  return [...out].sort();
}

function manifestOf(dir: string, git: GitContext | null, env: NodeJS.ProcessEnv, outputs: string[]): InputManifest {
  return takeInputManifest(dir, { files: git ? gitFiles(git, dir, env) : null, exclude: outputs });
}

/**
 * Records the state the run is about to analyze. For a commit, writes its snapshot in the data folder first (throws
 * SnapshotError when Git cannot); the user's work tree, index and HEAD are never touched.
 */
export function prepareAnalysis(request: AnalysisRequest): PreparedAnalysis {
  const { workspacePath, env } = request;
  const outputs = request.outputs ?? [];
  const git = gitContext(workspacePath, env);
  if (request.head) {
    const dest = path.join(snapshotsDir(request.home, request.workspaceId), request.runId);
    const snapshot = materializeCommit(git, request.head, dest, env);
    // The snapshot has no .git: its files are walked, with the same exclusions.
    const before = manifestOf(snapshot.path, null, env, outputs);
    return { request, target: "commit", path: snapshot.path, git, status: null, snapshot, before, removed: false };
  }
  const status = workingTreeStatus(git, workspacePath, env);
  const before = manifestOf(workspacePath, git.repository ? git : null, env, outputs);
  return { request, target: git.repository ? "working-tree" : "directory", path: workspacePath, git, status, snapshot: null, before, removed: false };
}

/** Takes the manifest again after the steps; the snapshot folder is removed unless JGATES_KEEP_SNAPSHOTS=1. */
export function verifyInputs(prep: PreparedAnalysis): { after: InputManifest; changes: InputChanges } {
  const outputs = prep.request.outputs ?? [];
  const after = manifestOf(prep.path, prep.snapshot ? null : prep.git.repository ? prep.git : null, prep.request.env, outputs);
  const changes = diffInputs(prep.before, after);
  if (prep.snapshot && prep.request.env.JGATES_KEEP_SNAPSHOTS !== "1") {
    removeSnapshot(prep.snapshot.path);
    prep.removed = true;
  }
  return { after, changes };
}

export interface DescribeInput {
  verified: { after: InputManifest; changes: InputChanges } | null;
  decision: Decision;
  plan?: Plan;
  planSource?: string;
  version: string;
  now: Date;
}

/** The analyzed block and the provenance of the result, for the decision taken. */
export function describeAnalysis(prep: PreparedAnalysis, input: DescribeInput): { analyzed: AnalyzedState; provenance: Provenance } {
  const t = translator("analysis");
  const { git, status, snapshot, before } = prep;
  const repo = git.repository ? git : null;
  const commit = snapshot ? snapshot.commit : (repo?.head ?? null);
  const dirty = snapshot ? false : status ? status.dirty : null;
  const traceable = !before.truncated;
  const snapshotId = snapshotIdentity({
    kind: snapshot ? "git-commit" : "in-place",
    commit,
    tree: snapshot?.tree ?? null,
    dirty,
    inputsHash: before.hash,
    traceable,
  });
  const hashes = input.plan ? hashesOfPlan(input.plan) : null;
  const identity = analysisIdentity(snapshotId, hashes, input.plan?.scope ?? null);
  const changes = input.verified?.changes ?? null;
  const stale = changes?.changed === true;
  const changedCount = changes ? changes.added.length + changes.modified.length + changes.removed.length : 0;
  const localChanges = status ? status.tracked.length + status.untracked.length : 0;

  let code: ApprovalCode;
  let message: string;
  if (stale) {
    code = "INPUTS_CHANGED";
    message = t("analysis_approval_stale", { count: changedCount });
  } else if (!traceable) {
    code = "INPUTS_UNTRACEABLE";
    message = t("analysis_approval_untraceable", { count: before.files });
  } else if (dirty === true) {
    code = "DIRTY_WORKING_TREE";
    message = commit ? t("analysis_approval_dirty", { count: localChanges, commit }) : t("analysis_approval_dirty_unborn", { count: localChanges });
  } else if (commit === null) {
    code = "NO_COMMIT";
    message = !git.available ? t("analysis_approval_no_git") : git.repository ? t("analysis_approval_unborn") : t("analysis_approval_not_repository");
  } else if (input.decision !== "passed") {
    code = "DECISION_NOT_PASSED";
    message = t("analysis_approval_not_passed", { decision: input.decision, commit });
  } else {
    code = "COMMIT_APPROVED";
    message = t(snapshot ? "analysis_approval_snapshot" : "analysis_approval_commit", { commit });
  }

  const analyzed: AnalyzedState = {
    target: prep.target,
    path: prep.path,
    dirty,
    snapshot: {
      id: snapshotId,
      kind: snapshot ? "git-commit" : "in-place",
      commit,
      tree: snapshot?.tree ?? null,
      path: prep.path,
      removed: prep.removed,
      notMaterialized: snapshot ? snapshot.notMaterialized.map((n) => ({ ...n })) : [],
    },
    git: {
      available: git.available,
      repository: git.repository,
      head: repo?.head ?? null,
      branch: repo?.branch ?? null,
      base: prep.request.base ?? null,
      changes: status ? { tracked: status.tracked, untracked: status.untracked, truncated: status.truncated } : null,
    },
    inputs: {
      hash: before.hash,
      files: before.files,
      bytes: before.bytes,
      truncated: before.truncated,
      excluded: before.excluded,
      lfsPointers: before.lfsPointers,
      verified: input.verified !== null,
      after: input.verified?.after.hash ?? null,
      changes: changes ? { added: changes.added, modified: changes.modified, removed: changes.removed } : null,
    },
    stale,
    hashes,
    identity,
    approval: { commit, approved: code === "COMMIT_APPROVED", code, message },
  };
  const provenance = buildProvenance({
    version: input.version,
    generatedAt: input.now,
    sourceCommit: commit,
    plan: input.plan ? { hash: input.plan.planHash, source: input.planSource ?? "built", file: "plan.json" } : null,
    identity,
    snapshot: snapshotId,
    hashes,
  });
  return { analyzed, provenance };
}
