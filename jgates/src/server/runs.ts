// Runs started from the UI. The server never runs tools itself: it hands the reviewed plan to the same CLI
// (`jgates run --plan <file> --json`) in a child process, so the UI does exactly what the CLI does, and
// cancelling stops that child.
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plan } from "../core/plan/index.js";

export type JobState = "running" | "finished" | "failed" | "cancelled";

export interface RunEvent {
  seq: number;
  at: string;
  type: "started" | "log" | "finished" | "failed" | "cancel-requested" | "cancelled";
  data: Record<string, unknown>;
}

export interface RunJob {
  id: string;
  state: JobState;
  planHash: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  runId: string | null;
  decision: string | null;
  error: { code: string; message: string } | null;
  result: unknown;
  /** JSONL stream of the runner's events (steps, stages, cancellation), read by cursor for the Acompanhar screen. */
  eventsFile: string;
  events: RunEvent[];
  child: ChildProcess | null;
  waiters: Set<() => void>;
}

const MAX_EVENTS = 5000;
const MAX_LINE = 2000;
const MAX_STDOUT = 32 * 1024 * 1024;

export const JOB_ID_PATTERN = "^job_[0-9a-f]{16}$";
export const RUN_ID_PATTERN = "^run_[0-9]{8}T[0-9]{6}Z_[0-9a-f]{8}$";

function cliMain(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "main.js");
}

export interface RunManagerOptions {
  projectDir: string;
  /** Folder where the plans handed to runs are written (0700). */
  plansDir: string;
  env?: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

export class RunManager {
  private readonly jobs = new Map<string, RunJob>();

  constructor(private readonly opts: RunManagerOptions) {}

  get active(): RunJob | null {
    for (const job of this.jobs.values()) if (job.state === "running") return job;
    return null;
  }

  get(id: string): RunJob | null {
    return this.jobs.get(id) ?? null;
  }

  private push(job: RunJob, type: RunEvent["type"], data: Record<string, unknown> = {}): void {
    if (job.events.length < MAX_EVENTS || type !== "log") {
      job.events.push({ seq: job.events.length, at: new Date().toISOString(), type, data });
    }
    for (const wake of job.waiters) wake();
    job.waiters.clear();
  }

  /** Starts the run of a plan in a child process; one run at a time per server (the caller checks `active`). */
  start(plan: Plan): RunJob {
    const id = `job_${crypto.randomBytes(8).toString("hex")}`;
    fs.mkdirSync(this.opts.plansDir, { recursive: true, mode: 0o700 });
    const hex = plan.planHash.replace(/^sha256:/, "");
    const planFile = path.join(this.opts.plansDir, `${hex}.json`);
    fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });

    const job: RunJob = {
      id,
      state: "running",
      planHash: plan.planHash,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      runId: null,
      decision: null,
      error: null,
      result: null,
      eventsFile: path.join(this.opts.plansDir, `${id}.events.jsonl`),
      events: [],
      child: null,
      waiters: new Set(),
    };
    this.jobs.set(id, job);

    const args = [cliMain(), "run", "--cwd", this.opts.projectDir, "--plan", planFile, "--no-interactive", "--json", "--events-jsonl", job.eventsFile];
    const child = spawn(process.execPath, args, {
      cwd: this.opts.projectDir,
      env: this.opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group on POSIX, so cancelling stops the tools the run started too (by pid, never by name).
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    job.child = child;
    this.push(job, "started", { planHash: plan.planHash });
    this.opts.log(`run ${id} started`);

    const out: Buffer[] = [];
    let outSize = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      outSize += chunk.length;
      if (outSize <= MAX_STDOUT) out.push(chunk);
    });
    let pending = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) if (line !== "") this.push(job, "log", { stream: "stderr", text: line.slice(0, MAX_LINE) });
    });
    child.on("error", (error) => {
      if (job.state !== "running") return;
      job.state = "failed";
      job.finishedAt = new Date().toISOString();
      job.error = { code: "RUN_SPAWN_FAILED", message: error.message };
      job.child = null;
      this.push(job, "failed", { code: "RUN_SPAWN_FAILED" });
    });
    child.on("close", (code) => {
      if (pending !== "") this.push(job, "log", { stream: "stderr", text: pending.slice(0, MAX_LINE) });
      job.child = null;
      job.exitCode = code;
      job.finishedAt = new Date().toISOString();
      if (job.state === "cancelled" || job.events.some((e) => e.type === "cancel-requested")) {
        job.state = "cancelled";
        this.push(job, "cancelled", { exitCode: code });
        this.opts.log(`run ${id} cancelled`);
        return;
      }
      let doc: Record<string, unknown> | null = null;
      try {
        doc = JSON.parse(Buffer.concat(out).toString("utf8")) as Record<string, unknown>;
      } catch {
        doc = null;
      }
      if (doc && typeof doc.runId === "string") {
        job.state = "finished";
        job.runId = doc.runId;
        job.decision = typeof doc.decision === "string" ? doc.decision : null;
        job.result = doc;
        this.push(job, "finished", { runId: doc.runId, decision: job.decision, exitCode: code });
      } else {
        job.state = "failed";
        const err = doc && typeof doc.code === "string" ? { code: doc.code, message: typeof doc.message === "string" ? doc.message : doc.code } : { code: "RUN_FAILED", message: `exit ${code}` };
        job.error = err;
        job.result = doc;
        this.push(job, "failed", { code: err.code, exitCode: code });
      }
      this.opts.log(`run ${id} ${job.state}`);
    });
    return job;
  }

  /** Asks a running job to stop; returns false when it is no longer running. */
  cancel(job: RunJob): boolean {
    if (job.state !== "running" || !job.child) return false;
    this.push(job, "cancel-requested");
    const child = job.child;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Already gone.
      }
    };
    kill("SIGTERM");
    const hard = setTimeout(() => {
      if (job.child) kill("SIGKILL");
    }, 5000);
    hard.unref();
    return true;
  }

  /** Waits until the job has an event at or after `cursor`, it stops running, or `ms` elapse. */
  wait(job: RunJob, cursor: number, ms: number): Promise<void> {
    if (job.events.length > cursor || job.state !== "running" || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        job.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      job.waiters.add(done);
    });
  }

  /** Stops every running job and wakes every waiter (server shutdown). */
  shutdown(): void {
    for (const job of this.jobs.values()) {
      if (job.state === "running") this.cancel(job);
      for (const wake of job.waiters) wake();
      job.waiters.clear();
    }
  }
}

/** Public view of a job (no process handle, no waiters). */
export function jobView(job: RunJob, withResult = true): Record<string, unknown> {
  return {
    id: job.id,
    state: job.state,
    planHash: job.planHash,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    runId: job.runId,
    decision: job.decision,
    error: job.error,
    events: job.events.length,
    ...(withResult ? { result: job.result } : {}),
  };
}
