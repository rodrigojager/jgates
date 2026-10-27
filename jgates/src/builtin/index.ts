import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateDocument } from "../core/config/load/schema.js";

/**
 * Built-in templates and starter profiles. One JSON file per item, found by scanning the folders (no central list):
 * templates/<id>.json follows schemas/config/template.schema.json and profiles/<id>.json is a profiles document
 * with exactly one profile, so the starter profiles can be copied as they are into a project's profiles.yml.
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
  cache.set(folder, items);
  return items;
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
