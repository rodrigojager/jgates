import type { ConfigDiagnostic, YamlLimits } from "../load/types.js";

/**
 * Layers of the normal precedence, weakest first:
 * defaults of JGates and of the adapters < templates (base before specialized) < profile < project/component < call.
 */
export type LayerName = "defaults" | "template" | "profile" | "project" | "call";
export const LAYER_ORDER: readonly LayerName[] = ["defaults", "template", "profile", "project", "call"];

/** Where a value came from. */
export interface Origin {
  layer: LayerName;
  /** Identity inside the layer: "jgates", "adapter:quality-bridge", "builtin:base", "profile:rapido", "builtin:standard", "jgates.yml", "call"... */
  source: string;
  /** File that holds the value, relative to the project ("builtin:<folder>/<file>" for built-in items); null when there is none. */
  file: string | null;
  /** Dotted path of the value inside the file (where to edit); null when there is no file. */
  path: string | null;
}

export interface FieldWrite extends Origin {
  /** Value of the field after this write. */
  value: unknown;
  /** "set" for a plain value; "list" for an explicit add/remove/replace operation (given in `operation`). */
  op: "set" | "list" | "object";
  operation?: unknown;
}

/** A leaf of the effective configuration with its origin and the value it replaced. */
export interface ResolvedField extends Origin {
  pointer: string;
  value: unknown;
  op: FieldWrite["op"];
  operation?: unknown;
  /** The value before the last write, with its origin; absent when only one layer wrote the field. */
  previous?: Origin & { value: unknown };
  /** Every write, weakest first. */
  history: FieldWrite[];
}

export interface ResolveIssue {
  code: string;
  message: string;
  fix?: string;
  file?: string;
  pointer?: string;
  /** Exact chain of a cycle, in traversal order (the first element appears again at the end). */
  chain?: string[];
  details?: unknown;
}

/** What template activation needs from the discovery inventory (the discovery's Inventory fits this shape). */
export interface InventoryLike {
  templatesActive?: boolean;
  languages?: string[];
  classifications?: Array<{ language?: string | null; framework?: string | null; approvable?: boolean }>;
}

/** A value forced by the call (CLI flag or API), the strongest layer. `value` may be a list operation. */
export interface CallOverride {
  pointer: string;
  value: unknown;
  /** Shown as the origin, for example "--skip"; defaults to "call". */
  source?: string;
}

export interface ResolveOptions {
  /** Profile asked by the call; overrides selection.profile. */
  profile?: string;
  overrides?: CallOverride[];
  /** Inventory of the first stage; when absent the discovery runs on the project. */
  inventory?: InventoryLike;
  /** Template entries (ids in jgates.yml templates) with activation manual that this call turns on. */
  templates?: string[];
  /** What removing an item that is not in the inherited list gives (default: warning). */
  missingRemove?: "warning" | "error" | "ignore";
  limits?: YamlLimits;
  /**
   * Folder whose jgates.yml and .jgates/ replace the project's own configuration (a CI policy). Discovery settings
   * and template files come from it too; the project only gives the inventory. Defaults to the project.
   */
  configDir?: string;
}

export interface TemplateState {
  /** Entry id in jgates.yml (or of the implicit default list). */
  id: string;
  source: string;
  /** reasonCode: ALWAYS, DETECTED, REQUESTED, NOT_DETECTED, MANUAL, DISABLED, REPORT_ONLY. */
  reason: string;
  /** Languages or frameworks of the inventory that matched (DETECTED). */
  matched?: string[];
}

export interface ActiveTemplate extends TemplateState {
  priority: number;
  /** Resolved identities applied for this entry, ancestors first. */
  chain: string[];
}

export interface TemplateNodeInfo {
  ref: string;
  file: string;
  priority: number;
  parents: string[];
}

export interface ProfileLink {
  /** As referenced: "rapido", "builtin:standard". */
  id: string;
  file: string;
  path: string;
}

export interface ResolvedProfile {
  id: string;
  label: string | null;
  description: string | null;
  /** The selected profile first, then each parent. */
  chain: ProfileLink[];
}

export interface LayerInfo extends Pick<Origin, "layer" | "source" | "file"> {}

export interface ResolveResult {
  ok: boolean;
  projectDir: string;
  /** Where the configuration was read from; origins (`file`) are relative to it. Equals projectDir without a policy. */
  configDir: string;
  /** The effective configuration (keys sorted). Collections of tools, rules, templates and components are maps by id. */
  config: Record<string, unknown>;
  /** Every leaf of `config`, by JSON Pointer, with its origin. */
  fields: Record<string, ResolvedField>;
  profile: ResolvedProfile | null;
  templates: { active: ActiveTemplate[]; inactive: TemplateState[]; nodes: TemplateNodeInfo[] };
  /** Layers in the order they were applied. */
  layers: LayerInfo[];
  warnings: ResolveIssue[];
  errors: ResolveIssue[];
  /** Load diagnostics (syntax, schema, references) of the project files. */
  diagnostics: ConfigDiagnostic[];
}

export interface FieldLookup {
  found: boolean;
  pointer: string;
  value?: unknown;
  /** The field, when the pointer is a leaf. */
  field?: ResolvedField;
  /** The leaves under the pointer, when it is an object. */
  fields?: Record<string, ResolvedField>;
  suggestion?: string;
}
