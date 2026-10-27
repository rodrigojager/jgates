// Forms are found by folder: every src/adapters/<id>/form/index.ts that exports a FormDefinition is registered (no
// central list). The scan is lazy and cached; tests and extensions can pass their own list to the form functions.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FormDefinition } from "./types.js";

const ADAPTERS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "adapters");

export function isFormDefinition(value: unknown): value is FormDefinition {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return typeof f.id === "string" && typeof f.adapter === "string" && Array.isArray(f.documents) && Array.isArray(f.fields) && Array.isArray(f.sections);
}

export async function scanForms(dir: string = ADAPTERS_DIR): Promise<FormDefinition[]> {
  const found: FormDefinition[] = [];
  let folders: string[] = [];
  try {
    folders = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return found;
  }
  for (const folder of folders) {
    const file = path.join(dir, folder, "form", "index.js");
    if (!fs.existsSync(file)) continue;
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    for (const key of Object.keys(mod).sort()) {
      const value = mod[key];
      if (isFormDefinition(value) && !found.some((f) => f.id === value.id)) found.push(value);
    }
  }
  return found;
}

let cached: Promise<FormDefinition[]> | null = null;

/** The built-in forms (cached after the first scan). */
export function builtinForms(): Promise<FormDefinition[]> {
  cached ??= scanForms();
  return cached;
}
