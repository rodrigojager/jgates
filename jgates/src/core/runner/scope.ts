// The execution scope of a step: what every process the step starts inherits without the adapter passing it on
// (the cancellation signal, the log limit, where to report each process). Adapters keep calling runSpec as before.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionResult, ExecutionSpec, RunnerOptions } from "./process.js";

/** What the plan says about the step that is running: its network and its resources (from the manifest). */
export interface StepLaunchFacts {
  network?: "none" | "bridge";
  resources?: { memoryMb?: number; cpus?: number; tmpfsMb?: number };
}

/**
 * Takes over the processes of a step: when `handles` says yes, runSpec does not spawn the executable on the host and
 * `run` decides what happens instead (a step container, or a refusal). Engine client commands are never handled.
 */
export interface StepLauncherHook {
  handles(spec: ExecutionSpec): boolean;
  run(spec: ExecutionSpec, options: RunnerOptions): Promise<ExecutionResult>;
}

export interface ProcessRecord {
  pid: number | null;
  executable: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  /** A log file on disk was cut at the limit. */
  logTruncated: boolean;
  spawnError: string | null;
}

export interface ExecutionScope {
  /** Step the processes belong to. */
  stepId?: string;
  signal?: AbortSignal;
  /** Per-stream limit of the log files written on disk. */
  maxLogBytes?: number;
  /** Time between the request to stop (SIGTERM) and the forced stop (SIGKILL). */
  killGraceMs?: number;
  /** Container-first: every process of the step goes through this launcher instead of the host. */
  launcher?: StepLauncherHook;
  launch?: StepLaunchFacts;
  onProcessStart?: (info: { pid: number | null; executable: string }) => void;
  onProcessEnd?: (record: ProcessRecord) => void;
}

const storage = new AsyncLocalStorage<ExecutionScope>();

export function runInScope<T>(scope: ExecutionScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function currentScope(): ExecutionScope | undefined {
  return storage.getStore();
}
