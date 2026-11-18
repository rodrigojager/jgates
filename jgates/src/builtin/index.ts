import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateDocument } from "../core/config/load/schema.js";

/**
 * Built-in templates and starter profiles. One JSON file per item, found by scanning the folders (no central list):
 * templates/<id>.json follows schemas/config/template.schema.json and profiles/<id>.json is a profiles document
 * with exactly one profile, so the starter profiles can be copied as they are into a project's profiles.yml.
 *
 * Templates can also be generated (the linter engine derives one per descriptor group): a provider registered with
 * registerTemplateProvider adds them, validated like the files. A built-in template whose document says
 * `implicit: true` is part of every project's configuration without being listed in jgates.yml (ADR-0022): the new
 * tools reach an existing project on upgrade with no change to its file (listImplicitTemplates, read by the resolver).
 */

export const BUILTIN_PREFIX = "builtin:";

export interface BuiltinItem {
  /** Identity used in references, for example "builtin:base". */
  ref: string;
  id: string;
  /** Pseudo path shown as the origin of the values, for example "builtin:templates/base.json". */
  file: string;
  value: Record<string, unknown>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const cache = new Map<string, Map<string, BuiltinItem>>();

/** A generated built-in template: its id and its document (schemas/config/template.schema.json). */
export interface GeneratedTemplate {
  id: string;
  value: Record<string, unknown>;
}
export type TemplateProvider = () => GeneratedTemplate[];
const providers = new Map<string, TemplateProvider>();

/**
 * Adds (or, with null, removes) a source of generated built-in templates under a name ("linters"). Their pseudo file
 * is builtin:<name>/<id>; an id that clashes with a file or another provider is a defect of JGates (BuiltinError).
 */
export function registerTemplateProvider(name: string, provider: TemplateProvider | null): void {
  if (provider) providers.set(name, provider);
  else providers.delete(name);
  cache.delete("templates");
}

/** A broken built-in file is a defect of JGates itself, not of the project: callers report it as an internal error. */
export class BuiltinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuiltinError";
  }
}

function loadFolder(folder: "templates" | "profiles"): Map<string, BuiltinItem> {
  const hit = cache.get(folder);
  if (hit) return hit;
  const dir = path.join(here, folder);
  const items = new Map<string, BuiltinItem>();
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort() : [];
  for (const name of names) {
    const id = name.slice(0, -".json".length);
    const file = `${BUILTIN_PREFIX}${folder}/${name}`;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Record<string, unknown>;
    } catch (error) {
      throw new BuiltinError(`${file}: ${(error as Error).message}`);
    }
    const problems = validateDocument(folder === "templates" ? "template" : "profiles", value, file);
    if (problems.length > 0) throw new BuiltinError(`${file}: ${problems.map((p) => `${p.path} ${p.message}`).join("; ")}`);
    if (folder === "templates" && value.id !== id) throw new BuiltinError(`${file}: id must be "${id}"`);
    if (folder === "profiles") {
      const keys = Object.keys((value.profiles as Record<string, unknown> | undefined) ?? {});
      if (keys.length !== 1 || keys[0] !== id) throw new BuiltinError(`${file}: must hold exactly the profile "${id}"`);
    }
    items.set(id, { ref: `${BUILTIN_PREFIX}${id}`, id, file, value });
  }
  if (folder === "templates") {
    for (const name of [...providers.keys()].sort()) {
      const generated = (providers.get(name) as TemplateProvider)();
      for (const { id, value } of [...generated].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        const file = `${BUILTIN_PREFIX}${name}/${id}`;
        if (items.has(id)) throw new BuiltinError(`${file}: the template id "${id}" is already built in (${items.get(id)?.file})`);
        const problems = validateDocument("template", value, file);
        if (problems.length > 0) throw new BuiltinError(`${file}: ${problems.map((p) => `${p.path} ${p.message}`).join("; ")}`);
        if (value.id !== id) throw new BuiltinError(`${file}: id must be "${id}"`);
        items.set(id, { ref: `${BUILTIN_PREFIX}${id}`, id, file, value });
      }
    }
  }
  cache.set(folder, items);
  return items;
}

/** The built-in templates that are part of every project's configuration (`implicit: true`), sorted by id. */
export function listImplicitTemplates(): BuiltinItem[] {
  return [...loadFolder("templates").values()].filter((i) => i.value.implicit === true).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function isBuiltinRef(ref: string): boolean {
  return ref.startsWith(BUILTIN_PREFIX);
}

export function listBuiltinTemplates(): BuiltinItem[] {
  return [...loadFolder("templates").values()];
}

export function listBuiltinProfiles(): BuiltinItem[] {
  return [...loadFolder("profiles").values()];
}

/** Accepts "builtin:base" or "base". */
export function getBuiltinTemplate(ref: string): BuiltinItem | undefined {
  return loadFolder("templates").get(isBuiltinRef(ref) ? ref.slice(BUILTIN_PREFIX.length) : ref);
}

/** Accepts "builtin:standard" or "standard". */
export function getBuiltinProfile(ref: string): BuiltinItem | undefined {
  return loadFolder("profiles").get(isBuiltinRef(ref) ? ref.slice(BUILTIN_PREFIX.length) : ref);
}

/** The body of a starter profile (label, description, extends, checks...). */
export function builtinProfileBody(item: BuiltinItem): Record<string, unknown> {
  return ((item.value.profiles as Record<string, Record<string, unknown>>)[item.id] ?? {}) as Record<string, unknown>;
}
