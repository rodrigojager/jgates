// Configuração > Execução: concurrency, network, fail-fast and the budgets of a run. They are policy of
// the repository (execution.* in jgates.yml), not a personal preference, and each one is written by patch. The origin of
// every value is the one `config resolve --explain` gives. Fields the engine does not apply yet say so (the budgets); failFast is read by `jgates run`.
import path from "node:path";
import { patchYamlText, readRevision, type YamlEdit } from "../../core/codecs/yaml/index.js";
import { unifiedDiff } from "../../core/documents/diff.js";
import { ROOT_FILE, parseYamlText } from "../../core/config/load/index.js";
import { encodePointer } from "../../core/config/resolve/index.js";
import { fileDiagnostics, invalidateProjectCache, projectResolveReadable } from "../../core/cache/project.js";
import { concurrencyFacts, configuredConcurrency } from "../../core/run/concurrency.js";
import { chooseConcurrency, MAX_AUTOMATIC_CONCURRENCY } from "../../core/runner/concurrency.js";
import { HttpError, refuseMsg } from "../http.js";
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
  /** Durations and sizes come as presets plus "Outro valor" in the screen. */
  unit?: "seconds" | "days" | "megabytes";
  presets?: number[];
}

const SECONDS = [30, 60, 120, 300, 600, 1800, 3600];
const MEGABYTES = [256, 512, 1024, 2048, 4096, 8192];

const FIELDS: FieldSpec[] = [
  { key: "concurrency", path: ["execution", "concurrency"], kind: "integer", applied: true, fallback: 1, presets: [1, 2, 4, 8] },
  { key: "network", path: ["execution", "network"], kind: "enum", options: ["explicit", "allow", "deny"], applied: true, fallback: "explicit" },
  { key: "failFast", path: ["execution", "failFast"], kind: "boolean", applied: true, fallback: false },
  { key: "timeoutSeconds", path: ["execution", "timeoutSeconds"], kind: "integer", applied: true, fallback: null, unit: "seconds", presets: SECONDS },
  { key: "dataMaxAgeDays", path: ["execution", "dataMaxAgeDays"], kind: "integer", applied: true, fallback: 7, unit: "days", presets: [1, 3, 7, 14, 30] },
  { key: "extensionImage", path: ["execution", "extensionImage"], kind: "enum", options: ["forbid", "pinned"], applied: true, fallback: null },
  { key: "trustSelfReported", path: ["execution", "trustSelfReported"], kind: "boolean", applied: true, fallback: false },
  { key: "budgets.totalSeconds", path: ["execution", "budgets", "totalSeconds"], kind: "integer", applied: false, fallback: null, unit: "seconds", presets: SECONDS },
  { key: "budgets.memoryMegabytes", path: ["execution", "budgets", "memoryMegabytes"], kind: "integer", applied: false, fallback: null, unit: "megabytes", presets: MEGABYTES },
  { key: "budgets.processes", path: ["execution", "budgets", "processes"], kind: "integer", applied: false, fallback: null, presets: [1, 2, 4, 8, 16] },
  { key: "budgets.logMegabytes", path: ["execution", "budgets", "logMegabytes"], kind: "integer", applied: false, fallback: null, unit: "megabytes", presets: [16, 64, 128, 256, 512, 1024] },
];

function describe(server: ServerContext): Rec {
  const mode = modeOf();
  const root = readRevision(path.join(server.projectDir, ROOT_FILE));
  // A key written by hand that the schema refuses (in any file) does not hide the values of jgates.yml: they are read as
  // the files hold them, and the diagnostics say where the problem is.
  const resolved = projectResolveReadable(server.projectDir);
  const fields = FIELDS.map((spec) => {
    const field = resolved.fields[encodePointer(spec.path)];
    return {
      key: spec.key,
      kind: spec.kind,
      options: spec.options ?? null,
      presets: spec.presets ?? null,
      unit: spec.unit ?? null,
      applied: spec.applied,
      value: field ? field.value : spec.fallback,
      default: spec.fallback,
      // Written in jgates.yml (the only layer a revert can remove); a value the defaults or a profile give is inherited.
      explicit: field !== undefined && field.layer === "project",
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
    diagnostics: fileDiagnostics(resolved),
  };
}

const HASH_PATTERN = "^[0-9a-f]{64}$";

/** The patch of a set of changes; a block left without keys by the reverts goes away with them. */
function editsOf(text: string, changes: Rec): YamlEdit[] {
  const edits: YamlEdit[] = Object.entries(changes).map(([key, value]) => {
    const spec = FIELDS.find((f) => f.key === key) as FieldSpec;
    return value === null ? { op: "delete" as const, path: spec.path } : { op: "set" as const, path: spec.path, value };
  });
  const parsed = parseYamlText(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, ROOT_FILE).value;
  const execution = structuredClone((parsed as Rec | undefined)?.execution ?? {}) as Rec;
  for (const e of edits) {
    let node: Rec = execution;
    const keys = e.path.slice(1) as string[];
    for (const k of keys.slice(0, -1)) {
      if (typeof node[k] !== "object" || node[k] === null) node[k] = {};
      node = node[k] as Rec;
    }
    const last = keys[keys.length - 1] as string;
    if (e.op === "set") node[last] = e.value;
    else delete node[last];
  }
  const budgets = execution.budgets as Rec | undefined;
  if (budgets && Object.keys(budgets).length === 0) delete execution.budgets;
  const hadExecution = typeof (parsed as Rec | undefined)?.execution === "object";
  if (Object.keys(execution).length === 0) {
    edits.length = 0;
    if (hadExecution) edits.push({ op: "delete", path: ["execution"] });
  } else if (budgets && Object.keys(budgets).length === 0 && edits.some((e) => e.op === "delete" && e.path[1] === "budgets")) {
    edits.push({ op: "delete", path: ["execution", "budgets"] });
  }
  return edits;
}

const changesSchema = {
  type: "object",
  minProperties: 1,
  additionalProperties: false,
  properties: Object.fromEntries(FIELDS.map((f) => [f.key, f.kind === "enum" ? { enum: [...(f.options as string[]), null] } : f.kind === "boolean" ? { type: ["boolean", "null"] } : { type: ["integer", "null"], minimum: 1, maximum: 10_000_000 }])),
};

export const routes: RouteDefinition[] = [
  {
    // The number of checks at a time (ADR-0023) as a run of this project would use it: the one the configuration sets, or the
    // automatic one from the memory and CPUs of the engine, with the facts behind it (Preferences explains the number).
    method: "GET",
    path: "/api/execution/concurrency",
    timeoutMs: 60_000,
    handler({ server }) {
      const choice = chooseConcurrency(configuredConcurrency(server.projectDir), concurrencyFacts(process.env));
      return {
        status: 200,
        json: { schemaVersion: 1, status: "OK", value: choice.value, source: choice.source, automatic: choice.automatic, max: MAX_AUTOMATIC_CONCURRENCY, memoryMb: choice.facts.memoryMb, cpus: choice.facts.cpus, step: choice.step },
      };
    },
  },
  {
    method: "GET",
    path: "/api/config/execution",
    handler({ server }) {
      return { status: 200, json: describe(server) };
    },
  },
  {
    // What a save would write: the diff of jgates.yml (nothing is written).
    method: "POST",
    path: "/api/config/execution/preview",
    body: { type: "object", additionalProperties: false, required: ["changes"], properties: { changes: changesSchema } },
    handler({ body, server }) {
      const b = body as { changes: Rec };
      const root = readRevision(path.join(server.projectDir, ROOT_FILE));
      if (!root.exists) throw refuseMsg(422, "ROOT_MISSING", "route_root_missing");
      const edits = editsOf(root.text, b.changes);
      const after = edits.length === 0 ? root.text : patchYamlText(root.text, edits).text;
      return { status: 200, json: { schemaVersion: 1, status: "OK", file: ROOT_FILE, revision: root.hash, changed: after !== root.text, diff: unifiedDiff(root.text, after, { oldLabel: `a/${ROOT_FILE}`, newLabel: `b/${ROOT_FILE}` }) } };
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
        changes: changesSchema,
      },
    },
    handler({ body, server }) {
      assertWritable();
      const b = body as { expectedRevision: string; changes: Rec };
      const root = readRevision(path.join(server.projectDir, ROOT_FILE));
      if (!root.exists) throw refuseMsg(422, "ROOT_MISSING", "route_root_missing");
      const edits = editsOf(root.text, b.changes);
      if (edits.length === 0) return { status: 200, json: describe(server) };
      patchConfigFile(server, ROOT_FILE, "root", edits, b.expectedRevision);
      // The answer is read again from the files just written (a write may fall in the clock tick of the last read).
      invalidateProjectCache();
      server.log(`execution settings saved: ${Object.keys(b.changes).join(", ")}`);
      return { status: 200, json: describe(server) };
    },
  },
];
