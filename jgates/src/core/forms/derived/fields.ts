// From a JSON schema to controls (ADR-0009, PLAN-config-editing.md section 2): enum to select (radios up to four
// values), boolean to switch, number to a number with its limits and presets, array of enum to checklist, array of
// free values to a list, object to a group, map to entries by id, oneOf/anyOf to a choice between shapes, an open
// object to YAML text. `describe` reads one schema node; `deriveTemplates` walks a whole schema into the patterns of
// its keys (the schema form), and the file form reuses `describe` while it walks the file.
import type { JsonSchema } from "../types.js";
import type { ConfigKind } from "./schemas.js";
import { valueSourceOf } from "./sources.js";
import type { DerivedGroupKind, DerivedOption, DerivedShape, DerivedWidget, FieldTemplate, GroupTemplate, NumberLimits } from "./types.js";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The most radio buttons a field gets; a longer enum is a select. */
export const RADIO_MAX = 4;
const MAX_DEPTH = 24;

/** Resolves local `$ref`s (#/$defs/...) of a node; sibling keywords (a description) win over the target's. */
export function deref(schema: unknown, root: JsonSchema, depth = 0): JsonSchema {
  if (!isObject(schema)) return {};
  const ref = schema.$ref;
  if (typeof ref !== "string" || depth > MAX_DEPTH) return schema;
  const target = resolvePointer(root, ref);
  const { $ref: _ignored, ...rest } = schema;
  return { ...deref(target, root, depth + 1), ...rest };
}

function resolvePointer(root: JsonSchema, ref: string): unknown {
  if (!ref.startsWith("#/")) return {};
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(node)) return {};
    node = node[seg];
  }
  return node;
}

const typesOf = (s: JsonSchema): string[] => (Array.isArray(s.type) ? (s.type as string[]) : typeof s.type === "string" ? [s.type] : []);

/** A branch that only states which keys are required (architecture layers: paths or modules), not a shape of its own. */
function constraintOnly(branch: JsonSchema): boolean {
  for (const key of ["type", "enum", "const", "$ref", "items", "oneOf", "anyOf", "additionalProperties"]) if (key in branch) return false;
  const props = branch.properties;
  return !isObject(props) || Object.values(props).every((p) => isObject(p) && Object.keys(p).length === 0);
}

/** The shapes of a oneOf/anyOf node (dereferenced), or null when it has none that are shapes. */
export function branchesOf(s: JsonSchema, root: JsonSchema): JsonSchema[] | null {
  const raw = Array.isArray(s.oneOf) ? s.oneOf : Array.isArray(s.anyOf) ? s.anyOf : null;
  if (!raw) return null;
  const branches = (raw as unknown[]).map((b) => deref(b, root));
  if (branches.every(constraintOnly)) return null;
  return branches;
}

const isNullSchema = (s: JsonSchema) => s.type === "null" || (Array.isArray(s.enum) && s.enum.length === 1 && s.enum[0] === null);

/** A schema with a null alternative (anyOf [X, null], type [X, "null"]) as X and a nullable flag. */
function collapseNullable(s: JsonSchema, root: JsonSchema): { schema: JsonSchema; nullable: boolean } {
  const branches = branchesOf(s, root);
  if (branches && branches.length === 2 && branches.some(isNullSchema)) {
    const other = branches.find((b) => !isNullSchema(b)) as JsonSchema;
    const { oneOf: _o, anyOf: _a, ...rest } = s;
    return { schema: { ...deref(other, root), ...(typeof rest.description === "string" ? { description: rest.description } : {}) }, nullable: true };
  }
  const types = typesOf(s);
  if (types.length === 2 && types.includes("null")) return { schema: { ...s, type: types.find((t) => t !== "null") }, nullable: true };
  return { schema: s, nullable: false };
}

function optionsOf(values: unknown[]): DerivedOption[] {
  return values.map((v) => ({ value: v as DerivedOption["value"], label: String(v), secondary: String(v) }));
}

function limitsOf(s: JsonSchema): NumberLimits {
  const out: NumberLimits = { integer: typesOf(s).includes("integer") };
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) if (typeof s[key] === "number") out[key] = s[key] as number;
  return out;
}

export function bounded(limits: NumberLimits | undefined): boolean {
  return !!limits && (limits.minimum !== undefined || limits.maximum !== undefined || limits.exclusiveMinimum !== undefined || limits.exclusiveMaximum !== undefined);
}

/** Unit and presets of a number, from the end of its key (timeoutSeconds, spiderMinutes, dataMaxAgeDays...). */
function unitOf(key: string): { unit: string; presets: number[] } | null {
  if (/Seconds$/.test(key)) return { unit: "seconds", presets: [10, 30, 60, 120, 300, 600, 1800, 3600] };
  if (/Minutes$/.test(key)) return { unit: "minutes", presets: [1, 2, 5, 10, 30, 60] };
  if (/Days$/.test(key)) return { unit: "days", presets: [1, 7, 14, 30, 90, 365] };
  if (/Megabytes$/.test(key)) return { unit: "megabytes", presets: [256, 512, 1024, 2048, 4096, 8192] };
  if (/(Percent|Score)$/.test(key)) return { unit: "percent", presets: [0, 10, 20, 50, 80, 100] };
  return null;
}

function within(n: number, l: NumberLimits): boolean {
  if (l.integer && !Number.isInteger(n)) return false;
  if (l.minimum !== undefined && n < l.minimum) return false;
  if (l.maximum !== undefined && n > l.maximum) return false;
  if (l.exclusiveMinimum !== undefined && n <= l.exclusiveMinimum) return false;
  if (l.exclusiveMaximum !== undefined && n >= l.exclusiveMaximum) return false;
  return true;
}

function presetsOf(key: string, s: JsonSchema, limits: NumberLimits): { presets?: number[]; unit?: string } {
  const unit = unitOf(key);
  const values = new Set<number>(unit?.presets ?? []);
  if (typeof s.default === "number") values.add(s.default);
  if (limits.minimum !== undefined) values.add(limits.minimum);
  if (limits.maximum !== undefined && limits.maximum <= 100_000) values.add(limits.maximum);
  const presets = [...values].filter((n) => within(n, limits)).sort((a, b) => a - b);
  return { ...(presets.length > 0 ? { presets } : {}), ...(unit ? { unit: unit.unit } : {}) };
}

export interface Described {
  /** The node dereferenced, without its null alternative. */
  schema: JsonSchema;
  nullable: boolean;
  /** A field: its control. */
  widget?: DerivedWidget;
  /** A container: its kind. */
  group?: DerivedGroupKind;
  options?: DerivedOption[];
  limits?: NumberLimits;
  presets?: number[];
  unit?: string;
  /** choice: the shapes, dereferenced. */
  branches?: JsonSchema[];
  shapes?: DerivedShape[];
  /** object: its keys. */
  properties?: Record<string, JsonSchema>;
  requiredKeys?: string[];
  /** map: the schema of every entry and the pattern of the keys. */
  entry?: JsonSchema;
  keyPattern?: string;
  /** array of objects (or of shapes): the schema of every item. */
  item?: JsonSchema;
}

function shapeOf(branch: JsonSchema, index: number, root: JsonSchema): DerivedShape {
  const d = describe(branch, root, "");
  const label =
    branch.const !== undefined
      ? String(branch.const)
      : d.group === "object" || d.group === "map"
        ? "object"
        : d.group === "array" || d.widget === "list" || d.widget === "checklist"
          ? "list"
          : (d.widget ?? "value");
  return { index, widget: d.group ? "group" : (d.widget ?? "yaml"), label, ...(d.options ? { options: d.options } : {}), ...(d.limits ? { limits: d.limits } : {}) };
}

/** How one schema node is shown. `key` is the last key of its path (for the unit of a number). */
export function describe(input: unknown, root: JsonSchema, key: string): Described {
  const { schema: s, nullable } = collapseNullable(deref(input, root), root);
  const base = { schema: s, nullable };
  if (s.const !== undefined) return { ...base, widget: "readonly", options: optionsOf([s.const]) };
  if (Array.isArray(s.enum)) {
    const values = (s.enum as unknown[]).filter((v) => v !== null);
    return { ...base, nullable: nullable || values.length < (s.enum as unknown[]).length, widget: values.length <= RADIO_MAX ? "radio" : "select", options: optionsOf(values) };
  }
  const branches = branchesOf(s, root);
  if (branches) return { ...base, widget: "choice", branches, shapes: branches.map((b, i) => shapeOf(b, i, root)) };
  const types = typesOf(s);
  if (types.includes("boolean") && types.length === 1) return { ...base, widget: "switch" };
  if ((types.includes("integer") || types.includes("number")) && types.every((t) => t === "integer" || t === "number")) {
    const limits = limitsOf(s);
    return { ...base, widget: "number", limits, ...presetsOf(key, s, limits) };
  }
  if (types.includes("array") || (types.length === 0 && "items" in s)) {
    const item = collapseNullable(deref(s.items, root), root).schema;
    if (Array.isArray(item.enum)) return { ...base, widget: "checklist", options: optionsOf((item.enum as unknown[]).filter((v) => v !== null)) };
    const inner = describe(item, root, key);
    if (inner.group || inner.widget === "choice") return { ...base, group: "array", item };
    return { ...base, widget: "list" };
  }
  const props = isObject(s.properties) ? (s.properties as Record<string, JsonSchema>) : null;
  if (props && Object.keys(props).length > 0) {
    return { ...base, group: "object", properties: props, requiredKeys: Array.isArray(s.required) ? (s.required as string[]) : [] };
  }
  if (isObject(s.additionalProperties)) {
    const names = isObject(s.propertyNames) && typeof s.propertyNames.pattern === "string" ? s.propertyNames.pattern : undefined;
    return { ...base, group: "map", entry: s.additionalProperties as JsonSchema, ...(names ? { keyPattern: names } : {}) };
  }
  if (types.includes("object") || (types.length === 0 && Object.keys(s).filter((k) => k !== "description" && k !== "title").length === 0)) return { ...base, widget: "yaml" };
  if (types.includes("string")) return { ...base, widget: "text" };
  return { ...base, widget: "yaml" };
}

/** "templates[].activation", "tools.*.persona": the text of a pattern or of a concrete path. */
export function patternOf(segments: ReadonlyArray<string | number>): string {
  let out = "";
  for (const s of segments) {
    if (s === "[]") out += "[]";
    else if (typeof s === "number") out += `[${s}]`;
    else if (s !== "*" && (/[.[\]"\s]/.test(s) || s === "")) out += `[${JSON.stringify(s)}]`;
    else out += out === "" ? s : `.${s}`;
  }
  return out;
}

/** The pattern of a concrete path, given which of its segments are map keys (`*`) and list indexes (`[]`). */
export function patternSegments(path: ReadonlyArray<string | number>, kinds: ReadonlyArray<"key" | "map" | "item">): string[] {
  return path.map((s, i) => (kinds[i] === "map" ? "*" : kinds[i] === "item" ? "[]" : String(s)));
}

function fieldTemplate(kind: ConfigKind, segments: string[], d: Described, required: boolean, shape: number | undefined): FieldTemplate {
  const pattern = patternOf(segments);
  const source = valueSourceOf(kind, pattern);
  return {
    pattern,
    segments,
    ...(shape !== undefined ? { shape } : {}),
    widget: d.widget as DerivedWidget,
    schema: d.schema,
    help: typeof d.schema.description === "string" ? d.schema.description : null,
    ...("default" in d.schema ? { default: d.schema.default } : {}),
    required,
    nullable: d.nullable,
    ...(d.options ? { options: d.options } : {}),
    ...(d.limits ? { limits: d.limits } : {}),
    ...(d.presets ? { presets: d.presets } : {}),
    ...(d.unit ? { unit: d.unit } : {}),
    ...(d.shapes ? { shapes: d.shapes } : {}),
    ...(source ? { source } : {}),
  };
}

/**
 * Every field and group of a schema, as patterns. `base` prefixes the paths (the settings of an adapter live under
 * tools.*); `entrySchema` replaces the schema of the entries of a map pattern (the instance schema of one adapter).
 */
export function deriveTemplates(
  schema: JsonSchema,
  root: JsonSchema,
  kind: ConfigKind,
  options: { base?: string[]; entrySchema?: (pattern: string) => JsonSchema | undefined } = {},
): { fields: FieldTemplate[]; groups: GroupTemplate[] } {
  const fields: FieldTemplate[] = [];
  const groups: GroupTemplate[] = [];
  const visit = (node: unknown, segments: string[], required: boolean, shape: number | undefined, key: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    const override = segments.length > 0 ? options.entrySchema?.(patternOf(segments)) : undefined;
    const d = describe(override ?? node, root, key);
    if (d.group) {
      const pattern = patternOf(segments);
      if (segments.length > 0) {
        const source = valueSourceOf(kind, pattern);
        groups.push({
          pattern,
          segments,
          ...(shape !== undefined ? { shape } : {}),
          kind: d.group,
          help: typeof d.schema.description === "string" ? d.schema.description : null,
          required,
          ...(d.keyPattern ? { keyPattern: d.keyPattern } : {}),
          ...(source ? { source } : {}),
        });
      }
      if (d.group === "object") for (const [k, v] of Object.entries(d.properties ?? {})) visit(v, [...segments, k], (d.requiredKeys ?? []).includes(k), shape, k, depth + 1);
      else if (d.group === "map") visit(d.entry, [...segments, "*"], false, shape, key, depth + 1);
      else visit(d.item, [...segments, "[]"], false, shape, key, depth + 1);
      return;
    }
    fields.push(fieldTemplate(kind, segments, d, required, shape));
    if (d.widget !== "choice") return;
    (d.branches ?? []).forEach((branch, i) => {
      const inner = describe(branch, root, key);
      if (inner.group === "object") for (const [k, v] of Object.entries(inner.properties ?? {})) visit(v, [...segments, k], (inner.requiredKeys ?? []).includes(k), i, k, depth + 1);
      else if (inner.group === "map") visit(inner.entry, [...segments, "*"], false, i, key, depth + 1);
      else if (inner.group === "array") visit(inner.item, [...segments, "[]"], false, i, key, depth + 1);
    });
  };
  visit(schema, options.base ?? [], false, undefined, "", 0);
  return { fields, groups };
}

/** "timeoutSeconds" -> "Timeout seconds": the words of a key, for a key without a catalogue label. */
export function keyWords(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
    .toLowerCase();
  return words === "" ? key : words.charAt(0).toUpperCase() + words.slice(1);
}
