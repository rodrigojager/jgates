// Local Semgrep rules: what the binding of an instance points to (a rule file or a directory of rule files), the
// syntax and contract check of each file, and renaming a file with its controlled references. Reading never
// creates or changes anything; creating and editing a rule go through the document service.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadProjectConfig } from "../config/load/index.js";
import { patchYamlFile, type YamlEdit } from "../codecs/yaml/index.js";
import { DocumentError, renameEntry } from "../documents/index.js";
import { resolveToolBindings, type ResolvedBinding } from "../tools/index.js";
import { validateRuleText, type RuleFileValidation, type RuleIssue } from "./validate.js";

export { validateRuleText, SEVERITIES, type RuleFileValidation, type RuleIssue, type RuleSummary } from "./validate.js";

/** The binding that holds the rules of a Semgrep instance. */
export const RULES_BINDING = "config";
const MAX_RULE_BYTES = 2 * 1024 * 1024;
const slash = (p: string): string => p.split(path.sep).join("/");

export interface RuleFile {
  /** Entry of a directory binding (path inside the directory); null for a single-file binding. */
  entry: string | null;
  /** Workspace-relative path, or null when the file lives under an external root. */
  path: string | null;
  abs: string;
  /** "sha256:<hex>" of the bytes (what the plan hashes); null when unreadable. */
  sha256: string | null;
  /** Revision for the document API (hex sha256 of the bytes); null when unreadable. */
  revision: string | null;
  size: number | null;
  validation: RuleFileValidation;
}

export interface RuleDuplicate {
  id: string;
  files: string[];
}

export interface RuleSource {
  instance: string;
  adapter: string;
  binding: string | null;
  kind: "file" | "directory" | null;
  relPath: string | null;
  access: "read" | "write" | null;
  include: string[] | null;
  exists: boolean;
  files: RuleFile[];
  duplicates: RuleDuplicate[];
  /** Why the instance has no usable local rules (no binding, refused, missing, empty), or null. */
  problem: { code: "NO_BINDING" | "BINDING_REFUSED" | "BINDING_MISSING" | "NO_RULE_FILES"; message: string } | null;
  /** Every file valid and no duplicated id: safe to run. */
  valid: boolean;
}

function unreadable(message: string): RuleFileValidation {
  return { status: "invalid", issues: [{ kind: "syntax", code: "UNREADABLE", message, line: null, column: null }], rules: [] };
}

function readRuleFile(entry: string | null, abs: string, workspaceReal: string): RuleFile {
  const rel = path.relative(workspaceReal, abs);
  const relPath = rel === "" || rel.startsWith("..") || path.isAbsolute(rel) ? null : slash(rel);
  try {
    const st = fs.statSync(abs);
    if (st.size > MAX_RULE_BYTES) return { entry, path: relPath, abs, sha256: null, revision: null, size: st.size, validation: unreadable("arquivo grande demais para validar") };
    const bytes = fs.readFileSync(abs);
    const hex = crypto.createHash("sha256").update(bytes).digest("hex");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { entry, path: relPath, abs, sha256: `sha256:${hex}`, revision: hex, size: st.size, validation: unreadable("o arquivo não é texto UTF-8") };
    }
    return { entry, path: relPath, abs, sha256: `sha256:${hex}`, revision: hex, size: st.size, validation: validateRuleText(text.replace(/^﻿/, "")) };
  } catch (error) {
    return { entry, path: relPath, abs, sha256: null, revision: null, size: null, validation: unreadable((error as Error).message) };
  }
}

/** Reads the rules an instance is bound to and validates every file. Never writes. */
export function collectRuleSource(dir: string, instanceId: string, bindingId: string = RULES_BINDING): RuleSource {
  const resolved = resolveToolBindings(dir, { skipInventory: true });
  const instance = resolved.instances.find((i) => i.id === instanceId);
  const empty: RuleSource = {
    instance: instanceId,
    adapter: instance?.adapter ?? "",
    binding: null,
    kind: null,
    relPath: null,
    access: null,
    include: null,
    exists: false,
    files: [],
    duplicates: [],
    problem: null,
    valid: false,
  };
  const binding: ResolvedBinding | undefined = instance?.bindings.find((b) => b.id === bindingId);
  if (!instance || !binding) return { ...empty, problem: { code: "NO_BINDING", message: `A instância ${instanceId} não tem o binding ${bindingId} com as regras locais.` } };
  const base: RuleSource = { ...empty, binding: binding.id, kind: binding.kind, relPath: binding.relPath, access: binding.access, include: binding.include, exists: binding.exists };
  if (binding.refused || binding.identity === null) return { ...base, problem: { code: "BINDING_REFUSED", message: `O binding ${binding.id} foi recusado (${binding.declared}).` } };
  if (!binding.exists) return { ...base, problem: { code: "BINDING_MISSING", message: `${binding.relPath ?? binding.declared} não existe.` } };
  let workspaceReal = resolved.projectDir;
  try {
    workspaceReal = fs.realpathSync.native(resolved.projectDir);
  } catch {
    // keep the lexical root
  }
  const files =
    binding.kind === "directory"
      ? binding.files
          .filter((f) => /\.ya?ml$/i.test(f.path))
          .map((f) => readRuleFile(f.path, f.identity, workspaceReal))
      : [readRuleFile(null, binding.identity, workspaceReal)];
  const byId = new Map<string, string[]>();
  for (const f of files) for (const r of f.validation.rules) byId.set(r.id, [...(byId.get(r.id) ?? []), f.entry ?? f.path ?? f.abs]);
  const duplicates = [...byId.entries()].filter(([, where]) => new Set(where).size > 1).map(([id, where]) => ({ id, files: [...new Set(where)] }));
  const problem = files.length === 0 ? ({ code: "NO_RULE_FILES", message: `${binding.relPath ?? binding.declared} não tem arquivos de regras (.yml ou .yaml).` } as const) : null;
  const valid = problem === null && files.every((f) => f.validation.status === "valid") && duplicates.length === 0;
  return { ...base, files, duplicates, problem, valid };
}

/** Rule files of a source filtered by a text found in the file name, an id or a message of the rules. */
export function searchRuleFiles(source: RuleSource, query: string, readText: (file: RuleFile) => string | null = (f) => safeRead(f.abs)): RuleFile[] {
  const q = query.trim().toLowerCase();
  if (q === "") return source.files;
  return source.files.filter((f) => (f.entry ?? f.path ?? "").toLowerCase().includes(q) || f.validation.rules.some((r) => r.id.toLowerCase().includes(q)) || (readText(f) ?? "").toLowerCase().includes(q));
}

function safeRead(abs: string): string | null {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/** Issues of a source as one flat list (file first), for messages and blockers. */
export function issuesOf(source: RuleSource): Array<RuleIssue & { file: string }> {
  const out: Array<RuleIssue & { file: string }> = [];
  for (const f of source.files) for (const i of f.validation.issues) out.push({ ...i, file: f.entry ?? f.path ?? f.abs });
  for (const d of source.duplicates) out.push({ kind: "contract", code: "RULE_ID_DUPLICATE", message: `O id ${d.id} aparece em mais de um arquivo (${d.files.join(", ")}).`, line: null, column: null, ruleId: d.id, file: d.files[0] ?? "" });
  return out;
}

export interface Reference {
  file: string;
  line: number;
  text: string;
}

export interface RenameRuleResult {
  status: "renamed" | "conflict";
  from: string;
  to: string;
  revision?: string;
  /** References in the configuration files that were rewritten. */
  updated: Reference[];
  /** References that still name the old file and must be changed by hand. */
  pending: Reference[];
  current?: { revision: string | null; exists: boolean };
}

function isYamlName(name: string): boolean {
  return /\.ya?ml$/i.test(name);
}

/**
 * Renames a rule file of a directory binding (never overwrites), then fixes the references JGates controls (the
 * include list of the binding) and reports every other mention of the old name in the configuration files.
 */
export function renameRuleFile(dir: string, instanceId: string, request: { from: string; to: string; expectedRevision: string; binding?: string }): RenameRuleResult {
  const bindingId = request.binding ?? RULES_BINDING;
  if (!isYamlName(request.to)) throw new DocumentError("ENTRY_NOT_ALLOWED", `O arquivo de regras precisa terminar em .yml ou .yaml (${request.to}).`, "Use um nome como minha-regra.yml.");
  const before = resolveToolBindings(dir, { skipInventory: true });
  const binding = before.instances.find((i) => i.id === instanceId)?.bindings.find((b) => b.id === bindingId);
  const oldRel = binding?.relPath ? `${binding.relPath}/${request.from}` : null;
  const moved = renameEntry(dir, instanceId, bindingId, { from: request.from, to: request.to, expectedRevision: request.expectedRevision });
  if (moved.status === "conflict") return { status: "conflict", from: request.from, to: request.to, updated: [], pending: [], current: moved.current };

  const updated: Reference[] = [];
  const loaded = loadProjectConfig(dir);
  const tools = loaded.byKind.tools;
  // 1. The include list of the binding: an entry that names the old file exactly follows the rename.
  if (tools && typeof tools.value === "object" && tools.value !== null) {
    const entryOf = (tools.value as { tools?: Record<string, { config?: { include?: unknown } }> }).tools?.[instanceId]?.config;
    const include = entryOf && typeof entryOf === "object" && Array.isArray(entryOf.include) ? entryOf.include : [];
    const edits: YamlEdit[] = [];
    include.forEach((p, index) => {
      if (p === request.from || p === oldRel) edits.push({ op: "set", path: ["tools", instanceId, "config", "include", index], value: p === request.from ? request.to : `${binding?.relPath}/${request.to}` });
    });
    if (edits.length > 0) {
      const abs = path.resolve(dir, tools.file);
      patchYamlFile(abs, edits);
      for (const e of edits) updated.push({ file: slash(path.relative(dir, abs)), line: 0, text: `include: ${String(include[e.path[4] as number])} -> ${String(e.value)}` });
    }
  }
  // 2. Anything else that still names the old file.
  const pending: Reference[] = [];
  const escape = (n: string): string => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const needles = [request.from, ...(oldRel ? [oldRel] : [])].map((n) => new RegExp(`(?<![\\w./-])${escape(n)}(?![\\w-])`));
  const seen = new Set<string>();
  for (const doc of loadProjectConfig(dir).documents) {
    const abs = path.resolve(dir, doc.file);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const text = safeRead(abs);
    if (text === null) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      if (needles.some((n) => n.test(line))) pending.push({ file: slash(path.relative(dir, abs)), line: index + 1, text: line.trim() });
    });
  }
  // A renamed file the binding no longer lists (include does not match the new name) would silently stop running.
  const after = resolveToolBindings(dir, { skipInventory: true }).instances.find((i) => i.id === instanceId)?.bindings.find((b) => b.id === bindingId);
  if (after && after.kind === "directory" && !after.files.some((f) => f.path === request.to)) {
    pending.push({ file: tools ? slash(path.relative(dir, path.resolve(dir, tools.file))) : ".jgates/tools.yml", line: 0, text: `include não lista ${request.to}: o arquivo deixou de rodar até o include ser ajustado` });
  }
  return { status: "renamed", from: request.from, to: request.to, revision: moved.revision, updated, pending };
}
