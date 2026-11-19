// The number of checks at a time of a run (ADR-0023): the one the configuration sets (the project's file, a template or
// the CI policy), or the automatic one computed from what the engine reports. JGates' own default layer of
// `execution.concurrency` means "automatic": only a value written by the user (or the policy) is a configured number.
import os from "node:os";
import { encodePointer, resolveConfig } from "../config/resolve/index.js";
import { detectEngineSync, engineRuntime, type EngineContext } from "../engine/index.js";
import { chooseConcurrency, type ConcurrencyChoice, type ConcurrencyFacts } from "../runner/concurrency.js";
import { stepMode } from "../runner/in-image.js";

const MiB = 1024 * 1024;

/** The number the configuration sets, or null when only JGates' default is there (the number is then automatic). */
export function configuredConcurrency(projectDir: string, configDir?: string): number | null {
  try {
    const field = resolveConfig(projectDir, configDir ? { configDir } : {}).fields[encodePointer(["execution", "concurrency"])];
    if (!field || field.layer === "defaults") return null;
    return typeof field.value === "number" && Number.isInteger(field.value) && field.value >= 1 ? field.value : null;
  } catch {
    // A configuration that cannot be resolved is reported by the run itself; the number is then automatic.
    return null;
  }
}

/**
 * What the automatic number reads: the engine's memory and CPUs, or, when JGates runs inside the tools image (the steps
 * are processes of this container), the memory this process may use and the CPUs it sees.
 */
export function concurrencyFacts(env: NodeJS.ProcessEnv, engine?: EngineContext): ConcurrencyFacts {
  if (stepMode(env) === "in-image") {
    const total = os.totalmem();
    const constrained = typeof process.constrainedMemory === "function" ? process.constrainedMemory() : 0;
    const bytes = constrained > 0 && constrained < total ? constrained : total;
    return { memoryMb: Math.floor(bytes / MiB), cpus: typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length };
  }
  try {
    const context = engine ?? { runtime: engineRuntime(env), runnerOptions: { parentEnv: env } };
    const detection = detectEngineSync({ requiredDiskMb: 0 }, context);
    return { memoryMb: detection.facts.memoryMb, cpus: detection.facts.cpus };
  } catch {
    return { memoryMb: null, cpus: null };
  }
}

/**
 * The number of checks at a time for a run of this project: configured, or automatic from the engine. The engine is
 * asked only when the number is automatic (a configured number does not need it).
 */
export function runConcurrency(input: { projectDir: string; configDir?: string; env: NodeJS.ProcessEnv; engine?: EngineContext }): ConcurrencyChoice {
  const configured = configuredConcurrency(input.projectDir, input.configDir);
  const facts: ConcurrencyFacts = configured !== null ? { memoryMb: null, cpus: null } : concurrencyFacts(input.env, input.engine);
  return chooseConcurrency(configured, facts);
}
