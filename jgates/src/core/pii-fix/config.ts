// The settings `jgates pii check` and `jgates pii fix` read from .jgates/pii.yml: the built-in detector (instance switch
// and entities), the external tools (`tools`, read by core/mask-tools) and the `fix` block (which tools, which files, how
// long the originals are kept). The file is validated against schemas/config/pii.schema.json; a problem carries the
// file and the field path and stops the command before anything runs.
import fs from "node:fs";
import path from "node:path";
import { parseYamlFile, validateDocument } from "../config/load/index.js";
import { PII_CONFIG_FILE, readMaskTools, type MaskToolDefinition } from "../mask-tools/index.js";
import { DEFAULT_ENABLED, DEFAULT_SEVERITY, SUPPORTED_ENTITIES } from "../../adapters/builtin-pii/settings.js";

export const DEFAULT_BACKUP_RETENTION_DAYS = 7;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

export interface PiiFixSettings {
  /** Tool ids of `fix.tools`, in order. */
  tools: string[];
  includes: string[];
  excludes: string[];
  backupRetentionDays: number;
}

export interface PiiSettings {
  /** Whether .jgates/pii.yml exists. */
  present: boolean;
  /** Problems with the file and the field path; not empty means nothing may run. */
  problems: string[];
  builtin: {
    /** The instance switch (`enabled`); absent counts as on. */
    enabled: boolean;
    /** The `config` of the bridge request (the effective entities and the detector options). */
    config: Rec;
    /** The entities that are on. */
    entities: string[];
  };
  fix: PiiFixSettings;
  /** The definitions of `fix.tools`, in order. */
  tools: MaskToolDefinition[];
}

/** Reads and validates .jgates/pii.yml of a configuration folder. Never throws. */
export function readPiiSettings(configDir: string): PiiSettings {
  const out: PiiSettings = {
    present: false,
    problems: [],
    builtin: { enabled: true, config: {}, entities: [] },
    fix: { tools: [], includes: ["**"], excludes: [], backupRetentionDays: DEFAULT_BACKUP_RETENTION_DAYS },
    tools: [],
  };
  const absolute = path.join(configDir, PII_CONFIG_FILE);
  let doc: Rec = {};
  if (fs.existsSync(absolute)) {
    out.present = true;
    const parsed = parseYamlFile(absolute, PII_CONFIG_FILE);
    const diagnostics = [...parsed.diagnostics];
    if (parsed.value !== undefined && diagnostics.length === 0) {
      diagnostics.push(...validateDocument("pii", parsed.value, PII_CONFIG_FILE, { doc: parsed.doc, lineCounter: parsed.lineCounter }));
    }
    for (const d of diagnostics) out.problems.push(`${d.file}: ${d.path === "" ? "" : `${d.path}: `}${d.message}`);
    if (isRec(parsed.value)) doc = parsed.value;
  }

  const entities = isRec(doc.entities) ? doc.entities : {};
  const top = typeof doc.severity === "string" ? doc.severity : null;
  const states = SUPPORTED_ENTITIES.map((id) => {
    const own = isRec(entities[id]) ? entities[id] : {};
    return {
      id,
      enabled: typeof own.enabled === "boolean" ? own.enabled : (DEFAULT_ENABLED[id] as boolean),
      severity: typeof own.severity === "string" ? own.severity : (top ?? (DEFAULT_SEVERITY[id] as string)),
    };
  });
  const config: Rec = { schemaVersion: 1, entities: Object.fromEntries(states.map((s) => [s.id, { enabled: s.enabled, severity: s.severity }])) };
  // Passed through as written: an option the detector cannot honor is refused by the sidecar, never dropped.
  for (const key of ["detection", "reporting", "remediation"] as const) if (isRec(doc[key])) config[key] = doc[key];
  out.builtin = { enabled: doc.enabled !== false, config, entities: states.filter((s) => s.enabled).map((s) => s.id) };

  const fix = isRec(doc.fix) ? doc.fix : {};
  if (Array.isArray(fix.tools)) out.fix.tools = strings(fix.tools);
  if (Array.isArray(fix.includes)) out.fix.includes = strings(fix.includes);
  if (Array.isArray(fix.excludes)) out.fix.excludes = strings(fix.excludes);
  if (typeof fix.backupRetentionDays === "number") out.fix.backupRetentionDays = fix.backupRetentionDays;

  const defined = readMaskTools(configDir);
  out.problems.push(...defined.problems);
  for (const [index, id] of out.fix.tools.entries()) {
    const tool = defined.tools.get(id);
    if (tool) out.tools.push(tool);
    else if (!defined.problems.some((p) => p.includes(`tools.${id}`))) out.problems.push(`${PII_CONFIG_FILE}: fix.tools[${index}]: the tool "${id}" is not defined in tools`);
  }
  return out;
}
