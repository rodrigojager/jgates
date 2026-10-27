import path from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import { translator } from "../../i18n/index.js";
import { createTomlCodec, TOML_UNAVAILABLE } from "../codecs/toml/index.js";
import { jsonCodec, dialectForFile } from "../codecs/json/index.js";
import { yamlCodec } from "../codecs/yaml/codec.js";
import { CodecError, sameValue, type Codec, type CodecOptions, type FieldEdit } from "../codecs/types.js";
import { openDocument, previewEdit, saveDocument, type OpenedDocument } from "../documents/index.js";
import { resolveToolBindings, type ResolvedBinding, type ToolInstance } from "../tools/index.js";
import { builtinForms } from "./registry.js";
import { exactPositionOf, positionOf, tomlPositions } from "./toml-positions.js";
import type {
  FieldView,
  FormConflict,
  FormDefinition,
  FormFieldSpec,
  FormIntent,
  FormPreviewResult,
  FormProposal,
  FormRequest,
  FormSaveResult,
  FormUnavailable,
  FormView,
  Position,
  UnsupportedEntry,
} from "./types.js";

/**
 * Form service: reads the document of a tool instance through the codec of its format, projects the section of the
 * form onto fields (set, inherited, unrecognized), and turns field intents into minimal codec edits that are saved by
 * the document service with the revision the form was read from.
 *
 * Invariants:
 *  - nothing the user did not change is written: an intent equal to the current value, or "inherit" on an absent key,
 *    is not an edit, and defaults are never written;
 *  - "inherit" removes the key; it is never the same as false, 0 or an empty list;
 *  - a value the schema does not recognize is never removed, replaced or switched off by the form;
 *  - keys the form does not cover stay byte for byte (the codec patches only the edited keys);
 *  - a revision that moved is a conflict: the intents are never re-applied over another version on their own.
 */

export * from "./types.js";
export { builtinForms, scanForms, isFormDefinition } from "./registry.js";
export { tomlPositions, positionOf, splitTomlKey } from "./toml-positions.js";

const t = translator("forms");

export type FormErrorCode =
  | "INSTANCE_NOT_FOUND"
  | "FORM_NOT_FOUND"
  | "FORM_NO_DOCUMENT"
  | "FORM_UNAVAILABLE"
  | "FORM_READ_ONLY"
  | "FORM_FIELD_UNKNOWN"
  | "FORM_FIELD_UNRECOGNIZED"
  | "FORM_VALUE_INVALID"
  | "FORM_PATCH_FAILED";

export class FormError extends Error {
  constructor(
    readonly code: FormErrorCode,
    message: string,
    readonly fix: string | null,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "FormError";
  }
}

export interface FormOptions {
  /** Forms to use instead of the built-in ones (tests, extensions). */
  forms?: FormDefinition[];
  /** Environment of the TOML helper (the Python and the sidecar it finds). */
  env?: NodeJS.ProcessEnv;
}

type AjvValidator = ((data: unknown) => boolean) & { errors?: Array<{ instancePath: string; message?: string }> | null };
type AjvCtor = new (opts: object) => { compile(schema: object): AjvValidator };
const Ajv = ((Ajv2020Module as unknown as { default?: AjvCtor }).default ?? (Ajv2020Module as unknown as AjvCtor)) as AjvCtor;
const ajv = new Ajv({ allErrors: true, strict: true });
const validators = new WeakMap<object, AjvValidator>();

function validatorOf(spec: FormFieldSpec): AjvValidator {
  let v = validators.get(spec.schema);
  if (!v) {
    v = ajv.compile(spec.schema);
    validators.set(spec.schema, v);
  }
  return v;
}

/** Problems of a value against the field schema (empty when valid). Never includes the value itself. */
export function fieldProblems(spec: FormFieldSpec, value: unknown): string[] {
  const v = validatorOf(spec);
  if (v(value)) return [];
  return (v.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`.trim());
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fieldId = (p: readonly string[]) => p.join(".");

function codecFor(format: string, env: NodeJS.ProcessEnv | undefined): Codec | null {
  if (format === "toml") return createTomlCodec(env ? { env } : {});
  if (format === "json" || format === "jsonc") return jsonCodec;
  if (format === "yaml") return yamlCodec;
  return null;
}

function codecOptions(format: string, file: string): CodecOptions {
  return format === "json" || format === "jsonc" ? { dialect: dialectForFile(file) } : {};
}

interface Located {
  form: FormDefinition;
  instance: ToolInstance;
  binding: ResolvedBinding;
  section: string[];
}

function locate(dir: string, instanceId: string, forms: FormDefinition[]): Located {
  const resolved = resolveToolBindings(dir, { skipInventory: true });
  const instance = resolved.instances.find((i) => i.id === instanceId);
  if (!instance) {
    const available = resolved.instances.map((i) => i.id).join(", ") || "-";
    throw new FormError("INSTANCE_NOT_FOUND", t("forms_instance_not_found", { name: instanceId }), t("forms_instance_not_found_fix", { available }));
  }
  const form = forms.find((f) => f.adapter === instance.adapter);
  if (!form) throw new FormError("FORM_NOT_FOUND", t("forms_not_found", { adapter: instance.adapter }), t("forms_not_found_fix"));
  // The primary binding first, then the others, in tools.yml order.
  const ordered = [...instance.bindings].sort((a, b) => Number(b.role === "primary") - Number(a.role === "primary"));
  for (const binding of ordered) {
    if (binding.refused || binding.kind !== "file") continue;
    const name = path.basename(binding.absPath || binding.declared);
    const spec = form.documents.find((d) => d.file === name);
    if (spec) return { form, instance, binding, section: [...spec.section] };
  }
  throw new FormError("FORM_NO_DOCUMENT", t("forms_no_document", { instance: instanceId }), t("forms_no_document_fix", { files: form.documents.map((d) => d.file).join(", ") }));
}

interface Loaded extends Located {
  doc: OpenedDocument;
  codec: Codec | null;
  /** Value of the form section (undefined when the section is absent). */
  sectionValue: unknown;
  positions: Map<string, Position>;
  unavailable: FormUnavailable | null;
}

function valueAt(root: unknown, segments: readonly (string | number)[]): { present: boolean; value: unknown; blockedAt: number | null } {
  let node: unknown = root;
  for (let i = 0; i < segments.length; i++) {
    if (!isObject(node)) return { present: false, value: undefined, blockedAt: i === 0 ? null : i };
    const key = segments[i] as string;
    if (!Object.prototype.hasOwnProperty.call(node, key)) return { present: false, value: undefined, blockedAt: null };
    node = node[key];
  }
  return { present: true, value: node, blockedAt: null };
}

function load(dir: string, instanceId: string, options: FormOptions, forms: FormDefinition[], text?: string): Loaded {
  const located = locate(dir, instanceId, forms);
  const doc = openDocument(dir, instanceId, located.binding.id);
  const base: Loaded = { ...located, doc, codec: null, sectionValue: undefined, positions: new Map(), unavailable: null };
  if (!doc.exists) return { ...base, unavailable: { code: "DOCUMENT_MISSING", message: t("forms_unavailable_missing", { file: doc.relPath ?? doc.path }), position: null } };
  const source = text ?? doc.text;
  if (source === null) return { ...base, unavailable: { code: "DOCUMENT_NOT_TEXT", message: t("forms_unavailable_not_text", { file: doc.relPath ?? doc.path }), position: null } };
  const codec = codecFor(doc.format, options.env);
  if (!codec) return { ...base, unavailable: { code: "STRUCTURED_EDIT_UNAVAILABLE", message: t("forms_unavailable_format", { format: doc.format }), position: null } };
  const read = codec.read(source, codecOptions(doc.format, doc.path));
  if (!read.ok) {
    const e = read.errors[0];
    if (e?.code === TOML_UNAVAILABLE) return { ...base, codec, unavailable: { code: "STRUCTURED_EDIT_UNAVAILABLE", message: e.message, position: null } };
    const position = e?.line ? { line: e.line, column: e.column ?? 1 } : null;
    return { ...base, codec, unavailable: { code: "DOCUMENT_PARSE", message: t("forms_unavailable_parse", { detail: e?.message ?? "-" }), position } };
  }
  let positions: Map<string, Position>;
  if (doc.format === "toml") positions = tomlPositions(source);
  else {
    positions = new Map();
    for (const f of read.fields) {
      const k = JSON.stringify(f.path);
      if (!positions.has(k)) positions.set(k, { line: f.line, column: f.column });
    }
  }
  const at = valueAt(read.value, located.section);
  if (at.present && !isObject(at.value)) {
    return {
      ...base,
      codec,
      positions,
      unavailable: { code: "SECTION_NOT_TABLE", message: t("forms_unavailable_section", { section: located.section.join(".") }), position: positionOf(positions, located.section) },
    };
  }
  return { ...base, codec, positions, sectionValue: at.present ? at.value : undefined };
}

function viewOf(l: Loaded): FormView {
  const section = l.section;
  const sectionValue = l.sectionValue;
  const docPath = (p: readonly string[]) => [...section, ...p].join(".");
  const fields: FieldView[] = l.form.fields.map((spec) => {
    const at = l.unavailable ? { present: false, value: undefined, blockedAt: null } : valueAt(sectionValue ?? {}, spec.path);
    const view: FieldView = {
      id: fieldId(spec.path),
      path: [...spec.path],
      documentPath: docPath(spec.path),
      label: t(spec.ui.label),
      help: t(spec.ui.help),
      group: spec.ui.group,
      section: spec.ui.section,
      widget: spec.ui.widget,
      order: spec.ui.order,
      unit: spec.ui.unit ? t(spec.ui.unit) : null,
      example: spec.ui.example ?? null,
      ordered: spec.ui.ordered === true,
      schema: spec.schema,
      state: "inherited",
      problems: [],
      position: null,
    };
    if ("default" in spec.schema) view.defaultValue = spec.schema.default;
    if (at.blockedAt !== null) {
      // A parent of the field holds something that is not a table: the field cannot be edited without replacing it.
      view.state = "unrecognized";
      view.problems = [t("forms_problem_parent", { path: docPath(spec.path.slice(0, at.blockedAt)) })];
      view.position = positionOf(l.positions, [...section, ...spec.path.slice(0, at.blockedAt)]);
      return view;
    }
    if (!at.present) return view;
    view.value = at.value;
    view.position = positionOf(l.positions, [...section, ...spec.path]);
    const problems = fieldProblems(spec, at.value);
    if (problems.length) {
      view.state = "unrecognized";
      view.problems = problems;
    } else view.state = "set";
    return view;
  });

  const unsupported: UnsupportedEntry[] = [];
  const paths = l.form.fields.map((f) => f.path);
  const walk = (node: Record<string, unknown>, prefix: string[]) => {
    for (const key of Object.keys(node)) {
      const p = [...prefix, key];
      if (paths.some((fp) => fp.length === p.length && fp.every((s, i) => s === p[i]))) continue;
      const container = paths.some((fp) => fp.length > p.length && p.every((s, i) => s === fp[i]));
      if (container && isObject(node[key])) walk(node[key] as Record<string, unknown>, p);
      else if (!container) unsupported.push({ path: p, documentPath: docPath(p), position: exactPositionOf(l.positions, [...section, ...p]) ?? positionOf(l.positions, [...section, ...p]) });
    }
  };
  if (!l.unavailable && isObject(sectionValue)) walk(sectionValue, []);

  return {
    form: { id: l.form.id, adapter: l.form.adapter, title: t(l.form.title) },
    instance: l.instance.id,
    binding: l.binding.id,
    document: { relPath: l.doc.relPath, format: l.doc.format, exists: l.doc.exists, state: l.doc.state, sharedWith: l.doc.sharedWith },
    revision: l.doc.revision,
    section,
    available: l.unavailable === null,
    unavailable: l.unavailable,
    editable: l.doc.state === "editable",
    sections: l.form.sections.map((s) => ({ id: s.id, label: t(s.label) })),
    fields: fields.sort((a, b) => a.order - b.order),
    unsupported,
  };
}

async function formsOf(options: FormOptions): Promise<FormDefinition[]> {
  return options.forms ?? (await builtinForms());
}

/** Reads the form of an instance: fields with their state, the keys the form does not cover and the revision. */
export async function openForm(dir: string, instanceId: string, options: FormOptions = {}): Promise<FormView> {
  return viewOf(load(dir, instanceId, options, await formsOf(options)));
}

/** Codec edits of the intents over the loaded document; throws FormError for an intent the form must refuse. */
function editsFor(l: Loaded, intents: readonly FormIntent[]): { edits: FieldEdit[]; changes: string[] } {
  if (l.unavailable) throw new FormError("FORM_UNAVAILABLE", l.unavailable.message, t("forms_unavailable_fix"), { reason: l.unavailable.code });
  const view = viewOf(l);
  const last = new Map<string, FormIntent>();
  for (const intent of intents) last.set(intent.field, intent);
  const edits: FieldEdit[] = [];
  const changes: string[] = [];
  for (const [id, intent] of last) {
    const spec = l.form.fields.find((f) => fieldId(f.path) === id);
    const field = view.fields.find((f) => f.id === id);
    if (!spec || !field) throw new FormError("FORM_FIELD_UNKNOWN", t("forms_field_unknown", { field: id }), t("forms_field_unknown_fix"), { field: id });
    if (field.state === "unrecognized") {
      throw new FormError("FORM_FIELD_UNRECOGNIZED", t("forms_field_unrecognized", { field: field.documentPath }), t("forms_field_unrecognized_fix", { line: field.position?.line ?? "-" }), { field: id, position: field.position });
    }
    const target = [...l.section, ...spec.path];
    if (intent.op === "inherit") {
      if (field.state === "inherited") continue;
      edits.push({ op: "delete", path: target });
      changes.push(id);
      continue;
    }
    const problems = fieldProblems(spec, intent.value);
    if (problems.length) throw new FormError("FORM_VALUE_INVALID", t("forms_value_invalid", { field: field.documentPath, problems: problems.join("; ") }), t("forms_value_invalid_fix"), { field: id, problems });
    if (field.state === "set" && sameValue(field.value, intent.value)) continue;
    edits.push({ op: "set", path: target, value: intent.value });
    changes.push(id);
  }
  return { edits, changes };
}

function propose(dir: string, l: Loaded, intents: readonly FormIntent[]): FormProposal & { revision: string | null } {
  const { edits, changes } = editsFor(l, intents);
  const text = l.doc.text ?? "";
  if (edits.length === 0) return { revision: l.doc.revision, changes, changed: false, text, diff: "", validation: { status: "valid", errors: [] } };
  let patched: string;
  try {
    patched = (l.codec as Codec).apply(text, edits, codecOptions(l.doc.format, l.doc.path)).text;
  } catch (error) {
    if (error instanceof CodecError) {
      const reason = error.details.reason === TOML_UNAVAILABLE ? "STRUCTURED_EDIT_UNAVAILABLE" : error.code;
      throw new FormError("FORM_PATCH_FAILED", t("forms_patch_failed", { detail: error.message }), t("forms_unavailable_fix"), { reason });
    }
    throw error;
  }
  const preview = previewEdit(dir, l.instance.id, l.binding.id, { text: patched });
  return { revision: preview.revision, changes, changed: preview.changed, text: patched, diff: preview.diff, validation: { status: preview.validation.status, errors: preview.validation.errors } };
}

function conflictOf(dir: string, instanceId: string, expected: string | null, intents: readonly FormIntent[], options: FormOptions, forms: FormDefinition[]): FormConflict {
  const now = load(dir, instanceId, options, forms);
  const current = { revision: now.doc.revision, text: now.doc.text, exists: now.doc.exists };
  let rebased: FormConflict["rebased"];
  try {
    const p = propose(dir, now, intents);
    rebased = { ok: true, ...p };
  } catch (error) {
    if (error instanceof FormError) rebased = { ok: false, code: error.code, message: error.message };
    else throw error;
  }
  return { status: "conflict", expectedRevision: expected, current, rebased };
}

/** Diff and validation of the intents over the document at `expectedRevision`, without writing anything. */
export async function previewForm(dir: string, instanceId: string, request: FormRequest, options: FormOptions = {}): Promise<FormPreviewResult> {
  const forms = await formsOf(options);
  const l = load(dir, instanceId, options, forms);
  if (l.doc.revision !== request.expectedRevision) return conflictOf(dir, instanceId, request.expectedRevision, request.intents, options, forms);
  return { status: "ok", ...propose(dir, l, request.intents) };
}

/**
 * Applies the intents and saves through the document service with the revision the form was read from. A moved
 * revision is a conflict with the current version and the same intents re-applied over it, for the user to confirm.
 */
export async function saveForm(dir: string, instanceId: string, request: FormRequest, options: FormOptions = {}): Promise<FormSaveResult> {
  const forms = await formsOf(options);
  const l = load(dir, instanceId, options, forms);
  if (l.doc.revision !== request.expectedRevision) return conflictOf(dir, instanceId, request.expectedRevision, request.intents, options, forms);
  if (!l.unavailable && l.doc.state !== "editable") {
    throw new FormError("FORM_READ_ONLY", t("forms_read_only", { file: l.doc.relPath ?? l.doc.path, reason: l.doc.reasons.map((r) => r.message).join("; ") || l.doc.state }), null, { state: l.doc.state });
  }
  const proposal = propose(dir, l, request.intents);
  if (!proposal.changed) return { status: "unchanged", revision: l.doc.revision, changes: proposal.changes };
  const saved = saveDocument(dir, instanceId, l.binding.id, { expectedRevision: request.expectedRevision, text: proposal.text, ...(l.doc.text !== null ? { baseText: l.doc.text } : {}) });
  if (saved.status === "conflict") return conflictOf(dir, instanceId, request.expectedRevision, request.intents, options, forms);
  if (saved.status === "unchanged") return { status: "unchanged", revision: saved.revision, changes: proposal.changes };
  return { status: "saved", previousRevision: saved.previousRevision, revision: saved.revision, changes: proposal.changes, changed: true, text: proposal.text, diff: saved.diff, validation: proposal.validation };
}
