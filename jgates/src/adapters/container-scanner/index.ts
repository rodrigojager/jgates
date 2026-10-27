// Shared plan and run of the security scanners that left the bridge (Gitleaks, Trivy, OSV-Scanner, Checkov): each one
// runs on the container runner in the image `tools prepare` pinned in .jgates/lock.json (the sidecar image by default),
// with the workspace read-only at /workspace and
// a writable /output in the run folder, where the tool writes its JSON report, its home, its temporary files and its
// caches. The adapter of each tool only says how to build its arguments and how to read its report (running and
// normalizing are the adapter's; reading and writing the configuration file stay with the codecs and the editor).
//
// Fail-closed: a report that is missing, cut, too large, of an unknown shape or written by a version outside the range
// the parser knows makes the stage an error, never "zero findings".
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { translator, type Translator } from "../../i18n/index.js";
import type { AdapterManifest } from "../../core/catalog/index.js";
import type { ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { CONTAINER_OUTPUT, CONTAINER_WORKSPACE, DEFAULT_MAX_LOG_BYTES, runContainer, substituteTokens, toContainerPath, type ContainerResult } from "../../core/runner/index.js";
import { resolveToolBindings, type ResolvedBinding } from "../../core/tools/index.js";
import type { AdapterContext, AdapterOutput, NormalizedSeverity, ResultFinding, ResultStage, StageAnalysisInput } from "../../core/run/types.js";
import { resolveHome } from "../../core/home/index.js";
import { storeCache, useCache, type CacheUse, type DatabaseCacheSpec } from "./db-cache.js";
import { probeScannerImage, type ScannerImageProbe } from "./image.js";

export { CACHE_RECORD, cacheDirOf, readCache, type CacheRecord, type DatabaseCacheSpec } from "./db-cache.js";

export { probeScannerImage, runtimeClientEnv, SIDECAR_IMAGE, toolVersionLabel, type ScannerImageProbe } from "./image.js";

const WORKSPACE = "{workspace}";
const RUN_DIR = "{runDir}";
/** Folders of the output mount the tool uses instead of its home, /tmp (a small tmpfs) and its cache. */
export const OUTPUT_HOME = `${CONTAINER_OUTPUT}/home`;
export const OUTPUT_TMP = `${CONTAINER_OUTPUT}/tmp`;
export const OUTPUT_CACHE = `${CONTAINER_OUTPUT}/cache`;
export const REPORT_FILE = "report.json";
/** Name of the file, next to the report, where the run records the facts of the analysis input (database, scope). */
export const FACTS_FILE = "analysis-input.json";

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const slash = (p: string): string => p.split(path.sep).join("/");

function sha256File(abs: string): string | null {
  try {
    return "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

/** A configuration document of the instance: the bound file, the file the tool would find itself, or none. */
export interface ConfigChoice {
  /** Binding id in tools.yml (config, ignore, ...). */
  binding: string;
  /** Workspace-relative path with forward slashes, or null. */
  file: string | null;
  source: "binding" | "native" | "none";
  sha256: string | null;
}

/** What one document of the tool is called and where the tool looks for it when nothing is bound. */
export interface DocumentSpec {
  /** Binding id: `config` is tools.<id>.config, any other is tools.<id>.configFiles.<binding>. */
  binding: string;
  /** File names the tool reads by itself in the scan root, in its order (empty: nothing is looked for). */
  native: string[];
}

/** Everything the plan knows when it builds the arguments of one instance. */
export interface ArgsInput {
  documents: Record<string, ConfigChoice>;
  /** Capabilities of the instance that run in this plan (at least the first one). */
  capabilities: string[];
  /** Workspace-relative scan root ("." or the component root). */
  root: string;
}

/** Facts the run records about what the analysis read besides the code (a vulnerability database): the stage's
 * analysisInput in result.json. */
export type AnalysisFacts = StageAnalysisInput;

/** A finding of a scanner before it is attributed to a stage. */
export type ScannerFinding = Omit<ResultFinding, "stageId"> & { capability: string };

export interface ParseResult {
  ok: boolean;
  findings: ScannerFinding[];
  /** Why the report proves nothing. */
  problem?: string;
  /** The version the report says it was written by, when it says so. */
  reportedVersion?: string | null;
}

export interface ParseOptions {
  /** The version the plan pinned (the image label). */
  version: string | null;
  /** The scan root inside the container (/workspace or /workspace/<component>). */
  cwd: string;
  /** Capabilities the invocation runs (the plan's contract), the first one deciding the mode. */
  capabilities: string[];
}

export interface ScannerDefinition {
  manifest: AdapterManifest;
  /** Message area of the adapter (label, conditions, limitations). */
  label: string;
  /** Capabilities the tool can actually prove; any other one an instance declares is uncredited. */
  capabilities: string[];
  documents: DocumentSpec[];
  /** The command inside the image (scanner name first). */
  args(input: ArgsInput): string[];
  /**
   * Files the tool reads by itself beyond the documents (OSV-Scanner's osv-scanner.toml next to each lockfile), as
   * workspace-relative paths: the plan hashes them, so a change to one of them changes the plan.
   */
  nativeFiles?(dir: string, input: ArgsInput): string[];
  /** File name of the JSON report the tool writes in /output (default report.json). */
  report?: string;
  /** Exit codes of a finished scan (with or without findings); any other one proves nothing. */
  exitCodes: number[];
  network: boolean;
  /** Conditions and limitations shown in the plan, for this instance. */
  conditions(input: ArgsInput, t: Translator): string[];
  limitations(input: ArgsInput, t: Translator): string[];
  /** Capabilities of one instance that cannot run together with the first one in the same invocation. */
  exclusive?(capabilities: string[], t: Translator): Record<string, string>;
  /** Extra environment of the tool (inside the container). */
  env?: Record<string, string>;
  /** Container limits (Trivy needs more than the defaults). */
  limits?: { memoryMb?: number; cpus?: number; pids?: number; tmpfsMb?: number };
  /** Reads the report the tool wrote in /output/report.json. */
  parse(text: string, options: ParseOptions): ParseResult;
  /** Reads the facts of the analysis input after the run (outputDir: the host folder mounted at /output). */
  facts?(outputDir: string, stderr: string): AnalysisFacts;
  /** Removes what the tool left in /output that must not stay in the run folder (a downloaded database). */
  cleanup?(outputDir: string): void;
  /** The database the tool downloads, kept in the data folder between runs (db-cache.ts). */
  database?: DatabaseCacheSpec;
}

const SEVERITY: Record<string, { normalized: NormalizedSeverity; blocking: boolean }> = {
  critical: { normalized: "critical", blocking: true },
  high: { normalized: "high", blocking: true },
  error: { normalized: "high", blocking: true },
  medium: { normalized: "medium", blocking: true },
  moderate: { normalized: "medium", blocking: true },
  warning: { normalized: "medium", blocking: true },
  low: { normalized: "low", blocking: false },
  info: { normalized: "info", blocking: false },
  negligible: { normalized: "info", blocking: false },
};

/** Normalized severity of a scanner's label; an unknown or missing one blocks (fail-closed). */
export function severityOf(native: string | null | undefined): { normalized: NormalizedSeverity; blocking: boolean } {
  return SEVERITY[String(native ?? "").trim().toLowerCase()] ?? { normalized: "unknown", blocking: true };
}

/** Workspace-relative path of a path the tool printed inside the container (absolute under /workspace or cwd-relative). */
export function workspacePath(raw: string, cwd: string): string {
  const value = raw.replace(/\\/g, "/");
  const abs = value.startsWith("/") ? path.posix.normalize(value) : path.posix.join(cwd, value);
  if (abs === CONTAINER_WORKSPACE) return ".";
  if (abs.startsWith(`${CONTAINER_WORKSPACE}/`)) return abs.slice(CONTAINER_WORKSPACE.length + 1);
  return value.replace(/^\.\//, "");
}

/** Builds a finding with the common fields: fingerprint of what identifies it, blocking by severity. */
export function finding(input: {
  tool: string;
  version: string | null;
  capability: string;
  category: string;
  ruleId: string;
  severity: string;
  message: string;
  file: string;
  line?: number | undefined;
  column?: number | undefined;
  nativeFingerprint?: string | undefined;
  evidence?: string | undefined;
  docsUrl?: string | undefined;
  extra?: unknown;
}): ScannerFinding {
  const level = severityOf(input.severity);
  return {
    capability: input.capability,
    tool: input.tool,
    ...(input.version ? { toolVersion: input.version } : {}),
    ruleId: input.ruleId,
    category: input.category,
    severity: input.severity,
    normalizedSeverity: level.normalized,
    message: input.message,
    location: { path: input.file, ...(input.line !== undefined ? { line: input.line } : {}), ...(input.column !== undefined ? { column: input.column } : {}) },
    fingerprint: "sha256:" + crypto.createHash("sha256").update(JSON.stringify([input.tool, input.ruleId, input.file, input.line ?? null, input.extra ?? null])).digest("hex"),
    origin: input.tool,
    blocking: level.blocking,
    ...(level.blocking ? { blockingReason: "blocking-tool" as const } : {}),
    waived: false,
    ...(input.nativeFingerprint ? { nativeFingerprint: input.nativeFingerprint } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.docsUrl ? { docsUrl: input.docsUrl } : {}),
  };
}

/** The parser's own check of the version: the one the plan pinned and the one the report declares. */
export function versionProblem(manifest: AdapterManifest, planned: string | null, reported: string | null | undefined): string | null {
  const t = translator("security");
  for (const [what, version] of [["plan", planned], ["report", reported ?? null]] as const) {
    if (version === null) continue;
    if (satisfiesRange(version, manifest.toolVersionRange) !== true) {
      return t(what === "plan" ? "security_parser_version_plan" : "security_parser_version_report", { tool: manifest.toolName, version, range: manifest.toolVersionRange });
    }
  }
  return null;
}

/** The runner the instance asked for in tools.yml: these scanners run only in a container. */
function runnerOf(input: ExternalPlanInput): string | null {
  const tools = isRec(input.config) && isRec(input.config.tools) ? input.config.tools : {};
  const body = tools[input.tool];
  return isRec(body) && typeof body.runner === "string" ? body.runner : null;
}

/** Capabilities the instance declares in tools.yml, the planned one first. */
function declaredCapabilities(input: ExternalPlanInput): string[] {
  const tools = isRec(input.config) && isRec(input.config.tools) ? input.config.tools : {};
  const body = tools[input.tool];
  const declared = isRec(body) && Array.isArray(body.capabilities) ? body.capabilities.filter((c): c is string => typeof c === "string") : [];
  return [...new Set([input.capability, ...declared])];
}

/** Capabilities of the instance that the selection turns on (the build passes its selection to every adapter). */
function selectedCapabilities(input: ExternalPlanInput): string[] {
  const selection = (input as ExternalPlanInput & { selection?: { items?: Array<{ kind: string; id: string; capabilities?: Array<{ capability: string | null; enabled: boolean }> }> } }).selection;
  const item = selection?.items?.find((i) => i.kind === "tool" && i.id === input.tool);
  const on = (item?.capabilities ?? []).filter((p) => p.enabled && p.capability).map((p) => p.capability as string);
  return on.length > 0 ? on : [input.capability];
}

interface DocumentOutcome {
  choice: ConfigChoice;
  problem: string | null;
}

/** The bound document (tools.yml), or the file the tool finds by itself in the scan root, or none. */
function chooseDocument(input: ExternalPlanInput, spec: DocumentSpec, root: string, bindings: ResolvedBinding[], t: Translator): DocumentOutcome {
  const binding = bindings.find((b) => b.id === spec.binding);
  if (binding) {
    const where = binding.declared;
    const choice: ConfigChoice = { binding: spec.binding, file: binding.relPath, source: "binding", sha256: null };
    if (binding.refused || binding.relPath === null) return { choice, problem: t("security_binding_refused", { tool: input.tool, binding: spec.binding, file: where }) };
    if (!binding.exists) return { choice, problem: t("security_binding_missing", { tool: input.tool, binding: spec.binding, file: where }) };
    if (binding.kind !== "file") return { choice, problem: t("security_binding_not_file", { tool: input.tool, binding: spec.binding, file: where }) };
    return { choice: { ...choice, sha256: sha256File(binding.absPath) }, problem: null };
  }
  for (const name of spec.native) {
    const rel = root === "." ? name : `${root}/${name}`;
    const abs = path.join(input.dir, ...rel.split("/"));
    try {
      if (fs.statSync(abs).isFile()) return { choice: { binding: spec.binding, file: rel, source: "native", sha256: sha256File(abs) }, problem: null };
    } catch {
      // not there: the next name
    }
  }
  return { choice: { binding: spec.binding, file: null, source: "none", sha256: null }, problem: null };
}

function imageAvailability(probe: ScannerImageProbe, manifest: AdapterManifest, instance: string, t: Translator): ExternalPlan["availability"] {
  const params = { tool: manifest.displayName, instance, runtime: probe.runtimeName, image: probe.image ?? "-", detail: probe.detail, command: probe.command };
  switch (probe.problem) {
    case "runtime_missing":
      return { status: "unavailable", reason: t("security_runtime_missing", params) };
    case "lock_invalid":
      return { status: "unavailable", reason: t("security_lock_invalid", params) };
    case "image_unprepared":
      return { status: "unavailable", reason: t("security_image_unprepared", params) };
    case "image_missing":
      return { status: "unavailable", reason: t("security_image_missing", params) };
    case "image_changed":
      return { status: "unavailable", reason: t("security_image_changed", params) };
    default:
      if (probe.version === null || satisfiesRange(probe.version, manifest.toolVersionRange) !== true) {
        return { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: manifest.toolName, version: probe.version ?? "?", range: manifest.toolVersionRange, what: manifest.id }) };
      }
      return { status: "available", reason: null };
  }
}

/** The plan of one instance: the exact `docker run` the container runner starts, with the documents chosen. */
export function planScanner(def: ScannerDefinition, input: ExternalPlanInput): ExternalPlan {
  const t = translator("security");
  const manifest = def.manifest;
  const root = input.componentRoot && input.componentRoot !== "." ? slash(input.componentRoot) : ".";
  let bindings: ResolvedBinding[] = [];
  try {
    bindings = resolveToolBindings(input.dir, { skipInventory: true }).instances.find((i) => i.id === input.tool)?.bindings ?? [];
  } catch {
    // an unreadable tools.yml is reported by config validate
  }
  const outcomes = def.documents.map((spec) => chooseDocument(input, spec, root, bindings, t));
  const documents = Object.fromEntries(outcomes.map((o) => [o.choice.binding, o.choice]));
  const documentProblem = outcomes.find((o) => o.problem !== null)?.problem ?? null;

  // Capabilities: the ones the selection runs, in the order the tool can prove them; the rest is uncredited.
  const declared = declaredCapabilities(input);
  const selected = selectedCapabilities(input);
  const uncredited: Record<string, string> = {};
  for (const cap of declared) if (!def.capabilities.includes(cap)) uncredited[cap] = t("security_capability_unsupported", { tool: manifest.displayName, capability: cap, supported: def.capabilities.join(", ") });
  const runnable = selected.filter((c) => def.capabilities.includes(c));
  Object.assign(uncredited, def.exclusive?.(runnable, t) ?? {});
  const capabilities = runnable.filter((c) => uncredited[c] === undefined);
  const argsInput: ArgsInput = { documents, capabilities: capabilities.length > 0 ? capabilities : [input.capability], root };

  const probe = probeScannerImage(input.env, input.dir, input.tool);
  const runner = runnerOf(input);
  let availability: ExternalPlan["availability"];
  let blocksPlan = false;
  if (documentProblem) {
    // A document the project bound that is not there or not usable: never fall back to another one silently.
    availability = { status: "unavailable", reason: documentProblem };
    blocksPlan = true;
  } else if (runner !== null && runner !== "container") availability = { status: "unavailable", reason: t("security_container_only", { tool: manifest.displayName, runner }) };
  else availability = imageAvailability(probe, manifest, input.tool, t);

  const args = def.args(argsInput);
  const configFiles = Object.values(documents)
    .filter((d) => d.file !== null)
    .map((d) => ({ file: d.file as string, sha256: d.sha256 }));
  for (const file of def.nativeFiles?.(input.dir, argsInput) ?? []) {
    if (!configFiles.some((f) => f.file === file)) configFiles.push({ file, sha256: sha256File(path.join(input.dir, ...file.split("/"))) });
  }
  return {
    label: t(def.label),
    command: {
      executable: manifest.toolName,
      args,
      cwd: root === "." ? WORKSPACE : `${WORKSPACE}/${root}`,
      env: { HOME: OUTPUT_HOME, TMPDIR: OUTPUT_TMP, ...(def.env ?? {}) },
      stdin: null,
      container: {
        runtime: probe.runtime ?? probe.runtimeName,
        image: probe.image ?? "",
        network: def.network ? "bridge" : "none",
        mounts: [
          { source: WORKSPACE, target: CONTAINER_WORKSPACE, readOnly: true },
          { source: `${RUN_DIR}/outputs/${manifest.id}/${input.tool}`, target: CONTAINER_OUTPUT, readOnly: false },
        ],
      },
    },
    runtime: { name: "container", interpreter: probe.runtime, available: probe.problem === null },
    toolVersion: probe.version,
    configFiles,
    availability,
    blocksPlan,
    network: def.network,
    limitations: def.limitations(argsInput, t),
    conditions: [
      ...def.conditions(argsInput, t),
      ...Object.values(documents).map((d) =>
        d.source === "none" ? t("security_document_none", { binding: d.binding }) : t(d.source === "binding" ? "security_document_binding" : "security_document_native", { binding: d.binding, file: d.file ?? "-" }),
      ),
      t("security_condition_container", { image: probe.image ?? "-", network: def.network ? "bridge" : "none" }),
    ],
    output: { format: "json", schema: null },
    ...(Object.keys(uncredited).length > 0 ? { uncredited } : {}),
    contract: { report: `${CONTAINER_OUTPUT}/${def.report ?? REPORT_FILE}`, exitCodes: [...def.exitCodes], parser: manifest.toolVersionRange, capabilities: argsInput.capabilities },
  };
}

const relToRun = (runDir: string, p: string): string => slash(path.relative(runDir, p));

/** Largest report the run reads (the log limit, JGATES_MAX_LOG_BYTES): a larger one is treated as cut. */
function reportLimit(env: NodeJS.ProcessEnv): number {
  const n = Number(env.JGATES_MAX_LOG_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_LOG_BYTES;
}

/** Short text of the database facts for the stage reason. */
function databaseText(facts: AnalysisFacts, t: Translator, cache: CacheUse | null, stored: boolean): string {
  const db = facts.database;
  if (!db) return "";
  const text = db.updatedAt ? t("security_database", { source: db.source, date: db.updatedAt }) : t("security_database_undated", { source: db.source });
  if (cache?.state === "reused") return `${text}; ${t("security_database_cached", { date: cache.record.downloadedAt ?? cache.record.storedAt })}`;
  return stored ? `${text}; ${t("security_database_stored")}` : text;
}

/** Runs the plan's invocation of one instance in the container and normalizes its report. */
export async function runScanner(def: ScannerDefinition, context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("security");
  const id = def.manifest.id;
  const invocation = plan.invocations.find((i) => i.adapter === id && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === id && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("security_no_invocation", { tool }));
  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const command = invocation.command;
  const container = command.container;
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
  const version = items[0]?.versions.toolVersion ?? null;
  const label = def.manifest.displayName;

  const outDir = path.join(context.outputsDir, id, tool);
  for (const sub of ["", "home", "tmp", "cache"]) fs.mkdirSync(path.join(outDir, sub), { recursive: true, mode: 0o700 });
  const stdoutLog = path.join(context.logsDir, `${tool}.stdout.log`);
  const stderrLog = path.join(context.logsDir, `${tool}.stderr.log`);

  const stageFor = (item: PlanItem, state: ResultStage["state"], reason?: string, extra: Partial<ResultStage> = {}): ResultStage => ({
    id: item.id,
    label: item.label,
    kind: "step",
    adapter: id,
    state,
    ...(reason ? { reason } : {}),
    ...extra,
  });
  const base = {
    requirements: items.map((i) => ({ id: i.id, required: i.requirement === "required", reason: i.reason.message })),
    disabled: [],
    logs: [] as string[],
    outputs: [relToRun(context.runDir, outDir)],
  };
  const all = (state: ResultStage["state"], reason: string, extra: Partial<ResultStage> = {}): AdapterOutput => ({ ...base, stages: items.map((i) => stageFor(i, state, reason, extra)), findings: [] });

  const unavailable = items.find((i) => i.availability.status !== "available");
  if (unavailable) return all("blocked", unavailable.availability.reason ?? t("security_blocked", { tool: label, detail: command.executable }));
  if (!container) return all("blocked", t("security_blocked", { tool: label, detail: t("security_no_container") }));

  const mount = (target: string): string => substituteTokens(container.mounts.find((m) => m.target === target)?.source ?? "", tokens);
  const workspace = mount(CONTAINER_WORKSPACE);
  const outputDir = mount(CONTAINER_OUTPUT) || outDir;
  const cwd = substituteTokens(command.cwd, tokens);
  const relCwd = slash(path.relative(workspace, cwd)) || ".";
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
  // A report left by an earlier attempt must never be read as this run's.
  const reportPath = path.join(outputDir, def.report ?? REPORT_FILE);
  fs.rmSync(reportPath, { force: true });
  const planned = Array.isArray(invocation.contract?.capabilities) ? (invocation.contract.capabilities as unknown[]).filter((c): c is string => typeof c === "string") : [];
  const capabilities = planned.length > 0 ? planned : items.map((i) => i.capabilities[0] ?? "");

  // The database of the tool: a fresh copy of the data folder is linked in and the tool told not to download it.
  const home = resolveHome({ env: context.env });
  const dbSpec = def.database && def.database.needed(capabilities) ? def.database : null;
  let cache: CacheUse | null = null;
  try {
    cache = dbSpec ? useCache(home, dbSpec, outputDir) : null;
  } catch {
    cache = null;
  }
  let args = command.args.map((a) => substituteTokens(a, tokens));
  if (dbSpec && cache?.state === "reused") args = [...args.slice(0, -1), ...dbSpec.skipArgs, ...args.slice(-1)];

  let result: ContainerResult;
  try {
    result = await runContainer(
      {
        runtime: container.runtime,
        image: container.image,
        command: [command.executable, ...args],
        workspace,
        outputDir,
        cwd: relCwd,
        env,
        network: container.network,
        timeoutMs: timeoutSeconds * 1000,
        labels: { "org.jgates.adapter": id },
        ...(def.limits ? { limits: def.limits } : {}),
        stdin: null,
        stdoutFile: stdoutLog,
        stderrFile: stderrLog,
      },
      { parentEnv: context.env },
    );
  } catch (error) {
    // A spec the container runner refuses (an image not pinned, a bad mount) never starts.
    return all("blocked", t("security_blocked", { tool: label, detail: (error as Error).message }));
  }
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];
  // The facts are read before the cleanup removes what they come from (the database the tool downloaded).
  const facts = def.facts?.(outputDir, result.stderr) ?? {};
  let stored = false;
  if (facts.database && cache?.state === "reused") {
    // Read from the cached copy: its source is the one recorded when it was downloaded, and no network was needed.
    facts.database = { ...facts.database, source: cache.record.source ?? facts.database.source, networkRequired: false };
  } else if (dbSpec && cache?.state === "download" && result.exitCode !== null && def.exitCodes.includes(result.exitCode)) {
    try {
      stored = storeCache(home, dbSpec, outputDir, facts.database?.source ?? null) !== null;
    } catch {
      stored = false;
    }
  }
  def.cleanup?.(outputDir);
  const uninterpreted = (reason: string): AdapterOutput => ({ ...all("error", reason, { interpreted: false, nativeStatus: `exit ${result.exitCode ?? "-"}` }), logs: base.logs });

  if (result.spawnError) return { ...all("blocked", t("security_blocked", { tool: label, detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
  if (result.timedOut) return { ...all("timeout", t("security_timeout", { tool: label, seconds: timeoutSeconds })), logs: base.logs };
  if (result.cancelled) return { ...all("cancelled", t("security_cancelled", { tool: label })), logs: base.logs };
  if (result.exitCode === null || !def.exitCodes.includes(result.exitCode)) {
    const detail = result.stderr.trim().split(/\r?\n/).slice(-3).join(" ") || String(result.signal ?? "");
    const key = result.container.runtimeFailure ? "security_runtime_failed" : "security_exit_error";
    return uninterpreted(t(key, { tool: label, code: result.exitCode ?? "-", detail }));
  }

  let text: string;
  try {
    const size = fs.statSync(reportPath).size;
    if (size > reportLimit(context.env)) return uninterpreted(t("security_report_too_large", { tool: label, bytes: size }));
    text = fs.readFileSync(reportPath, "utf8");
  } catch (error) {
    return uninterpreted(t("security_report_missing", { tool: label, detail: (error as NodeJS.ErrnoException).code ?? (error as Error).message }));
  }
  const cwdInContainer = toContainerPath(relCwd);
  const parsed = def.parse(text, { version, cwd: cwdInContainer, capabilities });
  if (!parsed.ok) return uninterpreted(t("security_invalid_report", { tool: label, detail: parsed.problem ?? "-" }));

  if (Object.keys(facts).length > 0) fs.writeFileSync(path.join(outputDir, FACTS_FILE), JSON.stringify(facts, null, 2) + "\n", { mode: 0o600 });
  const dbText = databaseText(facts, t, cache, stored);

  // Each finding goes to the stage of its capability (one instance may run several: Trivy vuln, misconfig, secret).
  // A finding of a capability the plan did not run here (a scanner a trivy.yaml turned on) has no stage: it is
  // dropped, and the stages say how many.
  const stageOf = (capability: string): PlanItem | undefined => items.find((i) => i.capabilities[0] === capability);
  const findings: ResultFinding[] = [];
  let dropped = 0;
  for (const { capability, ...f } of parsed.findings) {
    const item = stageOf(capability);
    if (item) findings.push({ stageId: item.id, ...f });
    else dropped += 1;
  }
  const droppedText = dropped > 0 ? t("security_findings_dropped", { count: dropped }) : "";
  return {
    ...base,
    stages: items.map((i) => {
      const mine = findings.filter((f) => f.stageId === i.id);
      const reason = [t("security_reason_completed", { tool: label, version: version ?? "?", count: mine.length }), dbText, droppedText].filter(Boolean).join("; ");
      return stageFor(i, "completed", reason, {
        findings: mine.length,
        blockingViolations: mine.filter((f) => f.blocking).length,
        nativeStatus: `exit ${result.exitCode}`,
        ...(facts.database ? { analysisInput: { database: { ...facts.database } } } : {}),
      });
    }),
    findings,
  };
}
