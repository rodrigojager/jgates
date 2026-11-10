// Source volume synchronization (S0 prototype): a helper container copies the project, bind-mounted read-only at
// /host, into the workspace's source volume `jgates-<ws>-src` at /dst. Changed files are copied, removed ones deleted,
// the excluded directories are never copied (and never deleted from the volume, so a dependency volume mounted at
// `.venv` stays). The project itself is only read. The production phase (`jgates internal sync`, exec bits from the
// Git index, run events) replaces the rsync command; the exclusion list is the versioned constant both use.
import {
  IMAGE_USER,
  ensureVolume,
  engineLabels,
  runInEngine,
  sourceVolumeName,
  type EngineContext,
  type EngineRunResult,
} from "../engine/index.js";

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

export const SYNC_HOST_MOUNT = "/host";
export const SYNC_DESTINATION = "/dst";

/**
 * The rsync command of the helper: incremental by size and modification time, deletes what the project removed.
 * New files get fixed modes (directories 755, files 644): a Windows bind mount shows every file as executable, which
 * tools report (ruff EXE002 on every module); the production phase sets the executable bits from the Git index.
 */
export function syncCommand(excluded: readonly string[] = SYNC_EXCLUDED_DIRECTORIES): string[] {
  return ["rsync", "--recursive", "--links", "--times", "--delete", "--chmod=D755,F644", "--stats", ...excluded.map((name) => `--exclude=${name}/`), `${SYNC_HOST_MOUNT}/`, `${SYNC_DESTINATION}/`];
}

export interface SyncCounts {
  /** Regular files in the project after the exclusions. */
  totalFiles: number;
  /** Files copied by this synchronization. */
  changedFiles: number;
  /** Files deleted from the volume because the project no longer has them. */
  deletedFiles: number;
}

const statNumber = (text: string, label: RegExp): number => {
  const match = label.exec(text);
  return match ? Number(match[1]!.replace(/[.,]/g, "")) : Number.NaN;
};

/** Counts from rsync `--stats` output. */
export function parseSyncStats(stdout: string): SyncCounts {
  return {
    totalFiles: statNumber(stdout, /Number of files: [\d.,]+ \(reg: ([\d.,]+)/),
    changedFiles: statNumber(stdout, /Number of regular files transferred: ([\d.,]+)/),
    deletedFiles: statNumber(stdout, /Number of deleted files: ([\d.,]+)/),
  };
}

export interface SyncInput {
  /** Absolute host path of the project (only read). */
  projectDir: string;
  /** Workspace id (ws_<16 hex>). */
  workspace: string;
  /** Tools image id. */
  image: string;
  /** JGates version, for the labels. */
  version: string;
  run?: string;
  /** Extra labels on every object (for example org.jgates.dev=true). */
  extraLabels?: Record<string, string>;
  timeoutMs?: number;
  context?: EngineContext;
}

export interface SyncResult extends SyncCounts {
  volume: string;
  /** The source volume did not exist and was created by this synchronization. */
  createdVolume: boolean;
  durationMs: number;
  container: EngineRunResult;
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

/** Synchronizes the project into its source volume (created and owner-initialized on first use). */
export async function syncProject(input: SyncInput): Promise<SyncResult> {
  const started = Date.now();
  const context = input.context ?? {};
  const volume = sourceVolumeName(input.workspace);
  const labels = (kind: "sync" | "helper") =>
    engineLabels({ kind, version: input.version, workspace: input.workspace, ...(input.run ? { run: input.run } : {}), ...(input.extraLabels ? { extra: input.extraLabels } : {}) });
  const createdVolume = await ensureVolume(volume, { labels: labels("sync"), helperLabels: labels("helper"), image: input.image }, context);
  const container = await runInEngine(
    {
      image: input.image,
      command: syncCommand(),
      labels: labels("sync"),
      user: IMAGE_USER,
      network: "none",
      mounts: [
        { type: "bind", source: input.projectDir, target: SYNC_HOST_MOUNT, readonly: true },
        { type: "volume", source: volume, target: SYNC_DESTINATION },
      ],
      resources: { memoryMb: 512, cpus: 2, pids: 64 },
      timeoutMs: input.timeoutMs ?? 600_000,
    },
    context,
  );
  if (container.exitCode !== 0) throw new SyncError(`the synchronization of the project failed (exit ${String(container.exitCode)})`, (container.stderr || container.stdout).trim());
  return { volume, createdVolume, durationMs: Date.now() - started, container, ...parseSyncStats(container.stdout) };
}
