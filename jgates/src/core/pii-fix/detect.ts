// The built-in PII detector (the quality sidecar, through the JSON bridge with a PII-only request), run over the
// temporary copy of the files of `jgates pii check`. The answer carries rule, entity, file and line, never the value.
import { resolvePython, resolveSidecarDir } from "../bridge/index.js";
import { runSpec } from "../runner/process.js";
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

export async function runBuiltinDetector(target: string, config: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): Promise<BuiltinOutcome> {
  const { interpreter } = resolvePython(env);
  if (!interpreter) return { state: "unavailable", reason: `Python not found (${env.JGATES_PYTHON ?? "python"})` };
  const sidecar = resolveSidecarDir(env);
  if (!sidecar) return { state: "unavailable", reason: "the quality-gate package (sidecar) was not found" };
  const result = await runSpec(
    {
      executable: interpreter,
      args: [...BRIDGE_ARGS],
      cwd: target,
      env: { PYTHONPATH: sidecar, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      stdin: JSON.stringify({ schemaVersion: 1, operation: "pii", target, config }),
      timeoutMs: BUILTIN_TIMEOUT_SECONDS * 1000,
    },
    { parentEnv: env },
  );
  if (result.spawnError) return { state: "unavailable", reason: `${result.spawnError.code}: the detector could not start` };
  if (result.timedOut) return { state: "timeout", reason: `no answer within ${BUILTIN_TIMEOUT_SECONDS} s` };
  const parsed = parsePiiResponse(result.stdout, { stageId: "pii-check", version: null });
  if (parsed.bridgeError) return { state: "error", reason: `${parsed.bridgeError.code}: ${parsed.bridgeError.message}` };
  if (!parsed.ok || result.truncated || result.exitCode !== 0) {
    return { state: "error", reason: result.truncated ? "output truncated" : (parsed.problem ?? `exit code ${result.exitCode ?? "-"}`) };
  }
  return {
    state: "completed",
    findings: parsed.findings.map((f) => ({ path: f.location?.path ?? "", entity: f.ruleId.replace(/^pii\./, ""), line: f.location?.line ?? null })),
  };
}
