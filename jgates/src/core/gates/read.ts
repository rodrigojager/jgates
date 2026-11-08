// Versioned readers and the writer of the gate records. A record without schemaVersion is a legacy record: it is
// migrated to the current version before validation (v1 only added the version field). A record of a newer version
// than this build knows is refused instead of guessed. A result.json written before V2 (no `gate`) reads as a Quality
// run, whose identity is derived from its `analyzed` block.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RunResult } from "../run/types.js";
import { validateGateRecord } from "./schemas.js";
import { sourceFromAnalyzed } from "./source.js";
import { GATE_KINDS, GATE_RECORD_VERSIONS, type GateKind, type GateRecordKind, type GateRecordTypes, type GateRunIdentity, type SourceIdentity } from "./types.js";

export type GateRecordErrorCode = "GATE_RECORD_UNREADABLE" | "GATE_RECORD_INVALID" | "GATE_RECORD_UNSUPPORTED_VERSION";

export class GateRecordError extends Error {
  constructor(
    readonly code: GateRecordErrorCode,
    readonly kind: GateRecordKind | "result",
    message: string,
    readonly problems: string[] = [],
  ) {
    super(problems.length > 0 ? `${message}: ${problems.join("; ")}` : message);
    this.name = "GateRecordError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Adds the version a legacy (unversioned) source identity lacks; anything else is left for validation. */
function migrateSource(source: unknown): unknown {
  return isObject(source) && !("schemaVersion" in source) ? { ...source, schemaVersion: 1 } : source;
}

/**
 * Migrates a record of one kind to the current version. Returns it unchanged when it already is current; throws
 * GATE_RECORD_UNSUPPORTED_VERSION for a newer or a malformed version.
 */
export function migrateGateRecord(kind: GateRecordKind, doc: unknown): unknown {
  if (!isObject(doc)) return doc;
  const current = GATE_RECORD_VERSIONS[kind];
  let out: Record<string, unknown> = doc;
  if (!("schemaVersion" in out)) {
    // Version 0 (no field) to 1: the same fields, now versioned.
    out = { ...out, schemaVersion: 1 };
  }
  const version = out.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new GateRecordError("GATE_RECORD_UNSUPPORTED_VERSION", kind, `${kind} record has a malformed schemaVersion ${JSON.stringify(version)}`);
  }
  if (version > current) {
    throw new GateRecordError("GATE_RECORD_UNSUPPORTED_VERSION", kind, `${kind} record version ${version} is newer than the supported version ${current}`);
  }
  if (kind === "run-identity" && "source" in out) out = { ...out, source: migrateSource(out.source) };
  if (kind === "evidence-binding" && isObject(out.identities) && "source" in out.identities) {
    out = { ...out, identities: { ...out.identities, source: migrateSource(out.identities.source) } };
  }
  return out;
}

/** Reads a record of one kind from parsed JSON: migrates it, validates it, and throws GateRecordError when invalid. */
export function readGateRecord<K extends GateRecordKind>(kind: K, doc: unknown): GateRecordTypes[K] {
  const migrated = migrateGateRecord(kind, doc);
  const problems = validateGateRecord(kind, migrated);
  if (problems.length > 0) throw new GateRecordError("GATE_RECORD_INVALID", kind, `invalid ${kind} record`, problems);
  return migrated as GateRecordTypes[K];
}

function readJson(file: string, kind: GateRecordKind | "result"): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new GateRecordError("GATE_RECORD_UNREADABLE", kind, `cannot read ${file}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new GateRecordError("GATE_RECORD_UNREADABLE", kind, `${file} is not JSON: ${(error as Error).message}`);
  }
}

/** Reads a record file of one kind through the versioned reader. */
export function loadGateRecord<K extends GateRecordKind>(kind: K, file: string): GateRecordTypes[K] {
  return readGateRecord(kind, readJson(file, kind));
}

/** Validates and writes a record (temporary file then rename, so a reader never sees half a record). */
export function writeGateRecord<K extends GateRecordKind>(kind: K, file: string, record: GateRecordTypes[K]): GateRecordTypes[K] {
  const problems = validateGateRecord(kind, record);
  if (problems.length > 0) throw new GateRecordError("GATE_RECORD_INVALID", kind, `refusing to write an invalid ${kind} record`, problems);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return record;
}

/** The gate of a result document: its `gate` field, or quality when absent (every result written before V2). */
export function gateOfResult(doc: { gate?: unknown }): GateKind {
  if (doc.gate === undefined) return "quality";
  if (typeof doc.gate === "string" && (GATE_KINDS as readonly string[]).includes(doc.gate)) return doc.gate as GateKind;
  throw new GateRecordError("GATE_RECORD_INVALID", "result", `result has an unknown gate ${JSON.stringify(doc.gate)}`);
}

export interface ResultReadOptions {
  /** The source identity recorded for the run, when the producer kept one; otherwise it is derived from `analyzed`. */
  source?: SourceIdentity;
}

/**
 * Reads a result document (result.json or the --json stdout) as the identity of a gate run. A result without `gate`
 * (written before V2) is a Quality run and is marked migratedFrom result-v1-without-gate.
 */
export function readResultAsGateRun(doc: unknown, options: ResultReadOptions = {}): GateRunIdentity {
  if (!isObject(doc)) throw new GateRecordError("GATE_RECORD_INVALID", "result", "result is not a JSON object");
  if (doc.schemaVersion !== 1) {
    throw new GateRecordError("GATE_RECORD_UNSUPPORTED_VERSION", "result", `result schemaVersion ${JSON.stringify(doc.schemaVersion)} is not supported`);
  }
  const result = doc as unknown as Partial<RunResult> & { gate?: unknown };
  const gate = gateOfResult(result);
  const analyzed = result.analyzed ?? null;
  const config = analyzed?.hashes?.config;
  const artifacts: Record<string, unknown> = isObject(result.artifacts) ? result.artifacts : {};
  const identity: GateRunIdentity = {
    schemaVersion: 1,
    gate,
    runId: String(result.runId ?? ""),
    configHash: typeof config === "string" ? config : null,
    source: options.source ?? sourceFromAnalyzed(analyzed, result.workspace?.path ?? null),
    plan: {
      hash: result.selection?.planHash ?? analyzed?.hashes?.plan ?? null,
      source: result.selection?.planSource ?? null,
    },
    stages: (Array.isArray(result.stages) ? result.stages : []).map((s) => ({ id: String(s.id), state: String(s.state) })),
    outcome: {
      decision: result.decision as GateRunIdentity["outcome"]["decision"],
      complete: result.complete as boolean,
      reduced: result.reduced as boolean,
      exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      partial: result.partial === true,
    },
    artifacts: {
      result: typeof artifacts.result === "string" ? artifacts.result : null,
      logs: Array.isArray(artifacts.logs) ? artifacts.logs.map(String) : [],
      outputs: Array.isArray(artifacts.outputs) ? artifacts.outputs.map(String) : [],
      ...(typeof artifacts.plan === "string" ? { plan: artifacts.plan } : {}),
      ...(typeof artifacts.events === "string" ? { events: artifacts.events } : {}),
    },
    ...(result.gate === undefined ? { migratedFrom: "result-v1-without-gate" as const } : {}),
  };
  return readGateRecord("run-identity", identity);
}

/** Reads a result.json file as the identity of a gate run (see readResultAsGateRun). */
export function loadResultAsGateRun(file: string, options: ResultReadOptions = {}): GateRunIdentity {
  return readResultAsGateRun(readJson(file, "result"), options);
}
