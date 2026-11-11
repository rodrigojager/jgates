// Advisory data (PLAN-lifecycle.md section 4): the vulnerability databases the offline scanners read live in the
// `jgates-data` volume, never in the tools image and never in the run folder. `jgates tools update-data` refreshes them
// (the only step with a network next to this volume, mounted for writing); a check mounts the volume read-only with
// `--network none`. Every database stores its fetch time in /data/jgates-data.json. A check whose database is missing is
// blocked with DATA_MISSING, one whose database is older than the threshold (default 7 days) with DATA_STALE: never
// "clean". The fetch times are part of the plan (inputs.container.dataTimestamps) and so of the provenance of a result.
import fs from "node:fs";
import path from "node:path";
import {
  IMAGE_USER,
  engineCommandSync,
  engineLabels,
  engineRuntime,
  ensureVolume,
  inspectImageSync,
  runInEngine,
  runInEngineSync,
  type EngineContext,
  type EngineMount,
} from "../engine/index.js";
import { encodePointer, resolveConfig } from "../config/resolve/index.js";
import { resolveReason } from "../reasons/index.js";
import type { PreflightProblem } from "../runner/preflight.js";
import type { RunStep } from "../runner/executor.js";
import type { PlanItem } from "../plan/types.js";
import { stepMode } from "../runner/in-image.js";
import { toolsImageTarget } from "../tools-image/index.js";
import { translator } from "../../i18n/index.js";
import { UPDATE_SCRIPT } from "./script.js";

export const DATA_VOLUME = "jgates-data";
export const DATA_TARGET = "/data";
export const DATA_STATUS_FILE = "jgates-data.json";
export const DEFAULT_DATA_MAX_AGE_DAYS = 7;

export type DatabaseId = "trivy" | "osv" | "govulndb" | "rustsec";
export const DATABASE_IDS: readonly DatabaseId[] = ["trivy", "osv", "govulndb", "rustsec"];

/** Where each database sits under /data, the tool that reads it and the adapter that runs that tool. */
export const DATABASES: Readonly<Record<DatabaseId, { tool: string; adapter: string; folder: string }>> = Object.freeze({
  trivy: { tool: "trivy", adapter: "trivy", folder: "trivy" },
  osv: { tool: "osv-scanner", adapter: "osv-scanner", folder: "osv" },
  govulndb: { tool: "govulncheck", adapter: "govulncheck", folder: "govulndb" },
  rustsec: { tool: "cargo-audit", adapter: "cargo-audit", folder: "rustsec" },
});

/**
 * Where the advisory data is, inside the container that reads it: /data (the jgates-data volume). Only JGates running
 * inside the tools image can be told another place (JGATES_DATA_DIR), since there the data is whatever the image mounted.
 */
export function dataRootOf(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.JGATES_DATA_DIR?.trim();
  return override && stepMode(env) === "in-image" ? override.replace(/[\/]+$/, "") : DATA_TARGET;
}

/** The folder of one database in the container that reads it. */
export function databaseDir(id: DatabaseId, env: NodeJS.ProcessEnv = process.env): string {
  return `${dataRootOf(env)}/${DATABASES[id].folder}`;
}

/** The database a plan item of an adapter reads, or null when the item needs no advisory data. */
export function databaseOfItem(item: Pick<PlanItem, "adapter" | "capabilities">): DatabaseId | null {
  switch (item.adapter) {
    case "trivy":
      // Only the vulnerability scanner reads the database; misconfiguration, secrets and licenses run on the image alone.
      return item.capabilities[0] === "dependencies" ? "trivy" : null;
    case "osv-scanner":
      return "osv";
    case "govulncheck":
      return "govulndb";
    case "cargo-audit":
      return "rustsec";
    default:
      return null;
  }
}

/** The volume of the advisory data, read-only for a step. */
export const dataMount = (): EngineMount => ({ type: "volume", source: DATA_VOLUME, target: DATA_TARGET, readonly: true });

export interface DatabaseStamp {
  fetchedAt: string;
  source: string;
}

export interface DataStatus {
  schemaVersion: 1;
  databases: Partial<Record<DatabaseId, DatabaseStamp>>;
}

export type DataReadState = "ok" | "no-volume" | "no-image" | "unreadable";

export interface DataRead {
  state: DataReadState;
  status: DataStatus;
}

const EMPTY: DataStatus = { schemaVersion: 1, databases: {} };

function parseStatus(text: string): DataStatus | null {
  try {
    const doc = JSON.parse(text) as { databases?: Record<string, { fetchedAt?: unknown; source?: unknown }> };
    if (!doc || typeof doc !== "object" || typeof doc.databases !== "object" || doc.databases === null) return null;
    const databases: DataStatus["databases"] = {};
    for (const id of DATABASE_IDS) {
      const entry = doc.databases[id];
      if (entry && typeof entry.fetchedAt === "string" && !Number.isNaN(Date.parse(entry.fetchedAt))) {
        databases[id] = { fetchedAt: entry.fetchedAt, source: typeof entry.source === "string" ? entry.source : "" };
      }
    }
    return { schemaVersion: 1, databases };
  } catch {
    return null;
  }
}

function contextOf(env: NodeJS.ProcessEnv): EngineContext {
  return { runtime: engineRuntime(env), runnerOptions: { parentEnv: env } };
}

const CLI_LABEL_VERSION = "0.0.0";

/** The fetch times stored with the data a job of the tools image sees: read as a file, nothing is started. */
export function readDataStatusNative(env: NodeJS.ProcessEnv = process.env): DataRead {
  const file = path.join(dataRootOf(env), DATA_STATUS_FILE);
  if (!fs.existsSync(file)) return { state: "no-volume", status: EMPTY };
  try {
    const status = parseStatus(fs.readFileSync(file, "utf8"));
    return status ? { state: "ok", status } : { state: "unreadable", status: EMPTY };
  } catch {
    return { state: "unreadable", status: EMPTY };
  }
}

/**
 * The fetch times stored in the volume, read with one short helper container (no network, volume read-only). A machine
 * without an engine, image or volume has no data: the answer is "nothing fetched", never an error.
 */
export function readDataStatusSync(env: NodeJS.ProcessEnv = process.env, version: string = CLI_LABEL_VERSION): DataRead {
  // Inside the tools image there is no engine: the data is whatever the job mounted (at /data or JGATES_DATA_DIR).
  if (stepMode(env) === "in-image") return readDataStatusNative(env);
  const context = contextOf(env);
  const image = inspectImageSync(env.JGATES_TOOLS_IMAGE?.trim() || toolsImageTarget(env).reference, context);
  if (!image) return { state: "no-image", status: EMPTY };
  // A volume that does not exist must not be created by the read (the engine would create an unlabelled one).
  const volume = engineCommandSync(["volume", "inspect", "--format", "{{.Name}}", DATA_VOLUME], context);
  if (volume.spawnError || volume.exitCode !== 0) return { state: "no-volume", status: EMPTY };
  const result = runInEngineSync(
    {
      image: image.id,
      command: ["cat", `${DATA_TARGET}/${DATA_STATUS_FILE}`],
      labels: engineLabels({ kind: "data", version }),
      mounts: [dataMount()],
      network: "none",
      resources: { memoryMb: 128, cpus: 1, pids: 32 },
      timeoutMs: 60_000,
    },
    context,
  );
  if (result.spawnError || result.exitCode !== 0) return { state: "unreadable", status: EMPTY };
  const status = parseStatus(result.stdout);
  return status ? { state: "ok", status } : { state: "unreadable", status: EMPTY };
}

/** Fetch time (ISO 8601) of every database, or null when it was never fetched: what the plan records. */
export function dataTimestampsOf(status: DataStatus): Record<string, string | null> {
  return Object.fromEntries(DATABASE_IDS.map((id) => [id, status.databases[id]?.fetchedAt ?? null]));
}

let cached: { key: string; at: number; value: Record<string, string | null> } | null = null;
const CACHE_MS = 5_000;

/** The timestamps for the plan (built synchronously, often): the read is repeated at most every few seconds. */
export function readDataTimestampsSync(env: NodeJS.ProcessEnv = process.env, version?: string): Record<string, string | null> {
  const key = `${engineRuntime(env)}|${env.JGATES_TOOLS_IMAGE ?? ""}`;
  if (cached && cached.key === key && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = dataTimestampsOf(readDataStatusSync(env, version).status);
  cached = { key, at: Date.now(), value };
  return value;
}

export type DatabaseState = "fresh" | "stale" | "missing";

export interface DatabaseAge {
  id: DatabaseId;
  state: DatabaseState;
  fetchedAt: string | null;
  /** Whole days since the fetch; null when it was never fetched. */
  ageDays: number | null;
}

export const DAY_MS = 86_400_000;

/** The age of each database against the threshold. A fetch time in the future counts as fresh. */
export function agesOf(status: DataStatus, now: Date, maxAgeDays: number): DatabaseAge[] {
  return DATABASE_IDS.map((id) => {
    const stamp = status.databases[id];
    if (!stamp) return { id, state: "missing" as const, fetchedAt: null, ageDays: null };
    const days = Math.max(0, (now.getTime() - Date.parse(stamp.fetchedAt)) / DAY_MS);
    return { id, state: days > maxAgeDays ? ("stale" as const) : ("fresh" as const), fetchedAt: stamp.fetchedAt, ageDays: Math.floor(days) };
  });
}

/** DATA_MISSING / DATA_STALE problems of the databases a step reads. */
export function dataProblems(needed: Iterable<DatabaseId>, status: DataStatus, now: Date, maxAgeDays: number): PreflightProblem[] {
  const ages = new Map(agesOf(status, now, maxAgeDays).map((a) => [a.id, a]));
  const problems: PreflightProblem[] = [];
  for (const id of new Set(needed)) {
    const age = ages.get(id) as DatabaseAge;
    const database = DATABASES[id].tool;
    if (age.state === "missing") problems.push({ code: "DATA_MISSING" as PreflightProblem["code"], message: resolveReason("DATA_MISSING", { database }).message });
    else if (age.state === "stale") problems.push({ code: "DATA_STALE" as PreflightProblem["code"], message: resolveReason("DATA_STALE", { database, days: age.ageDays ?? 0, max: maxAgeDays }).message });
  }
  return problems;
}

/** `execution.dataMaxAgeDays` of the configuration in force (default 7); an invalid value falls back to the default. */
export function dataMaxAgeDaysOf(configDir: string): number {
  try {
    const value = resolveConfig(configDir).fields[encodePointer(["execution", "dataMaxAgeDays"])]?.value;
    return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : DEFAULT_DATA_MAX_AGE_DAYS;
  } catch {
    return DEFAULT_DATA_MAX_AGE_DAYS;
  }
}

export interface DataRunInput {
  plan: { groups: { willRun: PlanItem[] } };
  env: NodeJS.ProcessEnv;
  runDir: string;
  /** execution.dataMaxAgeDays of the configuration in force (the policy's, in a governed run). */
  maxAgeDays: number;
  version?: string;
  now?: () => Date;
}

export interface DataRun {
  /** The steps whose items read an advisory database get a preflight that blocks them without usable data. */
  gate(steps: RunStep[]): RunStep[];
  /** The read-only data volume of a step that reads a database (checked fresh right before it starts). */
  stepEnvironment(stepId: string): { mounts: EngineMount[]; env: Record<string, string> } | null;
}

export const RUN_DATA_FILE = "data-status.json";

/** The databases each step of the plan reads, or null when no planned check reads any. */
export function createDataRun(input: DataRunInput): DataRun | null {
  const neededOf = new Map<string, Set<DatabaseId>>();
  for (const item of input.plan.groups.willRun) {
    const id = databaseOfItem(item);
    if (!id) continue;
    neededOf.set(item.tool, new Set([...(neededOf.get(item.tool) ?? []), id]));
  }
  if (neededOf.size === 0) return null;
  const ready = new Set<string>();
  const now = input.now ?? (() => new Date());
  return {
    gate(steps) {
      return steps.map((step) => {
        const needed = neededOf.get(step.id);
        if (!needed) return step;
        return {
          ...step,
          preflight: () => {
            const own = step.preflight?.() ?? [];
            const read = readDataStatusSync(input.env, input.version);
            const problems = dataProblems(needed, read.status, now(), input.maxAgeDays);
            // What the run used, next to the run: the scanners' results record these fetch times.
            try {
              fs.mkdirSync(input.runDir, { recursive: true });
              fs.writeFileSync(path.join(input.runDir, RUN_DATA_FILE), JSON.stringify({ ...read.status, maxAgeDays: input.maxAgeDays }, null, 2) + "\n");
            } catch {
              // The record is evidence, not a precondition.
            }
            if (problems.length === 0) ready.add(step.id);
            else ready.delete(step.id);
            return [...own, ...problems];
          },
        };
      });
    },
    stepEnvironment(stepId) {
      return neededOf.has(stepId) && ready.has(stepId) ? { mounts: [dataMount()], env: {} } : null;
    },
  };
}

/** The status the run recorded in its folder (RUN_DATA_FILE); {} fetch times when the run read no data. */
export function readRunDataStatus(runDir: string): DataStatus {
  try {
    return parseStatus(fs.readFileSync(path.join(runDir, RUN_DATA_FILE), "utf8")) ?? EMPTY;
  } catch {
    return EMPTY;
  }
}

/**
 * The vulnerability database a scanner step read, as the result records it (stage analysisInput.database): the source and
 * the fetch time stored in the volume when the run started. outputDir is `<run>/outputs/<adapter>/<tool>`. Null when the
 * run recorded nothing for the database (a run inside the image, where nothing reads the volume).
 */
export function recordedDatabaseFacts(outputDir: string, id: DatabaseId): { database: { source: string; updatedAt: string | null; downloadedAt: string | null; reported: boolean; networkRequired: boolean } } | null {
  const stamp = readRunDataStatus(path.resolve(outputDir, "..", "..", "..")).databases[id];
  if (!stamp) return null;
  return { database: { source: stamp.source, updatedAt: stamp.fetchedAt, downloadedAt: stamp.fetchedAt, reported: true, networkRequired: false } };
}

// ---- refresh -----------------------------------------------------------------------------------------------------

export interface UpdateProgress {
  database: DatabaseId;
  state: "started" | "updated" | "failed";
  message?: string;
}

export interface UpdateOptions {
  env: NodeJS.ProcessEnv;
  version: string;
  /** Databases to refresh (default: all). */
  only?: DatabaseId[];
  onProgress?: (event: UpdateProgress) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface UpdateResult {
  databases: Array<{ id: DatabaseId; ok: boolean; fetchedAt: string | null; error?: string }>;
  /** The engine or the image was not there: nothing was tried. */
  blocked?: string;
}

const UPDATE_TIMEOUT_MS = 45 * 60_000;

/**
 * Refreshes the advisory databases into the volume, one data container per database (each one sees the network; the
 * volume is mounted for writing there and nowhere else). A database that fails keeps its old copy and its old fetch time.
 */
export async function updateData(options: UpdateOptions): Promise<UpdateResult> {
  const t = translator("data");
  const context = contextOf(options.env);
  const image = inspectImageSync(options.env.JGATES_TOOLS_IMAGE?.trim() || toolsImageTarget(options.env).reference, context);
  const ids = options.only && options.only.length > 0 ? options.only : [...DATABASE_IDS];
  if (!image) return { databases: ids.map((id) => ({ id, ok: false, fetchedAt: null })), blocked: t("data_update_no_image") };
  const labels = engineLabels({ kind: "data", version: options.version });
  await ensureVolume(DATA_VOLUME, { labels, image: image.id, owner: IMAGE_USER, helperLabels: engineLabels({ kind: "helper", version: options.version }) }, context);
  const databases: UpdateResult["databases"] = [];
  for (const id of ids) {
    if (options.signal?.aborted) {
      databases.push({ id, ok: false, fetchedAt: null, error: t("data_update_cancelled") });
      continue;
    }
    options.onProgress?.({ database: id, state: "started" });
    const result = await runInEngine(
      {
        image: image.id,
        command: ["python3", "-c", UPDATE_SCRIPT, id],
        labels,
        mounts: [{ type: "volume", source: DATA_VOLUME, target: DATA_TARGET }],
        network: "bridge",
        user: IMAGE_USER,
        resources: { memoryMb: 4096, cpus: 2, tmpfsMb: 512 },
        tmpExec: true,
        timeoutMs: options.timeoutMs ?? UPDATE_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      context,
    );
    if (result.exitCode === 0 && !result.spawnError) {
      options.onProgress?.({ database: id, state: "updated" });
      databases.push({ id, ok: true, fetchedAt: null });
    } else {
      const error = (result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ") || result.spawnError?.message || `exit ${result.exitCode ?? "-"}`).slice(0, 400);
      options.onProgress?.({ database: id, state: "failed", message: error });
      databases.push({ id, ok: false, fetchedAt: null, error });
    }
  }
  cached = null;
  // The times come from the volume itself, the single place that stamps them.
  const read = readDataStatusSync(options.env, options.version);
  for (const entry of databases) entry.fetchedAt = read.status.databases[entry.id]?.fetchedAt ?? null;
  return { databases };
}
