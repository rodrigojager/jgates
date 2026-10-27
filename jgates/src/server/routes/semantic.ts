// Configuração > Ferramentas > card do semantic gate: the state of the optional integration and the form of its
// essential fields. It is off unless jgates.yml declares extensions.semantic-gate with a provider.
// `effective` gives the provider fields in effect (baseUrl, model, apiKeyEnv) with the origin of each one: the
// project, the user's preferences (jgates providers) or the provider's default.
//
// The form follows the forms engine (core/forms): the native file is the source, each field is set, inherited (the key
// is absent) or unrecognized (a value the form does not accept: shown read-only, never removed nor replaced), and a
// save sends field intents (set or inherit) with the revision the form was read from. The intents become a minimal
// patch of jgates.yml (comments and the other keys stay byte for byte); a revision that moved is REVISION_CONFLICT,
// as in the other screens. The advanced fields (masking, prompts, include, excludes, command...) stay in the file.
import path from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import { parseDocument } from "yaml";
import { readSemanticState } from "../../adapters/semantic-gate/index.js";
import { readRevision, type YamlEdit } from "../../core/codecs/yaml/index.js";
import { ROOT_FILE } from "../../core/config/load/index.js";
import { baseUrlProblem, listProviders, PROVIDERS, publicResolution } from "../../core/providers/index.js";
import { translator } from "../../i18n/index.js";
import { HttpError } from "../http.js";
import { modeOf } from "../policy-mode.js";
import type { RouteDefinition, ServerContext } from "../types.js";
import { assertWritable, patchConfigFile } from "./templates.js";

const t = translator("server");

type Rec = Record<string, unknown>;
type AjvValidator = ((data: unknown) => boolean) & { errors?: Array<{ instancePath: string; message?: string }> | null };
type AjvCtor = new (opts: object) => { compile(schema: object): AjvValidator };
const Ajv = ((Ajv2020Module as unknown as { default?: AjvCtor }).default ?? (Ajv2020Module as unknown as AjvCtor)) as AjvCtor;
const ajv = new Ajv({ allErrors: true, strict: true });

export const SECTION = ["extensions", "semantic-gate"] as const;
const NO_CONTROL = "^[^\\u0000-\\u001f\\u007f]+$";

/** The fields of the card: the data schema (what the semantic gate accepts) and the widget the card uses. */
interface FieldSpec {
  id: string;
  widget: "boolean" | "provider" | "text" | "select" | "number" | "string-list";
  schema: Rec;
}

export const FIELDS: FieldSpec[] = [
  { id: "enabled", widget: "boolean", schema: { type: "boolean" } },
  { id: "provider", widget: "provider", schema: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" } },
  { id: "model", widget: "text", schema: { type: "string", minLength: 1, maxLength: 200, pattern: NO_CONTROL } },
  { id: "scope", widget: "select", schema: { enum: ["changed", "full", "paths"] } },
  { id: "paths", widget: "string-list", schema: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 500, pattern: NO_CONTROL } } },
  { id: "timeoutSeconds", widget: "number", schema: { type: "integer", minimum: 1, maximum: 86_400 } },
  { id: "maxCalls", widget: "number", schema: { type: "integer", minimum: 1, maximum: 10_000 } },
  { id: "maxContextChars", widget: "number", schema: { type: "integer", minimum: 1000, maximum: 100_000_000 } },
  { id: "baseUrl", widget: "text", schema: { type: "string", minLength: 1, maxLength: 2048 } },
];

const validators = new Map(FIELDS.map((f) => [f.id, ajv.compile(f.schema)]));

/** Problems of a value against the field (the schema, and the base URL rule). Never includes the value itself. */
function problemsOf(spec: FieldSpec, value: unknown, block: Rec): string[] {
  const v = validators.get(spec.id) as AjvValidator;
  if (!v(value)) return (v.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`.trim());
  if (spec.id === "baseUrl") {
    const problem = baseUrlProblem(value, block.allowInsecureHttp === true);
    if (problem) return [t(`server_prov_${problem.toLowerCase()}`)];
  }
  return [];
}

const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

interface Loaded {
  exists: boolean;
  revision: string | null;
  /** The block (an empty object when absent). */
  block: Rec;
  /** null when the form can be used; otherwise why not (the file is missing, broken, or the block is not a mapping). */
  unavailable: { code: string; message: string } | null;
}

function load(server: ServerContext): Loaded {
  const file = path.join(server.projectDir, ROOT_FILE);
  const current = readRevision(file);
  if (!current.exists) return { exists: false, revision: null, block: {}, unavailable: { code: "ROOT_MISSING", message: t("server_semantic_root_missing") } };
  const doc = parseDocument(current.text);
  if (doc.errors.length > 0) return { exists: true, revision: current.hash, block: {}, unavailable: { code: "DOCUMENT_PARSE", message: t("server_semantic_parse") } };
  const value = doc.toJS() as unknown;
  const extensions = isRec(value) ? value.extensions : undefined;
  if (extensions !== undefined && extensions !== null && !isRec(extensions)) return { exists: true, revision: current.hash, block: {}, unavailable: { code: "SECTION_NOT_TABLE", message: t("server_semantic_not_mapping", { section: "extensions" }) } };
  const block = isRec(extensions) ? extensions[SECTION[1]] : undefined;
  if (block !== undefined && block !== null && !isRec(block)) return { exists: true, revision: current.hash, block: {}, unavailable: { code: "SECTION_NOT_TABLE", message: t("server_semantic_not_mapping", { section: SECTION.join(".") }) } };
  return { exists: true, revision: current.hash, block: isRec(block) ? block : {}, unavailable: null };
}

/** The providers and connections the card offers, by kind; the value in the file stays offered even when unknown. */
function providerChoices(current: unknown): Array<{ name: string; kind: "http" | "cli" | "connection" | "other" }> {
  const choices: Array<{ name: string; kind: "http" | "cli" | "connection" | "other" }> = PROVIDERS.map((p) => ({ name: p.id, kind: p.kind }));
  try {
    for (const entry of listProviders().providers) if (entry.kind === "connection") choices.push({ name: entry.name, kind: "connection" });
  } catch {
    // A broken preferences file leaves only the known providers to choose from (the listing says why).
  }
  if (typeof current === "string" && current !== "" && !choices.some((c) => c.name === current)) choices.push({ name: current, kind: "other" });
  return choices;
}

function formView(server: ServerContext): Rec {
  const l = load(server);
  const governed = modeOf().mode === "governed";
  const fields = FIELDS.map((spec) => {
    const present = Object.prototype.hasOwnProperty.call(l.block, spec.id) && l.block[spec.id] !== null;
    const value = present ? l.block[spec.id] : undefined;
    const problems = present ? problemsOf(spec, value, l.block) : [];
    return {
      id: spec.id,
      path: [spec.id],
      documentPath: [...SECTION, spec.id].join("."),
      widget: spec.widget,
      schema: spec.schema,
      state: !present ? "inherited" : problems.length > 0 ? "unrecognized" : "set",
      ...(present ? { value } : {}),
      problems,
    };
  });
  return {
    file: ROOT_FILE,
    section: [...SECTION],
    exists: l.exists,
    revision: l.revision,
    available: l.unavailable === null,
    unavailable: l.unavailable,
    editable: l.unavailable === null && !governed,
    locked: governed ? { reason: "governed", policy: modeOf().governed?.policy ?? "" } : null,
    fields,
    providers: providerChoices(l.block.provider),
    advanced: Object.keys(l.block).filter((k) => !FIELDS.some((f) => f.id === k)),
    docs: { pt: "docs/jgates/semantic-gate.pt-BR.md", en: "docs/jgates/semantic-gate.en.md" },
  };
}

function semanticView(server: ServerContext): Rec {
  const state = readSemanticState(server.projectDir);
  const s = state.settings;
  return {
    state: state.state,
    provider: state.provider,
    model: state.model,
    scope: state.scope,
    problems: state.problems,
    effective: state.effective ? publicResolution(state.effective) : null,
    limits: s ? { timeoutSeconds: s.timeoutSeconds, maxContextChars: s.maxContextChars, maxCalls: s.maxCalls } : null,
    cost: { reported: s?.costPerCall != null, perCall: s?.costPerCall ?? null },
    excludes: s?.excludes ?? [],
    configFile: ROOT_FILE,
    configKey: SECTION.join("."),
    requestFlag: "--semantic",
    form: formView(server),
  };
}

type Intent = { field: string; op: "set"; value: unknown } | { field: string; op: "inherit" };

/** The patch of the intents over the block on disk; refuses an unknown field, an unrecognized one and an invalid value. */
function editsFor(l: Loaded, intents: readonly Intent[]): { edits: YamlEdit[]; changes: string[] } {
  if (l.unavailable) throw new HttpError(422, "FORM_UNAVAILABLE", l.unavailable.message, t("server_semantic_unavailable_fix"), { reason: l.unavailable.code });
  const last = new Map<string, Intent>();
  for (const intent of intents) last.set(intent.field, intent);
  const edits: YamlEdit[] = [];
  const changes: string[] = [];
  for (const [id, intent] of last) {
    const spec = FIELDS.find((f) => f.id === id);
    if (!spec) throw new HttpError(400, "FORM_FIELD_UNKNOWN", t("server_semantic_field_unknown", { field: id }), null, { field: id });
    const present = Object.prototype.hasOwnProperty.call(l.block, id) && l.block[id] !== null;
    const target = [...SECTION, id];
    if (present && problemsOf(spec, l.block[id], l.block).length > 0) {
      throw new HttpError(409, "FORM_FIELD_UNRECOGNIZED", t("server_semantic_field_unrecognized", { field: target.join(".") }), t("server_semantic_field_unrecognized_fix"), { field: id });
    }
    if (intent.op === "inherit") {
      if (!present) continue;
      edits.push({ op: "delete", path: target });
      changes.push(id);
      continue;
    }
    const problems = problemsOf(spec, intent.value, l.block);
    if (problems.length > 0) throw new HttpError(422, "FORM_VALUE_INVALID", t("server_semantic_value_invalid", { field: target.join("."), problems: problems.join("; ") }), null, { field: id, problems });
    if (present && same(l.block[id], intent.value)) continue;
    edits.push({ op: "set", path: target, value: intent.value });
    changes.push(id);
  }
  return { edits, changes };
}

const intentsSchema = {
  type: "array",
  maxItems: 40,
  items: {
    oneOf: [
      {
        type: "object",
        properties: { field: { type: "string", minLength: 1, maxLength: 64 }, op: { const: "set" }, value: {} },
        required: ["field", "op", "value"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { field: { type: "string", minLength: 1, maxLength: 64 }, op: { const: "inherit" } },
        required: ["field", "op"],
        additionalProperties: false,
      },
    ],
  },
};

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/semantic",
    handler({ server }) {
      return { status: 200, json: semanticView(server) };
    },
  },
  {
    // Saves the intents of the card in jgates.yml > extensions.semantic-gate with the revision the card was read from.
    // Under /api/config/, so the governed mode refuses it like every other write of the configuration.
    method: "PUT",
    path: "/api/config/semantic",
    body: {
      type: "object",
      properties: { expectedRevision: { anyOf: [{ type: "string", pattern: "^[0-9a-f]{64}$" }, { type: "null" }] }, intents: intentsSchema },
      required: ["expectedRevision", "intents"],
      additionalProperties: false,
    },
    handler({ body, server }) {
      assertWritable();
      const request = body as { expectedRevision: string | null; intents: Intent[] };
      const l = load(server);
      if (l.revision !== request.expectedRevision) {
        throw new HttpError(409, "REVISION_CONFLICT", t("server_semantic_conflict", { file: ROOT_FILE }), t("server_semantic_conflict_fix"), { currentRevision: l.revision });
      }
      const { edits, changes } = editsFor(l, request.intents);
      if (edits.length > 0) patchConfigFile(server, ROOT_FILE, "root", edits, request.expectedRevision);
      server.log(`semantic gate settings ${edits.length > 0 ? "saved" : "unchanged"}: ${changes.join(", ") || "-"}`);
      return { status: 200, json: { schemaVersion: 1, status: "OK", save: { status: edits.length > 0 ? "saved" : "unchanged", changes }, semantic: semanticView(server) } };
    },
  },
];
