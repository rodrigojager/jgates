// Source volume synchronization (ADR-0004, PLAN-architecture.md section 5). A run copies the project into the
// workspace's source volume `jgates-<ws>-src` (at /workspace for the steps) before the steps start:
//  - the HOST decides what changed: it walks the project (minus the excluded directories), compares size, modification
//    time and mode with the manifest of the last successful sync (kept in the data folder, never in the project) and
//    packs only the changed files into one tar archive, plus a list of the paths the project no longer has;
//  - a helper container (labelled `sync`, no network) gets that stage folder read-only, deletes the removed paths and
//    unpacks the archive into the volume. The project itself is never mounted into any container, so nothing can write
//    to it. Measured on Windows: 10 000 files through a bind mount of the project took 53 s cold; streaming the same
//    files from the host takes about 1 s (PLAN-image.md section 4).
//  - executable bits come from the Git index (`git ls-files -s`) because Windows carries none; every other file is 644.
// The excluded directories are never copied and never deleted from the volume, so a dependency volume mounted at
// `.venv` or `node_modules` stays. `.git` is copied.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { workspaceId } from "../ids/index.js";
import { resolveHome, workspaceDir } from "../home/index.js";
import {
  IMAGE_USER,
  ensureVolume,
  engineLabels,
  runInEngine,
  sourceVolumeName,
  type EngineContext,
  type EngineRunResult,
} from "../engine/index.js";
import { TarWriter } from "./tar.js";

/** Directory names never copied into the source volume: host environments, platform builds and tool caches. */
export const SYNC_EXCLUDED_DIRECTORIES: readonly string[] = [
  ".venv",
  "venv",
  "node_modules",
  "target",
  "bin",
  "obj",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
];

/** A directory that holds a `pyvenv.cfg` is a Python virtual environment of the host (`env`, `.tox/py311`, ...). */
export const SYNC_EXCLUDED_MARKER = "pyvenv.cfg";

/** Where the helper finds the stage folder and the source volume. */
export const SYNC_STAGE_MOUNT = "/stage";
export const SYNC_DESTINATION = "/dst";
export const SYNC_ARCHIVE = "changes.tar";
export const SYNC_REMOVED = "removed.lst";

/**
 * The helper's script: removes what the project no longer has (NUL-separated, relative to the volume), then unpacks the
 * changed files with their modes. Plain sh, tar and xargs of the tools image.
 */
export const SYNC_SCRIPT = `set -e
cd ${SYNC_DESTINATION}
if [ -s ${SYNC_STAGE_MOUNT}/${SYNC_REMOVED} ]; then xargs -0 -a ${SYNC_STAGE_MOUNT}/${SYNC_REMOVED} rm -rf --; fi
if [ -s ${SYNC_STAGE_MOUNT}/${SYNC_ARCHIVE} ]; then tar -x -p --no-same-owner -f ${SYNC_STAGE_MOUNT}/${SYNC_ARCHIVE} -C ${SYNC_DESTINATION}; fi
`;

export function syncCommand(): string[] {
  return ["sh", "-c", SYNC_SCRIPT];
}

export type EntryKind = "f" | "d" | "l";

/** One path of the project as the sync sees it: [kind, size, mtimeMs, mode, link target]. */
export type ManifestEntry = [EntryKind, number, number, number, string?];

export interface SyncManifest {
  version: 1;
  volume: string;
  entries: Record<string, ManifestEntry>;
}

export interface ScanResult {
  entries: Map<string, ManifestEntry>;
  /** Directories skipped by the exclusion list (relative paths). */
  excludedFound: string[];
}

const toPosix = (p: string): string => p.split(path.sep).join("/");

/** Executable files of the Git index (`git ls-files -s`): mode 100755. Tracked non-executable files are known too. */
export function gitIndexModes(projectDir: string): Map<string, boolean> | null {
  const result = spawnSync("git", ["-c", "core.quotepath=off", "ls-files", "-s", "-z"], {
    cwd: projectDir,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error || result.status !== 0) return null;
  const modes = new Map<string, boolean>();
  for (const record of result.stdout.toString("utf8").split("\0")) {
    // "<mode> <object> <stage>\t<path>"
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const mode = record.slice(0, record.indexOf(" "));
    modes.set(record.slice(tab + 1), mode === "100755");
  }
  return modes;
}

/** Walks the project (excluded directories are not entered) and returns what the sync would copy. */
export function scanProject(projectDir: string, excluded: readonly string[] = SYNC_EXCLUDED_DIRECTORIES): ScanResult {
  const skip = new Set(excluded);
  const index = gitIndexModes(projectDir);
  const entries = new Map<string, ManifestEntry>();
  const excludedFound: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (rel !== "" && children.some((c) => c.name === SYNC_EXCLUDED_MARKER && c.isFile())) {
      excludedFound.push(rel);
      entries.delete(rel);
      return;
    }
    for (const child of children) {
      const childRel = rel === "" ? child.name : `${rel}/${child.name}`;
      const full = path.join(dir, child.name);
      if (child.isDirectory()) {
        if (skip.has(child.name)) {
          excludedFound.push(childRel);
          continue;
        }
        entries.set(childRel, ["d", 0, 0, 0o755]);
        walk(full, childRel);
      } else if (child.isSymbolicLink()) {
        try {
          const stat = fs.lstatSync(full);
          entries.set(childRel, ["l", 0, stat.mtimeMs, 0o777, fs.readlinkSync(full)]);
        } catch {
          // vanished while scanning
        }
      } else if (child.isFile()) {
        try {
          const stat = fs.lstatSync(full);
          const tracked = index?.get(childRel);
          const executable = tracked !== undefined ? tracked : process.platform === "win32" ? false : (stat.mode & 0o111) !== 0;
          entries.set(childRel, ["f", stat.size, stat.mtimeMs, executable ? 0o755 : 0o644]);
        } catch {
          // vanished while scanning
        }
      }
    }
  };
  walk(projectDir, "");
  return { entries, excludedFound: excludedFound.sort() };
}

export interface SyncPlan {
  /** Paths to send (new or different), sorted so a directory comes before what is inside it. */
  changed: string[];
  /** Paths to delete from the volume before unpacking (gone from the project, or of another kind now). */
  removed: string[];
  /** Files and links of the project after the exclusions. */
  totalFiles: number;
  changedFiles: number;
  deletedFiles: number;
}

const same = (a: ManifestEntry, b: ManifestEntry): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && (a[4] ?? "") === (b[4] ?? "");

/** What differs between the last synchronized state and the project now. */
export function planSync(previous: ReadonlyMap<string, ManifestEntry> | null, current: ReadonlyMap<string, ManifestEntry>): SyncPlan {
  const changed: string[] = [];
  const removed: string[] = [];
  let deletedFiles = 0;
  let changedFiles = 0;
  let totalFiles = 0;
  for (const [p, entry] of current) {
    if (entry[0] !== "d") totalFiles++;
    const before = previous?.get(p);
    if (before && same(before, entry)) continue;
    if (before && before[0] !== entry[0]) removed.push(p);
    changed.push(p);
    if (entry[0] !== "d") changedFiles++;
  }
  if (previous) {
    for (const [p, entry] of previous) {
      if (current.has(p)) continue;
      removed.push(p);
      if (entry[0] !== "d") deletedFiles++;
    }
  }
  changed.sort();
  // A removed directory takes its content with it (rm -rf); drop the paths already covered by a removed parent.
  removed.sort();
  const roots: string[] = [];
  for (const p of removed) if (!roots.some((r) => p.startsWith(`${r}/`))) roots.push(p);
  return { changed, removed: roots, totalFiles, changedFiles, deletedFiles };
}

export interface SyncCounts {
  /** Regular files and links in the project after the exclusions. */
  totalFiles: number;
  /** Files copied by this synchronization. */
  changedFiles: number;
  /** Files deleted from the volume because the project no longer has them. */
  deletedFiles: number;
}

export interface SyncInput {
  /** Absolute host path of the project (only read). */
  projectDir: string;
  /** Workspace id (ws_<16 hex>); derived from the project path when absent. */
  workspace?: string;
  /** Tools image id. */
  image: string;
  /** JGates version, for the labels. */
  version: string;
  run?: string;
  /** Data folder (the manifest and the stage folder live under workspaces/<ws>/sync); the default home. */
  home?: string;
  /** Extra labels on every object (for example org.jgates.dev=true). */
  extraLabels?: Record<string, string>;
  /** Directory names never copied (default: SYNC_EXCLUDED_DIRECTORIES). */
  excluded?: readonly string[];
  timeoutMs?: number;
  context?: EngineContext;
}

export interface SyncResult extends SyncCounts {
  workspace: string;
  volume: string;
  /** The source volume did not exist and was created by this synchronization (every file is sent). */
  createdVolume: boolean;
  /** Files that could not be read and were left for the next sync. */
  skippedFiles: number;
  /** Bytes of the archive sent to the volume. */
  bytes: number;
  /** Directory names of the exclusion list and the paths found and left out. */
  exclusions: string[];
  excludedPaths: string[];
  /** Time spent on the host (walking, comparing, packing) and in the helper container. */
  scanMs: number;
  copyMs: number;
  durationMs: number;
  /** The helper container; null when nothing had to be sent. */
  container: EngineRunResult | null;
}

export class SyncError extends Error {
  constructor(
    message: string,
    readonly details: string,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

export function syncStateDir(home: string, workspace: string): string {
  return path.join(workspaceDir(home, workspace), "sync");
}

function readManifest(file: string, volume: string): Map<string, ManifestEntry> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as SyncManifest;
    if (parsed.version !== 1 || parsed.volume !== volume) return null;
    return new Map(Object.entries(parsed.entries));
  } catch {
    return null;
  }
}

function writeManifest(file: string, volume: string, entries: ReadonlyMap<string, ManifestEntry>): void {
  const manifest: SyncManifest = { version: 1, volume, entries: Object.fromEntries(entries) };
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(manifest));
  fs.renameSync(temp, file);
}

/** Synchronizes the project into its source volume (created and owner-initialized on first use). */
export async function syncProject(input: SyncInput): Promise<SyncResult> {
  const started = Date.now();
  const context = input.context ?? {};
  const projectDir = path.resolve(input.projectDir);
  const workspace = input.workspace ?? workspaceId(projectDir);
  const volume = sourceVolumeName(workspace);
  const exclusions = [...(input.excluded ?? SYNC_EXCLUDED_DIRECTORIES)];
  const labels = (kind: "sync" | "helper") =>
    engineLabels({ kind, version: input.version, workspace, ...(input.run ? { run: input.run } : {}), ...(input.extraLabels ? { extra: input.extraLabels } : {}) });
  const createdVolume = await ensureVolume(volume, { labels: labels("sync"), helperLabels: labels("helper"), image: input.image }, context);

  const stateDir = syncStateDir(input.home ?? resolveHome(), workspace);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const manifestFile = path.join(stateDir, "manifest.json");
  // A volume created now is empty whatever an old manifest says.
  const previous = createdVolume ? null : readManifest(manifestFile, volume);

  const scanStarted = Date.now();
  const scan = scanProject(projectDir, exclusions);
  const plan = planSync(previous, scan.entries);
  const nextEntries = new Map(scan.entries);

  let skippedFiles = 0;
  let bytes = 0;
  let container: EngineRunResult | null = null;
  let copyMs = 0;
  let scanMs = 0;
  if (plan.changed.length > 0 || plan.removed.length > 0) {
    const stage = fs.mkdtempSync(path.join(stateDir, "stage-"));
    try {
      const writer = new TarWriter(path.join(stage, SYNC_ARCHIVE));
      for (const p of plan.changed) {
        const entry = scan.entries.get(p)!;
        const [kind, size, mtimeMs, mode, target] = entry;
        const ok =
          kind === "d"
            ? writer.add({ path: p, kind: "dir", mode, mtimeMs: Date.now() })
            : kind === "l"
              ? writer.add({ path: p, kind: "symlink", mode, mtimeMs, target: target ?? "" })
              : writer.add({ path: p, kind: "file", mode, mtimeMs, size, source: path.join(projectDir, ...p.split("/")) });
        if (!ok) {
          skippedFiles++;
          nextEntries.delete(p);
          // A file that cannot be read must not leave an old copy behind as if it were current.
          const before = previous?.get(p);
          if (before) nextEntries.set(p, before);
        }
      }
      writer.close();
      bytes = writer.bytes;
      fs.writeFileSync(path.join(stage, SYNC_REMOVED), plan.removed.map((p) => `${p}\0`).join(""));
      scanMs = Date.now() - scanStarted;
      const copyStarted = Date.now();
      container = await runInEngine(
        {
          image: input.image,
          command: syncCommand(),
          labels: labels("sync"),
          user: IMAGE_USER,
          network: "none",
          mounts: [
            { type: "bind", source: stage, target: SYNC_STAGE_MOUNT, readonly: true },
            { type: "volume", source: volume, target: SYNC_DESTINATION },
          ],
          resources: { memoryMb: 512, cpus: 2, pids: 64 },
          timeoutMs: input.timeoutMs ?? 600_000,
        },
        context,
      );
      copyMs = Date.now() - copyStarted;
      if (container.exitCode !== 0) throw new SyncError(`the synchronization of the project failed (exit ${String(container.exitCode)})`, (container.stderr || container.stdout).trim());
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  } else {
    scanMs = Date.now() - scanStarted;
  }
  writeManifest(manifestFile, volume, nextEntries);
  return {
    workspace,
    volume,
    createdVolume,
    skippedFiles,
    bytes,
    exclusions,
    excludedPaths: scan.excludedFound,
    scanMs,
    copyMs,
    durationMs: Date.now() - started,
    container,
    totalFiles: plan.totalFiles,
    changedFiles: plan.changedFiles - skippedFiles,
    deletedFiles: plan.deletedFiles,
  };
}
