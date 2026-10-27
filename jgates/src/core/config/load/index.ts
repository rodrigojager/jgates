import fs from "node:fs";
import path from "node:path";
import { translator } from "../../../i18n/index.js";
import { architectureReferenceProblems } from "../../architecture/references.js";
import { formatPath, hasSchema, suggestName, validateDocument } from "./schema.js";
import { parseYamlFile, type ParsedYaml } from "./yaml.js";
import {
  DEFAULT_LIMITS,
  FRAGMENT_FILES,
  type ConfigDiagnostic,
  type ConfigLoadResult,
  type DocumentKind,
  type LoadedDocument,
  type YamlLimits,
} from "./types.js";

export * from "./types.js";
export { parseYamlText, parseYamlFile } from "./yaml.js";
export { validateDocument, suggestName, configSchemaDir, hasSchema } from "./schema.js";

export const ROOT_FILE = "jgates.yml";
export const CONFIG_DIR = ".jgates";
/** Profiles that ship with JGates; the project may extend them. */
export const BUILTIN_PROFILES = ["builtin:minimal", "builtin:standard", "builtin:strict"] as const;

export interface LoadOptions {
  limits?: YamlLimits;
  /**
   * Folder to read jgates.yml and .jgates/ from instead of the project (a CI policy). When given, the project's own
   * configuration files are never read. Defaults to the project directory.
   */
  configDir?: string;
}

interface Pending {
  doc: LoadedDocument;
  parsed: ParsedYaml;
}

function rel(projectDir: string, absolute: string): string {
  return path.relative(projectDir, absolute).split(path.sep).join("/");
}

function isInside(parent: string, child: string): boolean {
  const r = path.relative(parent, child);
  return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
}

function fragmentKindOf(file: string): Exclude<DocumentKind, "root"> | undefined {
  const base = path.posix.basename(file);
  for (const [kind, name] of Object.entries(FRAGMENT_FILES)) if (name === base) return kind as Exclude<DocumentKind, "root">;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Loads jgates.yml and the fragments of a project, validating syntax, schema and references.
 * Fragments are the files listed in `extends` plus the default .jgates/*.yml files that exist.
 * With `options.configDir` the configuration comes from that folder only (paths in it are relative to it).
 * Never throws: every problem becomes a diagnostic with file and field path.
 */
export function loadProjectConfig(projectDir: string, options: LoadOptions = {}): ConfigLoadResult {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const t = translator("config");
  const projectRoot = path.resolve(projectDir);
  // Every configuration file, and every path a configuration file names, is relative to the configuration folder.
  const dir = options.configDir === undefined ? projectRoot : path.resolve(options.configDir);
  const diagnostics: ConfigDiagnostic[] = [];
  const pending: Pending[] = [];
  const loaded = new Set<string>();

  const add = (kind: DocumentKind, absolute: string, file: string): Pending => {
    loaded.add(absolute);
    const parsed = parseYamlFile(absolute, file, limits);
    diagnostics.push(...parsed.diagnostics);
    const entry: Pending = { doc: { kind, file, value: parsed.value, schemaPending: !hasSchema(kind) }, parsed };
    if (parsed.diagnostics.length === 0) {
      if (parsed.value === null || asRecord(parsed.value) === undefined) {
        diagnostics.push({ kind: "schema", code: "TYPE", file, path: "", pathSegments: [], message: t("config_document_not_mapping") });
      } else {
        diagnostics.push(...validateDocument(kind, parsed.value, file, { doc: parsed.doc, lineCounter: parsed.lineCounter }));
      }
    }
    pending.push(entry);
    return entry;
  };

  const rootAbsolute = path.join(dir, ROOT_FILE);
  let root: Pending | undefined;
  if (fs.existsSync(rootAbsolute)) root = add("root", rootAbsolute, ROOT_FILE);
  else {
    diagnostics.push({ kind: "reference", code: "ROOT_MISSING", file: ROOT_FILE, path: "", pathSegments: [], message: t("config_root_missing") });
  }

  // Fragments named in extends, in the declared order.
  const rootValue = asRecord(root?.doc.value);
  const extendsList = Array.isArray(rootValue?.extends) ? (rootValue?.extends as unknown[]) : [];
  extendsList.forEach((entry, index) => {
    if (typeof entry !== "string" || entry === "") return;
    const segments = ["extends", String(index)];
    const where = { file: ROOT_FILE, path: formatPath(segments), pathSegments: segments };
    const absolute = path.resolve(dir, entry);
    if (path.isAbsolute(entry) || !isInside(dir, absolute)) {
      diagnostics.push({ kind: "reference", code: "REF_OUTSIDE_PROJECT", ...where, message: t("config_ref_outside_project", { ref: entry }) });
      return;
    }
    let real: string;
    try {
      real = fs.realpathSync(absolute);
    } catch {
      diagnostics.push({ kind: "reference", code: "REF_MISSING_FILE", ...where, message: t("config_ref_missing_file", { ref: entry }) });
      return;
    }
    if (!isInside(fs.realpathSync(dir), real) || !fs.statSync(real).isFile()) {
      diagnostics.push({ kind: "reference", code: "REF_OUTSIDE_PROJECT", ...where, message: t("config_ref_outside_project", { ref: entry }) });
      return;
    }
    const kind = fragmentKindOf(entry);
    if (!kind) {
      diagnostics.push({ kind: "reference", code: "UNKNOWN_FRAGMENT", ...where, message: t("config_unknown_fragment", { ref: entry }) });
      return;
    }
    if (!loaded.has(absolute)) add(kind, absolute, rel(dir, absolute));
  });

  // Default fragments that exist but are not listed.
  for (const [kind, name] of Object.entries(FRAGMENT_FILES)) {
    const absolute = path.join(dir, CONFIG_DIR, name);
    if (!loaded.has(absolute) && fs.existsSync(absolute) && fs.statSync(absolute).isFile()) add(kind as DocumentKind, absolute, rel(dir, absolute));
  }

  const documents = pending.map((p) => p.doc);
  checkReferences(documents, dir, diagnostics, t);

  const byKind: Partial<Record<DocumentKind, LoadedDocument>> = {};
  for (const d of documents) byKind[d.kind] ??= d;
  return { projectDir: projectRoot, configDir: dir, valid: diagnostics.length === 0, documents, byKind, diagnostics };
}

type T = ReturnType<typeof translator>;

function checkReferences(documents: LoadedDocument[], dir: string, diagnostics: ConfigDiagnostic[], t: T): void {
  const ref = (file: string, segments: string[], code: string, message: string, suggestion?: string): void => {
    diagnostics.push({ kind: "reference", code, file, path: formatPath(segments), pathSegments: segments, message, ...(suggestion ? { suggestion } : {}) });
  };
  const all = (kind: DocumentKind): Array<{ file: string; value: Record<string, unknown> }> =>
    documents.flatMap((d) => {
      const value = asRecord(d.value);
      return d.kind === kind && value ? [{ file: d.file, value }] : [];
    });

  // Profiles known to the project, plus the starter ones.
  const profileIds = new Set<string>(BUILTIN_PROFILES);
  for (const { value } of all("profiles")) for (const id of Object.keys(asRecord(value.profiles) ?? {})) profileIds.add(id);
  const checkProfile = (file: string, segments: string[], id: unknown): void => {
    if (typeof id !== "string" || id === "" || profileIds.has(id)) return;
    ref(file, segments, "REF_PROFILE_UNKNOWN", t("config_ref_profile_unknown", { id }), suggestName(id, [...profileIds]));
  };

  for (const { file, value } of all("root")) {
    checkProfile(file, ["selection", "profile"], asRecord(value.selection)?.profile);
    const seen = new Set<string>();
    const templates = Array.isArray(value.templates) ? value.templates : [];
    templates.forEach((entry, index) => {
      const tpl = asRecord(entry);
      if (!tpl) return;
      if (typeof tpl.id === "string") {
        if (seen.has(tpl.id)) ref(file, ["templates", String(index), "id"], "REF_DUPLICATE_ID", t("config_ref_duplicate_id", { id: tpl.id }));
        seen.add(tpl.id);
      }
      const source = tpl.source;
      if (typeof source === "string" && source !== "" && !source.startsWith("builtin:")) {
        const absolute = path.resolve(dir, source);
        if (path.isAbsolute(source) || !isInside(dir, absolute)) {
          ref(file, ["templates", String(index), "source"], "REF_OUTSIDE_PROJECT", t("config_ref_outside_project", { ref: source }));
        } else if (!fs.existsSync(absolute)) {
          ref(file, ["templates", String(index), "source"], "REF_MISSING_FILE", t("config_ref_missing_file", { ref: source }));
        }
      }
    });
  }

  for (const { file, value } of all("profiles")) {
    for (const [id, profile] of Object.entries(asRecord(value.profiles) ?? {})) {
      checkProfile(file, ["profiles", id, "extends"], asRecord(profile)?.extends);
    }
  }

  for (const { file, value } of all("architecture")) {
    for (const problem of architectureReferenceProblems(value)) {
      ref(file, problem.segments, problem.code, t(problem.messageKey, problem.params), problem.suggestion);
    }
  }

  // Components named by tools and bindings must exist when the workspace lists components.
  const componentIds = new Set<string>();
  let componentsDeclared = false;
  for (const { file, value } of all("workspace")) {
    if (!Array.isArray(value.components)) continue;
    componentsDeclared = true;
    const seen = new Set<string>();
    value.components.forEach((entry, index) => {
      const id = asRecord(entry)?.id;
      if (typeof id !== "string") return;
      if (seen.has(id)) ref(file, ["components", String(index), "id"], "REF_DUPLICATE_ID", t("config_ref_duplicate_id", { id }));
      seen.add(id);
      componentIds.add(id);
    });
  }
  const toolIds = new Set<string>();
  for (const { value } of all("tools")) for (const id of Object.keys(asRecord(value.tools) ?? {})) toolIds.add(id);
  for (const { file, value } of all("tools")) {
    const checkComponent = (segments: string[], id: unknown): void => {
      if (!componentsDeclared || typeof id !== "string" || componentIds.has(id)) return;
      ref(file, segments, "REF_COMPONENT_UNKNOWN", t("config_ref_component_unknown", { id }), suggestName(id, [...componentIds]));
    };
    for (const [id, tool] of Object.entries(asRecord(value.tools) ?? {})) checkComponent(["tools", id, "component"], asRecord(tool)?.component);
    (Array.isArray(value.bindings) ? value.bindings : []).forEach((entry, index) => {
      const binding = asRecord(entry);
      if (!binding) return;
      checkComponent(["bindings", String(index), "component"], binding.component);
      if (typeof binding.tool === "string" && !toolIds.has(binding.tool)) {
        ref(file, ["bindings", String(index), "tool"], "REF_TOOL_UNKNOWN", t("config_ref_tool_unknown", { id: binding.tool }), suggestName(binding.tool, [...toolIds]));
      }
    });
  }
}
