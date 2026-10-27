import fs from "node:fs";
import path from "node:path";
import { decodeBytes } from "../documents/encoding.js";
import { formatOf, validateText } from "../documents/validate.js";
import { resolveToolBindings } from "../tools/index.js";

/**
 * A configuration file a planned tool reads that does not parse (saving an active
 * configuration that is invalid is an explicit choice, and it blocks the plan that depends on it). Only syntax is
 * checked, by the format's own parser; a format with no parser available ("unavailable") never blocks.
 */
export interface InvalidConfigFile {
  /** Workspace-relative path with forward slashes (the absolute path when the file is outside the workspace). */
  file: string;
  line: number | null;
  column: number | null;
  message: string;
  /** Tool instances of the plan that read the file. */
  tools: string[];
}

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES_PER_BINDING = 200;

const slash = (p: string): string => p.split(path.sep).join("/");

function syntaxProblem(abs: string): { line: number | null; column: number | null; message: string } | null {
  let bytes: Buffer;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    bytes = fs.readFileSync(abs);
  } catch {
    return null;
  }
  const text = decodeBytes(bytes).text;
  if (text === null) return null;
  const result = validateText(formatOf(abs), text);
  if (result.status !== "invalid") return null;
  const first = result.errors[0];
  return { line: first?.line ?? null, column: first?.column ?? null, message: first?.message ?? "" };
}

/**
 * Checks the files the given tool instances read: their bindings of tools.yml (every role but ignore, the files of a
 * directory binding included) and the extra files the caller already knows (the configuration file an adapter chose).
 */
export function invalidToolConfigs(dir: string, toolIds: string[], extraFiles: Record<string, string[]> = {}): InvalidConfigFile[] {
  const wanted = new Set(toolIds);
  const byFile = new Map<string, { abs: string; tools: Set<string> }>();
  const add = (abs: string, tool: string) => {
    const key = path.resolve(abs);
    const entry = byFile.get(key) ?? { abs: key, tools: new Set<string>() };
    entry.tools.add(tool);
    byFile.set(key, entry);
  };
  const resolved = resolveToolBindings(dir, { skipInventory: true });
  for (const instance of resolved.instances) {
    if (!wanted.has(instance.id)) continue;
    for (const b of instance.bindings) {
      if (b.refused || !b.exists || b.role === "ignore") continue;
      if (b.kind === "file") add(b.absPath, instance.id);
      else for (const f of b.files.slice(0, MAX_FILES_PER_BINDING)) add(path.join(b.absPath, ...f.path.split("/")), instance.id);
    }
  }
  for (const [tool, files] of Object.entries(extraFiles)) {
    if (!wanted.has(tool)) continue;
    for (const f of files) add(path.resolve(dir, f), tool);
  }
  const root = path.resolve(dir);
  const out: InvalidConfigFile[] = [];
  for (const { abs, tools } of [...byFile.values()].sort((a, b) => a.abs.localeCompare(b.abs))) {
    const problem = syntaxProblem(abs);
    if (!problem) continue;
    const rel = path.relative(root, abs);
    out.push({ file: rel.startsWith("..") || path.isAbsolute(rel) ? abs : slash(rel), ...problem, tools: [...tools].sort() });
  }
  return out;
}
