// Bridge to the Python quality sidecar: one JSON request in, one JSON response out.
//
// Interpreter (container-first, no Python on the host): the sidecar's own environment in the JGates tools image
// (/opt/tools/python/quality-sidecar, which imports quality_sidecar, tomlkit and defusedxml). On the host it only
// starts inside a step container the run launches; inside the image it runs natively. Inside the image only,
// JGATES_PYTHON names another interpreter (advanced CI setups), with the sidecar package found as below.
// The project's own Python (pytest) is resolveProjectPython, read only for such an override inside the image.
// Sidecar package for an override: JGATES_SIDECAR_DIR when set (folder that holds the quality_sidecar package);
// otherwise quality-gate/sidecar, found by walking up from this module. It is prepended to PYTHONPATH.
// The response is validated against quality-gate/schemas/bridge-response.schema.json: anything else is a failure.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runSpec } from "../runner/process.js";
import { findOnPath } from "../runner/path-lookup.js";

export { findOnPath };
import { stepMode } from "../runner/in-image.js";
import { inImageOverride, probeImageTool } from "../tools-image/catalogue.js";

export const SUBCHECK_STATUSES = ["ok", "findings", "skipped", "missing", "timeout", "error"] as const;
export type SubcheckStatus = (typeof SUBCHECK_STATUSES)[number];

export interface BridgeSubcheck {
  id: string;
  status: SubcheckStatus;
  findings?: number;
  exitCode?: number;
  reason?: string;
  error?: string;
  /** Effective argv the sidecar ran, in the public form of its report (workspace paths relative to the target). */
  command?: string[];
  /** Configuration file a configurable scanner used: the project's (local mode) or the package's. */
  config?: { source: "project" | "package"; path: string };
}

export interface BridgeResponse {
  schemaVersion: 1;
  ok: boolean;
  status: "APPROVED" | "REJECTED" | "NEEDS_CHANGES" | "ERROR";
  exitCode: number;
  error?: { code: string; message: string; tool?: string; path?: string };
  outputDir?: string;
  reportPath?: string;
  markdownPath?: string;
  subchecks: BridgeSubcheck[];
  report?: Record<string, unknown> & { findings: unknown[]; tools: unknown[] };
}

/** Request accepted by `python -m quality_sidecar bridge` (quality-gate/schemas/bridge-request.schema.json). */
export interface BridgeRequest {
  schemaVersion: 1;
  target: string;
  outputDir: string;
  mode?: "quick" | "offline" | "full";
  pii?: boolean;
  secrets?: boolean;
  iac?: boolean;
  projectTests?: boolean;
  coverage?: boolean;
  [key: string]: unknown;
}

export type BridgeFailureCode = "python-not-found" | "spawn-failed" | "timeout" | "unreadable-output" | "invalid-response";

export interface BridgeRaw {
  /** Interpreter that was (or would have been) started. */
  interpreter: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export type BridgeOutcome =
  | ({ kind: "response"; response: BridgeResponse } & BridgeRaw)
  | ({ kind: "failure"; code: BridgeFailureCode; message: string } & BridgeRaw);

export interface BridgeCallOptions {
  /** Working folder of the child process (the run folder, never the workspace). */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Default 30 minutes; JGATES_BRIDGE_TIMEOUT_MS overrides it. */
  timeoutMs?: number;
  /** Cancels the call (the whole process tree stops); defaults to the signal of the runner's execution scope. */
  signal?: AbortSignal;
  /**
   * Log files the sidecar's output streams into while it runs (the runner's own bounded logs, cut at
   * JGATES_MAX_LOG_BYTES with a marker); absent when the interpreter or the sidecar is missing and nothing starts.
   */
  stdoutFile?: string;
  stderrFile?: string;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The Python of the project (JGATES_PYTHON, then `python` and `python3` on PATH): the one its tests run with. */
export function resolveProjectPython(env: NodeJS.ProcessEnv = process.env): { interpreter: string | null; tried: string[] } {
  const tried = env.JGATES_PYTHON ? [env.JGATES_PYTHON] : ["python", "python3"];
  for (const name of tried) {
    const found = findOnPath(name, env);
    if (found) return { interpreter: found, tried };
  }
  return { interpreter: null, tried };
}

/** The interpreter of the quality sidecar's environment in the tools image. */
export const IMAGE_SIDECAR_PYTHON = "/opt/tools/python/quality-sidecar/bin/python";

export interface SidecarRuntime {
  /** The interpreter that runs the sidecar (null only for an override that names nothing on PATH). */
  interpreter: string | null;
  /** True when this process may start it itself: JGates runs inside the tools image. On the host only a step
   * container the run launches can start it (a host process never runs it). */
  native: boolean;
  /** The folder to prepend to PYTHONPATH (an override's sidecar package); null when the interpreter imports it already. */
  pythonPath: string | null;
  /** What was looked for, for messages. */
  tried: string[];
}

/** The Python that runs the quality sidecar (see the header of this module). Starts nothing. */
export function sidecarRuntime(env: NodeJS.ProcessEnv = process.env): SidecarRuntime {
  const override = inImageOverride(env, "JGATES_PYTHON");
  if (override) return { interpreter: findOnPath(override, env), native: true, pythonPath: resolveSidecarDir(env), tried: [override] };
  return { interpreter: IMAGE_SIDECAR_PYTHON, native: stepMode(env) === "in-image", pythonPath: null, tried: [IMAGE_SIDECAR_PYTHON] };
}

export interface SidecarAvailability extends SidecarRuntime {
  /** null when the sidecar can run; otherwise why not (an override's interpreter or package missing, or an image
   * without the sidecar). */
  problem: "python_missing" | "sidecar_missing" | null;
  /** The sidecar's version (the image's, or the package's pyproject.toml for an override). */
  version: string | null;
}

/** Whether the quality sidecar can run (for the plan): the image's copy from image.json, or an in-image override. */
export function sidecarAvailability(env: NodeJS.ProcessEnv = process.env): SidecarAvailability {
  const runtime = sidecarRuntime(env);
  if (inImageOverride(env, "JGATES_PYTHON")) {
    if (!runtime.interpreter) return { ...runtime, problem: "python_missing", version: null };
    const dir = runtime.pythonPath;
    if (!dir || !isFile(path.join(dir, "quality_sidecar", "__main__.py"))) return { ...runtime, problem: "sidecar_missing", version: null };
    let version: string | null = null;
    try {
      version = /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(path.dirname(dir), "pyproject.toml"), "utf8"))?.[1] ?? null;
    } catch {
      version = null;
    }
    return { ...runtime, problem: null, version };
  }
  const image = probeImageTool("quality-sidecar", env);
  return { ...runtime, problem: image.problem === null ? null : "sidecar_missing", version: image.version };
}

/** Folder quality-gate/ of the repository, found by walking up from this module; null when absent. */
export function findQualityGateDir(start: string = path.dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "quality-gate");
    if (isFile(path.join(candidate, "sidecar", "quality_sidecar", "__main__.py"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function resolveSidecarDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.JGATES_SIDECAR_DIR) return path.resolve(env.JGATES_SIDECAR_DIR);
  const qg = findQualityGateDir();
  return qg ? path.join(qg, "sidecar") : null;
}

type Validator = ((doc: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> | null };
let validator: Validator | null = null;

/** Compiled validator of bridge-response.schema.json (Ajv, draft 2020-12, strict). Throws when the schema is missing. */
export function responseValidator(): Validator {
  if (validator) return validator;
  const qg = findQualityGateDir();
  const file = qg ? path.join(qg, "schemas", "bridge-response.schema.json") : null;
  if (!file || !isFile(file)) throw new Error("bridge-response.schema.json not found next to the quality sidecar");
  const require = createRequire(import.meta.url);
  const mod = require("ajv/dist/2020") as { default: new (opts: object) => { compile(schema: unknown): Validator } };
  const ajv = new mod.default({ strict: true, allErrors: true });
  validator = ajv.compile(JSON.parse(fs.readFileSync(file, "utf8")));
  return validator;
}

/** Validates one bridge document; returns the problems (empty when valid). */
export function validateResponse(doc: unknown): string[] {
  const validate = responseValidator();
  if (validate(doc)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
}

/** Parses the bridge stdout: exactly one JSON document (surrounding whitespace allowed). */
export function parseBridgeStdout(stdout: string): { doc: unknown } | { problem: string } {
  const text = stdout.trim();
  if (!text) return { problem: "the bridge printed nothing on stdout" };
  try {
    return { doc: JSON.parse(text) };
  } catch (error) {
    return { problem: `stdout is not one JSON document: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Calls the bridge once. Never throws for sidecar problems: they come back as a failure outcome. */
export async function callBridge(request: BridgeRequest, opts: BridgeCallOptions): Promise<BridgeOutcome> {
  const env = opts.env ?? process.env;
  const started = Date.now();
  const base: BridgeRaw = { interpreter: null, exitCode: null, stdout: "", stderr: "", durationMs: 0 };
  const runtime = sidecarRuntime(env);
  const interpreter = runtime.interpreter;
  if (!interpreter) {
    return { kind: "failure", code: "python-not-found", message: `no Python interpreter found on PATH (tried: ${runtime.tried.join(", ")})`, ...base };
  }
  const sidecarDir = runtime.pythonPath;
  if (inImageOverride(env, "JGATES_PYTHON") && !sidecarDir) {
    return { kind: "failure", code: "spawn-failed", message: "the quality sidecar package was not found", ...base, interpreter };
  }
  const envTimeout = Number(env.JGATES_BRIDGE_TIMEOUT_MS);
  const timeoutMs = opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    ...(sidecarDir ? { PYTHONPATH: env.PYTHONPATH ? `${sidecarDir}${path.delimiter}${env.PYTHONPATH}` : sidecarDir } : {}),
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };

  // Through the local runner: no shell, the whole process tree stops on timeout or cancellation, bounded capture.
  // The bridge keeps the environment it always had (the sidecar's scanners read DOCKER_HOST, proxies and so on).
  const result = await runSpec(
    {
      executable: interpreter,
      args: ["-m", "quality_sidecar", "bridge"],
      cwd: opts.cwd,
      stdin: JSON.stringify(request),
      timeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.stdoutFile ? { stdoutFile: opts.stdoutFile } : {}),
      ...(opts.stderrFile ? { stderrFile: opts.stderrFile } : {}),
    },
    { parentEnv: childEnv, envAllowlist: Object.keys(childEnv) },
  );
  const raw: BridgeRaw & { spawnError?: string; timedOut: boolean } = {
    interpreter,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - started,
    timedOut: result.timedOut,
    ...(result.spawnError ? { spawnError: result.spawnError.message } : {}),
  };
  if (result.cancelled) {
    return { kind: "failure", code: "spawn-failed", message: "the bridge was cancelled", interpreter, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: raw.durationMs };
  }
  if (result.truncated) {
    return { kind: "failure", code: "unreadable-output", message: "the bridge output exceeded the capture limit", interpreter, exitCode: result.exitCode, stdout: "", stderr: result.stderr, durationMs: raw.durationMs };
  }

  const { spawnError, timedOut, ...rest } = raw;
  if (spawnError !== undefined) return { kind: "failure", code: "spawn-failed", message: spawnError, ...rest };
  if (timedOut) return { kind: "failure", code: "timeout", message: `the bridge did not answer within ${timeoutMs} ms`, ...rest };
  const parsed = parseBridgeStdout(rest.stdout);
  if ("problem" in parsed) {
    return { kind: "failure", code: "unreadable-output", message: `${parsed.problem} (exit code ${rest.exitCode})`, ...rest };
  }
  const problems = validateResponse(parsed.doc);
  if (problems.length > 0) {
    return { kind: "failure", code: "invalid-response", message: `the bridge response does not match its schema: ${problems.slice(0, 5).join("; ")}`, ...rest };
  }
  return { kind: "response", response: parsed.doc as BridgeResponse, ...rest };
}
