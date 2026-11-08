// Validation of the gate records against jgates/schemas/gates/<kind>.schema.json (Ajv, JSON Schema 2020-12, strict).
// The schemas reference each other by $id (run identity and evidence binding embed the source identity), so they are
// compiled together, once.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { GATE_RECORD_KINDS, type GateRecordKind } from "./types.js";

/** jgates/schemas/gates, found from dist/core/gates (and from src/core/gates). */
export function gateSchemaDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "schemas", "gates");
}

export function gateSchemaFile(kind: GateRecordKind): string {
  return path.join(gateSchemaDir(), `${kind}.schema.json`);
}

type Validator = ((doc: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string; params?: unknown }> | null };
interface AjvLike {
  addSchema(schema: object): unknown;
  getSchema(id: string): Validator | undefined;
}

let validators: Map<GateRecordKind, Validator> | null = null;

function compiled(): Map<GateRecordKind, Validator> {
  if (validators) return validators;
  const require = createRequire(import.meta.url);
  const mod = require("ajv/dist/2020") as { default: new (opts: object) => AjvLike };
  const ajv = new mod.default({ strict: true, allErrors: true });
  const ids = new Map<GateRecordKind, string>();
  for (const kind of GATE_RECORD_KINDS) {
    const schema = JSON.parse(fs.readFileSync(gateSchemaFile(kind), "utf8")) as { $id: string };
    ajv.addSchema(schema);
    ids.set(kind, schema.$id);
  }
  const out = new Map<GateRecordKind, Validator>();
  for (const [kind, id] of ids) {
    const validate = ajv.getSchema(id);
    if (!validate) throw new Error(`gate schema ${kind} did not compile`);
    out.set(kind, validate);
  }
  validators = out;
  return out;
}

/** Checks the schema cannot express: none of them may make an invalid record valid. */
function extraProblems(kind: GateRecordKind, doc: unknown): string[] {
  if (kind !== "sequence" || doc === null || typeof doc !== "object") return [];
  const runs = (doc as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) return [];
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const [i, ref] of runs.entries()) {
    const id = ref && typeof ref === "object" ? (ref as { runId?: unknown }).runId : undefined;
    if (typeof id !== "string") continue;
    if (seen.has(id)) problems.push(`/runs/${i}/runId must not reuse run ID ${id}: each gate has its own run`);
    seen.add(id);
  }
  return problems;
}

/** Validates a record of one kind; returns the problems ("<pointer> <message>"), empty when valid. */
export function validateGateRecord(kind: GateRecordKind, doc: unknown): string[] {
  const validate = compiled().get(kind);
  if (!validate) throw new Error(`unknown gate record kind ${kind}`);
  const problems = validate(doc) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
  return [...problems, ...extraProblems(kind, doc)];
}

export const validateSourceIdentity = (doc: unknown): string[] => validateGateRecord("source-identity", doc);
export const validateRunIdentity = (doc: unknown): string[] => validateGateRecord("run-identity", doc);
export const validateSequence = (doc: unknown): string[] => validateGateRecord("sequence", doc);
export const validateScope = (doc: unknown): string[] => validateGateRecord("scope", doc);
export const validateEvidenceBinding = (doc: unknown): string[] => validateGateRecord("evidence-binding", doc);
