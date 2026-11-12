// The derived forms (ADR-0009): a configuration file, or one tool instance, read through its JSON schema and shown as
// it is. Every key of the file comes back, with its control, its value, its origin, a display label and a link to the
// YAML editor at that key; keys the schema does not know come back too, as custom text fields with the schema's
// diagnostic. Known keys the file leaves out are listed with the value they inherit and where it comes from.
import fs from "node:fs";
import path from "node:path";
import { isMap, isScalar, isSeq, stringify, type Document, type LineCounter } from "yaml";
import { builtinManifests } from "../../../adapters/manifests.js";
import { builtinProfileBody, getBuiltinProfile, getBuiltinTemplate } from "../../../builtin/index.js";
import { translator } from "../../../i18n/index.js";
import { builtinTemplateText, createCoreCatalog } from "../../catalog/index.js";
import { readRevision } from "../../codecs/yaml/index.js";
import { parseYamlText, validateDocument, type ConfigDiagnostic } from "../../config/load/index.js";
import { encodePointer, type ResolveResult } from "../../config/resolve/index.js";
import { resolveToolBindings } from "../../tools/index.js";
import { suggestedFiles, toolsDocument } from "../instance-settings.js";
import { builtinForms } from "../registry.js";
import type { FormDefinition, FormFieldSpec, JsonSchema } from "../types.js";
import { deriveTemplates, describe, keyWords, patternOf, patternSegments, type Described } from "./fields.js";
import { DerivedFormError, locateConfigFile, seedOf } from "./files.js";
import {
  adapterDisplayName,
  adapterIds,
  adapterSettingsSchema,
  configSchemas,
  instanceSchema,
  loadConfigSchema,
  schemaEntryOfKind,
  settingOwners,
  type ConfigKind,
  type SchemaEntry,
} from "./schemas.js";
import { valueSourceOf } from "./sources.js";
import type {
  DerivedField,
  DerivedForm,
  DerivedGroup,
  DerivedOption,
  DerivedOrigin,
  DerivedWidget,
  DisplayLabel,
  FieldDiagnostic,
  FormFile,
  InstanceForm,
  SchemaForm,
} from "./types.js";

const t = translator("forms");
/** A catalogue key of a hand-written form: "area:key" reads the adapter's own catalogue, a bare key the forms one. */
const tf = (key: string): string => {
  const at = key.indexOf(":");
  return at > 0 ? translator(key.slice(0, at))(key.slice(at + 1)) : t(key);
};
/** The translation of a key, or null when the catalogue has none (the translator answers with the key itself). */
const tfOrNull = (key: string | undefined): string | null => {
  if (!key) return null;
  const text = tf(key);
  return text === key || text === key.slice(key.indexOf(":") + 1) ? null : text;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hasOwn = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const BOM = "﻿";

export interface DerivedFormOptions {
  /** The effective configuration (the server's cached one); it gives the value and origin of the keys a file leaves out. */
  resolved?: ResolveResult | null;
  /** False when the configuration cannot be written (governed mode). */
  editable?: boolean;
  /** Hand-written forms to use as overlays instead of the built-in ones (tests, extensions). */
  forms?: FormDefinition[];
}

// ---- catalogue names -----------------------------------------------------------------------------------------------

class Labels {
  private readonly catalog = createCoreCatalog().toDocument();
  private readonly manifests = builtinManifests();

  capability(id: string): string | null {
    return this.catalog.capabilities.find((c) => c.id === id)?.label ?? null;
  }

  category(id: string): string | null {
    return this.catalog.categories.find((c) => c.id === id)?.label ?? null;
  }

  adapter(id: string): string | null {
    return this.manifests.find((m) => m.id === id)?.displayName ?? null;
  }

  adapterCapabilities(id: string): string[] {
    const m = this.manifests.find((x) => x.id === id);
    if (!m) return [];
    return [...new Set([...m.capabilities, ...(m.subchecks ?? []).flatMap((s) => s.capabilities)])];
  }

  /** category:security, capability:lint, tool:<id>... as the catalogue names them. */
  selector(selector: string): string | null {
    const at = selector.indexOf(":");
    if (at <= 0) return null;
    const kind = selector.slice(0, at);
    const id = selector.slice(at + 1);
    if (kind === "capability") return this.capability(id);
    if (kind === "category") return this.category(id);
    return null;
  }

  template(source: string): string | null {
    if (!source.startsWith("builtin:")) return null;
    return builtinTemplateText(source, getBuiltinTemplate(source)?.value ?? {}).label;
  }

  profile(ref: string): string | null {
    const item = getBuiltinProfile(ref);
    if (!item) return null;
    const label = builtinProfileBody(item).label;
    return typeof label === "string" ? label : null;
  }

  options(values: readonly unknown[], label: (v: string) => string | null): DerivedOption[] {
    return values.map((v) => ({ value: v as DerivedOption["value"], label: label(String(v)) ?? String(v), secondary: String(v) }));
  }
}

// ---- where an absent key's value comes from --------------------------------------------------------------------------

/** The pointer of a key of a file in the effective configuration (layers.ts: projectDocumentOps), or null. */
function configPath(kind: ConfigKind, path: ReadonlyArray<string | number>, value: unknown): string[] | null {
  const [head, ...rest] = path;
  const doc = isObject(value) ? value : {};
  const idOf = (list: string, index: unknown, key: string): string | null => {
    const items = doc[list];
    if (!Array.isArray(items) || typeof index !== "number") return null;
    const item = items[index];
    return isObject(item) && typeof item[key] === "string" ? (item[key] as string) : null;
  };
  const str = (segs: ReadonlyArray<string | number>) => segs.map(String);
  switch (kind) {
    case "root":
      if (head === "selection" || head === "execution" || head === "extensions") return str(path);
      if (head === "templates") {
        const id = idOf("templates", rest[0], "id");
        return id ? ["templates", id, ...str(rest.slice(1))] : null;
      }
      return null;
    case "workspace":
      if (head === "discovery" || head === "include" || head === "exclude") return ["workspace", ...str(path)];
      if (head === "components") {
        const id = idOf("components", rest[0], "id");
        return id ? ["workspace", "components", id, ...str(rest.slice(1))] : null;
      }
      return null;
    case "tools":
      return head === "tools" || head === "bindings" ? str(path) : null;
    case "policy":
      if (head === "rules" || head === "exceptions") return ["policy", ...str(path)];
      if (head === "requiredEvidence") {
        const id = idOf("requiredEvidence", rest[0], "check");
        return id ? ["policy", "requiredEvidence", id, ...str(rest.slice(1))] : null;
      }
      return null;
    case "pii":
      if (head === "enabled" && rest.length === 0) return ["tools", "builtin-pii", "enabled"];
      return head === undefined || head === "schemaVersion" ? null : ["pii", ...str(path)];
    case "architecture":
      return head === undefined || head === "schemaVersion" ? null : ["architecture", ...str(path)];
    default:
      return null;
  }
}

function getIn(root: unknown, segments: readonly string[]): { found: boolean; value: unknown } {
  let node = root;
  for (const s of segments) {
    if (!isObject(node) || !hasOwn(node, s)) return { found: false, value: undefined };
    node = node[s];
  }
  return { found: true, value: node };
}

function originOfLayer(field: { layer: string; source: string; file: string | null; path: string | null }, thisFile: string): DerivedOrigin {
  const base = { source: field.source, file: field.file, path: field.path };
  switch (field.layer) {
    case "defaults":
      return { kind: field.source.startsWith("adapter:") ? "adapter" : "default", ...base };
    case "template":
      return { kind: "template", ...base };
    case "profile":
      return { kind: "profile", ...base };
    case "project":
      return { kind: field.file === thisFile ? "file" : "configuration", ...base };
    default:
      return { kind: "configuration", ...base };
  }
}

// ---- positions -----------------------------------------------------------------------------------------------------

function positionOf(doc: Document.Parsed | undefined, lineCounter: LineCounter | undefined, path: ReadonlyArray<string | number>): { line: number; column: number } | null {
  if (!doc || !lineCounter) return null;
  let node: unknown = doc.contents;
  let offset: number | null = null;
  for (const seg of path) {
    if (isMap(node)) {
      const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === String(seg));
      if (!pair) break;
      const range = (pair.key as { range?: [number, number, number] }).range;
      if (range) offset = range[0];
      node = pair.value;
    } else if (isSeq(node) && typeof seg === "number") {
      const item = node.items[seg] as { range?: [number, number, number] } | undefined;
      if (!item) break;
      if (item.range) offset = item.range[0];
      node = item;
    } else break;
  }
  if (offset === null) return null;
  const pos = lineCounter.linePos(offset);
  return { line: pos.line, column: pos.col };
}

const yamlText = (value: unknown): string => (typeof value === "string" ? value : stringify(value, { lineWidth: 0, indent: 2 }).replace(/\n$/, ""));

// ---- the walk ------------------------------------------------------------------------------------------------------

type SegKind = "key" | "map" | "item";

/** Which shape of a choice a value has: the first that fits, else the object shape that knows most of its keys. */
function matchBranch(branches: JsonSchema[], value: unknown, root: JsonSchema): number {
  let best = -1;
  let bestScore = -1;
  branches.forEach((b, i) => {
    if (best >= 0 && bestScore === Infinity) return;
    const d = describe(b, root, "");
    let fits = false;
    let score = 0;
    if (d.group === "object") {
      if (isObject(value)) {
        const known = Object.keys(value).filter((k) => hasOwn(d.properties ?? {}, k)).length;
        const unknown = Object.keys(value).length - known;
        const missing = (d.requiredKeys ?? []).filter((k) => !hasOwn(value, k)).length;
        fits = unknown === 0 && missing === 0;
        score = known;
      }
    } else if (d.group === "map") fits = isObject(value);
    else if (d.group === "array" || d.widget === "list" || d.widget === "checklist") fits = Array.isArray(value);
    else if (d.widget === "text") fits = typeof value === "string";
    else if (d.widget === "number") fits = typeof value === "number";
    else if (d.widget === "switch") fits = typeof value === "boolean";
    else if (d.widget === "readonly" || d.widget === "radio" || d.widget === "select") fits = (d.options ?? []).some((o) => o.value === value);
    if (fits) {
      if (bestScore !== Infinity) {
        best = i;
        bestScore = Infinity;
      }
    } else if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

class Builder {
  readonly fields: DerivedField[] = [];
  readonly groups: DerivedGroup[] = [];
  readonly labels = new Labels();
  private readonly diagnostics = new Map<string, FieldDiagnostic[]>();
  /** The adapter of tools.<id> entries the file does not have (an instance a template declares). */
  forcedAdapters = new Map<string, string>();

  constructor(
    readonly dir: string,
    readonly file: string,
    readonly kind: ConfigKind,
    readonly root: JsonSchema,
    readonly fileValue: unknown,
    readonly doc: Document.Parsed | undefined,
    readonly lineCounter: LineCounter | undefined,
    diagnostics: ConfigDiagnostic[],
    readonly resolved: ResolveResult | null,
  ) {
    for (const d of diagnostics) {
      const key = JSON.stringify(d.pathSegments.map(String));
      const list = this.diagnostics.get(key) ?? [];
      list.push({ code: d.code, message: d.message, ...(d.suggestion ? { suggestion: d.suggestion } : {}), ...(d.line !== undefined ? { line: d.line } : {}), ...(d.column !== undefined ? { column: d.column } : {}) });
      this.diagnostics.set(key, list);
    }
  }

  private diagsAt(path: ReadonlyArray<string | number>): FieldDiagnostic[] {
    return this.diagnostics.get(JSON.stringify(path.map(String))) ?? [];
  }

  private link(path: ReadonlyArray<string | number>) {
    const pos = positionOf(this.doc, this.lineCounter, path);
    return { file: this.file, path: patternOf(path), line: pos?.line ?? null, column: pos?.column ?? null };
  }

  private fileOrigin(path: ReadonlyArray<string | number>): DerivedOrigin {
    return { kind: "file", source: this.file, file: this.file, path: patternOf(path) };
  }

  /** The value and origin of a key the file leaves out. */
  private inherited(path: ReadonlyArray<string | number>, d: Described): { value: unknown; origin: DerivedOrigin } {
    if (this.kind === "profiles") {
      const fromParent = this.profileInherited(path);
      if (fromParent) return fromParent;
    }
    const pointerPath = this.resolved ? configPath(this.kind, path, this.fileValue) : null;
    if (pointerPath && this.resolved) {
      const pointer = encodePointer(pointerPath);
      const exact = this.resolved.fields[pointer];
      if (exact) return { value: exact.value, origin: originOfLayer(exact, this.file) };
      const under = Object.entries(this.resolved.fields).find(([k]) => k.startsWith(`${pointer}/`));
      if (under) return { value: getIn(this.resolved.config, pointerPath).value ?? null, origin: originOfLayer(under[1], this.file) };
    }
    if ("default" in d.schema) return { value: d.schema.default, origin: { kind: "default", source: "schema", file: null, path: null } };
    return { value: null, origin: { kind: "default", source: "jgates", file: null, path: null } };
  }

  /** profiles.<id>.<key...> left out: the value of the parent profile (extends), walking up to a built-in one. */
  private profileInherited(path: ReadonlyArray<string | number>): { value: unknown; origin: DerivedOrigin } | null {
    if (path[0] !== "profiles" || typeof path[1] !== "string" || path.length < 3) return null;
    const rest = path.slice(2).map(String);
    const profiles = isObject(this.fileValue) && isObject(this.fileValue.profiles) ? this.fileValue.profiles : {};
    let body: unknown = profiles[path[1]];
    const seen = new Set<string>([path[1]]);
    for (let depth = 0; depth < 10 && isObject(body) && typeof body.extends === "string"; depth++) {
      const parent = body.extends;
      if (seen.has(parent)) return null;
      seen.add(parent);
      const own = isObject(profiles[parent]) ? profiles[parent] : null;
      const builtin = own ? null : getBuiltinProfile(parent);
      body = own ?? (builtin ? builtinProfileBody(builtin) : null);
      if (!isObject(body)) return null;
      const found = getIn(body, rest);
      if (found.found) {
        return own
          ? { value: found.value, origin: { kind: "profile", source: `profile:${parent}`, file: this.file, path: patternOf(["profiles", parent, ...rest]) } }
          : { value: found.value, origin: { kind: "profile", source: parent, file: parent, path: patternOf(["profiles", parent.replace(/^builtin:/, ""), ...rest]) } };
      }
    }
    return null;
  }

  private entryLabel(pattern: string, key: string, value: unknown): DisplayLabel {
    const v = isObject(value) ? value : {};
    if (/(^|\.)tools\.\*$/.test(pattern)) {
      const adapter = typeof v.adapter === "string" ? v.adapter : (this.forcedAdapters.get(key) ?? null);
      return { text: (adapter && this.labels.adapter(adapter)) ?? key, secondary: key };
    }
    if (pattern === "profiles.*") return { text: typeof v.label === "string" ? v.label : (this.labels.profile(key) ?? key), secondary: key };
    if (/checks\.\*$/.test(pattern)) return { text: this.labels.selector(key) ?? key, secondary: key };
    return { text: typeof v.label === "string" ? v.label : key, secondary: key };
  }

  private itemLabel(pattern: string, index: number, value: unknown): DisplayLabel {
    const v = isObject(value) ? value : {};
    const id = ["id", "check", "tool", "rule"].map((k) => v[k]).find((x): x is string => typeof x === "string");
    if (pattern === "templates[]" && typeof v.source === "string") return { text: this.labels.template(v.source) ?? id ?? v.source, secondary: id ?? v.source };
    if (typeof v.check === "string") return { text: this.labels.selector(v.check) ?? v.check, secondary: v.check };
    if (typeof v.label === "string") return { text: v.label, secondary: id ?? String(index) };
    if (id) return { text: id, secondary: id };
    return { text: t("forms_derived_item", { index: index + 1 }), secondary: String(index) };
  }

  /** The adapter of a tools.<id> entry (from the entry, or the one a template declares). */
  private adapterOf(pattern: string, path: ReadonlyArray<string | number>, value: unknown): string | null {
    if (this.kind !== "tools" || pattern !== "tools.*") return null;
    if (isObject(value) && typeof value.adapter === "string") return value.adapter;
    return this.forcedAdapters.get(String(path[path.length - 1])) ?? null;
  }

  visit(value: unknown, present: boolean, schemaNode: unknown, path: Array<string | number>, kinds: SegKind[], groupId: string, required: boolean, key: string, adapter: string | null = null): void {
    if (path.length > 40) return;
    const pattern = patternOf(patternSegments(path, kinds));
    const d = describe(schemaNode, this.root, key);
    const id = patternOf(path);
    if (d.group) {
      const wrongType = present && (d.group === "array" ? !Array.isArray(value) : !isObject(value));
      if (wrongType) {
        this.pushField(value, true, { ...d, widget: "yaml" }, path, pattern, groupId, required, key, adapter);
        return;
      }
      let gid = groupId;
      if (path.length > 0) {
        const last = kinds[kinds.length - 1];
        const label = last === "map" ? this.entryLabel(pattern, String(path[path.length - 1]), value) : last === "item" ? this.itemLabel(pattern, path[path.length - 1] as number, value) : { text: keyWords(key), secondary: key };
        this.groups.push({
          id,
          path: [...path],
          pattern,
          group: groupId,
          kind: d.group,
          role: last === "map" ? "entry" : last === "item" ? "item" : "container",
          present,
          label,
          help: typeof d.schema.description === "string" ? d.schema.description : null,
          link: this.link(path),
          ...(d.keyPattern ? { keyPattern: d.keyPattern } : {}),
        });
        gid = id;
      }
      if (d.group === "object") {
        const entryAdapter = this.adapterOf(pattern, path, value) ?? adapter;
        const obj = present && isObject(value) ? value : {};
        const props = d.properties ?? {};
        for (const [k, s] of Object.entries(props)) {
          const has = present && hasOwn(obj, k);
          // An instance lists the settings its adapter reads; another adapter's key shows only when it is written.
          if (!has && entryAdapter && pattern === "tools.*") {
            const owners = settingOwners((s as JsonSchema).description);
            if (owners && !owners.includes(entryAdapter)) continue;
          }
          this.visit(has ? obj[k] : undefined, has, s, [...path, k], [...kinds, "key"], gid, (d.requiredKeys ?? []).includes(k), k, pattern === "tools.*" ? entryAdapter : adapter);
        }
        if (present) for (const k of Object.keys(obj)) if (!hasOwn(props, k)) this.custom(obj[k], [...path, k], gid, k);
      } else if (d.group === "map") {
        if (present && isObject(value)) for (const k of Object.keys(value)) this.visit(value[k], true, d.entry, [...path, k], [...kinds, "map"], gid, false, k, adapter);
      } else if (present && Array.isArray(value)) {
        value.forEach((item, i) => this.visit(item, true, d.item, [...path, i], [...kinds, "item"], gid, false, key, adapter));
      }
      return;
    }
    const field = this.pushField(value, present, d, path, pattern, groupId, required, key, adapter);
    if (d.widget !== "choice" || !d.branches) return;
    // The keys of the shape the value has, below the choice field.
    const shape = present ? matchBranch(d.branches, value, this.root) : -1;
    if (shape < 0) return;
    field.shape = shape;
    const inner = describe(d.branches[shape], this.root, key);
    if (inner.group === "object" && isObject(value)) {
      for (const [k, s] of Object.entries(inner.properties ?? {})) {
        const has = hasOwn(value, k);
        this.visit(has ? value[k] : undefined, has, s, [...path, k], [...kinds, "key"], field.id, (inner.requiredKeys ?? []).includes(k), k, adapter);
      }
      for (const k of Object.keys(value)) if (!hasOwn(inner.properties ?? {}, k)) this.custom(value[k], [...path, k], field.id, k);
    } else if (inner.group === "map" && isObject(value)) {
      for (const k of Object.keys(value)) this.visit(value[k], true, inner.entry, [...path, k], [...kinds, "map"], field.id, false, k, adapter);
    } else if (inner.group === "array" && Array.isArray(value)) {
      value.forEach((item, i) => this.visit(item, true, inner.item, [...path, i], [...kinds, "item"], field.id, false, key, adapter));
    }
  }

  private pushField(value: unknown, present: boolean, d: Described, path: Array<string | number>, pattern: string, groupId: string, required: boolean, key: string, adapter: string | null): DerivedField {
    const diagnostics = this.diagsAt(path);
    const inherited = present ? null : this.inherited(path, d);
    let widget = d.widget as DerivedWidget;
    let options = d.options;
    // The adapter field never changes in a form (another adapter is another instance); the capabilities of an instance
    // are the ones its adapter declares, offered as a checklist, plus any the file already has (x-custom...).
    if (/(^|\.)tools\.\*\.adapter$/.test(pattern)) widget = "readonly";
    if (/(^|\.)tools\.\*\.capabilities$/.test(pattern) && adapter) {
      const current = Array.isArray(present ? value : inherited?.value) ? ((present ? value : inherited?.value) as unknown[]).map(String) : [];
      const values = [...new Set([...this.labels.adapterCapabilities(adapter), ...current])];
      if (values.length > 0) {
        widget = "checklist";
        options = this.labels.options(values, (v) => this.labels.capability(v));
      }
    }
    const source = valueSourceOf(this.kind, pattern);
    const field: DerivedField = {
      id: patternOf(path),
      path: [...path],
      pattern,
      group: groupId,
      widget,
      schema: d.schema,
      label: { text: keyWords(key), secondary: key },
      help: typeof d.schema.description === "string" ? d.schema.description : null,
      state: present ? (diagnostics.length > 0 ? "invalid" : "set") : "inherited",
      value: present ? value : (inherited?.value ?? null),
      origin: present ? this.fileOrigin(path) : (inherited as { origin: DerivedOrigin }).origin,
      link: this.link(path),
      diagnostics,
      required,
      nullable: d.nullable,
      ...("default" in d.schema ? { default: d.schema.default } : {}),
      ...(options ? { options } : {}),
      ...(d.limits ? { limits: d.limits } : {}),
      ...(d.presets ? { presets: d.presets } : {}),
      ...(d.unit ? { unit: d.unit } : {}),
      ...(d.shapes ? { shapes: d.shapes } : {}),
      ...(source ? { source } : {}),
    };
    if (widget === "yaml" || (widget === "choice" && (isObject(field.value) || Array.isArray(field.value)))) {
      if (field.value !== null && field.value !== undefined) field.text = yamlText(field.value);
    }
    if (present && adapter && this.kind === "tools" && path.length === 3 && path[0] === "tools") {
      const owners = settingOwners(d.schema.description);
      if (owners && !owners.includes(adapter)) {
        field.foreign = true;
        field.help = t("forms_derived_foreign_help", { adapter });
      }
    }
    this.fields.push(field);
    return field;
  }

  private custom(value: unknown, path: Array<string | number>, groupId: string, key: string): void {
    this.fields.push({
      id: patternOf(path),
      path: [...path],
      pattern: null,
      group: groupId,
      widget: "text",
      schema: null,
      label: { text: key, secondary: key },
      help: t("forms_derived_custom_help"),
      state: "custom",
      value,
      text: yamlText(value),
      origin: this.fileOrigin(path),
      link: this.link(path),
      diagnostics: this.diagsAt(path),
      required: false,
      nullable: true,
    });
  }
}

// ---- reading a file ------------------------------------------------------------------------------------------------

interface Read {
  file: FormFile;
  value: unknown;
  available: boolean;
  doc: Document.Parsed | undefined;
  lineCounter: LineCounter | undefined;
  diagnostics: ConfigDiagnostic[];
  root: JsonSchema;
}

function rootSchemaOf(kind: ConfigKind): { entry: SchemaEntry; root: JsonSchema } {
  const entry = schemaEntryOfKind(kind);
  if (!entry) throw new DerivedFormError("SCHEMA_NOT_FOUND", t("forms_derived_schema_not_found", { schema: kind }), t("forms_derived_schema_not_found_fix", { available: configSchemas().map((s) => s.schema).join(", ") }));
  return { entry, root: loadConfigSchema(entry.schema) };
}

function readFile(dir: string, fileName: string, editable: boolean): Read {
  const located = locateConfigFile(dir, fileName);
  const { root } = rootSchemaOf(located.kind);
  const rev = readRevision(located.abs);
  const canWrite = editable && !located.generated && (rev.exists || seedOf(located.kind) !== null);
  const file: FormFile = { file: located.file, kind: located.kind, exists: rev.exists, revision: rev.hash, editable: canWrite };
  if (!rev.exists) return { file, value: {}, available: true, doc: undefined, lineCounter: undefined, diagnostics: [], root };
  const text = rev.text.startsWith(BOM) ? rev.text.slice(1) : rev.text;
  const parsed = parseYamlText(text, located.file);
  if (parsed.value === undefined || parsed.diagnostics.length > 0) {
    return { file: { ...file, editable: false }, value: undefined, available: false, doc: parsed.doc, lineCounter: parsed.lineCounter, diagnostics: parsed.diagnostics, root };
  }
  const diagnostics = isObject(parsed.value) ? validateDocument(located.kind as Parameters<typeof validateDocument>[0], parsed.value, located.file, { doc: parsed.doc, lineCounter: parsed.lineCounter }) : [];
  return { file, value: parsed.value, available: true, doc: parsed.doc, lineCounter: parsed.lineCounter, diagnostics, root };
}

const flatDiagnostics = (list: ConfigDiagnostic[]) =>
  list.map((d) => ({ path: d.path, code: d.code, message: d.message, ...(d.suggestion ? { suggestion: d.suggestion } : {}), ...(d.line !== undefined ? { line: d.line } : {}), ...(d.column !== undefined ? { column: d.column } : {}) }));

/**
 * The form of one configuration file (jgates.yml, .jgates/<fragment>.yml, a template): every key of the file and the
 * known keys it leaves out, from its schema.
 */
export function openFileForm(dir: string, fileName: string, options: DerivedFormOptions = {}): DerivedForm {
  const read = readFile(dir, fileName, options.editable !== false);
  const builder = new Builder(dir, read.file.file, read.file.kind, read.root, read.value, read.doc, read.lineCounter, read.diagnostics, options.resolved ?? null);
  if (read.available) builder.visit(isObject(read.value) ? read.value : {}, read.file.exists, read.root, [], [], "", false, "");
  return { schemaVersion: 1, file: read.file, available: read.available, fields: builder.fields, groups: builder.groups, diagnostics: flatDiagnostics(read.diagnostics) };
}

// ---- one tool instance ---------------------------------------------------------------------------------------------

function overlayWidget(spec: FormFieldSpec, current: DerivedWidget): DerivedWidget {
  switch (spec.ui.widget) {
    case "boolean":
      return "switch";
    case "select":
    case "radio":
      return current === "select" || current === "radio" || current === "text" ? spec.ui.widget : current;
    case "number":
      return "number";
    case "string-list":
    case "rule-list":
    case "glob-list":
      return current === "checklist" ? "checklist" : "list";
    case "list-map":
      return "yaml";
    default:
      return current;
  }
}

/** Labels, help, order, sections, options and pickers of a hand-written instance form, over the derived fields. */
function applyOverlay(fields: DerivedField[], form: FormDefinition, section: string[], dir: string, groupId: string): void {

  for (const spec of form.fields) {
    const path = [...section, ...spec.path];
    let field = fields.find((f) => f.path.length === path.length && f.path.every((s, i) => s === path[i]));
    if (!field) {
      // A setting the overlay knows and the schema does not: a field of its own, from the overlay's schema.
      const d = describe(spec.schema, {}, spec.path[spec.path.length - 1] ?? "");
      field = {
        id: patternOf(path),
        path,
        pattern: null,
        group: groupId,
        widget: (d.widget ?? "yaml") as DerivedWidget,
        schema: spec.schema,
        label: { text: spec.path.join("."), secondary: spec.path.join(".") },
        help: null,
        state: "inherited",
        value: "default" in spec.schema ? spec.schema.default : null,
        origin: { kind: "default", source: "schema", file: null, path: null },
        link: { file: "", path: patternOf(path), line: null, column: null },
        diagnostics: [],
        required: false,
        nullable: false,
      };
      fields.push(field);

    }
    const label = tfOrNull(spec.ui.label);
    if (label) field.label = { text: label, secondary: field.label.secondary };
    const help = tfOrNull(spec.ui.help);
    if (help) field.help = help;
    field.order = spec.ui.order;
    field.section = spec.ui.section;
    field.widget = overlayWidget(spec, field.widget);
    if (spec.ui.unit) field.unit = tfOrNull(spec.ui.unit) ?? field.unit ?? spec.ui.unit;
    if (spec.ui.example) field.example = spec.ui.example;
    if (spec.ui.required) field.required = true;
    if (spec.ui.showWhen) field.showWhen = spec.ui.showWhen;
    if (spec.ui.format) field.format = spec.ui.format;
    if (spec.ui.prefill !== undefined) field.prefill = spec.ui.prefill;
    if (spec.ui.suggestFiles) {
      field.suggestions = suggestedFiles(dir, spec.ui.suggestFiles);
      field.source = { name: "project-file", ...(spec.ui.suggestFiles.pattern ? { pattern: spec.ui.suggestFiles.pattern } : {}) };
    }
    // Option labels; a list of known values becomes a checklist. Values outside the overlay's list stay offered.
    const items = spec.schema.items as Record<string, unknown> | undefined;
    const values = Array.isArray(spec.schema.enum) ? (spec.schema.enum as unknown[]) : isObject(items) && Array.isArray(items.enum) ? (items.enum as unknown[]) : null;
    if (values) {
      const labelOf = (v: string): string | null => {
        const o = spec.ui.options?.[v];
        return o ? tfOrNull(o.label) : (field.options?.find((x) => String(x.value) === v)?.label ?? null);
      };
      const all = [...new Set([...values.map(String), ...(field.options ?? []).map((o) => String(o.value))])];
      const typed = (v: string): DerivedOption["value"] => (values.find((x) => String(x) === v) ?? field.options?.find((o) => String(o.value) === v)?.value ?? v) as DerivedOption["value"];
      field.options = all.map((v) => ({ value: typed(v), label: labelOf(v) ?? v, secondary: v }));
      if (isObject(items) && field.widget === "list") field.widget = "checklist";
    }
  }

}

/** Instances of the project: the ones of the tools file and the ones the effective configuration (templates) declares. */
function instancesOf(dir: string, resolved: ResolveResult | null): Array<{ id: string; adapter: string; declaredIn: "tools-file" | "template" }> {
  const out = new Map<string, { id: string; adapter: string; declaredIn: "tools-file" | "template" }>();
  for (const i of resolveToolBindings(dir, { skipInventory: true }).instances) out.set(i.id, { id: i.id, adapter: i.adapter, declaredIn: "tools-file" });
  const tools = resolved && isObject(resolved.config.tools) ? resolved.config.tools : {};
  for (const [id, body] of Object.entries(tools)) {
    if (out.has(id) || !isObject(body) || typeof body.adapter !== "string") continue;
    out.set(id, { id, adapter: body.adapter, declaredIn: "template" });
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The form of one tool instance: tools.<id> of the tools file through the settings schema of its adapter, with the
 * hand-written overlay of the adapter when it has one. An instance a template declares (absent from the file) shows
 * the values the template gives; the first key written creates its entry with the template's adapter.
 */
export async function openInstanceForm(dir: string, instanceId: string, options: DerivedFormOptions = {}): Promise<InstanceForm> {
  const forms = options.forms ?? (await builtinForms());
  const resolved = options.resolved ?? null;
  const tools = toolsDocument(dir);
  const read = readFile(dir, tools.relPath ?? ".jgates/tools.yml", options.editable !== false);
  const fileTools = isObject(read.value) && isObject(read.value.tools) ? read.value.tools : {};
  const entry = fileTools[instanceId];
  const known = instancesOf(dir, resolved).find((i) => i.id === instanceId);
  const adapter = isObject(entry) && typeof entry.adapter === "string" ? entry.adapter : (known?.adapter ?? null);
  if (!adapter) {
    const available = instancesOf(dir, resolved)
      .map((i) => i.id)
      .join(", ");
    throw new DerivedFormError("INSTANCE_NOT_FOUND", t("forms_instance_not_found", { name: instanceId }), t("forms_instance_not_found_fix", { available: available || "-" }), { instance: instanceId });
  }
  const section = ["tools", instanceId];
  const builder = new Builder(dir, read.file.file, read.file.kind, read.root, read.value, read.doc, read.lineCounter, read.diagnostics, resolved);
  builder.forcedAdapters.set(instanceId, adapter);
  const { schema } = instanceSchema();
  const present = entry !== undefined;
  if (read.available) builder.visit(entry, present, schema, section, ["key", "map"], "tools", false, instanceId, adapter);

  const overlay = forms.find((f) => f.adapter === adapter && f.scope === "instance") ?? null;
  const native = forms.find((f) => f.adapter === adapter && f.scope !== "instance") ?? null;
  const groupId = patternOf(section);
  if (overlay && read.available) applyOverlay(builder.fields, overlay, section, dir, groupId);
  const fields = builder.fields
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (a.f.order ?? 1000 + a.i) - (b.f.order ?? 1000 + b.i))
    .map((x) => x.f);
  const inside = (p: ReadonlyArray<string | number>) => p.length >= 2 && p[0] === "tools" && p[1] === instanceId;
  const label: DisplayLabel = { text: adapterDisplayName(adapter) ?? adapter, secondary: instanceId };
  return {
    schemaVersion: 1,
    file: read.file,
    available: read.available,
    fields,
    groups: builder.groups,
    diagnostics: flatDiagnostics(read.diagnostics.filter((d) => d.pathSegments[0] === "tools" && d.pathSegments[1] === instanceId)),
    instance: { id: instanceId, adapter, label, declaredIn: present ? "tools-file" : "template", foreign: fields.filter((f) => f.foreign && inside(f.path)).map((f) => String(f.path[2])) },
    section,
    hasForm: true,
    overlay: overlay ? { id: overlay.id, title: tf(overlay.title) } : null,
    nativeForm: native ? { id: native.id, title: tf(native.title), documents: native.documents.map((d) => d.file) } : null,
    ...(overlay
      ? {
          choices: (overlay.choices ?? []).map((c) => ({ id: c.id, label: tf(c.label), help: tf(c.help), required: c.required === true, options: c.options.map((o) => ({ field: o.field, label: tf(o.label), help: tf(o.help) })) })),
          rules: (overlay.rules ?? []).map((r) => ({ when: r.when, require: r.require, message: tf(r.message) })),
        }
      : {}),
  };
}

// ---- schema forms and the index ------------------------------------------------------------------------------------

/** The form of a configuration schema without a file: one template per key pattern. */
export function schemaForm(schemaFile: string): SchemaForm {
  const entry = configSchemas().find((e) => e.schema === schemaFile);
  if (!entry) throw new DerivedFormError("SCHEMA_NOT_FOUND", t("forms_derived_schema_not_found", { schema: schemaFile }), t("forms_derived_schema_not_found_fix", { available: configSchemas().map((s) => s.schema).join(", ") }), { schema: schemaFile });
  const root = loadConfigSchema(entry.schema);
  const { fields, groups } = deriveTemplates(root, root, entry.kind);
  return { schemaVersion: 1, schema: entry.schema, kind: entry.kind, title: entry.title, document: entry.document, fields, groups };
}

/** The settings form of an adapter (tools.<id> of .jgates/tools.yml), without an instance. */
export function adapterSchemaForm(adapter: string): SchemaForm {
  if (!adapterIds().includes(adapter)) throw new DerivedFormError("ADAPTER_NOT_FOUND", t("forms_derived_adapter_not_found", { adapter }), null, { adapter });
  const { root } = instanceSchema();
  const settings = adapterSettingsSchema(adapter);
  const wrapper: JsonSchema = { type: "object", properties: { tools: { type: "object", additionalProperties: settings } } };
  const { fields, groups } = deriveTemplates(wrapper, root, "tools");
  const labels = new Labels();
  for (const f of fields) {
    if (f.pattern === "tools.*.adapter") f.widget = "readonly";
    if (f.pattern === "tools.*.capabilities") {
      const caps = labels.adapterCapabilities(adapter);
      if (caps.length > 0) {
        f.widget = "checklist";
        f.options = labels.options(caps, (v) => labels.capability(v));
      }
    }
  }
  return {
    schemaVersion: 1,
    schema: `adapter:${adapter}`,
    kind: "tools",
    title: ".jgates/tools.yml",
    document: ".jgates/tools.yml",
    adapter: { id: adapter, label: adapterDisplayName(adapter) ?? adapter },
    fields,
    groups: groups.filter((g) => g.pattern !== "tools"),
  };
}

export interface FormsIndex {
  schemaVersion: 1;
  schemas: SchemaEntry[];
  adapters: Array<{ id: string; label: string; overlay: string | null; nativeForm: string | null }>;
  files: FormFile[];
  instances: Array<{ id: string; adapter: string; label: DisplayLabel; declaredIn: "tools-file" | "template"; hasForm: true; overlay: string | null; nativeForm: string | null }>;
}

/** What has a derived form: the schemas, the adapters, the configuration files of the project and its tool instances. */
export async function formsIndex(dir: string, options: DerivedFormOptions = {}): Promise<FormsIndex> {
  const forms = options.forms ?? (await builtinForms());
  const overlayOf = (adapter: string) => forms.find((f) => f.adapter === adapter && f.scope === "instance")?.id ?? null;
  const nativeOf = (adapter: string) => forms.find((f) => f.adapter === adapter && f.scope !== "instance")?.id ?? null;
  const schemas = configSchemas();
  const files: FormFile[] = [];
  const tools = toolsDocument(dir).relPath ?? ".jgates/tools.yml";
  const names = schemas.map((s) => (s.kind === "tools" ? tools : s.document)).filter((f): f is string => f !== null);
  let templateFiles: string[] = [];
  try {
    templateFiles = fs
      .readdirSync(path.join(dir, ".jgates", "templates"))
      .filter((f) => /\.ya?ml$/.test(f))
      .sort()
      .map((f) => `.jgates/templates/${f}`);
  } catch {
    templateFiles = [];
  }
  for (const name of [...names, ...templateFiles]) {
    try {
      const located = locateConfigFile(dir, name);
      const rev = readRevision(located.abs);
      files.push({ file: located.file, kind: located.kind, exists: rev.exists, revision: rev.hash, editable: options.editable !== false && !located.generated && (rev.exists || seedOf(located.kind) !== null) });
    } catch {
      // a file that is not reachable (a link out of the project) is not offered
    }
  }
  return {
    schemaVersion: 1,
    schemas,
    adapters: adapterIds().map((id) => ({ id, label: adapterDisplayName(id) ?? id, overlay: overlayOf(id), nativeForm: nativeOf(id) })),
    files,
    instances: instancesOf(dir, options.resolved ?? null).map((i) => ({
      ...i,
      label: { text: adapterDisplayName(i.adapter) ?? i.adapter, secondary: i.id },
      hasForm: true as const,
      overlay: overlayOf(i.adapter),
      nativeForm: nativeOf(i.adapter),
    })),
  };
}


