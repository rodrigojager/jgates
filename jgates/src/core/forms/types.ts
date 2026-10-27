/**
 * Schema-driven forms. A form belongs to an adapter and edits one section of
 * the tool's configuration document. Each field has a data schema (type, enum, limits: what the tool accepts) and a UI
 * schema (label, help, group, section, widget, order, unit: how the field is shown), kept apart.
 *
 * The persisted source is always the native text: a form never serialises the document. Each change is an
 * intent on one field, which becomes a codec edit (a minimal patch on the original text).
 */

/** A JSON Schema (2020-12) of one field value. Only standard keywords: the UI hints live in `FormFieldUi`. */
export type JsonSchema = Record<string, unknown>;

export type FieldGroup = "common" | "advanced";

/**
 * Widgets the renderer knows. `rule-list` and `glob-list` are string lists with a hint of what the items are; `ordered`
 * marks a list whose order matters (the UI offers to move items). `list-map` is an object of string → string list
 * (per-file ignores).
 */
export type FieldWidget = "number" | "text" | "select" | "radio" | "boolean" | "string-list" | "rule-list" | "glob-list" | "list-map";

export interface FormFieldUi {
  /** Catalog key (area "forms") of the label. */
  label: string;
  /** Catalog key of the help text. */
  help: string;
  group: FieldGroup;
  /** Id of one of `FormDefinition.sections` (for example general, lint, format). */
  section: string;
  widget: FieldWidget;
  order: number;
  /** Catalog key of the unit shown next to a number. */
  unit?: string;
  /** Example shown as a placeholder (never written). */
  example?: string;
  /** For lists: the order of the items matters. */
  ordered?: boolean;
}

export interface FormFieldSpec {
  /** Key path of the field inside the form section. */
  path: string[];
  schema: JsonSchema;
  ui: FormFieldUi;
}

/** A document the form applies to: by file name, with the key path of the section the form edits. */
export interface FormDocumentSpec {
  file: string;
  section: string[];
}

export interface FormDefinition {
  /** Form id (usually the adapter id). */
  id: string;
  /** Adapter whose instances use this form. */
  adapter: string;
  /** Catalog key of the form title. */
  title: string;
  /** Formats the form can edit, by document file name; the first match of the binding wins. */
  documents: FormDocumentSpec[];
  /** Sections of the form, in display order. */
  sections: Array<{ id: string; label: string }>;
  fields: FormFieldSpec[];
}

/**
 * State of a field in the document:
 *  - `set`: the key is present and the value is valid for the schema;
 *  - `inherited`: the key is absent (the tool uses its default or an inherited configuration);
 *  - `unrecognized`: the key is present with a value the schema does not accept. The form shows it read-only and never
 *    removes or changes it; the text editor is the way to change it.
 */
export type FieldState = "set" | "inherited" | "unrecognized";

export interface Position {
  line: number;
  column: number;
}

export interface FieldView {
  /** Stable id: the path joined by dots (relative to the section). */
  id: string;
  path: string[];
  /** Path in the document (section + field path), joined by dots, as the user would search it. */
  documentPath: string;
  label: string;
  help: string;
  group: FieldGroup;
  section: string;
  widget: FieldWidget;
  order: number;
  unit: string | null;
  example: string | null;
  ordered: boolean;
  schema: JsonSchema;
  state: FieldState;
  /** Present for `set` and `unrecognized`. */
  value?: unknown;
  /** The tool default (the schema `default`), shown for an inherited field; never written. */
  defaultValue?: unknown;
  /** Why the value is not recognized. */
  problems: string[];
  /** Position of the key in the file (null when absent or when the codec cannot place it). */
  position: Position | null;
}

export interface UnsupportedEntry {
  /** Path relative to the section. */
  path: string[];
  documentPath: string;
  position: Position | null;
}

export interface FormUnavailable {
  code: "DOCUMENT_MISSING" | "DOCUMENT_NOT_TEXT" | "STRUCTURED_EDIT_UNAVAILABLE" | "DOCUMENT_PARSE" | "SECTION_NOT_TABLE";
  message: string;
  position: Position | null;
}

export interface FormView {
  form: { id: string; adapter: string; title: string };
  instance: string;
  binding: string;
  document: {
    relPath: string | null;
    format: string;
    exists: boolean;
    state: string;
    sharedWith: Array<{ tool: string; binding: string; role: string }>;
  };
  /** Revision (sha256) of the document the view was read from; shared by every editor of the same file. */
  revision: string | null;
  /** Key path of the section the form edits. */
  section: string[];
  /** False when the form cannot be used (the text editor still works); `unavailable` says why. */
  available: boolean;
  unavailable: FormUnavailable | null;
  /** True when the document can be written (its state is editable). */
  editable: boolean;
  sections: Array<{ id: string; label: string }>;
  fields: FieldView[];
  /** Keys of the section the form does not cover, with their position in the file. */
  unsupported: UnsupportedEntry[];
}

/** One change of the form: set the field to a value, or remove it so the inherited value applies again. */
export type FormIntent = { field: string; op: "set"; value: unknown } | { field: string; op: "inherit" };

export interface FormRequest {
  /** Revision the form was read from. */
  expectedRevision: string | null;
  intents: FormIntent[];
}

export interface FormProposal {
  /** Field ids that change the document. */
  changes: string[];
  changed: boolean;
  text: string;
  /** Unified diff from the document on disk to the proposed text. */
  diff: string;
  validation: { status: string; errors: Array<{ message: string; line: number | null; column: number | null }> };
}

export interface FormConflict {
  status: "conflict";
  expectedRevision: string | null;
  current: { revision: string | null; text: string | null; exists: boolean };
  /** The same intents applied over the current version, for the user to confirm (never saved on their own). */
  rebased: ({ ok: true; revision: string | null } & FormProposal) | { ok: false; code: string; message: string };
}

export type FormPreviewResult = ({ status: "ok"; revision: string | null } & FormProposal) | FormConflict;

export type FormSaveResult =
  | ({ status: "saved"; previousRevision: string | null; revision: string } & FormProposal)
  | { status: "unchanged"; revision: string | null; changes: string[] }
  | FormConflict;
