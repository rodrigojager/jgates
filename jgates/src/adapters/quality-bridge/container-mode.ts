// The bridge's external scanners in the sidecar image. On a machine where the scanners are not installed (Windows
// above all: MegaLinter only exists in the image), the bridge would answer "missing" for every one of them. When
// Docker answers and the sidecar image (quality-gate/Dockerfile) is built, JGates runs those subchecks in the image
// instead, and the built-in ones (file size, the project's tests and coverage) stay on the host, where the project's
// own runtime is. The two answers are merged into one bridge response, so the rest of the run does not change.
//
// JGATES_BRIDGE_RUNNER chooses: `auto` (the default) uses the image only when a requested scanner is not on the host,
// `local` never uses it, `container` always does (and says why when it cannot). A governed request (jgates ci) and a
// custom sidecar (JGATES_SIDECAR_DIR) always stay local: the first runs inside the image already, the second is a
// development copy the image does not carry.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findQualityGateDir, findOnPath, parseBridgeStdout, validateResponse, type BridgeOutcome, type BridgeRequest, type BridgeResponse, type BridgeSubcheck } from "../../core/bridge/index.js";
import { resolveHome } from "../../core/home/index.js";
import { containerRuntime, runtimeClientEnv, SIDECAR_IMAGE } from "../../core/prepare/image.js";
import { CONTAINER_CACHE, CONTAINER_OUTPUT, CONTAINER_WORKSPACE, runContainer } from "../../core/runner/index.js";
import { translator } from "../../i18n/index.js";

/** Subchecks that run an external scanner (the rest are built into the sidecar or run the project's own tests). */
export const EXTERNAL_SUBCHECKS: readonly string[] = ["megalinter", "semgrep", "gitleaks", "trivy", "checkov", "osv-scanner", "jscpd"];

/** The command each external subcheck needs on the host (MegaLinter's launcher exists only in the image). */
function hostCommand(subcheck: string, env: NodeJS.ProcessEnv): string | null {
  if (subcheck === "megalinter") return env.MEGALINTER_COMMAND?.trim() || null;
  return subcheck;
}

export type BridgeRunner =
  | { kind: "local"; hint: string | null; missing: string[] }
  | { kind: "container"; image: string; imageId: string; runtime: string; external: string[] };

export interface RunnerFacts {
  /** JGATES_BRIDGE_RUNNER. */
  setting: "auto" | "local" | "container";
  /** The requested external subchecks whose scanner is not on the host. */
  missing: string[];
  /** The requested external subchecks. */
  external: string[];
  runtime: string | null;
  daemon: boolean;
  imageId: string | null;
}

/** The setting of JGATES_BRIDGE_RUNNER (anything unknown is `auto`). */
export function runnerSetting(env: NodeJS.ProcessEnv): RunnerFacts["setting"] {
  const value = (env.JGATES_BRIDGE_RUNNER ?? "").trim().toLowerCase();
  return value === "local" || value === "container" ? value : "auto";
}

/** The external subchecks of a request (null when the request does not name its subchecks: a legacy request). */
export function externalSubchecks(request: BridgeRequest): string[] | null {
  const subs = request.subchecks;
  if (!Array.isArray(subs)) return null;
  return subs.filter((s): s is string => typeof s === "string" && EXTERNAL_SUBCHECKS.includes(s));
}

/** Pure decision from the facts gathered (kept apart so it is tested without Docker). */
export function decideRunner(request: BridgeRequest, facts: RunnerFacts, t: (key: string, params?: Record<string, string | number>) => string, buildDir: string): BridgeRunner {
  const local = (hint: string | null): BridgeRunner => ({ kind: "local", hint, missing: facts.missing });
  if (request.hardened === true || request.mode !== "full" || facts.external.length === 0) return local(null);
  if (facts.setting === "local") return local(null);
  if (facts.setting === "auto" && facts.missing.length === 0) return local(null);
  if (facts.runtime && facts.daemon && facts.imageId) {
    return { kind: "container", image: SIDECAR_IMAGE, imageId: facts.imageId, runtime: facts.runtime, external: facts.external };
  }
  const reason = !facts.runtime || !facts.daemon
    ? t("bridge_docker_missing", { image: SIDECAR_IMAGE })
    : t("bridge_image_missing", { image: SIDECAR_IMAGE, command: `docker build -t ${SIDECAR_IMAGE} "${buildDir}"` });
  return local(reason);
}

function inspectImage(runtime: string, env: NodeJS.ProcessEnv): { daemon: boolean; imageId: string | null } {
  const r = spawnSync(runtime, ["image", "inspect", "--format", "{{.Id}}", SIDECAR_IMAGE], { encoding: "utf8", timeout: 30_000, env: runtimeClientEnv(env), windowsHide: true });
  const id = r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] ?? "" : "";
  if (/^sha256:[0-9a-f]{64}$/.test(id)) return { daemon: true, imageId: id };
  // The image is not there, or the daemon does not answer: `info` tells the two apart.
  const info = spawnSync(runtime, ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 15_000, env: runtimeClientEnv(env), windowsHide: true });
  return { daemon: info.status === 0, imageId: null };
}

/** Gathers the facts (host PATH, Docker, the image) and decides where the bridge's scanners run. */
export function chooseBridgeRunner(request: BridgeRequest, env: NodeJS.ProcessEnv): BridgeRunner {
  const t = translator("security");
  const setting = runnerSetting(env);
  const external = externalSubchecks(request) ?? [];
  const missing = external.filter((s) => {
    const command = hostCommand(s, env);
    return command === null || findOnPath(command, env) === null;
  });
  const facts: RunnerFacts = { setting, missing, external, runtime: null, daemon: false, imageId: null };
  const buildDir = findQualityGateDir() ?? "quality-gate";
  // A custom sidecar is a development copy: the image does not carry it, so it never runs in the image.
  if (env.JGATES_SIDECAR_DIR && setting !== "container") return decideRunner(request, { ...facts, setting: "local" }, t, buildDir);
  const wantsImage = request.hardened !== true && request.mode === "full" && external.length > 0 && setting !== "local" && (setting === "container" || missing.length > 0);
  if (wantsImage) {
    const runtime = containerRuntime(env).path;
    facts.runtime = runtime;
    if (runtime) Object.assign(facts, inspectImage(runtime, env));
  }
  return decideRunner(request, facts, t, buildDir);
}

/** The local part of a split request: everything but the external subchecks. */
export function localPart(request: BridgeRequest, external: readonly string[]): BridgeRequest {
  const subs = (request.subchecks as string[] | undefined) ?? [];
  return { ...request, subchecks: subs.filter((s) => !external.includes(s)) };
}

/** A host path inside the workspace as the container sees it; anything else is kept as it is. */
function toContainer(value: string, workspace: string): string {
  if (!path.isAbsolute(value)) return value;
  const rel = path.relative(workspace, value);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return value;
  return `${CONTAINER_WORKSPACE}/${rel.split(path.sep).join("/")}`;
}

/** The container part of a split request: only the external subchecks, with the container's paths. */
export function containerPart(request: BridgeRequest, external: readonly string[]): BridgeRequest {
  const configs = request.toolConfigs && typeof request.toolConfigs === "object" ? (request.toolConfigs as Record<string, string>) : null;
  const translated = configs ? Object.fromEntries(Object.entries(configs).map(([k, v]) => [k, toContainer(v, request.target)])) : null;
  const out: BridgeRequest = {
    ...request,
    target: CONTAINER_WORKSPACE,
    outputDir: CONTAINER_OUTPUT,
    projectTests: false,
    coverage: false,
    pii: false,
    subchecks: [...external],
  };
  if (translated) out.toolConfigs = translated;
  else delete out.toolConfigs;
  return out;
}

const STATUS_RANK: Record<BridgeResponse["status"], number> = { APPROVED: 0, NEEDS_CHANGES: 1, REJECTED: 2, ERROR: 3 };
const EXIT_OF: Record<BridgeResponse["status"], number> = { APPROVED: 0, REJECTED: 1, NEEDS_CHANGES: 2, ERROR: 3 };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** A response standing for a part that gave no usable answer: its subchecks are errors with the reason. */
export function failedPart(subchecks: readonly string[], reason: string): BridgeResponse {
  return {
    schemaVersion: 1,
    ok: true,
    status: "NEEDS_CHANGES",
    exitCode: 2,
    subchecks: subchecks.map((id) => ({ id, status: "error" as const, error: reason })),
    report: { findings: [], tools: [], summary: { counts: {}, reasons: [reason], toolErrors: [...subchecks] } },
  };
}

function mergeCounts(a: unknown, b: unknown): Rec {
  const out: Rec = {};
  for (const src of [a, b]) {
    if (!isRec(src)) continue;
    for (const [k, v] of Object.entries(src)) if (typeof v === "number") out[k] = ((out[k] as number | undefined) ?? 0) + v;
  }
  return out;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * One response from the host part and the container part. Each subcheck comes from the part that ran it; the
 * container's findings and tools are only those of its external scanners (a policy evaluated on both sides counts
 * once); the score loses what each part lost; the verdict is the worst of the two, or REJECTED below the threshold.
 */
export function mergeResponses(host: BridgeResponse, container: BridgeResponse, external: readonly string[]): BridgeResponse {
  const ext = new Set(external);
  const subchecks: BridgeSubcheck[] = [
    ...host.subchecks.filter((s) => !ext.has(s.id)),
    ...container.subchecks.filter((s) => ext.has(s.id)),
  ];
  const hostReport = isRec(host.report) ? host.report : undefined;
  const boxReport = isRec(container.report) ? container.report : undefined;
  const ofTool = (item: unknown, key: string): string | undefined => (isRec(item) && typeof item[key] === "string" ? (item[key] as string) : undefined);
  const findings = [
    ...(Array.isArray(hostReport?.findings) ? hostReport.findings : []),
    ...(Array.isArray(boxReport?.findings) ? boxReport.findings.filter((f) => ext.has(ofTool(f, "tool") ?? "")) : []),
  ];
  const tools = [
    ...(Array.isArray(hostReport?.tools) ? hostReport.tools.filter((x) => !ext.has(ofTool(x, "name") ?? "")) : []),
    ...(Array.isArray(boxReport?.tools) ? boxReport.tools.filter((x) => ext.has(ofTool(x, "name") ?? "")) : []),
  ];
  const hostScore = isRec(hostReport?.score) ? hostReport.score : undefined;
  const boxScore = isRec(boxReport?.score) ? boxReport.score : undefined;
  let score: Rec | undefined = hostScore ?? boxScore;
  if (hostScore && boxScore && typeof hostScore.value === "number" && typeof boxScore.value === "number") {
    score = { ...hostScore, value: Math.max(0, Math.round((hostScore.value + boxScore.value - 100) * 100) / 100) };
  }
  let status: BridgeResponse["status"] = STATUS_RANK[host.status] >= STATUS_RANK[container.status] ? host.status : container.status;
  if (status === "APPROVED" || status === "NEEDS_CHANGES") {
    if (score && typeof score.value === "number" && typeof score.threshold === "number" && score.value < score.threshold) status = "REJECTED";
  }
  const hostSummary = isRec(hostReport?.summary) ? hostReport.summary : {};
  const boxSummary = isRec(boxReport?.summary) ? boxReport.summary : {};
  const summary: Rec = {
    ...hostSummary,
    counts: mergeCounts(hostSummary.counts, boxSummary.counts),
    reasons: [...new Set([...strings(hostSummary.reasons), ...strings(boxSummary.reasons)])],
    toolErrors: [...new Set([...strings(hostSummary.toolErrors), ...strings(boxSummary.toolErrors).filter((x) => ext.has(x))])],
  };
  const report = { ...(boxReport ?? {}), ...(hostReport ?? {}), status, exitCode: EXIT_OF[status], findings, tools, summary, ...(score ? { score } : {}) };
  return { ...host, ok: host.ok && container.ok, status, exitCode: EXIT_OF[status], subchecks, report };
}

/** Adds the reason a scanner is missing (no Docker, no image) to the missing external subchecks of a local answer. */
export function withMissingHint(outcome: BridgeOutcome, missing: readonly string[], hint: string): BridgeOutcome {
  if (outcome.kind !== "response") return outcome;
  const set = new Set(missing);
  const subchecks = outcome.response.subchecks.map((s) => (s.status === "missing" && set.has(s.id) ? { ...s, error: hint } : s));
  return { ...outcome, response: { ...outcome.response, subchecks } };
}

export interface ContainerCall {
  runner: Extract<BridgeRunner, { kind: "container" }>;
  request: BridgeRequest;
  workspace: string;
  hostOutputDir: string;
  env: NodeJS.ProcessEnv;
  stdoutFile: string;
  stderrFile: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** The sidecar's cache folder in the JGates data folder (scanner databases and rules, kept between runs). */
export function sidecarCacheDir(env: NodeJS.ProcessEnv): string {
  return path.join(resolveHome({ env }), "cache", "quality-sidecar");
}

/** Runs the container part and returns its outcome in the bridge's own form. */
export async function callBridgeInContainer(call: ContainerCall): Promise<BridgeOutcome> {
  const started = Date.now();
  const interpreter = `${call.runner.runtime} ${call.runner.image} (${call.runner.imageId.slice(0, 19)})`;
  fs.mkdirSync(call.hostOutputDir, { recursive: true, mode: 0o700 });
  const cache = sidecarCacheDir(call.env);
  for (const sub of ["home", "xdg"]) fs.mkdirSync(path.join(cache, sub), { recursive: true, mode: 0o700 });
  const cpus = Math.max(2, Math.min(4, os.cpus().length));
  const result = await runContainer(
    {
      runtime: call.runner.runtime,
      image: call.runner.imageId,
      command: ["bridge"],
      workspace: call.workspace,
      outputDir: call.hostOutputDir,
      cacheDir: cache,
      // The scanners download their databases and registry rules (Trivy, OSV-Scanner, Semgrep's p/default).
      network: "bridge",
      limits: { memoryMb: 6144, cpus, pids: 4096, tmpfsMb: 1024 },
      env: {
        HOME: `${CONTAINER_CACHE}/home`,
        XDG_CACHE_HOME: `${CONTAINER_CACHE}/xdg`,
        SEMGREP_SEND_METRICS: "off",
        SEMGREP_ENABLE_VERSION_CHECK: "0",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
      labels: { "org.jgates.bridge": "true" },
      stdin: JSON.stringify(call.request),
      timeoutMs: call.timeoutMs,
      stdoutFile: call.stdoutFile,
      stderrFile: call.stderrFile,
      ...(call.signal ? { signal: call.signal } : {}),
    },
    { parentEnv: call.env },
  );
  const raw = { interpreter, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: Date.now() - started };
  if (result.spawnError) return { kind: "failure", code: "spawn-failed", message: `${result.spawnError.code}: ${result.spawnError.message}`, ...raw };
  if (result.timedOut) return { kind: "failure", code: "timeout", message: `the sidecar container did not answer within ${call.timeoutMs} ms`, ...raw };
  if (result.cancelled) return { kind: "failure", code: "spawn-failed", message: "the sidecar container was cancelled", ...raw };
  if (result.container.runtimeFailure) {
    const last = result.stderr.trim().split(/\r?\n/).slice(-1)[0] ?? "";
    return { kind: "failure", code: "spawn-failed", message: `the container runtime failed (exit ${result.exitCode}): ${last}`, ...raw };
  }
  const parsed = parseBridgeStdout(result.stdout);
  if ("problem" in parsed) return { kind: "failure", code: "unreadable-output", message: `${parsed.problem} (exit code ${result.exitCode})`, ...raw };
  const problems = validateResponse(parsed.doc);
  if (problems.length > 0) return { kind: "failure", code: "invalid-response", message: `the bridge response does not match its schema: ${problems.slice(0, 5).join("; ")}`, ...raw };
  return { kind: "response", response: parsed.doc as BridgeResponse, ...raw };
}

/** The response of one part, or a stand-in where the part failed (its subchecks are errors with the reason). */
export function responseOf(outcome: BridgeOutcome, subchecks: readonly string[], label: string): BridgeResponse {
  if (outcome.kind === "response") return outcome.response;
  return failedPart(subchecks, `${label}: ${outcome.code}: ${outcome.message}`);
}
