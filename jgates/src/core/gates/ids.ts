// Run IDs of the two gates live in disjoint namespaces: Quality keeps the historic run_... form and Semantic uses
// sem_..., so one ID can never name runs of both gates (the schemas enforce the prefixes). Sequences use seq_....
import crypto from "node:crypto";
import type { GateKind } from "./types.js";

export const RUN_ID_PREFIXES: Readonly<Record<GateKind, string>> = { quality: "run_", semantic: "sem_" };
export const SEQUENCE_ID_PREFIX = "seq_";

const stampOf = (now: Date): string => now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** New run ID of a gate: prefix, UTC timestamp and a random suffix (the Quality form equals core/ids newRunId). */
export function newGateRunId(gate: GateKind, now: Date = new Date()): string {
  return `${RUN_ID_PREFIXES[gate]}${stampOf(now)}_${crypto.randomBytes(4).toString("hex")}`;
}

export function newSequenceId(now: Date = new Date()): string {
  return `${SEQUENCE_ID_PREFIX}${stampOf(now)}_${crypto.randomBytes(4).toString("hex")}`;
}

/** The gate a run ID belongs to, from its prefix; null for an ID of neither namespace. */
export function gateOfRunId(runId: string): GateKind | null {
  if (runId.startsWith(RUN_ID_PREFIXES.quality)) return "quality";
  if (runId.startsWith(RUN_ID_PREFIXES.semantic)) return "semantic";
  return null;
}
