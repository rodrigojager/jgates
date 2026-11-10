// CodeQL prepared into its own volume (ADR-0003, ADR-0005, PLAN-lifecycle.md section 5). CodeQL is customer supplied: JGates
// never ships it and never installs it on the host. `jgates tools prepare-codeql --accept-terms` is the only place that
// downloads it: the user accepts GitHub's CodeQL terms (recorded with its date in the JGates data folder, never in the
// project), a data container with a network downloads the bundle of the official release, verifies its SHA-256 against the
// checksum file of the same release and unpacks it into the `jgates-codeql` volume. A check mounts that volume read-only
// at /codeql with `--network none`. Until the volume is prepared the dataflow capability is CUSTOMER_SUPPLIED (with the
// action "Prepare CodeQL") and its step is blocked, never passed.
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
import { resolveHome } from "../home/index.js";
import { resolveReason } from "../reasons/index.js";
import type { PreflightProblem } from "../runner/preflight.js";
import type { RunStep } from "../runner/executor.js";
import type { PlanItem } from "../plan/types.js";
import { toolsImageTarget } from "../tools-image/index.js";
import { translator } from "../../i18n/index.js";
import { PREPARE_SCRIPT } from "./script.js";

export const CODEQL_VOLUME = "jgates-codeql";
export const CODEQL_TARGET = "/codeql";
/** The CodeQL launcher inside the unpacked bundle. */
export const CODEQL_EXECUTABLE = `${CODEQL_TARGET}/codeql/codeql`;
export const CODEQL_STATUS_FILE = "jgates-codeql.json";
export const CODEQL_BUNDLE = "codeql-bundle-linux64.tar.gz";
/** The official release assets (linux/amd64 only). A mirror or a test server can be named with JGATES_CODEQL_RELEASE_BASE. */
export const DEFAULT_RELEASE_BASE = "https://github.com/github/codeql-action/releases/latest/download";
export const CODEQL_TERMS_URL = "https://github.com/github/codeql-cli-binaries/blob/main/LICENSE.md";
/** The file in the JGates data folder that holds the acceptance of the terms. */
export const TERMS_FILE = "codeql-terms.json";
export const PREPARE_TIMEOUT_MS = 30 * 60_000;

/** The CodeQL volume, read-only for a step. */
export const codeqlMount = (): EngineMount => ({ type: "volume", source: CODEQL_VOLUME, target: CODEQL_TARGET, readonly: true });

/** Whether a plan item is the CodeQL check (the only adapter that reads the volume). */
export const isCodeqlItem = (item: Pick<PlanItem, "adapter">): boolean => item.adapter === "codeql";

// ---- the acceptance of the terms ------------------------------------------------------------------------------------

export interface TermsAcceptance {
  schemaVersion: 1;
  /** ISO 8601 time of the acceptance. */
  acceptedAt: string;
  terms: string;
  /** JGates version that recorded it. */
  jgatesVersion: string;
}

/** `<JGates home>/codeql-terms.json`: the user's decision, kept with the user's data and never in a project. */
export function termsFile(home: string = resolveHome()): string {
  return path.join(home, TERMS_FILE);
}

export function readAcceptance(home: string = resolveHome()): TermsAcceptance | null {
  try {
    const doc = JSON.parse(fs.readFileSync(termsFile(home), "utf8")) as Partial<TermsAcceptance>;
    if (doc && typeof doc.acceptedAt === "string" && !Number.isNaN(Date.parse(doc.acceptedAt))) {
      return { schemaVersion: 1, acceptedAt: doc.acceptedAt, terms: typeof doc.terms === "string" ? doc.terms : CODEQL_TERMS_URL, jgatesVersion: typeof doc.jgatesVersion === "string" ? doc.jgatesVersion : "" };
    }
  } catch {
    // never accepted
  }
  return null;
}

export function recordAcceptance(home: string, version: string, now: Date = new Date()): TermsAcceptance {
  const record: TermsAcceptance = { schemaVersion: 1, acceptedAt: now.toISOString().replace(/\.\d+Z$/, "Z"), terms: CODEQL_TERMS_URL, jgatesVersion: version };
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = termsFile(home);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return record;
}

// ---- the state of the volume ----------------------------------------------------------------------------------------

export interface CodeqlStatus {
  schemaVersion: 1;
  /** The CodeQL CLI version the bundle reports (empty when it could not be read). */
  version: string;
  sha256: string;
  bytes: number;
  source: string;
  termsAcceptedAt: string;
  preparedAt: string;
}

export type CodeqlReadState = "ok" | "no-volume" | "no-image" | "unreadable";

export interface CodeqlRead {
  state: CodeqlReadState;
  status: CodeqlStatus | null;
}

function parseStatus(text: string): CodeqlStatus | null {
  try {
    const doc = JSON.parse(text) as Record<string, unknown>;
    if (!doc || typeof doc !== "object" || typeof doc.preparedAt !== "string" || typeof doc.sha256 !== "string") return null;
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    return { schemaVersion: 1, version: str(doc.version), sha256: doc.sha256, bytes: typeof doc.bytes === "number" ? doc.bytes : 0, source: str(doc.source), termsAcceptedAt: str(doc.termsAcceptedAt), preparedAt: doc.preparedAt };
  } catch {
    return null;
  }
}

function contextOf(env: NodeJS.ProcessEnv): EngineContext {
  return { runtime: engineRuntime(env), runnerOptions: { parentEnv: env } };
}

const CLI_LABEL_VERSION = "0.0.0";

/**
 * What the volume holds, read with one short helper container (no network, volume read-only). A machine without an
 * engine, image or volume has nothing prepared: the answer is a state, never an error.
 */
export function readCodeqlStatusSync(env: NodeJS.ProcessEnv = process.env, version: string = CLI_LABEL_VERSION): CodeqlRead {
  const context = contextOf(env);
  const image = inspectImageSync(env.JGATES_TOOLS_IMAGE?.trim() || toolsImageTarget(env).reference, context);
  if (!image) return { state: "no-image", status: null };
  // A volume that does not exist must not be created by the read (the engine would create an unlabelled one).
  const volume = engineCommandSync(["volume", "inspect", "--format", "{{.Name}}", CODEQL_VOLUME], context);
  if (volume.spawnError || volume.exitCode !== 0) return { state: "no-volume", status: null };
  const result = runInEngineSync(
    {
      image: image.id,
      command: ["cat", `${CODEQL_TARGET}/${CODEQL_STATUS_FILE}`],
      labels: engineLabels({ kind: "data", version }),
      mounts: [codeqlMount()],
      network: "none",
      resources: { memoryMb: 128, cpus: 1, pids: 32 },
      timeoutMs: 60_000,
    },
    context,
  );
  if (result.spawnError || result.exitCode !== 0) return { state: "unreadable", status: null };
  const status = parseStatus(result.stdout);
  return status ? { state: "ok", status } : { state: "unreadable", status: null };
}

let cached: { key: string; at: number; value: CodeqlRead } | null = null;
const CACHE_MS = 5_000;

/** The same read for the plan (built synchronously, often): repeated at most every few seconds. */
export function codeqlStatusForPlan(env: NodeJS.ProcessEnv = process.env, version?: string): CodeqlRead {
  const key = `${engineRuntime(env)}|${env.JGATES_TOOLS_IMAGE ?? ""}`;
  if (cached && cached.key === key && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = readCodeqlStatusSync(env, version);
  cached = { key, at: Date.now(), value };
  return value;
}

export function resetCodeqlStatusCache(): void {
  cached = null;
}

// ---- the run --------------------------------------------------------------------------------------------------------

export interface CodeqlRunInput {
  plan: { groups: { willRun: PlanItem[] } };
  env: NodeJS.ProcessEnv;
  runDir: string;
  version?: string;
}

export interface CodeqlRun {
  /** The CodeQL steps get a preflight that blocks them (CUSTOMER_SUPPLIED) when the volume is not prepared. */
  gate(steps: RunStep[]): RunStep[];
  /** The read-only CodeQL volume of a step that runs CodeQL (checked fresh right before it starts). */
  stepEnvironment(stepId: string): { mounts: EngineMount[]; env: Record<string, string> } | null;
}

export const RUN_CODEQL_FILE = "codeql-status.json";

/** The CodeQL steps of the plan that the plan itself found ready; a step the plan found unavailable is the adapter's to block. */
export function createCodeqlRun(input: CodeqlRunInput): CodeqlRun | null {
  const steps = new Set(input.plan.groups.willRun.filter((i) => isCodeqlItem(i) && i.availability.status === "available").map((i) => i.tool));
  if (steps.size === 0) return null;
  const ready = new Set<string>();
  return {
    gate(list) {
      return list.map((step) => {
        if (!steps.has(step.id)) return step;
        return {
          ...step,
          preflight: () => {
            const own = step.preflight?.() ?? [];
            const read = readCodeqlStatusSync(input.env, input.version);
            // What the run used, next to the run: the bundle checksum and the acceptance are part of the provenance.
            try {
              fs.mkdirSync(input.runDir, { recursive: true });
              fs.writeFileSync(path.join(input.runDir, RUN_CODEQL_FILE), JSON.stringify({ state: read.state, status: read.status }, null, 2) + "\n");
            } catch {
              // The record is evidence, not a precondition.
            }
            if (read.state === "ok") {
              ready.add(step.id);
              return own;
            }
            ready.delete(step.id);
            return [...own, { code: "CUSTOMER_SUPPLIED" as PreflightProblem["code"], message: resolveReason("CUSTOMER_SUPPLIED", { tool: "CodeQL" }).message }];
          },
        };
      });
    },
    stepEnvironment(stepId) {
      return steps.has(stepId) && ready.has(stepId) ? { mounts: [codeqlMount()], env: {} } : null;
    },
  };
}

// ---- the preparation ------------------------------------------------------------------------------------------------

export interface ReleaseUrls {
  bundle: string;
  checksum: string;
}

export function releaseUrls(env: NodeJS.ProcessEnv = process.env): ReleaseUrls {
  const base = (env.JGATES_CODEQL_RELEASE_BASE?.trim() || DEFAULT_RELEASE_BASE).replace(/\/+$/, "");
  return { bundle: `${base}/${CODEQL_BUNDLE}`, checksum: `${base}/${CODEQL_BUNDLE}.checksum.txt` };
}

export type PrepareState = "prepared" | "refused" | "blocked" | "failed";

export interface PrepareOptions {
  env: NodeJS.ProcessEnv;
  version: string;
  /** The user typed --accept-terms now. */
  acceptTerms: boolean;
  /** The JGates data folder (default: the resolved home). */
  home?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => Date;
}

export interface PrepareResult {
  state: PrepareState;
  message: string;
  acceptance: TermsAcceptance | null;
  status: CodeqlStatus | null;
  source: string;
  /** Raw engine text of a failure, for the details. */
  error?: string;
}

/**
 * Prepares the CodeQL bundle into the jgates-codeql volume. Without an acceptance (now, or one recorded earlier in the
 * JGates data folder) it refuses before anything else: no engine call, no download.
 */
export async function prepareCodeql(options: PrepareOptions): Promise<PrepareResult> {
  const t = translator("codeql");
  const home = options.home ?? resolveHome({ env: options.env });
  const urls = releaseUrls(options.env);
  let acceptance = readAcceptance(home);
  if (!acceptance && !options.acceptTerms) {
    return { state: "refused", message: t("codeql_prepare_terms_required", { terms: CODEQL_TERMS_URL, source: urls.bundle }), acceptance: null, status: null, source: urls.bundle };
  }
  const context = contextOf(options.env);
  const image = inspectImageSync(options.env.JGATES_TOOLS_IMAGE?.trim() || toolsImageTarget(options.env).reference, context);
  if (!image) return { state: "blocked", message: t("codeql_prepare_no_image"), acceptance, status: null, source: urls.bundle };
  // The acceptance is recorded once the engine and the image are there to use it (a refusal above records nothing).
  if (!acceptance) acceptance = recordAcceptance(home, options.version, options.now?.());
  const labels = engineLabels({ kind: "data", version: options.version });
  await ensureVolume(CODEQL_VOLUME, { labels, image: image.id, owner: IMAGE_USER, helperLabels: engineLabels({ kind: "helper", version: options.version }) }, context);
  const result = await runInEngine(
    {
      image: image.id,
      command: ["python3", "-c", PREPARE_SCRIPT],
      labels,
      mounts: [{ type: "volume", source: CODEQL_VOLUME, target: CODEQL_TARGET }],
      network: "bridge",
      user: IMAGE_USER,
      env: { JGATES_CODEQL_URL: urls.bundle, JGATES_CODEQL_CHECKSUM_URL: urls.checksum, JGATES_CODEQL_TERMS_ACCEPTED_AT: acceptance.acceptedAt },
      resources: { memoryMb: 4096, cpus: 2, tmpfsMb: 512 },
      tmpExec: true,
      timeoutMs: options.timeoutMs ?? PREPARE_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
    },
    context,
  );
  resetCodeqlStatusCache();
  if (result.exitCode !== 0 || result.spawnError) {
    const error = (result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ") || result.spawnError?.message || `exit ${result.exitCode ?? "-"}`).slice(0, 400);
    return { state: "failed", message: t("codeql_prepare_failed", { error }), acceptance, status: null, source: urls.bundle, error };
  }
  // The checksum and the version come from the volume itself, the single place that stamps them.
  const read = readCodeqlStatusSync(options.env, options.version);
  if (read.state !== "ok" || !read.status) return { state: "failed", message: t("codeql_prepare_unreadable"), acceptance, status: null, source: urls.bundle };
  return { state: "prepared", message: t("codeql_prepare_done", { version: read.status.version || "?", sha256: read.status.sha256 }), acceptance, status: read.status, source: urls.bundle };
}
