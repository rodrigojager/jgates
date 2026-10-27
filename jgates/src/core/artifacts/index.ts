import fs from "node:fs";
import path from "node:path";
import { readRegistry, removeRegistryEntries, workspaceDir, workspaceLineage } from "../home/index.js";
import type { WorkspaceEntry } from "../home/index.js";

// Run history, run marks and retention over the JGates data folder. Everything here stays inside
// <home>/workspaces/<id>/runs: nothing reads or deletes the user's project.

export interface RunMarks {
  baseline: boolean;
  preserved: boolean;
}

export interface RunInfo {
  runId: string;
  /** The workspace id whose folder holds the run (an older id when the workspace was relinked). */
  workspaceId: string;
  dir: string;
  startedAt: string | null;
  decision: string | null;
  partial: boolean;
  /** The run switched checks off for that run only: a partial round, not an approval of the full profile. */
  reduced: boolean;
  bytes: number;
  marks: RunMarks;
  /** Milliseconds since epoch used for ordering and age: startedAt, else the folder's modification time. */
  time: number;
}

const MARKS_FILE = "marks.json";
const ACTIVE_WINDOW_MS = 60 * 60 * 1000;

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function readMarks(runDir: string): RunMarks {
  const doc = readJson(path.join(runDir, MARKS_FILE));
  return { baseline: doc?.baseline === true, preserved: doc?.preserved === true };
}

/** Marks (or unmarks) a run so the retention keeps it. */
export function markRun(home: string, workspaceId: string, runId: string, marks: Partial<RunMarks>): RunMarks {
  const dir = runPath(home, workspaceId, runId);
  if (!fs.existsSync(dir)) throw new Error(`run not found: ${runId}`);
  const next = { ...readMarks(dir), ...marks };
  fs.writeFileSync(path.join(dir, MARKS_FILE), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

function runPath(home: string, workspaceId: string, runId: string): string {
  if (!runId || runId !== path.basename(runId) || runId.startsWith(".")) throw new Error(`invalid run id: ${runId}`);
  return path.join(workspaceDir(home, workspaceId), "runs", runId);
}

export function dirBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirBytes(full);
      else total += fs.lstatSync(full).size;
    } catch {
      // vanished while walking
    }
  }
  return total;
}

/** The runs stored in one workspace folder (no relinked ones), newest first. */
export function readRunsOf(home: string, workspaceId: string): RunInfo[] {
  const runsDir = path.join(workspaceDir(home, workspaceId), "runs");
  let names: string[];
  try {
    names = fs.readdirSync(runsDir);
  } catch {
    return [];
  }
  const out: RunInfo[] = [];
  for (const name of names) {
    const dir = path.join(runsDir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const result = readJson(path.join(dir, "result.json"));
    const startedAt = typeof result?.startedAt === "string" ? result.startedAt : null;
    const parsed = startedAt ? Date.parse(startedAt) : NaN;
    out.push({
      runId: name,
      workspaceId,
      dir,
      startedAt,
      decision: typeof result?.decision === "string" ? result.decision : null,
      partial: result?.partial === true || result === null,
      reduced: result?.reduced === true,
      bytes: dirBytes(dir),
      marks: readMarks(dir),
      time: Number.isFinite(parsed) ? parsed : st.mtimeMs,
    });
  }
  return out.sort((a, b) => b.time - a.time || (a.runId < b.runId ? 1 : -1));
}

/** The history of a workspace: its own runs and those of the ids relinked into it, newest first. */
export function listRuns(home: string, workspaceId: string): RunInfo[] {
  const all = workspaceLineage(home, workspaceId).flatMap((id) => readRunsOf(home, id));
  return all.sort((a, b) => b.time - a.time || (a.runId < b.runId ? 1 : -1));
}

// ---- retention ----------------------------------------------------------------------------------------------

export interface RetentionPolicy {
  maxAgeDays: number;
  maxWorkspaceBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  maxAgeDays: 30,
  maxWorkspaceBytes: 2 * 1024 ** 3,
  maxTotalBytes: 10 * 1024 ** 3,
};

export type RemovalReason = "age" | "workspace-size" | "total-size" | "workspace-missing";

export interface PlannedRun {
  workspaceId: string;
  runId: string;
  dir: string;
  bytes: number;
  reason: RemovalReason;
}

export interface MissingWorkspace {
  id: string;
  path: string;
  /** Runs kept because they are marked (baseline or preserved), so the folder stays. */
  keptRuns: string[];
  /** True when nothing is kept: the whole workspace folder and its registry entry go. */
  removable: boolean;
}

export interface RetentionPlan {
  policy: RetentionPolicy;
  runs: PlannedRun[];
  missingWorkspaces: MissingWorkspace[];
  freedBytes: number;
}

function isProtected(run: RunInfo, now: number): boolean {
  if (run.marks.baseline || run.marks.preserved) return true;
  // A run still writing its result.json (or whose result is not there yet) is not touched for an hour.
  return run.partial && now - run.time < ACTIVE_WINDOW_MS && now - fs.lstatSync(run.dir).mtimeMs < ACTIVE_WINDOW_MS;
}

/** Applies the registry links: the entry a relinked workspace now belongs to. */
function groupRoot(entries: WorkspaceEntry[], id: string): string {
  const seen = new Set<string>();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const next = entries.find((w) => w.id === current)?.relinkedTo;
    if (!next || !entries.some((w) => w.id === next)) break;
    current = next;
  }
  return current;
}

export function planRetention(home: string, policy: RetentionPolicy = DEFAULT_RETENTION, now: number = Date.now()): RetentionPlan {
  const entries = readRegistry(home).workspaces;
  const groups = new Map<string, string[]>();
  for (const e of entries) {
    const root = groupRoot(entries, e.id);
    groups.set(root, [...(groups.get(root) ?? []), e.id]);
  }
  const planned: PlannedRun[] = [];
  const missing: MissingWorkspace[] = [];
  const survivors: RunInfo[][] = [];
  const maxAge = policy.maxAgeDays * 24 * 60 * 60 * 1000;
  const plan = (r: RunInfo, reason: RemovalReason): void => {
    planned.push({ workspaceId: r.workspaceId, runId: r.runId, dir: r.dir, bytes: r.bytes, reason });
  };

  for (const [root, ids] of groups) {
    const runs = ids.flatMap((id) => readRunsOf(home, id));
    const rootEntry = entries.find((w) => w.id === root) as WorkspaceEntry;
    if (!fs.existsSync(rootEntry.path)) {
      const kept: string[] = [];
      for (const r of runs) {
        if (isProtected(r, now)) kept.push(r.runId);
        else plan(r, "workspace-missing");
      }
      missing.push({ id: root, path: rootEntry.path, keptRuns: kept, removable: kept.length === 0 });
      continue;
    }
    let left = runs.filter((r) => {
      if (isProtected(r, now)) return true;
      if (now - r.time > maxAge) {
        plan(r, "age");
        return false;
      }
      return true;
    });
    // Oldest first until the workspace fits.
    let size = left.reduce((n, r) => n + r.bytes, 0);
    for (const r of [...left].sort((a, b) => a.time - b.time)) {
      if (size <= policy.maxWorkspaceBytes) break;
      if (isProtected(r, now)) continue;
      plan(r, "workspace-size");
      size -= r.bytes;
      left = left.filter((x) => x !== r);
    }
    survivors.push(left);
  }

  let total = survivors.flat().reduce((n, r) => n + r.bytes, 0);
  for (const r of survivors.flat().sort((a, b) => a.time - b.time)) {
    if (total <= policy.maxTotalBytes) break;
    if (isProtected(r, now)) continue;
    plan(r, "total-size");
    total -= r.bytes;
  }
  return { policy, runs: planned, missingWorkspaces: missing, freedBytes: planned.reduce((n, r) => n + r.bytes, 0) };
}

export interface RetentionApplied {
  removedRuns: PlannedRun[];
  removedWorkspaces: string[];
  freedBytes: number;
  skipped: { path: string; reason: string }[];
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Deletes what a plan lists, and only inside <home>/workspaces; anything else is skipped and reported. */
export function applyRetention(home: string, plan: RetentionPlan): RetentionApplied {
  const base = path.join(fs.realpathSync(home), "workspaces");
  const out: RetentionApplied = { removedRuns: [], removedWorkspaces: [], freedBytes: 0, skipped: [] };
  const safeRemove = (target: string): boolean => {
    let real: string;
    try {
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error("symlink");
      real = fs.realpathSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      out.skipped.push({ path: target, reason: "unsafe" });
      return false;
    }
    if (!inside(base, real)) {
      out.skipped.push({ path: target, reason: "outside-data-folder" });
      return false;
    }
    fs.rmSync(real, { recursive: true, force: true });
    return true;
  };
  for (const run of plan.runs) {
    let dir: string;
    try {
      dir = runPath(home, run.workspaceId, run.runId);
    } catch {
      out.skipped.push({ path: run.dir, reason: "invalid-run-id" });
      continue;
    }
    if (safeRemove(dir)) {
      out.removedRuns.push(run);
      out.freedBytes += run.bytes;
    }
  }
  const entries = readRegistry(home).workspaces;
  for (const w of plan.missingWorkspaces) {
    if (!w.removable) continue;
    const ids = entries.filter((e) => groupRoot(entries, e.id) === w.id).map((e) => e.id);
    let ok = true;
    for (const id of ids) ok = safeRemove(workspaceDir(home, id)) && ok;
    if (ok) {
      removeRegistryEntries(home, ids);
      out.removedWorkspaces.push(w.id);
    }
  }
  return out;
}
