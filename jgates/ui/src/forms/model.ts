// Client model of a schema-driven form. The server sends the fields with their state (set, inherited, unrecognized);
// the client keeps only the pending intents, one per field, and never builds the document itself.

export type FieldState = "set" | "inherited" | "unrecognized";

export interface FieldView {
  id: string;
  path: string[];
  documentPath: string;
  label: string;
  help: string;
  group: "common" | "advanced";
  section: string;
  widget: "number" | "text" | "select" | "radio" | "boolean" | "string-list" | "rule-list" | "glob-list" | "list-map";
  order: number;
  unit: string | null;
  example: string | null;
  ordered: boolean;
  schema: Record<string, any>;
  state: FieldState;
  value?: unknown;
  defaultValue?: unknown;
  problems: string[];
  position: { line: number; column: number } | null;
}

export interface FormView {
  form: { id: string; adapter: string; title: string };
  instance: string;
  binding: string;
  document: { relPath: string | null; format: string; exists: boolean; state: string; sharedWith: Array<{ tool: string; binding: string }> };
  revision: string | null;
  section: string[];
  available: boolean;
  unavailable: { code: string; message: string; position: { line: number; column: number } | null } | null;
  editable: boolean;
  sections: Array<{ id: string; label: string }>;
  fields: FieldView[];
  unsupported: Array<{ path: string[]; documentPath: string; position: { line: number; column: number } | null }>;
}

export type Pending = { op: "set"; value: unknown } | { op: "inherit" };
export type FormIntent = { field: string; op: "set"; value: unknown } | { field: string; op: "inherit" };

/** What a field shows: the pending intent when there is one, otherwise the document. */
export function effective(field: FieldView, pending: Pending | undefined): { inherited: boolean; value: unknown } {
  if (pending) return pending.op === "inherit" ? { inherited: true, value: undefined } : { inherited: false, value: pending.value };
  return { inherited: field.state === "inherited", value: field.value };
}

/** Pending intents as the API takes them. */
export function intentsOf(pending: Map<string, Pending>): FormIntent[] {
  return [...pending.entries()].map(([field, p]) => (p.op === "set" ? { field, op: "set", value: p.value } : { field, op: "inherit" }));
}

/** A change that brings the field back to what the document has is not pending any more. */
export function withPending(pending: Map<string, Pending>, field: FieldView, next: Pending): Map<string, Pending> {
  const copy = new Map(pending);
  const same =
    (next.op === "inherit" && field.state === "inherited") ||
    (next.op === "set" && field.state === "set" && JSON.stringify(next.value) === JSON.stringify(field.value));
  if (same) copy.delete(field.id);
  else copy.set(field.id, next);
  return copy;
}

const flat = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

/** Search by rule (the values, such as F401), description (label and help) and path of the field. */
export function matches(field: FieldView, query: string, pending: Pending | undefined): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const shown = effective(field, pending).value;
  const haystack = [field.label, field.help, field.documentPath, field.id, flat(field.value), flat(shown), flat(field.defaultValue)].join("\n").toLowerCase();
  return q.split(/\s+/).every((word) => haystack.includes(word));
}

/** Short text of a value for read-only display. */
export function display(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ");
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
