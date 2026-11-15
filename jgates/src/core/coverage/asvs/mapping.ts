// The ASVS mapping pack (jgates/packs/asvs/jgates-asvs-map): one reviewed data file per chapter with exactly one entry
// per requirement, naming the checks that examine it. The skeleton claims nothing: every entry has no check and the
// status "unmapped". The gates here keep the mapping honest: unknown requirements, rules, capabilities and attack
// classes are refused, a pending entry counts for nothing, no string repeats the official text, and every rule of the
// Semgrep pack is mapped or listed with a reason in unmapped-rules.json. Entries refer to requirements by id only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundledPackRulesDir, buildPackIndex } from "../../../adapters/semgrep/index.js";
import { buildMatrix } from "../../matrix/index.js";
import { loadVendored } from "../../semantic-modules/cloudflare/source.js";
import type { AsvsData } from "./index.js";

/** What an entry's checks are worth. `unmapped`: no check. `pending`: checks written, not yet reviewed (counts for nothing). */
export const MAPPING_STATUSES = ["unmapped", "pending", "reviewed", "owner-reviewed"] as const;
export type MappingStatus = (typeof MAPPING_STATUSES)[number];
export const MAPPING_EVIDENCE = ["repository", "deployment", "person"] as const;
export const MAPPING_UNITS = ["semgrep-rule", "capability", "semantic-ledger", "semantic-method"] as const;
export type MappingUnit = (typeof MAPPING_UNITS)[number];
export const MAPPING_DEPTHS = ["partial", "full"] as const;
export const MAPPING_SUBDIMENSIONS = ["injection", "authorization", "tenant-isolation", "secrets", "cryptography", "privacy", "business-logic", "runtime-evidence", "hardening"] as const;

export interface MappingCheck {
  unit: MappingUnit;
  /** A rule id, `<adapter>#<capability>`, `FILE.md#Class`, or a Semantic method id. */
  id: string;
  /** Only for `semantic-method`: the category of the method the entry relies on. */
  category?: string;
  covers: string;
  misses: string;
  depth: (typeof MAPPING_DEPTHS)[number];
}

export interface MappingEntry {
  requirement: string;
  status: MappingStatus;
  /** `null`: not classified yet (no mapping decision was made). */
  evidence: (typeof MAPPING_EVIDENCE)[number] | null;
  subdimensions: string[];
  checks: MappingCheck[];
  why?: string;
  review?: { by: string; date: string };
}

/** One chapter file of the pack. */
export interface MappingChapterFile {
  version: string;
  chapter: string;
  entries: MappingEntry[];
}

export interface UnmappedRule {
  id: string;
  /** The refused requirement of a (rule, requirement) pair; without it the entry refuses every requirement the rule was written for. */
  requirement?: string;
  reason: string;
}

export interface UnmappedRulesFile {
  version: string;
  rules: UnmappedRule[];
}

export interface AsvsMapping {
  version: string;
  files: Array<MappingChapterFile & { file: string }>;
  entries: MappingEntry[];
  unmappedRules: UnmappedRulesFile;
}

export class AsvsMappingError extends Error {}

export const UNMAPPED_RULES_FILE = "unmapped-rules.json";

/** The pack folder, next to the package (dist/core/coverage/asvs -> ../../../../packs/asvs/jgates-asvs-map). */
export function asvsMapDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "..", "packs", "asvs", "jgates-asvs-map");
}

/** `V06` for chapter `V6`: the file stem of a chapter. */
export function chapterFileStem(chapter: string): string {
  const n = /^V(\d+)$/.exec(chapter);
  return n ? `V${(n[1] as string).padStart(2, "0")}` : chapter;
}

/** Reads the chapter files and the unmapped-rules file of one version. Throws AsvsMappingError when a file is missing or is not JSON. */
export function loadMapping(version: string = "5.0.0", dir: string = asvsMapDir(), chapters?: string[]): AsvsMapping {
  const base = path.join(dir, version);
  const readJson = (file: string): unknown => {
    try {
      return JSON.parse(fs.readFileSync(path.join(base, file), "utf8"));
    } catch (error) {
      throw new AsvsMappingError(`${file}: ${(error as Error).message}`);
    }
  };
  const ids = chapters ?? Array.from({ length: 17 }, (_, i) => `V${i + 1}`);
  const files = ids.map((chapter) => {
    const file = `${chapterFileStem(chapter)}.json`;
    return { ...(readJson(file) as MappingChapterFile), file };
  });
  return { version, files, entries: files.flatMap((f) => f.entries ?? []), unmappedRules: readJson(UNMAPPED_RULES_FILE) as UnmappedRulesFile };
}

/** The checks an entry is worth: only a reviewed entry counts. A `pending` entry behaves as unmapped. */
export function countedChecks(entry: MappingEntry): MappingCheck[] {
  return entry.status === "reviewed" || entry.status === "owner-reviewed" ? entry.checks : [];
}

/** What the gates check mapped checks against. */
export interface MappingContext {
  /** Rule id to the subdimension its own metadata declares. */
  rules: Map<string, string>;
  /** Rule id to the requirement ids its own metadata (`asvs_requirements`) says it was written for; a rule without any is absent. */
  ruleRequirements: Map<string, string[]>;
  /** `<adapter>#<capability>` with at least one `validated` row of the matrix. */
  capabilities: Set<string>;
  /** `FILE.md#Class` blocks of the vendored attack-class files that a ledger unit can name. */
  attackBlocks: Set<string>;
  /** Semantic method id to its categories (empty when it has none). */
  methods: Map<string, Set<string>>;
}

/** The context of this installation: the pack index, the matrix, the vendored attack classes and the Semantic methods. */
export function buildMappingContext(): MappingContext {
  const rules = new Map<string, string>();
  const ruleRequirements = new Map<string, string[]>();
  const rulesDir = bundledPackRulesDir("jgates");
  if (rulesDir) {
    for (const rule of buildPackIndex(rulesDir).rules) {
      rules.set(rule.id, rule.subdimension);
      if (rule.asvsRequirements.length > 0) ruleRequirements.set(rule.id, rule.asvsRequirements);
    }
  }
  const capabilities = new Set<string>();
  for (const row of buildMatrix().rows) if (row.state === "validated") capabilities.add(`${row.adapter}#${row.capability}`);
  const attackBlocks = new Set<string>();
  for (const [ref, block] of loadVendored().blocks) if (block.kind !== "section") attackBlocks.add(ref);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const categoriesDir = path.resolve(here, "..", "..", "..", "..", "vendor", "trailofbits-skills", "insecure-defaults", "categories");
  const categories = new Set(fs.existsSync(categoriesDir) ? fs.readdirSync(categoriesDir).filter((n) => n.endsWith(".md")).map((n) => n.replace(/\.md$/, "")) : []);
  const methods = new Map<string, Set<string>>([
    ["insecure-defaults", categories],
    ["differential-review", new Set()],
    ["variant-analysis", new Set()],
    ["cross-component", new Set()],
    ["supply-chain", new Set()],
  ]);
  return { rules, ruleRequirements, capabilities, attackBlocks, methods };
}

const words = (text: string): string[] => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);

/** Words in a row that make a string "a repeat" of a requirement text. */
export const REPEAT_RUN = 8;

/** Whether a string repeats the text of a requirement: a run of REPEAT_RUN consecutive words of it, or all of a short text. */
export function repeatsRequirementText(value: string, texts: readonly string[]): boolean {
  const own = words(value);
  if (own.length === 0) return false;
  const joined = ` ${own.join(" ")} `;
  for (const text of texts) {
    const theirs = words(text);
    if (theirs.length === 0) continue;
    const run = Math.min(REPEAT_RUN, theirs.length);
    for (let i = 0; i + run <= theirs.length; i++) if (joined.includes(` ${theirs.slice(i, i + run).join(" ")} `)) return true;
  }
  return false;
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

/** The problems of one check against the context; empty when the check is sound. */
export function checkProblems(check: MappingCheck, context: MappingContext, entrySubdimensions: readonly string[] = []): string[] {
  const out: string[] = [];
  if (!(MAPPING_UNITS as readonly string[]).includes(check.unit)) return [`unknown unit "${String(check.unit)}"`];
  if (check.unit === "semgrep-rule") {
    const sub = context.rules.get(check.id);
    if (sub === undefined) out.push(`unknown rule ${check.id}`);
    else if (!entrySubdimensions.includes(sub)) out.push(`rule ${check.id} declares the subdimension ${sub}, which the entry does not carry`);
  } else if (check.unit === "capability") {
    if (!context.capabilities.has(check.id)) out.push(`unknown capability ${check.id}: no validated matrix row`);
  } else if (check.unit === "semantic-ledger") {
    if (!context.attackBlocks.has(check.id)) out.push(`unknown attack class ${check.id}`);
  } else {
    const categories = context.methods.get(check.id);
    if (!categories) out.push(`unknown Semantic method ${check.id}`);
    else if (check.category !== undefined && !categories.has(check.category)) out.push(`method ${check.id} has no category ${check.category}`);
  }
  for (const field of ["covers", "misses"] as const) if (typeof check[field] !== "string" || check[field].trim() === "") out.push(`missing ${field}`);
  if (!(MAPPING_DEPTHS as readonly string[]).includes(check.depth)) out.push(`depth must be partial or full`);
  return out;
}

/**
 * The gates of the mapping against the official data and the context. Returns one line per problem, empty when the
 * mapping is sound: exactly one entry per requirement and no unknown one; the status agrees with the checks; every
 * check names something that exists; no string repeats a requirement's text; every pack rule is mapped (by any entry,
 * pending included) or listed in unmapped-rules.json with a reason, and the list names no rule twice or unknown.
 */
export function validateMapping(mapping: AsvsMapping, data: AsvsData, context: MappingContext): string[] {
  const problems: string[] = [];
  const known = new Map(data.requirements.map((r) => [r.id, r]));
  const seen = new Set<string>();
  for (const file of mapping.files) {
    if (file.version !== data.version) problems.push(`${file.file}: version ${String(file.version)} is not ${data.version}`);
    for (const entry of file.entries ?? []) {
      const where = `${file.file} ${String(entry.requirement)}`;
      const requirement = known.get(entry.requirement);
      if (!requirement) {
        problems.push(`${where}: unknown requirement`);
        continue;
      }
      if (requirement.chapter !== file.chapter) problems.push(`${where}: belongs to ${requirement.chapter}, not ${file.chapter}`);
      if (seen.has(entry.requirement)) problems.push(`${where}: more than one entry`);
      seen.add(entry.requirement);
      if (!(MAPPING_STATUSES as readonly string[]).includes(entry.status)) problems.push(`${where}: unknown status ${String(entry.status)}`);
      if (entry.status === "unmapped" && entry.checks.length > 0) problems.push(`${where}: unmapped but has checks`);
      if (entry.status !== "unmapped" && entry.checks.length === 0) problems.push(`${where}: ${String(entry.status)} without a check`);
      if (entry.checks.length > 0 && (typeof entry.why !== "string" || entry.why.trim() === "")) problems.push(`${where}: checks without a why`);
      for (const check of entry.checks) for (const p of checkProblems(check, context, entry.subdimensions ?? [])) problems.push(`${where}: ${p}`);
      for (const sub of entry.subdimensions ?? []) if (!(MAPPING_SUBDIMENSIONS as readonly string[]).includes(sub)) problems.push(`${where}: unknown subdimension ${sub}`);
    }
  }
  for (const id of known.keys()) if (!seen.has(id)) problems.push(`${id}: no entry`);

  const texts = data.requirements.map((r) => r.text);
  const own = [...mapping.entries.flatMap((e) => strings(e)), ...mapping.unmappedRules.rules.flatMap((r) => strings(r.reason))];
  for (const value of own) if (repeatsRequirementText(value, texts)) problems.push(`a mapping string repeats a requirement text: ${JSON.stringify(value.slice(0, 80))}`);

  const mapped = new Set(mapping.entries.flatMap((e) => e.checks.filter((c) => c.unit === "semgrep-rule").map((c) => c.id)));
  const listed = new Set<string>();
  const pairs = new Set<string>();
  for (const rule of mapping.unmappedRules.rules) {
    if (!context.rules.has(rule.id)) problems.push(`${UNMAPPED_RULES_FILE}: unknown rule ${rule.id}`);
    if (typeof rule.reason !== "string" || rule.reason.trim() === "") problems.push(`${UNMAPPED_RULES_FILE}: ${rule.id} has no reason`);
    if (rule.requirement !== undefined && !known.has(rule.requirement)) problems.push(`${UNMAPPED_RULES_FILE}: ${rule.id} names the unknown requirement ${rule.requirement}`);
    const pair = `${rule.id} ${rule.requirement ?? "*"}`;
    if (pairs.has(pair)) problems.push(`${UNMAPPED_RULES_FILE}: ${rule.id}${rule.requirement ? ` for ${rule.requirement}` : ""} listed twice`);
    pairs.add(pair);
    listed.add(rule.id);
  }
  for (const id of context.rules.keys()) if (!mapped.has(id) && !listed.has(id)) problems.push(`rule ${id} is neither mapped nor listed in ${UNMAPPED_RULES_FILE}`);
  return problems;
}

/**
 * The two-way gate between what a rule says it was written for (`asvs_requirements` in its metadata) and what the mapping
 * says. One line per problem, empty when both agree:
 *   - every requirement of a rule's `asvs_requirements` has an entry that names the rule, or the (rule, requirement) pair
 *     is listed in unmapped-rules.json (an entry there without a requirement refuses all of the rule's requirements);
 *   - every entry that names a rule names a requirement of that rule's `asvs_requirements`.
 * The mapping stays the only thing the map trusts; this only keeps the two statements from drifting apart.
 */
export function validateRuleRequirements(mapping: AsvsMapping, context: MappingContext): string[] {
  const problems: string[] = [];
  const named = new Map<string, Set<string>>();
  for (const entry of mapping.entries) {
    for (const check of entry.checks) {
      if (check.unit !== "semgrep-rule") continue;
      if (!named.has(check.id)) named.set(check.id, new Set());
      (named.get(check.id) as Set<string>).add(entry.requirement);
    }
  }
  const refused = (id: string, requirement: string): boolean => mapping.unmappedRules.rules.some((r) => r.id === id && (r.requirement === undefined || r.requirement === requirement));
  for (const [id, requirements] of context.ruleRequirements) {
    for (const requirement of requirements) {
      if (!(named.get(id)?.has(requirement) ?? false) && !refused(id, requirement)) problems.push(`rule ${id} was written for ${requirement}, which no entry maps to it and ${UNMAPPED_RULES_FILE} does not refuse`);
    }
  }
  for (const [id, requirements] of named) {
    if (!context.rules.has(id)) continue;
    const stated = new Set(context.ruleRequirements.get(id) ?? []);
    for (const requirement of requirements) if (!stated.has(requirement)) problems.push(`entry ${requirement} names rule ${id}, whose asvs_requirements do not include ${requirement}`);
  }
  return problems;
}
