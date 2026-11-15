// Index of the rules of the bundled JGates Semgrep pack, read from the rule files themselves (there is no second
// list to keep in step). JavaScript and Python keep their files directly in `rules/`; every other language has its
// own folder `rules/<language>/`. The plan, the ASVS map and the pack tests read the pack through this module.
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * The closed lists of the pack (languages with their prefixes, categories, subdimensions, severities, signal tags, the
 * metadata keys a rule may carry). They live in `pack-lists.json`, a plain file a Node script can read without a build:
 * the `pack:check` command and the tests read the same file.
 */
export interface PackLists {
  languages: Record<string, string>;
  categories: string[];
  subdimensions: string[];
  severities: string[];
  signalTags: string[];
  forbiddenMetadata: string[];
  ruleMetadata: string[];
  signalMetadata: string[];
}

export const PACK_LISTS: Readonly<PackLists> = JSON.parse(fs.readFileSync(new URL("./pack-lists.json", import.meta.url), "utf8")) as PackLists;

/** The language of a pack file and the id prefix its rules carry: `jgates.<prefix>.<name>`. */
export const PACK_LANGUAGE_PREFIX: Readonly<Record<string, string>> = PACK_LISTS.languages;

export interface PackRule {
  id: string;
  /** The pack language the file belongs to (`javascript` also serves TypeScript). */
  language: string;
  /** The Semgrep `languages` of the rule. */
  languages: string[];
  category: string;
  cwe: string;
  subdimension: string;
  author: string;
  severity: string;
  /** The rule file, relative to the rules folder, with forward slashes. */
  file: string;
  /** The annotated fixture beside the rule file (same stem, not YAML), relative to the rules folder; null when missing. */
  fixture: string | null;
  /** Every metadata key of the rule, for the checks that refuse unwanted ones. */
  metadataKeys: string[];
  /** The family name: the id without `jgates.<prefix>.`, the same in every language that has the family. */
  family: string;
  /** The ASVS requirement ids the rule was written for (a statement of intent, not a mapping); empty when it has none. */
  asvsRequirements: string[];
  /** The tag of a signal rule (a record of the scan, never a finding); null for a check. */
  signal: string | null;
}

/** A (language, tag) pair some signal rule of the pack records. */
export interface PackSignal {
  language: string;
  tag: string;
}

export interface PackIndex {
  rules: PackRule[];
  /** The (language, tag) pairs that have a signal rule. */
  signals: PackSignal[];
  /** Rule files that could not be read or parsed, and rules without an id. */
  problems: Array<{ file: string; message: string }>;
}

/** Every `.yaml` rule file under the folder, recursing into `<language>/`; relative paths, sorted, forward slashes. */
export function listPackRuleFiles(rulesDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith(".yaml")) out.push(path.relative(rulesDir, abs).split(path.sep).join("/"));
    }
  };
  if (fs.existsSync(rulesDir)) walk(rulesDir);
  return out.sort();
}

/** The pack language of a rule file: its folder when nested, else the first word of the file name. */
export function packLanguageOf(file: string): string {
  const parts = file.split("/");
  return parts.length > 1 ? (parts[0] as string) : ((parts[0] as string).split("-")[0] as string);
}

/** The fixture beside a rule file: the same stem with any other extension. */
export function packFixtureOf(rulesDir: string, file: string): string | null {
  const dir = path.dirname(file);
  const stem = path.basename(file).replace(/\.yaml$/, "");
  const beside = fs.readdirSync(path.join(rulesDir, dir)).find((n) => n.startsWith(`${stem}.`) && !n.endsWith(".yaml"));
  return beside ? (dir === "." ? beside : `${dir}/${beside}`) : null;
}

const text = (value: unknown): string => (typeof value === "string" ? value : value === undefined || value === null ? "" : String(value));

/** Reads the pack index from the rule files of a rules folder. */
export function buildPackIndex(rulesDir: string): PackIndex {
  const rules: PackRule[] = [];
  const problems: PackIndex["problems"] = [];
  for (const file of listPackRuleFiles(rulesDir)) {
    let doc: unknown;
    try {
      doc = parseYaml(fs.readFileSync(path.join(rulesDir, file), "utf8"));
    } catch (error) {
      problems.push({ file, message: (error as Error).message });
      continue;
    }
    const list = (doc as { rules?: unknown } | null)?.rules;
    if (!Array.isArray(list)) {
      problems.push({ file, message: "no rules list" });
      continue;
    }
    const fixture = packFixtureOf(rulesDir, file);
    for (const raw of list as Array<Record<string, unknown>>) {
      const meta = (raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {}) as Record<string, unknown>;
      if (typeof raw.id !== "string" || raw.id === "") {
        problems.push({ file, message: "a rule without an id" });
        continue;
      }
      rules.push({
        id: raw.id,
        language: packLanguageOf(file),
        languages: Array.isArray(raw.languages) ? raw.languages.map(String) : [],
        category: text(meta.category),
        cwe: text(meta.cwe),
        subdimension: text(meta.subdimension),
        author: text(meta.author),
        severity: text(raw.severity),
        file,
        fixture,
        metadataKeys: Object.keys(meta).sort(),
        family: raw.id.replace(/^jgates\.[^.]+\./, ""),
        asvsRequirements: Array.isArray(meta.asvs_requirements) ? meta.asvs_requirements.map(String) : [],
        signal: typeof meta.signal === "string" && meta.signal !== "" ? meta.signal : null,
      });
    }
  }
  const signals: PackSignal[] = [];
  for (const rule of rules) {
    if (rule.signal !== null && !signals.some((s) => s.language === rule.language && s.tag === rule.signal)) signals.push({ language: rule.language, tag: rule.signal });
  }
  return { rules, signals, problems };
}

/** The index of a bundled pack folder (`<pack>/rules`). */
export const packRuleIndex = buildPackIndex;
