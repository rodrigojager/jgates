import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CommandModule } from "./command.js";

/** Folder with the built-in command modules (next to this module). */
export function defaultCommandsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "commands");
}

function isCommandModule(value: unknown): value is CommandModule {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === "string" && typeof v.description === "string" && Array.isArray(v.options) && typeof v.run === "function";
}

/** Imports every .js file of the folders that exports a `command`; no central list. Sorted by name. */
export async function loadCommands(dirs: string[] = [defaultCommandsDir()]): Promise<CommandModule[]> {
  const found = new Map<string, CommandModule>();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
    for (const file of files) {
      const mod = (await import(pathToFileURL(path.join(dir, file)).href)) as { command?: unknown };
      if (isCommandModule(mod.command)) found.set(mod.command.name, mod.command);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
