import fs from "node:fs";
import path from "node:path";
import { canonicalPath } from "../ids/index.js";
import { loadProjectConfig, type ConfigDiagnostic } from "../config/load/index.js";
import { discoverWorkspace } from "../discovery/index.js";
import { matchesExactly } from "../discovery/glob.js";
import type { AdapterManifest } from "../catalog/index.js";
import { builtinManifests } from "../../adapters/manifests.js";

export type BindingRole = "primary" | "support" | "rules" | "ignore";
export type SupportLevel = "editable-file" | "assisted" | "full" | "unavailable" | "incompatible";

export interface BindingFile {
  /** Path relative to the binding root, forward slashes. */
  path: string;
  /** Canonical real path (identity of the physical document). */
  identity: string;
}

export interface ResolvedBinding {
  id: string;
  role: BindingRole;
  /** "write" unless the binding declares access: read (then JGates only reads the file). */
  access: "read" | "write";
  section: string | null;
  origin: string | null;
  kind: "file" | "directory";
  /** Path as written in tools.yml. */
  declared: string;
  /** "workspace" or the id of the declared external root. */
  root: string;
  /** Workspace-relative path with forward slashes, or null when the target is outside the workspace (external root). */
  relPath: string | null;
  absPath: string;
  exists: boolean;
  /** Canonical real path of the physical document (of the directory for kind directory); null when refused. */
  identity: string | null;
  include: string[] | null;
  /** Files of a directory binding that match include (all files when include is absent). */
  files: BindingFile[];
  refused: boolean;
}

export interface ToolInstance {
  id: string;
  adapter: string;
  component: string | null;
  componentRoot: string | null;
  enabled: boolean;
  required: boolean;
  runner: string;
  base: string | null;
  supportLevel: SupportLevel;
  bindings: ResolvedBinding[];
}

export interface ToolDocument {
  /** Canonical real path. */
  identity: string;
  kind: "file" | "directory";
  exists: boolean;
  /** Instances and binding ids that use this physical document. */
  usedBy: Array<{ tool: string; binding: string; role: BindingRole }>;
}

export interface ToolBindingsResult {
  ok: boolean;
  projectDir: string;
  configFile: string | null;
  externalRoots: Array<{ id: string; path: string; origin: string | null }>;
  instances: ToolInstance[];
  documents: ToolDocument[];
  diagnostics: ConfigDiagnostic[];
}

export interface ResolveBindingsOptions {
  /** Adapter manifests used for the support level; defaults to the registered built-in manifests (src/adapters/manifests.ts). */
  manifests?: AdapterManifest[];
  /** Skips workspace discovery (component roots stay null). */
  skipInventory?: boolean;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const slash = (p: string) => p.split(path.sep).join("/");

function diag(code: string, file: string, pathSegments: string[], message: string, suggestion?: string): ConfigDiagnostic {
  return { kind: "reference", code, file, path: pathSegments.join("."), pathSegments, message, ...(suggestion ? { suggestion } : {}) };
}

/** Real path of the nearest existing ancestor plus the missing tail; works for paths that do not exist. */
function realPathLenient(abs: string): { real: string; exists: boolean } {
  const parts: string[] = [];
  let cur = path.resolve(abs);
  for (;;) {
    try {
      fs.lstatSync(cur);
      break;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      parts.unshift(path.basename(cur));
      cur = parent;
    }
  }
  let real: string;
  try {
    real = canonicalPath(cur);
  } catch {
    real = path.resolve(cur);
  }
  return { real: path.join(real, ...parts), exists: parts.length === 0 };
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Support level of an instance, from the adapter manifest (the only source of truth); defaults to the registered manifests. */
export function supportLevelFor(adapter: string, hasBindings: boolean, manifests: AdapterManifest[] = builtinManifests(), platform: string = process.platform): SupportLevel {
  const manifest = manifests.find((m) => m.id === adapter);
  if (!manifest) return hasBindings ? "editable-file" : "unavailable";
  if (!manifest.platforms.includes(platform)) return "incompatible";
  // Edit modes of the manifest schema: a validated structured write (the form) is "assisted";
  // "full" also needs the effective configuration, both tested; text alone is an editable file.
  const tested = new Set(manifest.editing.tested);
  const implemented = new Set(manifest.editing.implemented);
  if (implemented.has("structured-write") && tested.has("structured-write") && implemented.has("effective-preview") && tested.has("effective-preview")) return "full";
  if (implemented.has("structured-write")) return "assisted";
  if (implemented.size > 0) return "editable-file";
  return "unavailable";
}

function listDirectory(absDir: string, include: string[] | null, rootReal: string): BindingFile[] {
  const out: BindingFile[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 16 || out.length >= 5000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(dir, e.name);
      if (e.isDirectory()) walk(childAbs, childRel, depth + 1);
      else if (e.isFile() || e.isSymbolicLink()) {
        if (include && !include.some((p) => matchesExactly(p, childRel))) continue;
        let real: string;
        try {
          real = canonicalPath(childAbs);
        } catch {
          continue;
        }
        if (!isInside(rootReal, real)) continue; // a symlink that leaves the allowed root is never listed
        out.push({ path: childRel, identity: real });
      }
    }
  };
  walk(absDir, "", 0);
  return out;
}

interface RefInput {
  id: string;
  ref: Json | string;
  defaultRole: BindingRole;
  segments: string[];
}

/** Resolves the bindings of every tool instance of .jgates/tools.yml to the real files. Never creates a file. */
export function resolveToolBindings(dir: string, options: ResolveBindingsOptions = {}): ToolBindingsResult {
  const projectDir = path.resolve(dir);
  const manifests = options.manifests ?? builtinManifests();
  const loaded = loadProjectConfig(projectDir);
  const doc = loaded.byKind.tools;
  const diagnostics: ConfigDiagnostic[] = loaded.diagnostics.filter((d) => doc && d.file === doc.file);
  const result: ToolBindingsResult = {
    ok: true,
    projectDir,
    configFile: doc?.file ?? null,
    externalRoots: [],
    instances: [],
    documents: [],
    diagnostics,
  };
  if (!doc || !isObject(doc.value)) return result;
  const file = doc.file;

  let workspaceReal: string;
  try {
    workspaceReal = canonicalPath(projectDir);
  } catch {
    workspaceReal = projectDir;
  }
  const roots = new Map<string, string>([["workspace", workspaceReal]]);
  const rawRoots = Array.isArray(doc.value.externalRoots) ? doc.value.externalRoots : [];
  rawRoots.forEach((r, i) => {
    if (!isObject(r) || typeof r.id !== "string" || typeof r.path !== "string") return;
    const abs = path.resolve(projectDir, r.path);
    const { real } = realPathLenient(abs);
    roots.set(r.id, real);
    result.externalRoots.push({ id: r.id, path: real, origin: typeof r.origin === "string" ? r.origin : null });
    if (r.id === "workspace") diagnostics.push(diag("EXTERNAL_ROOT_RESERVED", file, ["externalRoots", String(i), "id"], `O id "workspace" é reservado.`));
  });

  const inventoryRoots = new Map<string, string>();
  if (!options.skipInventory) {
    try {
      for (const c of discoverWorkspace(projectDir).inventory.classifications) inventoryRoots.set(c.id, c.componentRoot);
    } catch {
      // discovery is optional context
    }
  }

  const tools = isObject(doc.value.tools) ? doc.value.tools : {};
  const byIdentity = new Map<string, ToolDocument>();

  for (const [toolId, rawTool] of Object.entries(tools)) {
    if (!isObject(rawTool)) continue;
    const toolBase = typeof rawTool.base === "string" ? rawTool.base : null;
    const refs: RefInput[] = [];
    if (typeof rawTool.config === "string") refs.push({ id: "config", ref: rawTool.config, defaultRole: "primary", segments: ["tools", toolId, "config"] });
    else if (isObject(rawTool.config)) refs.push({ id: "config", ref: rawTool.config, defaultRole: "primary", segments: ["tools", toolId, "config"] });
    if (isObject(rawTool.configFiles)) {
      for (const [id, ref] of Object.entries(rawTool.configFiles)) {
        if (isObject(ref)) refs.push({ id, ref, defaultRole: "support", segments: ["tools", toolId, "configFiles", id] });
      }
    }

    const bindings: ResolvedBinding[] = [];
    for (const r of refs) {
      const spec: Json = typeof r.ref === "string" ? { path: r.ref } : r.ref;
      const declared = String(spec.path);
      const rootId = typeof spec.root === "string" ? spec.root : "workspace";
      const rootReal = roots.get(rootId);
      const kind = spec.kind === "directory" ? "directory" : "file";
      const include = Array.isArray(spec.include) ? spec.include.map(String) : null;
      const base: ResolvedBinding = {
        id: r.id,
        role: (spec.role as BindingRole) ?? r.defaultRole,
        // The editor may write a bound file unless the binding declares access: read.
        access: spec.access === "read" ? "read" : "write",
        section: typeof spec.section === "string" ? spec.section : null,
        origin: typeof spec.origin === "string" ? spec.origin : null,
        kind,
        declared,
        root: rootId,
        relPath: null,
        absPath: "",
        exists: false,
        identity: null,
        include,
        files: [],
        refused: false,
      };
      const refuse = (code: string, message: string, suggestion?: string) => {
        base.refused = true;
        diagnostics.push(diag(code, file, [...r.segments, "path"], message, suggestion));
        result.ok = false;
      };
      bindings.push(base);
      if (!rootReal) {
        refuse("EXTERNAL_ROOT_UNKNOWN", `A raiz externa "${rootId}" do binding ${toolId}.${r.id} não foi declarada.`, "Declare a raiz em externalRoots.");
        continue;
      }
      // Paths are relative to the workspace root unless an explicit base (binding, then tool) or a root says otherwise.
      const baseDir = typeof spec.base === "string" ? spec.base : toolBase;
      const start = rootId === "workspace" ? projectDir : rootReal;
      const abs = path.resolve(start, baseDir ?? ".", declared);
      base.absPath = abs;
      const lenient = realPathLenient(abs);
      const allowed = rootId === "workspace" ? [workspaceReal, ...[...roots.entries()].filter(([k]) => k !== "workspace").map(([, v]) => v)] : [rootReal];
      // Lexical check first (../), then the real path (symlinks), against the roots that were declared.
      const lexicalOk = rootId === "workspace" ? isInside(projectDir, abs) || roots.size > 1 : isInside(rootReal, abs);
      const realOk = allowed.some((root) => isInside(root, lenient.real));
      if (!lexicalOk || !realOk) {
        const viaSymlink = lexicalOk && !realOk;
        refuse(
          viaSymlink ? "BINDING_SYMLINK_ESCAPE" : "BINDING_OUTSIDE_ROOT",
          viaSymlink
            ? `O binding ${toolId}.${r.id} (${declared}) sai da raiz por um link simbólico.`
            : `O binding ${toolId}.${r.id} (${declared}) sai da raiz do workspace.`,
          "Declare uma raiz externa em externalRoots e use root: <id>, ou aponte para um caminho dentro do workspace.",
        );
        continue;
      }
      base.identity = lenient.real;
      base.exists = lenient.exists;
      if (isInside(workspaceReal, lenient.real)) base.relPath = slash(path.relative(workspaceReal, lenient.real)) || ".";
      if (base.exists) {
        let st: fs.Stats | null = null;
        try {
          st = fs.statSync(abs);
        } catch {
          st = null;
        }
        if (st?.isDirectory() && kind === "file") {
          base.kind = "directory";
        }
        if (base.kind === "directory" && st?.isDirectory()) base.files = listDirectory(abs, include, allowed.find((root) => isInside(root, lenient.real)) ?? workspaceReal);
      }
      const docKey = base.identity;
      let entry = byIdentity.get(docKey);
      if (!entry) {
        entry = { identity: docKey, kind: base.kind, exists: base.exists, usedBy: [] };
        byIdentity.set(docKey, entry);
      }
      entry.usedBy.push({ tool: toolId, binding: r.id, role: base.role });
    }

    const adapter = String(rawTool.adapter ?? "");
    const component = typeof rawTool.component === "string" ? rawTool.component : null;
    result.instances.push({
      id: toolId,
      adapter,
      component,
      componentRoot: component ? (inventoryRoots.get(component) ?? null) : null,
      enabled: rawTool.enabled !== false,
      required: rawTool.required === true,
      runner: typeof rawTool.runner === "string" ? rawTool.runner : "local",
      base: toolBase,
      supportLevel: supportLevelFor(adapter, bindings.some((b) => !b.refused), manifests),
      bindings,
    });
  }
  result.documents = [...byIdentity.values()].sort((a, b) => a.identity.localeCompare(b.identity));
  return result;
}
