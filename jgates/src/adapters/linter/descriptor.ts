// The linter descriptors: one folder per tool under src/builtin/linters/<id>/ (linter.json, validated by
// schemas/catalog/linter.schema.json, plus the tool's default configuration when it needs one). The folder is scanned
// like the templates folder; there is no list to edit. A broken descriptor is a defect of JGates itself: the scan
// throws a LinterDescriptorError naming the file, never skips it (a tool cannot be half-added).
//
// JGATES_LINTERS_EXTRA_DIR names one more folder of descriptors (the engine's own tests use it for invented tools; a
// developer uses it to try a descriptor before it is added). It is read when the descriptors are first asked for.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import { CORE_CAPABILITIES } from "../../core/catalog/index.js";

export type LinterSection = "language" | "format" | "tooling" | "other";
export type LinterReader = "sarif" | "checkstyle" | "junit" | "json" | "lines" | "files" | "status" | "custom";
export type LinterLevel = "error" | "warning" | "info";

export interface LinterTexts {
  label: string;
  purpose: string;
  limitation: string;
  needs: string;
}

export interface LinterDescriptor {
  schemaVersion: 1;
  id: string;
  name: string;
  sourceUrl: string;
  license: string;
  program: { tool: string; command?: string; prefix?: string[]; versionRange: string };
  megalinter: string[];
  place: { section: LinterSection; group: string; capability: string; kind: "lint" | "format" | "scan" | "sbom"; tier: "main" | "extended" };
  activation: {
    extensions?: string[];
    names?: string[];
    content?: { pattern: string; firstLine?: boolean; names?: string[] };
    requires?: string[];
    project?: true;
  };
  run: {
    mode: "files" | "each-file" | "project";
    args: string[];
    env?: Record<string, string>;
    exit: { clean: number[]; findings: number[] };
    needsDependencies?: boolean;
    executesProjectCode: boolean;
    network: boolean;
    readOnly: boolean;
    workspaceWrites?: string[];
    timeoutSeconds?: number;
    resources?: { memoryMb?: number; cpus?: number; tmpfsMb?: number };
  };
  output: {
    from: "stdout" | "stderr" | "file";
    file?: string;
    reader: LinterReader;
    pattern?: string;
    jsonLines?: boolean;
    items?: string;
    fields?: { file: string; line?: string; column?: string; rule?: string; level?: string; message: string };
    rule?: string;
    level?: LinterLevel;
    locationOptional?: boolean;
  };
  severity?: Record<string, LinterLevel>;
  configuration: { files: string[]; default: string; args?: string[]; ci?: { args?: string[] } };
  governed: {
    treatment: "trusted" | "self-reported" | "excluded";
    config: string;
    suppressions: { honoured: boolean; description: string; pattern?: string; files?: string };
  };
  install: string;
  text: { en: LinterTexts; "pt-BR": LinterTexts };
}

/** A descriptor with where it was found. */
export interface LoadedLinter {
  descriptor: LinterDescriptor;
  /** The descriptor's folder (absolute): its default configuration lives there. */
  dir: string;
  /** builtin:linters/<id>/linter.json, or the extra folder's path. */
  file: string;
}

export class LinterDescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinterDescriptorError";
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** src/builtin/linters (dist/builtin/linters once built). */
export function builtinLintersDir(): string {
  return path.resolve(here, "..", "..", "builtin", "linters");
}

/** jgates/schemas/catalog/linter.schema.json, found from dist/adapters/linter. */
export function linterSchemaFile(): string {
  return path.resolve(here, "..", "..", "..", "schemas", "catalog", "linter.schema.json");
}

/** The folder of the custom readers (readers/<id>.js), next to this module. */
export function customReadersDir(): string {
  return path.join(here, "readers");
}

/** The engine's own token for a custom reader file. */
export const CUSTOM_READER_EXT = path.extname(fileURLToPath(import.meta.url)) || ".js";

type Validate = ((data: unknown) => boolean) & { errors?: Array<{ instancePath: string; message?: string }> | null };
type AjvCtor = new (opts: object) => { compile(schema: object): Validate };
const Ajv = ((Ajv2020Module as unknown as { default?: AjvCtor }).default ?? (Ajv2020Module as unknown as AjvCtor)) as AjvCtor;
let validator: Validate | null = null;

function validate(doc: unknown): string[] {
  if (!validator) {
    const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false, removeAdditional: false, coerceTypes: false, useDefaults: false });
    validator = ajv.compile(JSON.parse(fs.readFileSync(linterSchemaFile(), "utf8")) as object);
  }
  if (validator(doc)) return [];
  return (validator.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
}

function compiles(pattern: string, flags = ""): string | null {
  try {
    new RegExp(pattern, flags);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** The checks the schema cannot make: the id is the folder, the patterns compile, the tokens fit the mode, the files exist. */
function semanticProblems(d: LinterDescriptor, dir: string, folderName: string, customDir: string): string[] {
  const problems: string[] = [];
  if (d.id !== folderName) problems.push(`id must be "${folderName}" (the folder name)`);
  const patterns: Array<[string, string | undefined]> = [
    ["output.pattern", d.output.pattern],
    ["activation.content.pattern", d.activation.content?.pattern],
    ["governed.suppressions.pattern", d.governed.suppressions.pattern],
    ["governed.suppressions.files", d.governed.suppressions.files],
  ];
  for (const [where, pattern] of patterns) {
    if (pattern === undefined) continue;
    const bad = compiles(pattern, "m");
    if (bad) problems.push(`${where} does not compile: ${bad}`);
  }
  if (d.output.reader === "lines" && d.output.pattern && !/\(\?<file>/.test(d.output.pattern)) problems.push("output.pattern needs a named group file");
  if (d.output.reader === "lines" && d.output.pattern && !/\(\?<rule>/.test(d.output.pattern) && !d.output.rule) problems.push("output.pattern has no group rule and output.rule is not set");
  if (d.output.reader === "lines" && d.output.pattern && !/\(\?<message>/.test(d.output.pattern)) problems.push("output.pattern needs a named group message");
  const args = d.run.args.join("\u0000");
  if (d.run.mode !== "files" && args.includes("{files}")) problems.push("{files} is only for the files mode");
  if (d.run.mode !== "each-file" && args.includes("{file}")) problems.push("{file} is only for the each-file mode");
  if (d.output.from === "file" && !args.includes("{report}")) problems.push("output.from file needs the {report} token in run.args");
  if (d.output.from !== "file" && args.includes("{report}")) problems.push("{report} is only for output.from file");
  if (d.run.mode === "each-file" && d.output.from === "file") problems.push("each-file mode reads stdout or stderr");
  const capability = CORE_CAPABILITIES.find((c) => c.id === d.place.capability);
  if (!capability) problems.push(`place.capability ${d.place.capability} is not a capability of the catalogue`);
  if (d.configuration.default !== "tool") {
    if (!fs.existsSync(path.join(dir, d.configuration.default))) problems.push(`configuration.default names ${d.configuration.default}, which is not in the descriptor folder`);
    if (!(d.configuration.args ?? []).join("\u0000").includes("{config}")) problems.push("a default configuration needs configuration.args with the {config} token");
  } else if ((d.configuration.args ?? []).length > 0) problems.push("configuration.args are only for a default configuration file");
  if (d.output.reader === "custom" && !fs.existsSync(path.join(customDir, `${d.id}${CUSTOM_READER_EXT}`))) problems.push(`output.reader custom needs readers/${d.id}${CUSTOM_READER_EXT} in the engine`);
  if (d.governed.suppressions.honoured && !d.governed.suppressions.pattern) problems.push("governed.suppressions.honoured needs the pattern that finds them");
  for (const lang of ["en", "pt-BR"] as const) for (const [key, value] of Object.entries(d.text[lang])) if (value.trim() === "") problems.push(`text.${lang}.${key} is empty`);
  return problems;
}

function loadFolder(root: string, label: (id: string) => string): LoadedLinter[] {
  if (!fs.existsSync(root)) return [];
  const out: LoadedLinter[] = [];
  const names = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const name of names) {
    const dir = path.join(root, name);
    const file = label(name);
    const abs = path.join(dir, "linter.json");
    if (!fs.existsSync(abs)) throw new LinterDescriptorError(`${file}: the folder has no linter.json`);
    let doc: unknown;
    try {
      doc = JSON.parse(fs.readFileSync(abs, "utf8"));
    } catch (error) {
      throw new LinterDescriptorError(`${file}: ${(error as Error).message}`);
    }
    const schemaProblems = validate(doc);
    if (schemaProblems.length > 0) throw new LinterDescriptorError(`${file}: ${schemaProblems.join("; ")}`);
    const descriptor = doc as LinterDescriptor;
    const problems = semanticProblems(descriptor, dir, name, customReadersDir());
    if (problems.length > 0) throw new LinterDescriptorError(`${file}: ${problems.join("; ")}`);
    out.push({ descriptor, dir, file });
  }
  return out;
}

let cache: { key: string; linters: LoadedLinter[] } | null = null;

/** Every descriptor: the built-in folder, then the extra folder of JGATES_LINTERS_EXTRA_DIR. Ids are unique. */
export function loadLinters(env: NodeJS.ProcessEnv = process.env): LoadedLinter[] {
  const extra = env.JGATES_LINTERS_EXTRA_DIR?.trim() ? path.resolve(env.JGATES_LINTERS_EXTRA_DIR.trim()) : "";
  const key = `${builtinLintersDir()}\u0000${extra}`;
  if (cache?.key === key) return cache.linters;
  const linters = [...loadFolder(builtinLintersDir(), (id) => `builtin:linters/${id}/linter.json`), ...(extra ? loadFolder(extra, (id) => path.join(extra, id, "linter.json")) : [])];
  const seen = new Set<string>();
  for (const l of linters) {
    if (seen.has(l.descriptor.id)) throw new LinterDescriptorError(`${l.file}: the id ${l.descriptor.id} is used by another descriptor`);
    seen.add(l.descriptor.id);
  }
  cache = { key, linters };
  return linters;
}

export function linterById(id: string, env: NodeJS.ProcessEnv = process.env): LoadedLinter | undefined {
  return loadLinters(env).find((l) => l.descriptor.id === id);
}

/** The descriptor's texts in a locale (pt-BR, else English). */
export function linterTexts(d: LinterDescriptor, locale: string): LinterTexts {
  return locale.toLowerCase().startsWith("pt") ? d.text["pt-BR"] : d.text.en;
}

/** The variable that names another executable for the tool, inside the tools image only (JGATES_LINTER_<ID>). */
export function linterOverrideEnv(id: string): string {
  return `JGATES_LINTER_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/** The group key of a descriptor (section/group) and the id of its derived template. */
export function linterGroupKey(d: LinterDescriptor): string {
  return `${d.place.section}/${d.place.group}`;
}

export function linterTemplateId(d: LinterDescriptor): string {
  return `${d.place.section === "other" ? "scan" : "lint"}-${d.place.group}`;
}

/** The catalogue category of the descriptor's capability (quality, security...). */
export function linterCategory(d: LinterDescriptor): string {
  return CORE_CAPABILITIES.find((c) => c.id === d.place.capability)?.category ?? "quality";
}
