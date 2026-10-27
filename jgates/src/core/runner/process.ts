// One process of the local runner: executable + args with no shell, an allowlisted environment, stdout and stderr
// captured separately (in memory up to a limit, for the adapter to parse, and on disk up to a limit, as logs),
// a timeout and cancellation that stop the whole process tree, and the facts of the execution.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { BoundedCapture, BoundedLog } from "./log-sink.js";
import { currentScope, type ProcessRecord } from "./scope.js";
import { treeStopper, type TreeStopper } from "./tree.js";

export interface ExecutionSpec {
  executable: string;
  args: string[];
  cwd: string;
  /** Extra environment on top of the allowlisted parent variables. */
  env?: Record<string, string>;
  /** Text written to stdin (then closed); null/absent closes stdin at once. */
  stdin?: string | null;
  timeoutMs?: number;
  /** Log files the output streams into (cut at the log limit, with a truncation marker). */
  stdoutFile?: string;
  stderrFile?: string;
  /** Cancels the process tree; defaults to the signal of the execution scope. */
  signal?: AbortSignal;
}

export interface ExecutionResult {
  /** Exit code; null when the process was killed by a signal or never started. */
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** Stopped because the run was cancelled. */
  cancelled: boolean;
  /** In-memory output cut at the capture limit: what the adapter got is not the whole output. */
  truncated: boolean;
  /** The process could not be started (for example ENOENT). */
  spawnError: { code: string; message: string } | null;
  pid: number | null;
  startedAt: string;
  finishedAt: string;
  stdoutBytes: number;
  stderrBytes: number;
  /** A log file on disk was cut at the log limit. */
  logTruncated: boolean;
}

export interface RunnerOptions {
  /** Parent environment the allowlist is read from; defaults to process.env. */
  parentEnv?: NodeJS.ProcessEnv;
  /** Variable names copied from the parent environment. */
  envAllowlist?: readonly string[];
  /** Per-stream in-memory capture limit in bytes. */
  maxOutputBytes?: number;
  /** Per-stream limit of the log files on disk. */
  maxLogBytes?: number;
  /** Between SIGTERM and SIGKILL when the tree is stopped. */
  killGraceMs?: number;
}

/** Variables every scanner may need to start; nothing else leaks from the parent (tokens, proxies, credentials). */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
];

export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_LOG_BYTES = 16 * 1024 * 1024;
export const DEFAULT_KILL_GRACE_MS = 3000;
/** After the main process exits, how long its pipes may stay open (held by a leftover grandchild) before the tree is stopped. */
const LINGER_MS = 500;

/** The environment a spec runs with: allowlisted parent variables, then the spec's own. */
export function buildEnv(spec: Pick<ExecutionSpec, "env">, options: RunnerOptions = {}): NodeJS.ProcessEnv {
  const parent = options.parentEnv ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const name of options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...(spec.env ?? {}) };
}

/** Replaces {token} placeholders of the plan (for example {runDir}, {workspace}) in a text. */
export function substituteTokens(text: string, tokens: Record<string, string>): string {
  let out = text;
  for (const [name, value] of Object.entries(tokens)) out = out.split(`{${name}}`).join(value);
  return out;
}

const header = (spec: ExecutionSpec): string => `executable: ${spec.executable}\nargs: ${JSON.stringify(spec.args)}\ncwd: ${spec.cwd}\n---\n`;

export function runSpec(spec: ExecutionSpec, options: RunnerOptions = {}): Promise<ExecutionResult> {
  const scope = currentScope();
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const captureLimit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const logLimit = options.maxLogBytes ?? scope?.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  const graceMs = options.killGraceMs ?? scope?.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const abort = spec.signal ?? scope?.signal;
  const group = process.platform !== "win32";

  return new Promise((resolve) => {
    const out = new BoundedCapture(captureLimit);
    const err = new BoundedCapture(captureLimit);
    let outBytes = 0;
    let errBytes = 0;
    let outLog: BoundedLog | null = null;
    let errLog: BoundedLog | null = null;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let exited: { code: number | null; signal: string | null } | null = null;
    let timer: NodeJS.Timeout | undefined;
    let linger: NodeJS.Timeout | undefined;
    let stopper: TreeStopper | null = null;
    let pid: number | null = null;

    const finish = (partial: Pick<ExecutionResult, "exitCode" | "signal" | "spawnError">): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (linger) clearTimeout(linger);
      abort?.removeEventListener("abort", onAbort);
      // Nothing the tool started outlives it: what is left of its process group is stopped (the run's own resources only).
      if (stopper) {
        stopper.rootExited();
        stopper.force();
      }
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - started;
      const footer = `\n---\nexit code: ${partial.exitCode ?? "(none)"}\nsignal: ${partial.signal ?? "(none)"}\nduration ms: ${durationMs}\n${timedOut ? "timed out\n" : ""}${cancelled ? "cancelled\n" : ""}${partial.spawnError ? `spawn error: ${partial.spawnError.code}: ${partial.spawnError.message}\n` : ""}`;
      const logTruncated = Boolean(outLog?.truncated || errLog?.truncated);
      try {
        outLog?.close();
        errLog?.close(footer);
      } catch {
        // A log that cannot be closed does not change the facts of the execution.
      }
      const result: ExecutionResult = {
        ...partial,
        stdout: out.text(),
        stderr: err.text(),
        durationMs,
        timedOut,
        cancelled,
        truncated: out.truncated || err.truncated,
        pid,
        startedAt,
        finishedAt,
        stdoutBytes: outBytes,
        stderrBytes: errBytes,
        logTruncated,
      };
      const record: ProcessRecord = {
        pid,
        executable: spec.executable,
        startedAt,
        finishedAt,
        durationMs,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut,
        cancelled,
        stdoutBytes: outBytes,
        stderrBytes: errBytes,
        logTruncated,
        spawnError: partial.spawnError ? `${partial.spawnError.code}: ${partial.spawnError.message}` : null,
      };
      try {
        scope?.onProcessEnd?.(record);
      } finally {
        resolve(result);
      }
    };

    function onAbort(): void {
      if (settled) return;
      cancelled = true;
      stopper?.stop();
    }

    try {
      if (spec.stdoutFile) outLog = new BoundedLog(spec.stdoutFile, logLimit);
      if (spec.stderrFile) errLog = new BoundedLog(spec.stderrFile, logLimit, header(spec));
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      finish({ exitCode: null, signal: null, spawnError: { code: e.code ?? "LOG_UNWRITABLE", message: e.message } });
      return;
    }

    if (abort?.aborted) {
      cancelled = true;
      finish({ exitCode: null, signal: null, spawnError: null });
      return;
    }
    let cwdOk = false;
    try {
      cwdOk = fs.statSync(spec.cwd).isDirectory();
    } catch {
      cwdOk = false;
    }
    if (!cwdOk) {
      finish({ exitCode: null, signal: null, spawnError: { code: "CWD_MISSING", message: `working directory not found: ${spec.cwd}` } });
      return;
    }

    let child;
    try {
      child = spawn(spec.executable, spec.args, {
        cwd: spec.cwd,
        env: buildEnv(spec, options),
        shell: false,
        windowsHide: true,
        // Own process group on Unix: stopping the run stops every process the tool started (by pid, never by name).
        detached: group,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      finish({ exitCode: null, signal: null, spawnError: { code: e.code ?? "SPAWN_FAILED", message: e.message } });
      return;
    }
    pid = child.pid ?? null;
    if (pid !== null) stopper = treeStopper(pid, { group, graceMs });
    scope?.onProcessStart?.({ pid, executable: spec.executable });

    child.on("error", (error: NodeJS.ErrnoException) => finish({ exitCode: null, signal: null, spawnError: { code: error.code ?? "SPAWN_FAILED", message: error.message } }));
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      out.write(chunk);
      outLog?.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errBytes += chunk.length;
      err.write(chunk);
      errLog?.write(chunk);
    });
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      stopper?.rootExited();
      // A grandchild that still holds the pipes keeps "close" from firing: stop what is left of the tree, then stop waiting.
      linger = setTimeout(() => {
        stopper?.force();
        linger = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish({ exitCode: exited?.code ?? null, signal: exited?.signal ?? null, spawnError: null });
        }, LINGER_MS);
      }, LINGER_MS);
    });
    child.on("close", (code, signal) => finish({ exitCode: exited?.code ?? code, signal: exited?.signal ?? signal, spawnError: null }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(spec.stdin ?? undefined);
    abort?.addEventListener("abort", onAbort, { once: true });
    if (spec.timeoutMs !== undefined && spec.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        stopper?.stop();
      }, spec.timeoutMs);
    }
  });
}
