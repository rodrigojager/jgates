// Bridge to the Python quality sidecar: one JSON request in, one JSON response out.
//
// Interpreter: JGATES_PYTHON when set (absolute path or a name looked up on PATH); otherwise the Python environment
// JGates installs into (<JGATES_HOME>/tools/python, created by `jgates doctor --fix`) when it exists; otherwise the
// first of `python` and `python3` found on PATH. In the repository that is the .venv (`.venv/bin` first on PATH).
// The project's own Python (pytest) is resolveProjectPython: it never picks the JGates environment.
// Sidecar package: JGATES_SIDECAR_DIR when set (folder that holds the quality_sidecar package); otherwise
// quality-gate/sidecar, found by walking up from this module. It is prepended to PYTHONPATH, so the bridge
// works with an editable install and without one.
// The response is validated against quality-gate/schemas/bridge-response.schema.json: anything else is a failure.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runSpec } from "../runner/process.js";
import { pythonEnvBinDir, pythonEnvInterpreter } from "../install/paths.js";

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

/** Looks a command up on PATH (PATHEXT on Windows); an absolute or relative path is checked as is. */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)] : [""];
  if (command.includes("/") || command.includes("\\")) {
    for (const ext of exts) if (isFile(command + ext)) return path.resolve(command + ext);
    return null;
  }
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
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

/** Resolves the Python interpreter for the sidecar (see the header of this module). */
export function resolvePython(env: NodeJS.ProcessEnv = process.env): { interpreter: string | null; tried: string[] } {
  if (!env.JGATES_PYTHON) {
    const own = pythonEnvInterpreter(env);
    if (own) return { interpreter: own, tried: [own] };
  }
  return resolveProjectPython(env);
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
  const { interpreter, tried } = resolvePython(env);
  if (!interpreter) {
    return { kind: "failure", code: "python-not-found", message: `no Python interpreter found on PATH (tried: ${tried.join(", ")})`, ...base };
  }
  const sidecarDir = resolveSidecarDir(env);
  if (!sidecarDir) {
    return { kind: "failure", code: "spawn-failed", message: "the quality sidecar package was not found", ...base, interpreter };
  }
  const envTimeout = Number(env.JGATES_BRIDGE_TIMEOUT_MS);
  const timeoutMs = opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
  // On the JGates environment, the sidecar's scanners installed there (Ruff, Semgrep) come first on its PATH.
  const ownBin = interpreter === pythonEnvInterpreter(env) ? pythonEnvBinDir(env) : null;
  const pathKey = env.PATH === undefined && env.Path !== undefined ? "Path" : "PATH";
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    ...(ownBin ? { [pathKey]: env[pathKey] ? `${ownBin}${path.delimiter}${env[pathKey]}` : ownBin } : {}),
    PYTHONPATH: env.PYTHONPATH ? `${sidecarDir}${path.delimiter}${env.PYTHONPATH}` : sidecarDir,
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
