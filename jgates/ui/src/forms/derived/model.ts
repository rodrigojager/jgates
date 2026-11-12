// What the derived form shows of a field: its label (a catalogue name for the keys the UI knows, the key as secondary
// text), where its value comes from, what an edit sends, and why a typed control is open (tests/ui/free-text.ts).
import { ft, ftOrNull } from "../i18n";
import type { DerivedField, DerivedGroup, DerivedFormData, FieldEdit, KeyEditRequest } from "./types";

/** The key a field or group is named after (the last string segment of its path). */
export function keyOf(item: { path: Array<string | number>; label: { secondary: string } }): string {
  for (let i = item.path.length - 1; i >= 0; i--) if (typeof item.path[i] === "string") return item.path[i] as string;
  return item.label.secondary;
}

/**
 * The visible name: an overlay label (fields with an order come from a hand-written form) or a catalogue name wins; a
 * key the catalogue knows gets its name in the UI language; anything else keeps the server's words.
 */
export function fieldTitle(field: DerivedField): string {
  if (field.state === "custom") return field.label.text;
  if (field.order !== undefined) return field.label.text;
  return ftOrNull(`key_${keyOf(field)}`) ?? field.label.text;
}

export function groupTitle(group: DerivedGroup): string {
  if (group.role !== "container") return group.label.text;
  return ftOrNull(`key_${keyOf(group)}`) ?? group.label.text;
}

/** Short text of a value. */
export function display(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ");
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** Where the value of a field comes from, in words. */
export function originText(field: DerivedField, form: DerivedFormData): string {
  const o = field.origin;
  switch (o.kind) {
    case "file":
      return o.file === form.file.file || o.file === null ? ft("df_origin_file") : ft("df_origin_other_file", { file: o.file });
    case "configuration":
      return ft("df_origin_configuration", { file: o.file ?? o.source });
    case "profile":
      return ft("df_origin_profile", { source: o.source.replace(/^profile:/, "") });
    case "template":
      return ft("df_origin_template", { source: o.source });
    case "adapter":
      return ft("df_origin_adapter", { source: o.source.replace(/^adapter:/, "") });
    default:
      return o.source === "schema" ? ft("df_origin_schema") : ft("df_origin_default");
  }
}

/** The number with its unit in words ("60 segundos"). */
export function withUnit(n: number, unit: string | undefined): string {
  if (!unit) return String(n);
  return ftOrNull(`unit_${unit}`, { count: n }) ?? `${n} ${unit}`;
}

/** The kind of open value a typed control of this field takes (one of tests/ui/free-text.ts FREE_TEXT_REASONS). */
export function freeTextReason(field: DerivedField, mode: "text" | "yaml" | "number" | "item" = "text"): string {
  if (field.state === "custom") return "custom-key";
  if (mode === "yaml") return "yaml-value";
  if (mode === "number") return "number";
  const key = keyOf(field);
  if (/command$/i.test(key)) return "command";
  if (/^args$|arguments$/i.test(key)) return "arguments";
  if (/image/i.test(key)) return "image-reference";
  if (/(url|target)$/i.test(key)) return "url";
  if (/(path|paths|file|files|dir|folder|include|exclude|includes|excludes)$/i.test(key)) return "project-path";
  if (/(sha256|checksum)$/i.test(key)) return "checksum";
  if (/^(id|name|env|valueEnv|header)$/i.test(key)) return "identifier";
  return "open-text";
}

/** The value a field shows: the edit when there is one, otherwise what the file has (or inherits). */
export function shownValue(field: DerivedField, edit: FieldEdit | undefined): unknown {
  if (edit && "value" in edit) return edit.value;
  return field.value;
}

/** The YAML text a field shows (custom keys, open values). */
export function shownText(field: DerivedField, edit: FieldEdit | undefined): string {
  if (edit && "yaml" in edit) return edit.yaml;
  if (field.text !== undefined) return field.text;
  if (field.value === null || field.value === undefined || field.state === "inherited") return "";
  return typeof field.value === "string" ? field.value : JSON.stringify(field.value);
}

/** True when the edit brings nothing new (the same value the file has). */
export function editIsNoop(field: DerivedField, edit: FieldEdit): boolean {
  if (field.state === "inherited") return false;
  if ("yaml" in edit) return edit.yaml === (field.text ?? "");
  return JSON.stringify(edit.value) === JSON.stringify(field.value);
}

export function setRequest(form: DerivedFormData, field: DerivedField, edit: FieldEdit): KeyEditRequest {
  return { file: form.file.file, path: field.path, op: "set", ...("yaml" in edit ? { yaml: edit.yaml } : { value: edit.value }), expectedRevision: form.file.revision };
}

export function removeRequest(form: DerivedFormData, field: DerivedField): KeyEditRequest {
  return { file: form.file.file, path: field.path, op: "remove", expectedRevision: form.file.revision };
}

/** A field written in the file (it can go back to what it inherits). */
export const isWritten = (field: DerivedField): boolean => field.state === "set" || field.state === "invalid" || field.state === "custom";
