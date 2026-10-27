// The configurable part of the masking: extensions.semantic-gate.masking (entities, patterns, tools, onMatch) and
// include, validated with the path of each field, and the step that hands the masked file texts to the external
// tools of .jgates/pii.yml (mode `context`) and reads them back.
import {
  COUNT_LABEL,
  createMaskWorkspace,
  readMaskTools,
  runMaskTools,
  sumToolCounts,
  type MaskFailureCode,
  type MaskToolDefinition,
  type MaskToolOutcome,
} from "../../core/mask-tools/index.js";
import { DEFAULT_MASK_ENTITIES, MASK_ENTITIES, type MaskEntity, type MaskPattern, type MaskRules } from "./mask.js";

export type OnMatch = "mask" | "block";

export interface MaskingSettings extends MaskRules {
  tools: MaskToolDefinition[];
  onMatch: OnMatch;
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const PATTERN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FLAGS = /^[imsu]*$/;

/**
 * Reads `masking` (and validates `include`) of the block. `prefix` is the field path of the block
 * (extensions.semantic-gate); `configDir` is where .jgates/pii.yml is read from (the project, or the policy).
 */
export function parseMasking(raw: unknown, prefix: string, configDir: string, problems: string[]): MaskingSettings {
  const out: MaskingSettings = { entities: { ...DEFAULT_MASK_ENTITIES }, patterns: [], tools: [], onMatch: "mask" };
  const at = `${prefix}.masking`;
  if (raw === undefined || raw === null) return out;
  if (!isRec(raw)) {
    problems.push(`${at} must be a mapping`);
    return out;
  }
  for (const key of Object.keys(raw)) if (!["pii", "patterns", "tools", "onMatch"].includes(key)) problems.push(`${at}.${key} is not a known option`);

  if (raw.pii !== undefined) {
    if (!isRec(raw.pii)) problems.push(`${at}.pii must be a mapping of entity: true|false`);
    else
      for (const [entity, on] of Object.entries(raw.pii)) {
        if (!(MASK_ENTITIES as readonly string[]).includes(entity)) problems.push(`${at}.pii.${entity} is not a known entity (${MASK_ENTITIES.join(", ")})`);
        else if (typeof on !== "boolean") problems.push(`${at}.pii.${entity} must be true or false`);
        else out.entities[entity as MaskEntity] = on;
      }
  }

  if (raw.patterns !== undefined) {
    if (!Array.isArray(raw.patterns)) problems.push(`${at}.patterns must be a list`);
    else {
      const seen = new Set<string>();
      raw.patterns.forEach((p: unknown, i: number) => {
        const where = `${at}.patterns[${i}]`;
        if (!isRec(p)) return void problems.push(`${where} must be a mapping with id, regex and label`);
        for (const key of Object.keys(p)) if (!["id", "regex", "label", "flags"].includes(key)) problems.push(`${where}.${key} is not a known option`);
        const id = typeof p.id === "string" ? p.id : "";
        if (!PATTERN_ID.test(id)) return void problems.push(`${where}.id must be a lowercase id (letters, digits, ".", "_" and "-")`);
        if (seen.has(id)) return void problems.push(`${where}.id repeats the id "${id}"`);
        seen.add(id);
        const label = p.label === undefined ? id : p.label;
        if (typeof label !== "string" || !COUNT_LABEL.test(label)) return void problems.push(`${where}.label must be letters, digits, ".", "_" or "-" (up to 64)`);
        const flags = p.flags === undefined ? "" : p.flags;
        if (typeof flags !== "string" || !FLAGS.test(flags)) return void problems.push(`${where}.flags may hold only i, m, s and u`);
        if (typeof p.regex !== "string" || p.regex === "") return void problems.push(`${where}.regex must be a non-empty string`);
        let regex: RegExp;
        try {
          regex = new RegExp(p.regex, `${[...new Set(flags)].join("")}g`);
        } catch (error) {
          return void problems.push(`${where}.regex is not a valid regular expression (${error instanceof Error ? error.message : String(error)})`);
        }
        if (regex.test("")) return void problems.push(`${where}.regex matches an empty text`);
        regex.lastIndex = 0;
        out.patterns.push({ id, label, regex } satisfies MaskPattern);
      });
    }
  }

  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools)) problems.push(`${at}.tools must be a list of tool ids of .jgates/pii.yml`);
    else if (raw.tools.length > 0) {
      const file = readMaskTools(configDir);
      problems.push(...file.problems);
      const seen = new Set<string>();
      raw.tools.forEach((id: unknown, i: number) => {
        const where = `${at}.tools[${i}]`;
        if (typeof id !== "string" || id === "") return void problems.push(`${where} must be a tool id`);
        if (seen.has(id)) return void problems.push(`${where} repeats the tool "${id}"`);
        seen.add(id);
        const tool = file.tools.get(id);
        if (!tool) return void problems.push(`${where}: the tool "${id}" is not defined in .jgates/pii.yml (tools)`);
        out.tools.push(tool);
      });
    }
  }

  if (raw.onMatch !== undefined) {
    if (raw.onMatch === "mask" || raw.onMatch === "block") out.onMatch = raw.onMatch;
    else problems.push(`${at}.onMatch must be mask or block`);
  }
  return out;
}

/** `include`: the allow list of paths. Absent or empty: every path of the scope. */
export function parseInclude(raw: unknown, prefix: string, problems: string[]): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((g) => typeof g !== "string" || g.trim() === "")) {
    problems.push(`${prefix}.include must be a list of path globs`);
    return [];
  }
  return raw as string[];
}

// ---- the external tools on the context ----------------------------------------------------------------------------------

/** The text fields of a file of the review context, in this order. */
const TEXT_FIELDS = ["content", "diff", "stagedDiff"] as const;
type TextField = (typeof TEXT_FIELDS)[number];
const separator = (field: TextField): string => `\n@@jgates-mask-part ${field}@@\n`;

/** One file of the copy holds what the provider would see of that file; several parts are joined by a marker line. */
export function serializeFile(file: Record<string, unknown>): { text: string; fields: TextField[] } | null {
  const fields = TEXT_FIELDS.filter((f) => typeof file[f] === "string" && file[f] !== "");
  if (fields.length === 0) return null;
  let text = "";
  fields.forEach((f, i) => {
    text += (i === 0 ? "" : separator(f)) + (file[f] as string);
  });
  return { text, fields };
}

/** The parts back, or null when the markers did not survive the tool as they were written. */
export function deserializeFile(text: string, fields: readonly TextField[]): Partial<Record<TextField, string>> | null {
  const out: Partial<Record<TextField, string>> = {};
  let rest = text;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as TextField;
    const next = fields[i + 1];
    if (next === undefined) {
      if (TEXT_FIELDS.some((f) => rest.includes(separator(f)))) return null;
      out[field] = rest;
      break;
    }
    const sep = separator(next);
    const at = rest.indexOf(sep);
    if (at < 0) return null;
    const part = rest.slice(0, at);
    if (TEXT_FIELDS.some((f) => part.includes(separator(f)))) return null;
    out[field] = part;
    rest = rest.slice(at + sep.length);
  }
  return out;
}

export type ContextToolsResult =
  | { ok: true; files: Array<Record<string, unknown>>; counts: Record<string, number>; detected: boolean; outcomes: MaskToolOutcome[] }
  | { ok: false; code: MaskFailureCode; reason: string; counts: Record<string, number>; outcomes: MaskToolOutcome[] };

/** What the result shows of each tool run: never the text, only the flags, the counts per label and the code. */
export const toolSummary = (outcomes: readonly MaskToolOutcome[]): Array<Record<string, unknown>> =>
  outcomes.map((o) => ({
    id: o.tool,
    ok: o.ok,
    detected: o.status?.detected ?? null,
    changed: o.status?.changed ?? null,
    counts: o.status?.counts ?? {},
    durationMs: o.durationMs,
    ...(o.ok ? {} : { code: o.code }),
  }));

/** Runs the tools (in order) on a copy of the masked file texts and returns the files with the tools' edits. */
export async function maskWithTools(
  files: ReadonlyArray<Record<string, unknown>>,
  tools: readonly MaskToolDefinition[],
  options: { env: NodeJS.ProcessEnv; signal?: AbortSignal; vault?: boolean },
): Promise<ContextToolsResult> {
  const parts: Array<{ index: number; path: string; text: string; fields: TextField[] }> = [];
  files.forEach((file, index) => {
    const serialized = serializeFile(file);
    if (serialized && typeof file.path === "string") parts.push({ index, path: file.path, ...serialized });
  });
  if (tools.length === 0 || parts.length === 0) return { ok: true, files: files.map((f) => ({ ...f })), counts: {}, detected: false, outcomes: [] };
  let workspace;
  try {
    workspace = createMaskWorkspace(parts.map((p) => ({ path: p.path, content: p.text })));
  } catch (error) {
    return { ok: false, code: "MASKING_COMMAND_FAILED", reason: `the copy for the tools could not be written (${error instanceof Error ? error.message : String(error)})`, counts: {}, outcomes: [] };
  }
  try {
    const run = await runMaskTools(tools, workspace, { mode: "context", parentEnv: options.env, ...(options.vault === false ? { vault: false } : {}), ...(options.signal ? { signal: options.signal } : {}) });
    const counts = sumToolCounts(run.outcomes);
    if (!run.ok) {
      const failed = run.outcomes[run.outcomes.length - 1];
      const code = failed && !failed.ok ? failed.code : "MASKING_COMMAND_FAILED";
      const reason = failed && !failed.ok ? failed.reason : "a masking tool failed";
      return { ok: false, code, reason, counts, outcomes: run.outcomes };
    }
    const out = files.map((f) => ({ ...f }));
    for (const part of parts) {
      const back = deserializeFile(workspace.readText(part.path.replaceAll("\\", "/")), part.fields);
      if (!back) return { ok: false, code: "MASKING_COMMAND_FAILED", reason: `the part markers of ${part.path} were changed by a tool`, counts, outcomes: run.outcomes };
      Object.assign(out[part.index] as Record<string, unknown>, back);
    }
    return { ok: true, files: out, counts, detected: run.outcomes.some((o) => o.status?.detected === true), outcomes: run.outcomes };
  } finally {
    workspace.cleanup();
  }
}
