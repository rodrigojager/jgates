// The execution scope of a step: what every process the step starts inherits without the adapter passing it on
// (the cancellation signal, the log limit, where to report each process). Adapters keep calling runSpec as before.
import { AsyncLocalStorage } from "node:async_hooks";

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
