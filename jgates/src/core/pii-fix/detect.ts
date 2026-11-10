// The built-in PII detector (the quality sidecar, through the JSON bridge with a PII-only request), run over the
// temporary copy of the files of `jgates pii check`. The answer carries rule, entity, file and line, never the value.
import { sidecarRuntime } from "../bridge/index.js";
import { runSpec } from "../runner/process.js";
import { exceptionLine } from "../runner/stderr.js";
import { HELPER_WORK_DIR, runPiiHelper, type HelperFile } from "./helper.js";
import { parsePiiResponse } from "../../adapters/builtin-pii/normalize.js";

export interface BuiltinFinding {
  /** Relative to the copy (the same as the project path). */
  path: string;
  entity: string;
  line: number | null;
}

export type BuiltinOutcome =
  | { state: "completed"; findings: BuiltinFinding[] }
  | { state: "unavailable" | "error" | "timeout"; reason: string };

const BRIDGE_ARGS = ["-m", "quality_sidecar", "bridge"];
export const BUILTIN_TIMEOUT_SECONDS = 300;

/**
 * Runs the detector over the files of a scope. Inside the tools image it runs natively over `target` (the temporary copy);
 * anywhere else the same sidecar runs in a helper container that receives the files on standard input and answers on
 * standard output (the host has no Python and the helper sees nothing of the project but these files).
 */
export async function runBuiltinDetector(
  target: string,
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  files: readonly HelperFile[] = [],
): Promise<BuiltinOutcome> {
  const runtime = sidecarRuntime(env);
  const interpreter = runtime.interpreter;
  let result: { stdout: string; stderr: string; exitCode: number | null; truncated: boolean };
  if (!runtime.native) {
    const answer = await runPiiHelper({ schemaVersion: 1, operation: "pii", target: HELPER_WORK_DIR, config }, files, BUILTIN_TIMEOUT_SECONDS * 1000, env);
    if (answer.kind === "unavailable") return { state: "unavailable", reason: `the PII detector runs in the JGates tools image and the helper container could not start: ${answer.reason}` };
    if (answer.kind === "timeout") return { state: "timeout", reason: `no answer within ${BUILTIN_TIMEOUT_SECONDS} s` };
    result = { stdout: answer.stdout, stderr: answer.stderr, exitCode: answer.exitCode, truncated: false };
  } else {
    if (!interpreter) return { state: "unavailable", reason: `Python not found (${runtime.tried.join(", ")})` };
    const sidecar = runtime.pythonPath;
    const native = await runSpec(
      {
        executable: interpreter,
        args: [...BRIDGE_ARGS],
        cwd: target,
        env: { ...(sidecar ? { PYTHONPATH: sidecar } : {}), PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
        stdin: JSON.stringify({ schemaVersion: 1, operation: "pii", target, config }),
        timeoutMs: BUILTIN_TIMEOUT_SECONDS * 1000,
      },
      { parentEnv: env },
    );
    if (native.spawnError) return { state: "unavailable", reason: `${native.spawnError.code}: the detector could not start` };
    if (native.timedOut) return { state: "timeout", reason: `no answer within ${BUILTIN_TIMEOUT_SECONDS} s` };
    result = native;
  }
  const parsed = parsePiiResponse(result.stdout, { stageId: "pii-check", version: null });
  if (parsed.bridgeError) return { state: "error", reason: `${parsed.bridgeError.code}: ${parsed.bridgeError.message}` };
  if (!parsed.ok || result.truncated || result.exitCode !== 0) {
    // A detector that died before answering: the exception line of its stderr says why (never the rest of it).
    const crash = result.stdout.trim() === "" && result.exitCode !== 0 ? exceptionLine(result.stderr) : null;
    if (crash) return { state: "error", reason: `exit code ${result.exitCode ?? "-"}: ${crash}` };
    return { state: "error", reason: result.truncated ? "output truncated" : (parsed.problem ?? `exit code ${result.exitCode ?? "-"}`) };
  }
  return {
    state: "completed",
    findings: parsed.findings.map((f) => ({ path: f.location?.path ?? "", entity: f.ruleId.replace(/^pii\./, ""), line: f.location?.line ?? null })),
  };
}
