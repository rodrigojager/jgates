// The sync phase of a run: before the steps, the project is synchronized into the workspace's source volume. It reports
// its counts and the exclusion list in the phase events and in its own log block (logs/sync.log).
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { EngineError, engineRuntime, inspectImageSync, type EngineContext } from "../engine/index.js";
import type { PhaseOutcome, RunPhase } from "../runner/executor.js";
import { loadWorkspaceSettings } from "../discovery/index.js";
import { toolsImageTarget } from "../tools-image/index.js";
import { SyncError, syncProject, type SyncResult } from "./index.js";

export const SYNC_PHASE_ID = "sync";
export const SYNC_LOG = "logs/sync.log";

export interface SyncPhaseInput {
  /** The folder the steps analyze (the workspace, or the snapshot of a commit). */
  projectDir: string;
  /** Workspace id (ws_<16 hex>) of the run. */
  workspace: string;
  runId: string;
  /** The run folder; the log goes to <runDir>/logs/sync.log. */
  runDir: string;
  version: string;
  home: string;
  env?: NodeJS.ProcessEnv;
  engine?: EngineContext;
}

/** Details of the phase for events and result: counts, the volume and the exclusion list. */
export function syncDetails(result: SyncResult): Record<string, unknown> {
  return {
    workspace: result.workspace,
    volume: result.volume,
    createdVolume: result.createdVolume,
    totalFiles: result.totalFiles,
    changedFiles: result.changedFiles,
    deletedFiles: result.deletedFiles,
    skippedFiles: result.skippedFiles,
    bytes: result.bytes,
    exclusions: result.exclusions,
    buildOutputs: result.buildOutputs,
    excludePatterns: result.excludePatterns,
    excludedPaths: result.excludedPaths,
    scanMs: result.scanMs,
    copyMs: result.copyMs,
    durationMs: result.durationMs,
  };
}

function writeLog(runDir: string, text: string): string[] {
  try {
    fs.mkdirSync(path.join(runDir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(runDir, SYNC_LOG), text);
    return [SYNC_LOG];
  } catch {
    return [];
  }
}

export function syncLogText(result: SyncResult, locale?: string): string {
  const t = translator("sync", locale);
  return (
    [
      t("sync_log_title"),
      t("sync_log_volume", { volume: result.volume, state: result.createdVolume ? t("sync_log_volume_new") : t("sync_log_volume_existing") }),
      t("sync_log_counts", { total: result.totalFiles, changed: result.changedFiles, deleted: result.deletedFiles }),
      ...(result.skippedFiles > 0 ? [t("sync_log_skipped", { count: result.skippedFiles })] : []),
      t("sync_log_timing", { scan: result.scanMs, copy: result.copyMs, total: result.durationMs, bytes: result.bytes }),
      t("sync_log_exclusions", { names: result.exclusions.join(", ") }),
      t("sync_log_build_outputs", { names: result.buildOutputs.join(", ") }),
      ...(result.excludePatterns.length > 0 ? [t("sync_log_patterns", { patterns: result.excludePatterns.join(", ") })] : []),
      ...(result.excludedPaths.length > 0 ? [t("sync_log_excluded_found", { paths: result.excludedPaths.slice(0, 50).join(", ") })] : []),
    ].join("\n") + "\n"
  );
}

/** The phase of a run; never throws (a failure is the phase's outcome and blocks the steps). */
export function createSyncPhase(input: SyncPhaseInput): RunPhase {
  const env = input.env ?? process.env;
  const engine: EngineContext = input.engine ?? { runtime: engineRuntime(env), runnerOptions: { parentEnv: env } };
  const t = translator("sync");
  return {
    id: SYNC_PHASE_ID,
    label: t("sync_phase_label"),
    async run(): Promise<PhaseOutcome> {
      try {
        const reference = env.JGATES_TOOLS_IMAGE?.trim() || toolsImageTarget(env).reference;
        const image = inspectImageSync(reference, engine);
        if (!image) return { ok: false, code: "IMAGE_MISSING", reason: t("sync_failed_image", { image: reference }), details: { image: reference } };
        const result = await syncProject({
          projectDir: input.projectDir,
          workspace: input.workspace,
          image: image.id,
          version: input.version,
          run: input.runId,
          home: input.home,
          context: engine,
          excludePatterns: loadWorkspaceSettings(input.projectDir).settings.exclude,
        });
        return { ok: true, details: syncDetails(result), logs: writeLog(input.runDir, syncLogText(result)) };
      } catch (error) {
        const raw = error instanceof SyncError || error instanceof EngineError ? error.details : "";
        const message = error instanceof Error ? error.message : String(error);
        const logs = writeLog(input.runDir, `${t("sync_log_title")}\n${t("sync_log_failed", { message })}\n${raw}\n`);
        return { ok: false, code: "SYNC_FAILED", reason: t("sync_failed", { message }), details: { message, engine: raw }, logs };
      }
    },
  };
}
