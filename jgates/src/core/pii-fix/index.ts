// `jgates pii check` and `jgates pii fix`: personal data in the project files, found by the built-in detector and the
// external tools of .jgates/pii.yml (fix.tools), and corrected only by those tools, only on request.
//
// check  copies the files of the scope to a temporary folder, runs the built-in detector and the tools (mode `check`,
//        which may change nothing) on the copy and reports files and counts by label, never a value.
// fix    copies the files to a folder of the data folder, runs the tools (mode `fix`) with the checks of
//        core/mask-tools, and returns what would change; applying writes each file atomically only if the project file
//        still has the bytes that were copied, after keeping the original for `--undo`.
// The protocol of the tools and the checks of what they did are core/mask-tools: one module for the semantic gate and
// for this command.
import fs from "node:fs";
import path from "node:path";
import { writeBytesAtomic } from "../documents/atomic.js";
import { registerWorkspace, resolveHome } from "../home/index.js";
import { createMaskWorkspace, runMaskTools, sumToolCounts, type MaskToolOutcome, type MaskWorkspace } from "../mask-tools/index.js";
import { gitContext, workingTreeStatus, type GitContext } from "../snapshot/git.js";
import {
  applyPiiFixRetention,
  createBackup,
  expiryOf,
  listFixes,
  newFixId,
  planPiiFixRetention,
  readFix,
  readOriginal,
  removeFix,
  sha256,
  workRoot,
  writeFixManifest,
  type FixManifest,
} from "./backups.js";
import { readPiiSettings, type PiiSettings } from "./config.js";
import { runBuiltinDetector } from "./detect.js";
import { readEntry, resolveScope, stageFiles, type LeftOut, type ScopeKind, type ScopeRequest } from "./scope.js";

export { readPiiSettings, DEFAULT_BACKUP_RETENTION_DAYS, type PiiSettings } from "./config.js";
export { resolveScope, type ScopeKind, type ScopeRequest, type LeftOut } from "./scope.js";
export { planPiiFixRetention, applyPiiFixRetention, listFixes, FIX_ID, type ExpiredBackup, type FixManifest } from "./backups.js";

/** Files larger than this are left out (reason "too-large"). */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export class PiiCommandError extends Error {
  constructor(
    readonly code: string,
    readonly exitCode: number,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "PiiCommandError";
  }
}

export interface PiiScopeInput {
  kind: ScopeKind;
  paths: string[];
}

const addCounts = (into: Record<string, number>, from: Record<string, number>): void => {
  for (const [label, n] of Object.entries(from)) into[label] = (into[label] ?? 0) + n;
};

const isBinary = (bytes: Buffer): boolean => bytes.subarray(0, 8000).includes(0);

interface CopiedFile {
  path: string;
  bytes: Buffer;
  sha256: string;
}

/** Resolves the scope and reads the files; binary, oversized and unreadable files are left out with a reason. */
function collect(projectDir: string, settings: PiiSettings, scope: PiiScopeInput, forFix: boolean, env: NodeJS.ProcessEnv): { files: CopiedFile[]; skipped: LeftOut[]; refused: LeftOut[]; git: GitContext } {
  const request: ScopeRequest = { kind: scope.kind, paths: scope.paths, forFix, includes: settings.fix.includes, excludes: settings.fix.excludes };
  const resolved = resolveScope(projectDir, request, env);
  if (!resolved.ok) throw new PiiCommandError(resolved.code, resolved.code === "GIT_FAILED" ? 4 : 3, resolved.detail);
  const files: CopiedFile[] = [];
  const skipped: LeftOut[] = [];
  for (const entry of resolved.entries) {
    const bytes = readEntry(projectDir, resolved.git, entry, env);
    if (bytes === null) skipped.push({ path: entry.path, reason: "unreadable" });
    else if (bytes.length > MAX_FILE_BYTES) skipped.push({ path: entry.path, reason: "too-large" });
    else if (isBinary(bytes)) skipped.push({ path: entry.path, reason: "binary" });
    else files.push({ path: entry.path, bytes, sha256: sha256(bytes) });
  }
  return { files, skipped, refused: resolved.refused, git: resolved.git };
}

function toolSummary(o: MaskToolOutcome): ToolSummary {
  return o.ok
    ? { id: o.tool, state: "completed", detected: o.status.detected, counts: o.status.counts ?? {}, files: o.status.files ?? [], durationMs: o.durationMs }
    : { id: o.tool, state: "error", code: o.code, reason: o.reason, counts: o.status?.counts ?? {}, files: [], durationMs: o.durationMs };
}

export interface ToolSummary {
  id: string;
  state: "completed" | "error";
  code?: string;
  reason?: string;
  detected?: boolean;
  counts: Record<string, number>;
  /** Files the tool named in its status. */
  files: string[];
  durationMs: number;
}

// ---- check -------------------------------------------------------------------------------------------------------------

export interface DetectorSummary {
  id: string;
  kind: "builtin" | "tool";
  state: "completed" | "disabled" | "unavailable" | "error" | "timeout";
  reason?: string;
  counts: Record<string, number>;
}

export interface CheckedFile {
  path: string;
  /** Built-in findings by entity. */
  counts: Record<string, number>;
  /** The detectors that found something in the file. */
  detectors: string[];
}

export interface CheckOutcome {
  scope: ScopeKind;
  scanned: number;
  decision: "passed" | "failed" | "incomplete";
  exitCode: 0 | 1 | 2;
  files: CheckedFile[];
  counts: Record<string, number>;
  detectors: DetectorSummary[];
  skipped: LeftOut[];
  refused: LeftOut[];
}

export interface PiiOptions {
  projectDir: string;
  scope: PiiScopeInput;
  env?: NodeJS.ProcessEnv;
  settings?: PiiSettings;
}

function settingsOrThrow(projectDir: string, given?: PiiSettings): PiiSettings {
  const settings = given ?? readPiiSettings(projectDir);
  if (settings.problems.length > 0) throw new PiiCommandError("CONFIG_INVALID", 3, settings.problems.join("\n"));
  return settings;
}

export async function checkPii(options: PiiOptions): Promise<CheckOutcome> {
  const env = options.env ?? process.env;
  const settings = settingsOrThrow(options.projectDir, options.settings);
  const { files, skipped, refused } = collect(options.projectDir, settings, options.scope, false, env);
  const outcome: CheckOutcome = { scope: options.scope.kind, scanned: files.length, decision: "passed", exitCode: 0, files: [], counts: {}, detectors: [], skipped, refused };
  const byFile = new Map<string, CheckedFile>();
  const fileOf = (p: string): CheckedFile => {
    let f = byFile.get(p);
    if (!f) byFile.set(p, (f = { path: p, counts: {}, detectors: [] }));
    return f;
  };
  let found = false;
  let incomplete = false;
  if (files.length > 0) {
    const workspace = createMaskWorkspace(files.map((f) => ({ path: f.path, content: f.bytes })));
    try {
      if (!settings.builtin.enabled || settings.builtin.entities.length === 0) {
        outcome.detectors.push({ id: "builtin-pii", kind: "builtin", state: "disabled", counts: {} });
      } else {
        const builtin = await runBuiltinDetector(workspace.dir, settings.builtin.config, env);
        if (builtin.state === "completed") {
          const counts: Record<string, number> = {};
          for (const finding of builtin.findings) {
            const file = fileOf(finding.path);
            file.counts[finding.entity] = (file.counts[finding.entity] ?? 0) + 1;
            if (!file.detectors.includes("builtin-pii")) file.detectors.push("builtin-pii");
            counts[finding.entity] = (counts[finding.entity] ?? 0) + 1;
          }
          if (builtin.findings.length > 0) found = true;
          addCounts(outcome.counts, counts);
          outcome.detectors.push({ id: "builtin-pii", kind: "builtin", state: "completed", counts });
        } else {
          incomplete = true;
          outcome.detectors.push({ id: "builtin-pii", kind: "builtin", state: builtin.state, reason: builtin.reason, counts: {} });
        }
      }
      // The tools see the same copy, one after the other; in mode check none may change anything.
      const run = await runMaskTools(settings.tools, workspace, { mode: "check", parentEnv: env });
      for (const o of run.outcomes) {
        const s = toolSummary(o);
        if (s.state === "completed") {
          if (s.detected) found = true;
          for (const p of s.files) {
            const file = fileOf(p);
            if (!file.detectors.includes(s.id)) file.detectors.push(s.id);
          }
          addCounts(outcome.counts, s.counts);
          outcome.detectors.push({ id: s.id, kind: "tool", state: "completed", counts: s.counts });
        } else {
          incomplete = true;
          outcome.detectors.push({ id: s.id, kind: "tool", state: "error", reason: s.reason ?? "", counts: {} });
        }
      }
      // A tool after a failed one did not run.
      for (const tool of settings.tools.slice(run.outcomes.length)) outcome.detectors.push({ id: tool.id, kind: "tool", state: "error", reason: "not run: an earlier tool failed", counts: {} });
    } finally {
      workspace.cleanup();
    }
  }
  outcome.files = [...byFile.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  outcome.decision = found ? "failed" : incomplete ? "incomplete" : "passed";
  outcome.exitCode = found ? 1 : incomplete ? 2 : 0;
  return outcome;
}

// ---- fix ---------------------------------------------------------------------------------------------------------------

export interface FixChange {
  path: string;
  before: Buffer;
  after: Buffer;
  originalSha256: string;
  fixedSha256: string;
}

export interface FixPreparation {
  projectDir: string;
  scope: ScopeKind;
  workspaceId: string;
  home: string;
  settings: PiiSettings;
  git: GitContext;
  env: NodeJS.ProcessEnv;
  scanned: number;
  changes: FixChange[];
  counts: Record<string, number>;
  tools: ToolSummary[];
  skipped: LeftOut[];
  refused: LeftOut[];
  /** Set when a tool failed or touched the project: nothing may be applied. */
  failure: { code: string; reason: string } | null;
}

/** Size and time of the changed and untracked files Git sees, outside the files of the scope. */
function projectGuard(projectDir: string, git: GitContext, scope: ReadonlySet<string>, env: NodeJS.ProcessEnv): Map<string, string> | null {
  const status = workingTreeStatus(git, projectDir, env);
  if (!status) return null;
  const out = new Map<string, string>();
  for (const p of [...status.tracked.map((c) => c.path), ...status.untracked]) {
    if (scope.has(p)) continue;
    try {
      const st = fs.lstatSync(path.join(projectDir, ...p.split("/")));
      out.set(p, `${st.size}:${st.mtimeMs}:${st.mode}`);
    } catch {
      out.set(p, "missing");
    }
  }
  return out;
}

function sameGuard(a: Map<string, string> | null, b: Map<string, string> | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * Runs the tools of fix.tools (mode fix) on a copy of the scope and returns what would change. Nothing in the project
 * changes here. Throws PiiCommandError for configuration and scope problems (NO_FIX_TOOL when fix.tools is empty).
 */
export async function prepareFix(options: PiiOptions & { home?: string }): Promise<FixPreparation> {
  const env = options.env ?? process.env;
  const settings = settingsOrThrow(options.projectDir, options.settings);
  if (settings.tools.length === 0) throw new PiiCommandError("NO_FIX_TOOL", 3, "fix.tools");
  const projectDir = path.resolve(options.projectDir);
  const { files, skipped, refused, git } = collect(projectDir, settings, options.scope, true, env);
  const home = options.home ?? resolveHome({ env });
  const workspaceId = registerWorkspace(projectDir, { home }).id;
  // Expired originals of this workspace go as soon as the next fix runs, not only on `jgates gc`.
  applyPiiFixRetention(home, planPiiFixRetention(home, Date.now(), workspaceId));
  const prep: FixPreparation = { projectDir, scope: options.scope.kind, workspaceId, home, settings, git, env, scanned: files.length, changes: [], counts: {}, tools: [], skipped, refused, failure: null };
  if (files.length === 0) return prep;

  const scopeSet = new Set(files.map((f) => f.path));
  const guardBefore = git.repository ? projectGuard(projectDir, git, scopeSet, env) : null;
  let workspace: MaskWorkspace | null = null;
  try {
    workspace = createMaskWorkspace(files.map((f) => ({ path: f.path, content: f.bytes })), { tmpDir: workRoot(home, workspaceId) });
    const run = await runMaskTools(settings.tools, workspace, { mode: "fix", parentEnv: env });
    prep.tools = run.outcomes.map(toolSummary);
    prep.counts = sumToolCounts(run.outcomes);
    if (!run.ok) {
      const failed = run.outcomes.find((o) => !o.ok);
      prep.failure = failed && !failed.ok ? { code: failed.code, reason: failed.reason } : { code: "MASKING_COMMAND_FAILED", reason: "a tool failed" };
      return prep;
    }
    // A tool works in the copy; one that wrote in the project outside the files of the scope cannot be trusted.
    if (git.repository && !sameGuard(guardBefore, projectGuard(projectDir, git, scopeSet, env))) {
      prep.failure = { code: "PROJECT_TOUCHED", reason: "a file of the project outside the copy changed while the tools ran" };
      return prep;
    }
    for (const f of files) {
      const after = workspace.read(f.path);
      if (!after.equals(f.bytes)) prep.changes.push({ path: f.path, before: f.bytes, after, originalSha256: f.sha256, fixedSha256: sha256(after) });
    }
    return prep;
  } finally {
    workspace?.cleanup();
  }
}

export interface FixApplied {
  fixId: string | null;
  expiresAt: string | null;
  applied: string[];
  skipped: LeftOut[];
  /** Set when `git add` of the changed files failed (--staged). */
  stageError: string | null;
}

class ChangedSinceCopy extends Error {}

function readIfFile(abs: string): { bytes: Buffer; mode: number } | null {
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return null;
    return { bytes: fs.readFileSync(abs), mode: st.mode & 0o7777 };
  } catch {
    return null;
  }
}

/**
 * Applies the changes of a preparation: keeps the originals first, then replaces each file atomically, only if the
 * project file still has the bytes that were copied (otherwise it is skipped and listed). With --staged the changed
 * files, and only them, go back to the index.
 */
export function applyFix(prep: FixPreparation, options: { now?: Date } = {}): FixApplied {
  if (prep.failure) throw new Error("a failed preparation cannot be applied");
  const now = options.now ?? new Date();
  const out: FixApplied = { fixId: null, expiresAt: null, applied: [], skipped: [], stageError: null };
  const ready: Array<FixChange & { mode: number }> = [];
  for (const change of prep.changes) {
    const current = readIfFile(path.join(prep.projectDir, ...change.path.split("/")));
    if (!current || sha256(current.bytes) !== change.originalSha256) out.skipped.push({ path: change.path, reason: "changed-since-copy" });
    else ready.push({ ...change, mode: current.mode });
  }
  if (ready.length === 0) return out;

  const fixId = newFixId(now);
  const backup = createBackup(prep.home, prep.workspaceId, fixId);
  const manifest: FixManifest = {
    schemaVersion: 1,
    fixId,
    createdAt: now.toISOString(),
    expiresAt: expiryOf(now, prep.settings.fix.backupRetentionDays),
    workspacePath: prep.projectDir,
    scope: prep.scope,
    staged: prep.scope === "staged",
    tools: prep.tools.map((t) => t.id),
    counts: prep.counts,
    files: ready.map((c) => ({ path: c.path, mode: c.mode, originalSha256: c.originalSha256, fixedSha256: c.fixedSha256 })),
  };
  try {
    for (const change of ready) backup.saveOriginal(change.path, change.before);
    backup.writeManifest(manifest);
  } catch (error) {
    backup.remove();
    throw error;
  }
  for (const change of ready) {
    const abs = path.join(prep.projectDir, ...change.path.split("/"));
    try {
      writeBytesAtomic(abs, change.after, {
        mode: change.mode,
        verify: () => {
          const now = readIfFile(abs);
          if (!now || sha256(now.bytes) !== change.originalSha256) throw new ChangedSinceCopy();
        },
      });
      out.applied.push(change.path);
    } catch (error) {
      out.skipped.push({ path: change.path, reason: error instanceof ChangedSinceCopy ? "changed-since-copy" : "write-failed" });
    }
  }
  if (out.applied.length === 0) {
    backup.remove();
    return out;
  }
  manifest.files = manifest.files.filter((f) => out.applied.includes(f.path));
  writeFixManifest(prep.home, prep.workspaceId, manifest);
  out.fixId = fixId;
  out.expiresAt = manifest.expiresAt;
  if (manifest.staged) out.stageError = stageFiles(prep.projectDir, prep.git, out.applied, prep.env);
  return out;
}

// ---- undo --------------------------------------------------------------------------------------------------------------

export interface UndoOutcome {
  fixId: string;
  restored: string[];
  skipped: LeftOut[];
  /** The originals were deleted (everything restored). */
  removed: boolean;
  stageError: string | null;
}

/** Restores the originals of a fix (the newest one when no id is given). Throws PiiCommandError NOTHING_TO_UNDO. */
export function undoFix(options: { projectDir: string; fixId?: string; home?: string; env?: NodeJS.ProcessEnv }): UndoOutcome {
  const env = options.env ?? process.env;
  const projectDir = path.resolve(options.projectDir);
  const home = options.home ?? resolveHome({ env });
  const workspaceId = registerWorkspace(projectDir, { home }).id;
  const manifest = options.fixId ? readFix(home, workspaceId, options.fixId) : (listFixes(home, workspaceId)[0] ?? null);
  if (!manifest) throw new PiiCommandError("NOTHING_TO_UNDO", 3, options.fixId ?? "");
  const out: UndoOutcome = { fixId: manifest.fixId, restored: [], skipped: [], removed: false, stageError: null };
  for (const file of manifest.files) {
    const abs = path.join(projectDir, ...file.path.split("/"));
    const current = readIfFile(abs);
    if (!current) {
      out.skipped.push({ path: file.path, reason: "missing" });
      continue;
    }
    if (sha256(current.bytes) !== file.fixedSha256) {
      out.skipped.push({ path: file.path, reason: "changed-since-fix" });
      continue;
    }
    try {
      const original = readOriginal(home, workspaceId, manifest.fixId, file.path);
      if (sha256(original) !== file.originalSha256) {
        out.skipped.push({ path: file.path, reason: "backup-damaged" });
        continue;
      }
      writeBytesAtomic(abs, original, {
        mode: file.mode,
        verify: () => {
          const now = readIfFile(abs);
          if (!now || sha256(now.bytes) !== file.fixedSha256) throw new ChangedSinceCopy();
        },
      });
      out.restored.push(file.path);
    } catch (error) {
      out.skipped.push({ path: file.path, reason: error instanceof ChangedSinceCopy ? "changed-since-fix" : "write-failed" });
    }
  }
  if (manifest.staged && out.restored.length > 0) {
    out.stageError = stageFiles(projectDir, gitContext(projectDir, env), out.restored, env);
  }
  if (out.skipped.length === 0) {
    removeFix(home, workspaceId, manifest.fixId);
    out.removed = true;
  } else if (out.restored.length > 0) {
    manifest.files = manifest.files.filter((f) => !out.restored.includes(f.path));
    writeFixManifest(home, workspaceId, manifest);
  }
  return out;
}
