// Environment: the same diagnosis as `jgates doctor` (engine, tools image, the image's tools) and the explicit
// preparation of an instance's data ("Preparar": the Semgrep rules).
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrepareError, diagnoseEnvironment, prepareInstance, previewPrepare } from "../../core/prepare/index.js";
import { refreshPath, refreshPathAsync } from "../../core/env-refresh/index.js";
import { CODEQL_TERMS_URL, prepareCodeql, readCodeqlStatusSync, releaseUrls } from "../../core/codeql-prepare/index.js";
import { updateData } from "../../core/data/index.js";
import { factsAsOf, invalidateEngineFacts, withEngineFacts } from "../../core/engine/facts.js";
import { collectStatus, runSetup, type LifecycleReason, type StatusReport } from "../../core/lifecycle/index.js";
import { resolveReason } from "../../core/reasons/index.js";
import { extensionState, hasExtension } from "../../core/extension/index.js";
import { readServicesConfig } from "../../core/services/index.js";
import { imageToolCatalogue } from "../../core/tools-image/index.js";
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

/** The tools the pinned tools image carries, with their versions (read from the package's mirror, nothing is started). */
function imageTools(): Array<{ name: string; version: string }> {
  const catalogue = imageToolCatalogue(process.env);
  return Object.entries(catalogue?.tools ?? {})
    .map(([name, version]) => ({ name, version }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** What jgates.yml says about the compose services: the files, the services to start and the application under test. */
function servicesOf(projectDir: string): { configured: boolean; compose: string[]; start: string[] | null; target: string | null } {
  const config = readServicesConfig(projectDir);
  if (!config) return { configured: false, compose: [], start: null, target: null };
  return { configured: true, compose: config.compose, start: config.start, target: config.target ? `${config.target.service}:${config.target.port}${config.target.path === "/" ? "" : config.target.path}` : null };
}

/** The project's own image: built for the current key, to be rebuilt (EXTENSION_OUTDATED), or not there. */
function extensionOf(server: ServerContext, status: StatusReport, locale?: string): Record<string, unknown> {
  const images = status.extension.images;
  const hasDockerfile = hasExtension(server.projectDir);
  if (!hasDockerfile) return { state: images.length > 0 ? "present" : "none", images, dockerfile: false, reasons: [] };
  const baseDigest = status.image.state === "ready" ? status.image.id : null;
  let built: { status: string; tag: string | null } = { status: "unknown", tag: null };
  try {
    built = extensionState({ projectDir: server.projectDir, workspace: status.workspace?.id ?? "ws_unknown", env: process.env, baseDigest });
  } catch {
    // The state of the image could not be read: shown as present, never as a failure of the whole screen.
  }
  if (built.status === "outdated") {
    const resolved = resolveReason("EXTENSION_OUTDATED", {}, locale);
    return { state: "outdated", images, dockerfile: true, tag: built.tag, reasons: [{ code: "EXTENSION_OUTDATED", message: resolved.message, action: resolved.action }] };
  }
  return { state: "present", images, dockerfile: true, tag: built.tag, reasons: [] };
}

/**
 * The one definition of ready, for the environment state, the overview and the doctor card: the engine, image and
 * dependencies in a usable state; the advisory data is a warning, not a blocker (inside the tools image there is no
 * engine or image to ask for). Pure: it reads a status, so the doctor can use it without the environment's other reads.
 */
export function readinessOf(status: StatusReport): { ready: boolean; notReady: Array<"engine" | "image" | "dependencies"> } {
  const units = status.workspace?.dependencies ?? [];
  const dependencies = units.length === 0 ? "none" : units.some((u) => u.state === "failed") ? "failed" : units.every((u) => u.state === "ready") ? "ready" : "not-ready";
  const states: Record<"engine" | "image" | "dependencies", { state: string; ok: string[] }> = {
    engine: { state: String(status.engine.state), ok: ["ready"] },
    image: { state: String(status.image.state), ok: ["ready"] },
    dependencies: { state: dependencies, ok: ["ready", "none"] },
  };
  const notReady = (["engine", "image", "dependencies"] as const).filter((id) => !(status.mode === "in-image" && id !== "dependencies") && !states[id].ok.includes(states[id].state));
  return { ready: status.ready && notReady.length === 0, notReady };
}

/**
 * Every section of the environment with its state and its reasons (the shared catalogue's text and action). Called
 * inside withEngineFacts, the engine answers come from the cached facts: a working engine's answers are a few seconds
 * old at most and refreshed in the background, while a missing or stopped engine is asked again at every call, so a
 * Docker installed or started after the server began shows on the next check.
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
    codeql = { termsUrl: CODEQL_TERMS_URL, state: prepared ? "prepared" : "not-prepared", read: read.state, version: read.status?.version ?? null, preparedAt: read.status?.preparedAt ?? null, reasons: cause };
  } else {
    codeql = { termsUrl: CODEQL_TERMS_URL, state: "unknown", read: "no-image", version: null, preparedAt: null, reasons: [] };
  }

  const sections = {
    engine: withReasons(status.engine, engineReasons),
    image: withReasons({ ...status.image, sizeBytes: status.disk.images.find((i) => i.name === status.image.reference)?.sizeBytes ?? status.disk.images[0]?.sizeBytes ?? null, tools: imageTools() }, imageReasons),
    data: withReasons(status.data, dataReasons),
    dependencies: { state: dependencyState, units, volumes: status.disk.volumes.filter((v) => v.name.includes("-deps-")), reasons: dependencyReasons },
    services: { state: (status.workspace?.services.running ?? 0) > 0 ? "running" : "stopped", running: status.workspace?.services.running ?? 0, ...servicesOf(server.projectDir), reasons: [] },
    extension: extensionOf(server, status, locale),
    codeql,
  };
  // When the engine was read: the oldest cached answer used, or now.
  const checkedAt = factsAsOf() ?? new Date().toISOString();
  const { ready, notReady } = readinessOf(status);
  return { schemaVersion: 1, status: "OK", mode: status.mode, ready, notReady, checkedAt, disk: status.disk, reasons: status.reasons, warnings: status.warnings, sections };
}

/** The environment state, read from the engine facts without blocking the server; `fresh` asks the engine everything again. */
export function cachedEnvironmentState(server: ServerContext, locale?: string, fresh = false): Promise<Record<string, unknown>> {
  return withEngineFacts(() => environmentState(server, locale), { prime: { version: server.version }, fresh });
}

// ---- preparation jobs ------------------------------------------------------------------------------------------------

type JobKind = "pull" | "data" | "dependencies" | "codeql";

interface Job {
  id: string;
  kind: JobKind;
  state: "running" | "done" | "failed";
  events: Array<Record<string, unknown> & { seq: number }>;
  waiters: Set<() => void>;
  /** Settles with the outcome (true: done) when the job ends; other routes chain their own work on it. */
  finished: Promise<boolean>;
  settle: (ok: boolean) => void;
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
  // A pull, a data update, the dependencies or CodeQL changed what the engine holds: the next reads ask it again.
  invalidateEngineFacts();
  job.state = ok ? "done" : "failed";
  push(job, { type: "end", ok, ...result });
  job.settle(ok);
}

function cliMain(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli", "main.js");
}

function startJob(server: ServerContext, kind: JobKind, locale?: string): Job {
  let settle: (ok: boolean) => void = () => undefined;
  const finished = new Promise<boolean>((resolve) => (settle = resolve));
  const job: Job = { id: `job_${crypto.randomBytes(6).toString("hex")}`, kind, state: "running", events: [], waiters: new Set(), finished, settle };
  push(job, { type: "start", kind });
  const failed = (error: unknown): void => finishJob(job, false, { error: error instanceof Error ? error.message : String(error) });
  if (kind === "pull") {
    // The same steps as `jgates setup` (engine, disk, image, volumes), without the advisory data: that is its own job.
    runSetup({ env: process.env, version: server.version, projectDir: server.projectDir, withData: false, ...(locale ? { locale } : {}), onEvent: (event) => push(job, { ...event }) })
      .then((result) => finishJob(job, result.ready, { ready: result.ready, pulled: result.pulled, steps: result.steps, reasons: result.reasons }))
      .catch(failed);
  } else if (kind === "codeql") {
    // Customer supplied: the route only starts this job after an explicit acceptance of GitHub's terms.
    prepareCodeql({ env: process.env, version: server.version, acceptTerms: true })
      .then((result) => finishJob(job, result.state === "prepared", { state: result.state, message: result.message, ...(result.error ? { error: result.error } : {}) }))
      .catch(failed);
  } else if (kind === "data") {
    updateData({ env: process.env, version: server.version, onProgress: (event) => push(job, { type: "data-update", ...event }) })
      .then((result) => finishJob(job, !result.blocked && result.databases.every((d) => d.ok), { databases: result.databases, ...(result.blocked ? { blocked: result.blocked } : {}) }))
      .catch(failed);
  } else {
    // The dependencies are the CLI's `deps prepare` in a child process (one code path, one set of logs).
    // In the language of the screen that asked: the units' messages are shown as they come.
    const child = spawn(process.execPath, [cliMain(), "deps", "prepare", "--json", "--cwd", server.projectDir], { cwd: server.projectDir, env: { ...process.env, ...(locale ? { JGATES_LOCALE: locale } : {}) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

export type EnvironmentJobView = ReturnType<typeof publicJob>;

/**
 * Starts a preparation job of this server, or hands back the one of that kind that is still running (one per kind).
 * `finished` settles with the outcome, so the first-run wizard can chain the next preparation on it.
 */
export function startEnvironmentJob(server: ServerContext, kind: JobKind, locale?: string): { job: EnvironmentJobView; reused: boolean; finished: Promise<boolean> } {
  const running = [...jobsFor(server).values()].find((j) => j.kind === kind && j.state === "running");
  if (running) return { job: publicJob(running), reused: true, finished: running.finished };
  refreshPath({ force: true });
  const job = startJob(server, kind, locale);
  server.log(`environment job ${job.kind} ${job.id}`);
  return { job: publicJob(job), reused: false, finished: job.finished };
}

/** A job of this server by id (null after a restart of the server: jobs live in memory only). */
export function environmentJob(server: ServerContext, id: string): EnvironmentJobView | null {
  const job = jobsFor(server).get(id);
  return job ? publicJob(job) : null;
}

/** The running job of a kind, if any. */
export function runningEnvironmentJob(server: ServerContext, kind: JobKind): EnvironmentJobView | null {
  const job = [...jobsFor(server).values()].find((j) => j.kind === kind && j.state === "running");
  return job ? publicJob(job) : null;
}

export const routes: RouteDefinition[] = [
  {
    // Every section (engine, image, data, dependencies, services, extension, CodeQL) with its state and its reasons.
    // `fresh=1` is the screen's "check again": the engine is asked everything anew instead of the cached facts.
    method: "GET",
    path: "/api/environment/state",
    query: { type: "object", properties: { ...LOCALE_QUERY.properties, fresh: { type: "string", enum: ["1"] } }, additionalProperties: false },
    timeoutMs: 120_000,
    async handler({ server, query }) {
      const fresh = query.fresh === "1";
      // The PATH is read again at most every few seconds, and at once on "check again" (a Docker installed meanwhile).
      if (!server.policyMode) await refreshPathAsync({ force: fresh });
      const locale = normalizeLocale(query.locale) ?? undefined;
      return { status: 200, json: await cachedEnvironmentState(server, locale, fresh) };
    },
  },
  {
    // Starts a preparation (the image pull, the advisory data, the project's dependencies); one running job per kind.
    method: "POST",
    path: "/api/environment/jobs",
    body: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["pull", "data", "dependencies", "codeql"] },
        locale: { type: "string", enum: ["en", "pt-BR"] },
        // Required, and true, for the CodeQL job: the person accepted GitHub's CodeQL terms in the screen.
        acceptTerms: { type: "boolean" },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    handler({ body, server }) {
      if (server.policyMode) throw new HttpError(409, "POLICY_MODE", translator("reasons")("env_api_policy_mode"), null);
      const input = body as { kind: JobKind; locale?: string; acceptTerms?: boolean };
      if (input.kind === "codeql" && input.acceptTerms !== true) throw new HttpError(422, "TERMS_NOT_ACCEPTED", translator("codeql")("codeql_prepare_terms_required", { terms: CODEQL_TERMS_URL, source: releaseUrls(process.env).bundle }), null);
      const { job, reused } = startEnvironmentJob(server, input.kind, normalizeLocale(input.locale) ?? undefined);
      return { status: 200, json: { schemaVersion: 1, status: "OK", job, reused } };
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
    timeoutMs: 120_000,
    async handler({ server }) {
      if (!server.policyMode) await refreshPathAsync();
      return { status: 200, json: { status: "OK", ...(await withEngineFacts(() => diagnoseEnvironment(server.projectDir), { prime: { version: server.version } })) } };
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
        const environment = await withEngineFacts(() => diagnoseEnvironment(server.projectDir), { prime: { version: server.version } });
        return { status: 200, json: { schemaVersion: 1, status: "OK", dryRun: false, preview, result, environment } };
      } catch (error) {
        if (error instanceof PrepareError) throw toHttp(error);
        throw error;
      }
    },
  },
];
