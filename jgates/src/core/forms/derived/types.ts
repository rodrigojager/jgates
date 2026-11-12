// Types of the forms derived from the configuration schemas (ADR-0009). A derived form is a flat list of fields and
// groups addressed by key path; the UI builds the tree from the paths. The same shapes serve the schema form (no file:
// one template per pattern) and the file form (every key of the file, plus the known keys it leaves to inheritance).
import type { JsonSchema } from "../types.js";
import type { ConfigKind } from "./schemas.js";
import type { ValueSource } from "./sources.js";

/**
 * The control of a field:
 *  - select (an enum of more than four values), radio (up to four), switch (boolean), number (with limits and presets),
 *    checklist (a list of known values), list (a list of free values), text (a string), readonly (a constant);
 *  - choice: a value of one of several shapes (oneOf/anyOf); `shapes` lists them, their own keys follow as fields;
 *  - yaml: a value the schema leaves open (an object without declared keys), edited as YAML text.
 */
export type DerivedWidget = "select" | "radio" | "switch" | "number" | "checklist" | "list" | "text" | "readonly" | "choice" | "yaml";

/** A container: an object of declared keys, a map of entries by id, a list of objects. */
export type DerivedGroupKind = "object" | "map" | "array";

export interface DerivedOption {
  value: string | number | boolean | null;
  /** Catalogue name (or the overlay's label); the value itself when there is none. */
  label: string;
  /** The raw value, shown as secondary text. */
  secondary: string;
}

export interface NumberLimits {
  integer: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
}

export interface DerivedShape {
  index: number;
  widget: DerivedWidget | "group";
  /** A short name of the shape ("text", "object", "list", the const it holds...). */
  label: string;
  options?: DerivedOption[];
  limits?: NumberLimits;
}

/** A field or group as the schema declares it: a pattern of key paths ("tools.*.persona", "templates[].activation"). */
export interface FieldTemplate {
  pattern: string;
  /** Segments of the pattern: "*" stands for a map key, "[]" for a list index. */
  segments: string[];
  /** Index of the oneOf/anyOf shape of an ancestor this key belongs to (absent: every shape). */
  shape?: number;
  widget: DerivedWidget;
  schema: JsonSchema;
  help: string | null;
  default?: unknown;
  /** The key is listed in `required` of its object. */
  required: boolean;
  nullable: boolean;
  options?: DerivedOption[];
  limits?: NumberLimits;
  /** Values offered in one click for a number (within the limits). */
  presets?: number[];
  /** Unit of a number, from its name (seconds, minutes, days, megabytes, percent). */
  unit?: string;
  shapes?: DerivedShape[];
  source?: ValueSource;
}

export interface GroupTemplate {
  pattern: string;
  segments: string[];
  shape?: number;
  kind: DerivedGroupKind;
  help: string | null;
  required: boolean;
  /** For a map: the pattern its keys must match (propertyNames). */
  keyPattern?: string;
  source?: ValueSource;
}

export interface SchemaForm {
  schemaVersion: 1;
  /** The schema file (jgates.schema.json) or "adapter:<id>" for the settings of an adapter. */
  schema: string;
  kind: ConfigKind;
  title: string;
  /** The document the form edits (null for the templates: one file each). */
  document: string | null;
  /** For an adapter form: the adapter and its catalogue name. */
  adapter?: { id: string; label: string };
  fields: FieldTemplate[];
  groups: GroupTemplate[];
}

/** Where a value comes from (the vocabulary of `config resolve --explain` and of the tool limits). */
export type OriginKind = "file" | "configuration" | "profile" | "template" | "adapter" | "default";

export interface DerivedOrigin {
  /**
   * file: written in this file; configuration: another configuration file of the project; profile: the profile (or a
   * parent profile); template: a template; adapter: an adapter's default; default: JGates' own default or the schema's.
   */
  kind: OriginKind;
  /** Identity inside the layer: the file, "profile:<id>", "builtin:base", "adapter:<id>", "jgates", "schema". */
  source: string;
  /** File that holds the value (relative to the project, "builtin:..." for built-in items); null when there is none. */
  file: string | null;
  /** Dotted path of the value inside that file; null when there is no file. */
  path: string | null;
}

export interface DisplayLabel {
  /** The catalogue name (or the overlay's label, or the key in words). */
  text: string;
  /** The technical id or key, shown as secondary text. */
  secondary: string;
}

/** A link to the YAML editor at a key: `#/config/yaml?file=<file>&path=<path>`. */
export interface YamlLink {
  file: string;
  /** Dotted key path, list indexes in brackets (selection.gates, templates[0].activation). */
  path: string;
  /** Line and column of the key in the file; for an absent key, of the nearest key around it that exists. */
  line: number | null;
  column: number | null;
}

export interface FieldDiagnostic {
  code: string;
  message: string;
  suggestion?: string;
  line?: number;
  column?: number;
}

/**
 * State of a field in the file:
 *  - set: present, and the schema accepts it;
 *  - inherited: absent; `value` is the effective value and `origin` says where it comes from;
 *  - invalid: present, and the schema refuses it (`diagnostics` say why);
 *  - custom: a key the schema does not know (a "campo personalizado"), edited as text, with its diagnostic.
 */
export type DerivedState = "set" | "inherited" | "invalid" | "custom";

export interface DerivedField {
  /** The key path as text (the YAML link path). */
  id: string;
  path: Array<string | number>;
  /** The template it was built from (absent for a custom key). */
  pattern: string | null;
  /** Id of the group that holds it ("" for the top of the document). */
  group: string;
  widget: DerivedWidget;
  schema: JsonSchema | null;
  label: DisplayLabel;
  help: string | null;
  state: DerivedState;
  /** The value in the file (set, invalid, custom) or the effective value (inherited; null when there is none). */
  value: unknown;
  /** A custom key, or a value the UI edits as text: the YAML of the value. */
  text?: string;
  origin: DerivedOrigin;
  link: YamlLink;
  diagnostics: FieldDiagnostic[];
  required: boolean;
  nullable: boolean;
  default?: unknown;
  options?: DerivedOption[];
  limits?: NumberLimits;
  presets?: number[];
  unit?: string;
  shapes?: DerivedShape[];
  /** The shape of a choice the value has (index into `shapes`). */
  shape?: number;
  source?: ValueSource;
  /** A key of tools.<id> the schema accepts but this adapter does not read. */
  foreign?: boolean;
  /** From a hand-written overlay: display order, section and UI hints. */
  order?: number;
  section?: string;
  example?: string;
  showWhen?: { field: string; equals: unknown };
  format?: string;
  prefill?: unknown;
  suggestions?: string[];
}

export interface DerivedGroup {
  id: string;
  path: Array<string | number>;
  pattern: string;
  group: string;
  kind: DerivedGroupKind;
  /** For a map entry or a list item: also "entry" / "item" in `role`. */
  role: "container" | "entry" | "item";
  present: boolean;
  label: DisplayLabel;
  help: string | null;
  link: YamlLink;
  keyPattern?: string;
}

export interface FormFile {
  file: string;
  kind: ConfigKind;
  exists: boolean;
  /** sha256 of the bytes; null when the file does not exist. Every write must send it back. */
  revision: string | null;
  /** False in governed mode, for a generated file (the lock) or when the file cannot be parsed. */
  editable: boolean;
}

export interface DerivedForm {
  schemaVersion: 1;
  file: FormFile;
  /** The document parses; false: `diagnostics` has the syntax error and only the YAML editor can fix it. */
  available: boolean;
  fields: DerivedField[];
  groups: DerivedGroup[];
  /** Every diagnostic of the file (syntax, schema), with its key path. */
  diagnostics: Array<FieldDiagnostic & { path: string }>;
}

/** The form of one tool instance: the tools.<id> section of the tools file, with the adapter's overlay when it has one. */
export interface InstanceForm extends DerivedForm {
  instance: { id: string; adapter: string; label: DisplayLabel; declaredIn: "tools-file" | "template"; foreign: string[] };
  /** Key path of the section (["tools", "<id>"]). */
  section: string[];
  /** Every instance has a derived form; kept for the Options tab (T14). */
  hasForm: true;
  /** The hand-written overlay applied to the fields (an instance-settings form). */
  overlay: { id: string; title: string } | null;
  /** A hand-written form of a native file of the tool (ruff.toml, pytest.ini...), served by /api/forms/<instance>. */
  nativeForm: { id: string; title: string; documents: string[] } | null;
  choices?: Array<{ id: string; label: string; help: string; required: boolean; options: Array<{ field: string; label: string; help: string }> }>;
  rules?: Array<{ when: { field: string; equals: unknown }; require: { field: string; equals: unknown }; message: string }>;
}

/** One key edit: set a value at a key path of one file, or remove the key. */
export interface KeyEditRequest {
  file: string;
  path: Array<string | number>;
  op: "set" | "remove";
  /** The new value (set). */
  value?: unknown;
  /** The new value as YAML text, for a field edited as text (a custom key); used when `value` is absent. */
  yaml?: string;
  /** The revision the form was read from (null: the file did not exist). */
  expectedRevision: string | null;
}

export interface KeyEditPreview {
  status: "ok";
  file: string;
  /** The revision the edit applies to. */
  revision: string | null;
  changed: boolean;
  /** Unified diff from the file on disk to the proposed text. */
  diff: string;
  text: string;
  /** Parents left empty by a removal, removed with it. */
  pruned: string[];
  /** Problems the edit would bring that the file did not have; a save is refused while there is one. */
  problems: Array<{ path: string; code: string; message: string }>;
  writable: boolean;
}

export type KeyEditSave =
  | { status: "saved"; file: string; previousRevision: string | null; revision: string; changed: true; diff: string; pruned: string[] }
  | { status: "unchanged"; file: string; revision: string | null; changed: false; diff: ""; pruned: string[] };
