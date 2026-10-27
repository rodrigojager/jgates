// Configuração > Execução: default runner, concurrency, network, fail-fast and the budgets of a run. They are policy of
// the repository (execution.* in jgates.yml), not a personal preference, and each one is written by patch. The origin of
// every value is the one `config resolve --explain` gives. Fields the engine does not apply yet say so (runner and the budgets); failFast is read by `jgates run`.
import path from "node:path";
import { readRevision } from "../../core/codecs/yaml/index.js";
import { ROOT_FILE } from "../../core/config/load/index.js";
import { encodePointer, resolveConfig } from "../../core/config/resolve/index.js";
import { HttpError } from "../http.js";
import type { RouteDefinition, ServerContext } from "../types.js";
import { assertWritable, patchConfigFile } from "./templates.js";
import { modeOf } from "./workspaces.js";

type Rec = Record<string, unknown>;

interface FieldSpec {
  key: string;
  path: string[];
  kind: "enum" | "integer" | "boolean";
  options?: string[];
  /** Whether the run engine reads this setting today. */
  applied: boolean;
  fallback: unknown;
}

const FIELDS: FieldSpec[] = [
  { key: "runner", path: ["execution", "runner"], kind: "enum", options: ["local", "container"], applied: false, fallback: "local" },
  { key: "concurrency", path: ["execution", "concurrency"], kind: "integer", applied: true, fallback: 1 },
  { key: "network", path: ["execution", "network"], kind: "enum", options: ["explicit", "allow", "deny"], applied: true, fallback: "explicit" },
  { key: "failFast", path: ["execution", "failFast"], kind: "boolean", applied: true, fallback: false },
  { key: "timeoutSeconds", path: ["execution", "timeoutSeconds"], kind: "integer", applied: true, fallback: null },
  { key: "budgets.totalSeconds", path: ["execution", "budgets", "totalSeconds"], kind: "integer", applied: false, fallback: null },
  { key: "budgets.memoryMegabytes", path: ["execution", "budgets", "memoryMegabytes"], kind: "integer", applied: false, fallback: null },
  { key: "budgets.processes", path: ["execution", "budgets", "processes"], kind: "integer", applied: false, fallback: null },
  { key: "budgets.logMegabytes", path: ["execution", "budgets", "logMegabytes"], kind: "integer", applied: false, fallback: null },
];

function describe(server: ServerContext): Rec {
  const mode = modeOf();
  const root = readRevision(path.join(server.projectDir, ROOT_FILE));
  const resolved = resolveConfig(server.projectDir);
  const fields = FIELDS.map((spec) => {
    const field = resolved.fields[encodePointer(spec.path)];
    return {
      key: spec.key,
      kind: spec.kind,
      options: spec.options ?? null,
      applied: spec.applied,
      value: field ? field.value : spec.fallback,
      explicit: field !== undefined,
      origin: field ? { layer: field.layer, source: field.source, file: field.file, path: field.path } : { layer: "defaults", source: "jgates", file: null, path: null },
      saveTo: { file: ROOT_FILE, path: spec.path.join(".") },
    };
  });
  return {
    schemaVersion: 1,
    status: "OK",
    mode: mode.mode,
    governed: mode.governed,
    file: ROOT_FILE,
    exists: root.exists,
    revision: root.hash,
    fields,
    retention: "storage",
  };
}

const HASH_PATTERN = "^[0-9a-f]{64}$";

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/config/execution",
    handler({ server }) {
      return { status: 200, json: describe(server) };
    },
  },
  {
    // changes: { "network": "deny", "budgets.totalSeconds": null }. null removes the key (back to the inherited value).
    method: "PUT",
    path: "/api/config/execution",
    body: {
      type: "object",
      additionalProperties: false,
      required: ["expectedRevision", "changes"],
      properties: {
        expectedRevision: { type: "string", pattern: HASH_PATTERN },
        changes: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties: Object.fromEntries(FIELDS.map((f) => [f.key, f.kind === "enum" ? { enum: [...(f.options as string[]), null] } : f.kind === "boolean" ? { type: ["boolean", "null"] } : { type: ["integer", "null"], minimum: 1, maximum: 10_000_000 }])),
        },
      },
    },
    handler({ body, server }) {
      assertWritable();
      const b = body as { expectedRevision: string; changes: Rec };
      const root = readRevision(path.join(server.projectDir, ROOT_FILE));
      if (!root.exists) throw new HttpError(422, "ROOT_MISSING", "Não há jgates.yml neste projeto.", "Crie a configuração antes (jgates init).");
      const edits = Object.entries(b.changes).map(([key, value]) => {
        const spec = FIELDS.find((f) => f.key === key) as FieldSpec;
        return value === null ? { op: "delete" as const, path: spec.path } : { op: "set" as const, path: spec.path, value };
      });
      patchConfigFile(server, ROOT_FILE, "root", edits, b.expectedRevision);
      server.log(`execution settings saved: ${Object.keys(b.changes).join(", ")}`);
      return { status: 200, json: describe(server) };
    },
  },
];
