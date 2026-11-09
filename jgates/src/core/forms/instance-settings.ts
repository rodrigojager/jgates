// Document side of the "instance" forms: the settings of a tool instance live in tools.<id> of the tools file
// (.jgates/tools.yml), not in a configuration file bound to the instance. Reading, previewing and saving that file keep
// the same contract as the document service: the revision is the sha256 of the bytes, a moved revision is a conflict and
// nothing is written, the write is atomic and only the edited keys change (the YAML codec patches the text).
import fs from "node:fs";
import path from "node:path";
import { hashBytes, readRevision, writeFileAtomic } from "../codecs/yaml/index.js";
import { unifiedDiff } from "../documents/diff.js";
import { validateText, type ValidationResult } from "../documents/validate.js";
import type { OpenedDocument } from "../documents/index.js";
import { resolveToolBindings } from "../tools/index.js";

export const TOOLS_FILE = ".jgates/tools.yml";

/** The part of an opened document the form service reads. */
export type FormDocument = Pick<OpenedDocument, "exists" | "relPath" | "path" | "text" | "format" | "revision" | "state" | "sharedWith" | "reasons">;

/** The tools file of the workspace (the one tools.yml resolution reports, or .jgates/tools.yml). */
export function toolsDocument(dir: string): FormDocument {
  const resolved = resolveToolBindings(dir, { skipInventory: true });
  const relPath = (resolved.configFile ?? TOOLS_FILE).replace(/\\/g, "/");
  const abs = path.resolve(dir, relPath);
  const rev = readRevision(abs);
  return {
    exists: rev.exists,
    relPath,
    path: abs,
    text: rev.exists ? rev.text : null,
    format: "yaml",
    revision: rev.hash,
    state: "editable",
    sharedWith: [],
    reasons: [],
  };
}

export function previewToolsText(doc: FormDocument, text: string): { revision: string | null; changed: boolean; diff: string; validation: ValidationResult } {
  const before = doc.text ?? "";
  return { revision: doc.revision, changed: before !== text, diff: unifiedDiff(before, text), validation: validateText("yaml", text) };
}

export type ToolsSaveResult = { status: "saved"; previousRevision: string | null; revision: string; diff: string } | { status: "unchanged"; revision: string | null } | { status: "conflict" };

/** Writes the text when the file still has the revision that was read; never over another version. */
export function saveToolsText(doc: FormDocument, expectedRevision: string | null, text: string): ToolsSaveResult {
  const current = readRevision(doc.path);
  if (current.hash !== expectedRevision) return { status: "conflict" };
  if (current.exists && current.text === text) return { status: "unchanged", revision: current.hash };
  writeFileAtomic(doc.path, text);
  return { status: "saved", previousRevision: current.hash, revision: hashBytes(Buffer.from(text, "utf8")), diff: unifiedDiff(current.exists ? current.text : "", text) };
}

const SKIP = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "target", ".jgates", ".tox", ".mypy_cache"]);

/**
 * Files of the project offered for a path field: the candidates that exist, then the files whose name matches the
 * pattern in a shallow scan (depth 3, at most 50 found). Relative paths with forward slashes, without duplicates.
 */
export function suggestedFiles(dir: string, spec: { candidates: string[]; pattern?: string }): string[] {
  const out: string[] = [];
  const add = (rel: string) => {
    if (!out.includes(rel)) out.push(rel);
  };
  for (const c of spec.candidates) {
    try {
      if (fs.statSync(path.join(dir, ...c.split("/"))).isFile()) add(c);
    } catch {
      // not there
    }
  }
  if (!spec.pattern) return out;
  const matcher = new RegExp(spec.pattern, "i");
  const walk = (abs: string, rel: string, depth: number) => {
    if (depth > 3 || out.length >= 50) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith(".")) walk(path.join(abs, e.name), childRel, depth + 1);
      } else if (e.isFile() && matcher.test(e.name)) add(childRel);
    }
  };
  walk(dir, "", 0);
  return out;
}
