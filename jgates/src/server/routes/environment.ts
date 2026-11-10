// Environment: the same diagnosis as `jgates doctor` (engine, tools image, the image's tools) and the explicit
// preparation of an instance's data ("Preparar": the Semgrep rules).
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrepareError, diagnoseEnvironment, prepareInstance, previewPrepare } from "../../core/prepare/index.js";
import { refreshPath } from "../../core/env-refresh/index.js";
import { readCodeqlStatusSync } from "../../core/codeql-prepare/index.js";
import { updateData } from "../../core/data/index.js";
import { collectStatus, runSetup, type LifecycleReason, type StatusReport } from "../../core/lifecycle/index.js";
import { resolveReason } from "../../core/reasons/index.js";
import { normalizeLocale, translator } from "../../i18n/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";
import { ID_PATTERN } from "./tools.js";

const STATUS_FOR: Record<string, number> = { INSTANCE_NOT_FOUND: 404, PREPARE_NOT_SUPPORTED: 422, VERSION_DOWNGRADE: 409, IMAGE_NOT_FOUND: 422, RUNTIME_MISSING: 422 };

function toHttp(error: PrepareError): HttpError {
  return new HttpError(STATUS_FOR[error.code] ?? 422, error.code, error.message, error.fix, error.details);
}

const ENGINE_CODES = new Set(["ENGINE_NOT_INSTALLED", "ENGINE_STOPPED", "ENGINE_LOW_MEMORY", "UNSUPPORTED_PLATFORM", "ENGINE_LOST"]);
const MAX_WAIT_MS = 25_000;
const MAX_JOBS = 20;
const LOCALE_QUERY = { type: "object", properties: { locale: { type: "string", enum: ["en", "pt-BR"] } }, additionalProperties: false };

const withReasons = <T extends object>(section: T, reasons: LifecycleReason[]): T & { reasons: LifecycleReason[] } => ({ ...section, reasons });

/**
 * Every section of the environment with its state and its reasons (the shared catalogue's text and action), read fresh
 * at every call: nothing is cached, so a Docker installed or started after the server began shows on the next check.
 */
export async function environmentState(server: ServerContext, locale?: string): Promise<Record<string, unknown>> {
  const status: StatusReport = await collectStatus({ env: process.env, version: server.version, projectDir: server.projectDir, ...(locale ? { locale } : {}) });
  const all = [...status.reasons, ...status.warnings];
  const engineReasons = all.filter((r) => ENGINE_CODES.has(r.code));
  const imageReasons = all.filter((r) => r.code.startsWith("IMAGE_") || r.code === "DISK_LOW");
  const dataReasons = all.filter((r) => r.code.startsWith("DATA_"));

  const units = status.workspace?.dependencies ?? [];
  const dependencyReasons: LifecycleReason[] = [];
  for (const unit of units) {
    const code = unit.state === "failed" ? "DEPENDENCIES_FAILED" : unit.state === "ready" ? null : "DEPENDENCIES_NOT_READY";
    if (!code) continue;
    const r = resolveReason(code, { component: unit.components.join(", ") }, locale);
    dependencyReasons.push({ code, message: r.message, action: r.action });
  }
  const dependencyState = units.length === 0 ? "none" : units.some((u) => u.state === "failed") ? "failed" : units.every((u) => u.state === "ready") ? "ready" : "not-ready";

  // CodeQL is customer supplied: its volume is read only when the image can run the helper that reads it.
  let codeql: Record<string, unknown>;
  if (status.image.state === "ready" || status.image.state === "version-mismatch") {
    const read = status.image.state === "ready" ? readCodeqlStatusSync(process.env, server.version) : { state: "no-image" as const, status: null };
    const prepared = read.status !== null;
    const cause = prepared ? [] : [{ code: "CUSTOMER_SUPPLIED", ...(({ message, action }) => ({ message, action }))(resolveReason("CUSTOMER_SUPPLIED", { tool: "CodeQL" }, locale)) }];
    codeql = { state: prepared ? "prepared" : "not-prepared", read: read.state, version: read.status?.version ?? null, preparedAt: read.status?.preparedAt ?? null, reasons: cause };
  } else {
    codeql = { state: "unknown", read: "no-image", version: null, preparedAt: null, reasons: [] };
  }

  const sections = {
    engine: withReasons(status.engine, engineReasons),
    image: withReasons(status.image, imageReasons),
    data: withReasons(status.data, dataReasons),
    dependencies: { state: dependencyState, units, reasons: dependencyReasons },
    services: { state: (status.workspace?.services.running ?? 0) > 0 ? "running" : "stopped", running: status.workspace?.services.running ?? 0, reasons: [] },
    extension: { state: status.extension.images.length > 0 ? "present" : "none", images: status.extension.images, reasons: [] },
    codeql,
  };
  return { schemaVersion: 1, status: "OK", mode: status.mode, ready: status.ready, checkedAt: new Date().toISOString(), disk: status.disk, reasons: status.reasons, warnings: status.warnings, sections };
}

// ---- preparation jobs ------------------------------------------------------------------------------------------------

type JobKind = "pull" | "data" | "dependencies";

interface Job {
  id: string;
  kind: JobKind;
  state: "running" | "done" | "failed";
  events: Array<Record<string, unknown> & { seq: number }>;
  waiters: Set<() => void>;
}

const jobsOf = new WeakMap<ServerContext, Map<string, Job>>();

function jobsFor(server: ServerContext): Map<string, Job> {
  let map = jobsOf.get(server);
  if (!map) {
    map = new Map();
    jobsOf.set(server, map);
  }
  return map;
}

function push(job: Job, event: Record<string, unknown>): void {
  job.events.push({ ...event, seq: job.events.length + 1 });
  for (const wake of [...job.waiters]) wake();
}

function finishJob(job: Job, ok: boolean, result: Record<string, unknown>): void {
  job.state = ok ? "done" : "failed";
  push(job, { type: "end", ok, ...result });
}

function cliMain(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli", "main.js");
}

function startJob(server: ServerContext, kind: JobKind, locale?: string): Job {
  const job: Job = { id: `job_${crypto.randomBytes(6).toString("hex")}`, kind, state: "running", events: [], waiters: new Set() };
  push(job, { type: "start", kind });
  const failed = (error: unknown): void => finishJob(job, false, { error: error instanceof Error ? error.message : String(error) });
  if (kind === "pull") {
    // The same steps as `jgates setup` (engine, disk, image, volumes), without the advisory data: that is its own job.
    runSetup({ env: process.env, version: server.version, projectDir: server.projectDir, withData: false, ...(locale ? { locale } : {}), onEvent: (event) => push(job, { ...event }) })
      .then((result) => finishJob(job, result.ready, { ready: result.ready, pulled: result.pulled, steps: result.steps, reasons: result.reasons }))
      .catch(failed);
  } else if (kind === "data") {
    updateData({ env: process.env, version: server.version, onProgress: (event) => push(job, { type: "data-update", ...event }) })
      .then((result) => finishJob(job, !result.blocked && result.databases.every((d) => d.ok), { databases: result.databases, ...(result.blocked ? { blocked: result.blocked } : {}) }))
      .catch(failed);
  } else {
    // The dependencies are the CLI's `deps prepare` in a child process (one code path, one set of logs).
    const child = spawn(process.execPath, [cliMain(), "deps", "prepare", "--json", "--cwd", server.projectDir], { cwd: server.projectDir, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.on("error", failed);
    child.on("exit", (code) => {
      let doc: { units?: unknown[]; code?: string } = {};
      try {
        doc = JSON.parse(out) as typeof doc;
      } catch {
        doc = {};
      }
      for (const unit of doc.units ?? []) push(job, { type: "dependencies-unit", unit });
      finishJob(job, code === 0, { exitCode: code, ...(doc.code ? { code: doc.code } : {}) });
    });
  }
  const map = jobsFor(server);
  map.set(job.id, job);
  // Keep the last few finished jobs only.
  for (const [id, old] of map) {
    if (map.size <= MAX_JOBS) break;
    if (old.state !== "running") map.delete(id);
  }
  return job;
}

const publicJob = (job: Job) => ({ id: job.id, kind: job.kind, state: job.state });

export const routes: RouteDefinition[] = [
  {
    // Every section (engine, image, data, dependencies, services, extension, CodeQL) with its state and its reasons.
    method: "GET",
    path: "/api/environment/state",
    query: LOCALE_QUERY,
    async handler({ server, query }) {
      if (!server.policyMode) refreshPath({ force: true });
      const locale = normalizeLocale(query.locale) ?? undefined;
      return { status: 200, json: await environmentState(server, locale) };
    },
  },
  {
    // Starts a preparation (the image pull, the advisory data, the project's dependencies); one running job per kind.
    method: "POST",
    path: "/api/environment/jobs",
    body: {
      type: "object",
      properties: { kind: { type: "string", enum: ["pull", "data", "dependencies"] }, locale: { type: "string", enum: ["en", "pt-BR"] } },
      required: ["kind"],
      additionalProperties: false,
    },
    handler({ body, server }) {
      if (server.policyMode) throw new HttpError(409, "POLICY_MODE", translator("reasons")("env_api_policy_mode"), null);
      const input = body as { kind: JobKind; locale?: string };
      const running = [...jobsFor(server).values()].find((j) => j.kind === input.kind && j.state === "running");
      if (running) return { status: 200, json: { schemaVersion: 1, status: "OK", job: publicJob(running), reused: true } };
      refreshPath({ force: true });
      const job = startJob(server, input.kind, normalizeLocale(input.locale) ?? undefined);
      server.log(`environment job ${job.kind} ${job.id}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", job: publicJob(job), reused: false } };
    },
  },
  {
    // The events of a job after the cursor (`after`: the last `seq` the caller has), waiting up to `wait` ms for news.
    method: "GET",
    path: "/api/environment/jobs/:id",
    params: { type: "object", properties: { id: { type: "string", pattern: "^job_[0-9a-f]{12}$" } }, required: ["id"], additionalProperties: false },
    query: { type: "object", properties: { after: { type: "string", pattern: "^[0-9]{1,9}$" }, wait: { type: "string", pattern: "^[0-9]{1,6}$" } }, additionalProperties: false },
    async handler({ params, query, server }) {
      const job = jobsFor(server).get(params.id as string);
      if (!job) throw new HttpError(404, "JOB_NOT_FOUND", translator("reasons")("env_api_job_not_found"), null);
      const after = Number(query.after ?? 0);
      const wait = Math.min(Number(query.wait ?? 0), MAX_WAIT_MS);
      if (wait > 0 && job.state === "running" && job.events.length <= after) {
        await new Promise<void>((resolve) => {
          const wake = (): void => {
            clearTimeout(timer);
            job.waiters.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, wait);
          job.waiters.add(wake);
        });
      }
      const events = job.events.filter((e) => e.seq > after);
      return { status: 200, json: { schemaVersion: 1, status: "OK", job: publicJob(job), events, next: job.events.length } };
    },
  },
  {
    method: "GET",
    path: "/api/environment",
    handler({ server }) {
      if (!server.policyMode) refreshPath();
      return { status: 200, json: { status: "OK", ...diagnoseEnvironment(server.projectDir) } };
    },
  },
  {
    // dryRun (the default) only shows versions and network; false downloads, stores and pins.
    method: "POST",
    path: "/api/environment/prepare",
    body: {
      type: "object",
      properties: {
        instance: { type: "string", pattern: ID_PATTERN },
        dryRun: { type: "boolean" },
        allowVersionChange: { type: "boolean" },
      },
      required: ["instance"],
      additionalProperties: false,
    },
    timeoutMs: 180_000,
    async handler({ body, server }) {
      const input = body as { instance: string; dryRun?: boolean; allowVersionChange?: boolean };
      if (!server.policyMode) refreshPath({ force: true });
      try {
        const preview = previewPrepare(server.projectDir, input.instance);
        if (input.dryRun !== false) return { status: 200, json: { schemaVersion: 1, status: "OK", dryRun: true, preview } };
        const result = await prepareInstance(server.projectDir, input.instance, { allowVersionChange: input.allowVersionChange === true });
        server.log(`prepare ${input.instance} ${result.rules.hash}`);
        return { status: 200, json: { schemaVersion: 1, status: "OK", dryRun: false, preview, result, environment: diagnoseEnvironment(server.projectDir) } };
      } catch (error) {
        if (error instanceof PrepareError) throw toHttp(error);
        throw error;
      }
    },
  },
];
