// Client shapes of the derived forms API (/api/forms/derived/*, jgates/src/core/forms/derived/types.ts).
import type { ValueSource } from "../../components/pickers";

export type DerivedWidget = "select" | "radio" | "switch" | "number" | "checklist" | "list" | "text" | "readonly" | "choice" | "yaml";
export type DerivedState = "set" | "inherited" | "invalid" | "custom";
export type OriginKind = "file" | "configuration" | "profile" | "template" | "adapter" | "default";
export type KeyPath = Array<string | number>;

export interface DerivedOption {
  value: string | number | boolean | null;
  label: string;
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
  label: string;
  options?: DerivedOption[];
  limits?: NumberLimits;
}

export interface DisplayLabel {
  text: string;
  secondary: string;
}

export interface DerivedOrigin {
  kind: OriginKind;
  source: string;
  file: string | null;
  path: string | null;
}

export interface YamlLink {
  file: string;
  path: string;
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

export interface DerivedField {
  id: string;
  path: KeyPath;
  pattern: string | null;
  group: string;
  widget: DerivedWidget;
  schema: Record<string, any> | null;
  label: DisplayLabel;
  help: string | null;
  state: DerivedState;
  value: unknown;
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
  shape?: number;
  source?: ValueSource;
  foreign?: boolean;
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
  path: KeyPath;
  pattern: string;
  group: string;
  kind: "object" | "map" | "array";
  role: "container" | "entry" | "item";
  present: boolean;
  label: DisplayLabel;
  help: string | null;
  link: YamlLink;
  keyPattern?: string;
}

export interface FormFile {
  file: string;
  kind: string;
  exists: boolean;
  revision: string | null;
  editable: boolean;
}

export interface DerivedFormData {
  schemaVersion: 1;
  file: FormFile;
  available: boolean;
  fields: DerivedField[];
  groups: DerivedGroup[];
  diagnostics: Array<FieldDiagnostic & { path: string }>;
  /** Tool instance forms only. */
  instance?: { id: string; adapter: string; label: DisplayLabel; declaredIn: "tools-file" | "template"; foreign: string[] };
  section?: string[];
  overlay?: { id: string; title: string } | null;
  nativeForm?: { id: string; title: string; documents: string[] } | null;
}

export interface KeyEditRequest {
  file: string;
  path: KeyPath;
  op: "set" | "remove";
  value?: unknown;
  yaml?: string;
  expectedRevision: string | null;
}

export interface KeyEditPreview {
  status: "ok";
  file: string;
  revision: string | null;
  changed: boolean;
  diff: string;
  text: string;
  pruned: string[];
  problems: Array<{ path: string; code: string; message: string }>;
  writable: boolean;
}

export type KeyEditSave =
  | { status: "saved"; file: string; previousRevision: string | null; revision: string; changed: true; diff: string; pruned: string[] }
  | { status: "unchanged"; file: string; revision: string | null; changed: false; diff: ""; pruned: string[] };

/** What a field edit holds until it is saved: a value, or YAML text (custom keys and open values). */
export type FieldEdit = { value: unknown } | { yaml: string };

/** Where a form comes from: a configuration file of the project, or a tool instance (tools.<id> of the tools file). */
export type FormSource = { file: string } | { instance: string };
