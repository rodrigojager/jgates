// How many steps of a run may share the machine (ADR-0023). Only the steps that read the synchronized copy of the
// project and nothing else run beside each other; every other step runs alone. The automatic number never promises
// more memory or CPUs than the engine reports: the smaller of (engine memory / a step's memory limit) and
// (engine CPUs / a step's CPUs), at least 1 and at most 8.
import { DEFAULT_RESOURCES } from "../engine/index.js";

/** The automatic number is never above this; a number the user sets is taken as it is. */
export const MAX_AUTOMATIC_CONCURRENCY = 8;

export interface ConcurrencyFacts {
  /** Memory the engine has (or the machine, when JGates runs inside the tools image); null when unknown. */
  memoryMb: number | null;
  /** CPUs the engine has; null when unknown. */
  cpus: number | null;
}

export interface ConcurrencyChoice {
  /** The number the executor uses. */
  value: number;
  /** configuration: the user set it (configuration file or Preferences); automatic: computed from the facts. */
  source: "configuration" | "automatic";
  /** The automatic number for these facts (shown next to a configured one). */
  automatic: number;
  facts: ConcurrencyFacts;
  /** The limits of one step the automatic number was computed with. */
  step: { memoryMb: number; cpus: number };
}

const positive = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** The automatic number of steps at a time for these engine facts and these limits of a step. */
export function automaticConcurrency(facts: ConcurrencyFacts, step: { memoryMb?: number; cpus?: number } = {}): number {
  const stepMemory = positive(step.memoryMb) ? step.memoryMb : DEFAULT_RESOURCES.memoryMb;
  const stepCpus = positive(step.cpus) ? step.cpus : DEFAULT_RESOURCES.cpus;
  const bounds: number[] = [];
  if (positive(facts.memoryMb)) bounds.push(Math.floor(facts.memoryMb / stepMemory));
  if (positive(facts.cpus)) bounds.push(Math.floor(facts.cpus / stepCpus));
  // Nothing known about the engine: one step at a time, as before.
  if (bounds.length === 0) return 1;
  return Math.min(MAX_AUTOMATIC_CONCURRENCY, Math.max(1, Math.min(...bounds)));
}

/** A configured number when it is a positive integer, otherwise the automatic one. */
export function chooseConcurrency(configured: number | null | undefined, facts: ConcurrencyFacts, step: { memoryMb?: number; cpus?: number } = {}): ConcurrencyChoice {
  const automatic = automaticConcurrency(facts, step);
  const limits = { memoryMb: positive(step.memoryMb) ? step.memoryMb : DEFAULT_RESOURCES.memoryMb, cpus: positive(step.cpus) ? step.cpus : DEFAULT_RESOURCES.cpus };
  if (typeof configured === "number" && Number.isInteger(configured) && configured >= 1) return { value: configured, source: "configuration", automatic, facts, step: limits };
  return { value: automatic, source: "automatic", automatic, facts, step: limits };
}
