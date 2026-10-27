// Project prompts of the semantic gate (jgates.yml > extensions.semantic-gate.prompts). `system` and `review` each
// take `mode: replace | append` and `file`, a path relative to the folder the configuration is read from: the
// workspace, or the CI policy in governed mode (the same configDir as the masking). The output contract of the prompt
// is not customizable: the semantic-gate package always closes the prompt with it, so the answer stays parseable.
import fs from "node:fs";
import path from "node:path";
import type { SemanticPromptsProvenance } from "../../core/provenance/index.js";

export type PromptKind = "system" | "review";
export const PROMPT_KINDS: readonly PromptKind[] = ["system", "review"];

export interface PromptEntry {
  mode: "replace" | "append";
  /** As written in the configuration (relative to the config folder, with "/"). */
  file: string;
  /** Absolute path, inside the config folder. */
  path: string;
}

export type PromptSettings = Partial<Record<PromptKind, PromptEntry>>;

/** What a run records about the prompts it used ($.semantic.prompts and $.provenance.semanticPrompts). */
export type PromptsRecord = SemanticPromptsProvenance;
type PromptPartRecord = SemanticPromptsProvenance["system"];

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" ? false : !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Reads and checks the `prompts` block; every problem goes to `problems` (the settings then become invalid). */
export function parsePrompts(value: unknown, prefix: string, configDir: string, problems: string[]): PromptSettings {
  const out: PromptSettings = {};
  if (value === undefined || value === null) return out;
  const at = `${prefix}.prompts`;
  if (!isRec(value)) {
    problems.push(`${at} must be a mapping with system and/or review`);
    return out;
  }
  for (const [kind, entry] of Object.entries(value)) {
    if (kind !== "system" && kind !== "review") {
      problems.push(`${at}.${kind} is not a known prompt (use system or review)`);
      continue;
    }
    if (!isRec(entry)) {
      problems.push(`${at}.${kind} must be a mapping with mode and file`);
      continue;
    }
    for (const key of Object.keys(entry)) if (key !== "mode" && key !== "file") problems.push(`${at}.${kind}.${key} is not a known option`);
    const mode = entry.mode;
    if (mode !== "replace" && mode !== "append") {
      problems.push(`${at}.${kind}.mode must be replace or append`);
      continue;
    }
    const file = entry.file;
    if (typeof file !== "string" || file.trim() === "") {
      problems.push(`${at}.${kind}.file must be a path relative to ${path.basename(configDir) || configDir}`);
      continue;
    }
    const root = path.resolve(configDir);
    const absolute = path.resolve(root, file);
    if (path.isAbsolute(file) || !inside(root, absolute)) {
      problems.push(`${at}.${kind}.file must stay inside the configuration folder: ${file}`);
      continue;
    }
    let real: string;
    try {
      real = fs.realpathSync(absolute);
      if (!fs.statSync(real).isFile()) throw new Error("not a file");
    } catch {
      problems.push(`${at}.${kind}.file does not exist or is not a file: ${file}`);
      continue;
    }
    if (!inside(fs.realpathSync(root), real)) {
      problems.push(`${at}.${kind}.file must stay inside the configuration folder: ${file}`);
      continue;
    }
    out[kind] = { mode, file: file.split(path.sep).join("/"), path: real };
  }
  return out;
}

/** The settings as the semantic-gate package takes them (absolute files). */
export function gatePromptSettings(settings: PromptSettings): Record<string, { mode: string; file: string }> {
  const out: Record<string, { mode: string; file: string }> = {};
  for (const kind of PROMPT_KINDS) {
    const entry = settings[kind];
    if (entry) out[kind] = { mode: entry.mode, file: entry.path };
  }
  return out;
}

interface GatePromptInfo {
  sha256: string;
  system: { mode: string; sha256: string };
  review: { mode: string; sha256: string };
}

/** The record of the effective prompts: the package hashes, the configured (relative) files and where they came from. */
export function promptsRecord(info: GatePromptInfo, settings: PromptSettings, governed: boolean): PromptsRecord {
  const part = (kind: PromptKind): PromptPartRecord => {
    const entry = settings[kind];
    const sha256 = String(info[kind].sha256);
    return entry ? { source: governed ? "policy" : "project", mode: entry.mode, file: entry.file, sha256 } : { source: "default", mode: "default", file: null, sha256 };
  };
  return { sha256: String(info.sha256), system: part("system"), review: part("review") };
}
