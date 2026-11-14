// The JSON schemas the derived forms are built from: every configuration schema of jgates/schemas/config (found by
// listing the folder, so a new schema gets a form without a change here) and the settings schema of each adapter, cut
// out of the tool instance schema of tools.schema.json.
//
// Adapter settings live in one schema (tools.<id> of .jgates/tools.yml accepts every key of every adapter). Which
// adapter reads a key is written at the start of its description ("zizmor: ...", "oasdiff, schemathesis, zap: ...",
// "Test runners (pytest, vitest, ...): ..."): the adapter ids named before the first colon own the key. A key whose
// description names no adapter is a setting of every instance (enabled, component, timeoutSeconds...). Reading the
// owners from the schema keeps it the only source: a key added there shows up in the form of its adapters, and a key
// whose description names nobody still gets a field in every form instead of none.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { builtinManifests } from "../../../adapters/manifests.js";
import { localizedAdapterName } from "../../catalog/index.js";
import { translator } from "../../../i18n/index.js";
import { CONFIG_DIR, FRAGMENT_FILES, ROOT_FILE, configSchemaDir } from "../../config/load/index.js";
import type { JsonSchema } from "../types.js";

/** Kind of a configuration document, as the loader names it (root is jgates.yml), plus template and lock. */
export type ConfigKind = "root" | "workspace" | "tools" | "policy" | "profiles" | "pii" | "architecture" | "dependencies" | "template" | "lock" | (string & {});

export interface SchemaEntry {
  /** File name in jgates/schemas/config (for example jgates.schema.json). */
  schema: string;
  kind: ConfigKind;
  /** The schema title (the file it describes). */
  title: string;
  /** The project file the schema validates (relative, forward slashes); null for template files (one per template). */
  document: string | null;
  /** The project file is written by JGates itself (the lock), never by a form. */
  generated: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function kindOfSchema(file: string): ConfigKind {
  const base = file.replace(/\.schema\.json$/, "");
  return base === "jgates" ? "root" : base;
}

function documentOf(kind: ConfigKind): string | null {
  if (kind === "root") return ROOT_FILE;
  if (kind === "template") return null;
  if (kind === "lock") return `${CONFIG_DIR}/lock.json`;
  const fragment = (FRAGMENT_FILES as Record<string, string>)[kind];
  return fragment ? `${CONFIG_DIR}/${fragment}` : null;
}

const cache = new Map<string, JsonSchema>();

/** A schema of jgates/schemas/config by file name (parsed once). */
export function loadConfigSchema(schemaFile: string): JsonSchema {
  let schema = cache.get(schemaFile);
  if (!schema) {
    schema = JSON.parse(fs.readFileSync(path.join(configSchemaDir(), schemaFile), "utf8")) as JsonSchema;
    cache.set(schemaFile, schema);
  }
  return schema;
}

/** Every configuration schema, in file name order. */
export function configSchemas(): SchemaEntry[] {
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(configSchemaDir())
      .filter((f) => f.endsWith(".schema.json"))
      .sort();
  } catch {
    return [];
  }
  return files.map((schema) => {
    const kind = kindOfSchema(schema);
    const title = loadConfigSchema(schema).title;
    return { schema, kind, title: typeof title === "string" ? title : schema, document: documentOf(kind), generated: kind === "lock" };
  });
}

export function schemaEntryOfKind(kind: ConfigKind): SchemaEntry | undefined {
  return configSchemas().find((e) => e.kind === kind);
}

/** The kind of a project configuration file (jgates.yml, .jgates/<fragment>.yml, .jgates/templates/<x>.yml), or null. */
export function kindOfFile(file: string): ConfigKind | null {
  if (file === ROOT_FILE) return "root";
  if (file.startsWith(`${CONFIG_DIR}/templates/`) && /\.ya?ml$/.test(file) && !file.slice(`${CONFIG_DIR}/templates/`.length).includes("/")) return "template";
  if (file === `${CONFIG_DIR}/lock.json`) return "lock";
  if (!file.startsWith(`${CONFIG_DIR}/`) || file.slice(CONFIG_DIR.length + 1).includes("/")) return null;
  const base = path.posix.basename(file);
  for (const [kind, name] of Object.entries(FRAGMENT_FILES)) if (name === base) return kind;
  return null;
}

/** The ids of the built-in adapters. */
export function adapterIds(): string[] {
  return builtinManifests().map((m) => m.id);
}

/** The display name of an adapter in the catalogue, or null when it is not a built-in one. */
export function adapterDisplayName(adapter: string): string | null {
  const manifest = builtinManifests().find((m) => m.id === adapter);
  return manifest ? localizedAdapterName(manifest.id, manifest.displayName) : null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The adapters a setting belongs to, read from the start of its description (the text before the first colon); null
 * when it names none (a setting of every instance).
 */
export function settingOwners(description: unknown, ids: readonly string[] = adapterIds()): string[] | null {
  if (typeof description !== "string") return null;
  const colon = description.indexOf(":");
  if (colon <= 0) return null;
  const head = description.slice(0, colon);
  const owners = ids.filter((id) => new RegExp(`(^|[^a-z0-9-])${escape(id)}($|[^a-z0-9-])`).test(head));
  return owners.length > 0 ? owners : null;
}

/**
 * The help text of a schema description in the language of the screen. The schemas are written in English; the
 * catalog "schema-help" holds each description under the hash of its English text (a changed description loses its
 * translation until the catalog follows, and V2-73 fails on the gap), and the English text is the fallback.
 */
export function schemaHelp(description: unknown): string | null {
  if (typeof description !== "string") return null;
  const key = `h_${crypto.createHash("sha1").update(description).digest("hex").slice(0, 12)}`;
  const text = translator("schema-help")(key);
  return text === key ? description : text;
}

/** The schema of one tool instance (tools.<id>) as tools.schema.json declares it, with its $defs. */
export function instanceSchema(): { schema: JsonSchema; root: JsonSchema } {
  const root = loadConfigSchema("tools.schema.json");
  const tools = (root.properties as Record<string, JsonSchema>).tools as JsonSchema;
  return { schema: tools.additionalProperties as JsonSchema, root };
}

/**
 * The settings schema of an adapter: the instance keys of every adapter (no owner in the description) plus the keys
 * its description gives to this adapter, in the order of tools.schema.json. `$defs` stay those of tools.schema.json.
 */
export function adapterSettingsSchema(adapter: string): JsonSchema {
  const { schema } = instanceSchema();
  const ids = adapterIds();
  const properties: Record<string, JsonSchema> = {};
  for (const [key, value] of Object.entries((schema.properties ?? {}) as Record<string, JsonSchema>)) {
    const owners = settingOwners(value.description, ids);
    if (owners === null || owners.includes(adapter)) properties[key] = value;
  }
  return { ...schema, properties };
}

/** Keys of tools.<id> that are not settings of the adapter (they are valid for the schema but the adapter ignores them). */
export function foreignSetting(adapter: string, key: string): boolean {
  const { schema } = instanceSchema();
  const value = ((schema.properties ?? {}) as Record<string, JsonSchema>)[key];
  if (!isObject(value)) return false;
  const owners = settingOwners(value.description);
  return owners !== null && !owners.includes(adapter);
}
