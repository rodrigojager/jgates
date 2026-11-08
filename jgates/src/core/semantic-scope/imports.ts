// The import graph of a scope end. JavaScript/TypeScript files are parsed (never evaluated) with the same parser as the
// static trace of configurations (core/cache/trace.ts): static imports, re-exports, require and import() with a
// literal path; an import() or require of a computed value is recorded as an unknown, never guessed. Python files are
// scanned with regular expressions (no parser ships with JGates), and that uncertainty is recorded in the extractor
// limitations. The architecture adapters (dependency-cruiser, Import Linter) need external tools a preview cannot
// assume, so they are not run here; the graph says so.
import { builtinModules } from "node:module";
import path from "node:path";
import { parse } from "@babel/parser";
import { isJs, isPython } from "./classify.js";
import type { FileView } from "./views.js";
import type { ExtractorInfo, UnknownCode } from "./types.js";
import { translator } from "../../i18n/index.js";

const t = translator("semantic-scope");

export const MAX_PARSE_BYTES = 1024 * 1024;
export const MAX_GRAPH_FILES = 20_000;

export interface FoundImport {
  spec: string;
  kind: "static" | "require" | "dynamic";
}

export interface ExtractedImports {
  method: "ast" | "regex";
  imports: FoundImport[];
  unknowns: Array<{ code: UnknownCode; detail: string }>;
}

type Node = { type: string; [key: string]: unknown };

function literal(node: Node | undefined | null): string | null {
  if (!node) return null;
  if (node.type === "StringLiteral") return node.value as string;
  if (node.type === "TemplateLiteral" && (node.expressions as unknown[]).length === 0) {
    const quasis = node.quasis as Array<{ value: { cooked?: string } }>;
    return quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function walkJs(node: unknown, out: ExtractedImports): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) walkJs(n, out);
    return;
  }
  const n = node as Node;
  switch (n.type) {
    case "ImportDeclaration":
    case "ExportAllDeclaration":
    case "ExportNamedDeclaration": {
      const spec = literal(n.source as Node | undefined);
      if (spec !== null) out.imports.push({ spec, kind: "static" });
      break;
    }
    case "TSImportEqualsDeclaration": {
      const ref = n.moduleReference as Node | undefined;
      if (ref?.type === "TSExternalModuleReference") {
        const spec = literal(ref.expression as Node);
        if (spec !== null) out.imports.push({ spec, kind: "require" });
      }
      break;
    }
    case "ImportExpression": {
      const spec = literal(n.source as Node);
      if (spec !== null) out.imports.push({ spec, kind: "dynamic" });
      else out.unknowns.push({ code: "DYNAMIC_IMPORT", detail: "import() of a computed value" });
      break;
    }
    case "CallExpression": {
      const callee = n.callee as Node;
      const args = (n.arguments as Node[]) ?? [];
      if (callee.type === "Import") {
        const spec = literal(args[0]);
        if (spec !== null) out.imports.push({ spec, kind: "dynamic" });
        else out.unknowns.push({ code: "DYNAMIC_IMPORT", detail: "import() of a computed value" });
      } else if (callee.type === "Identifier" && callee.name === "require" && args.length > 0) {
        const spec = literal(args[0]);
        if (spec !== null) out.imports.push({ spec, kind: "require" });
        else out.unknowns.push({ code: "COMPUTED_REQUIRE", detail: "require() of a computed value" });
      }
      break;
    }
    default:
      break;
  }
  for (const [key, value] of Object.entries(n)) {
    if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "comments" || key === "leadingComments" || key === "trailingComments") continue;
    if (value && typeof value === "object") walkJs(value, out);
  }
}

const PY_IMPORT = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm;
const PY_FROM = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(?:\(([^)]*)\)|([\w*, \t]+))/gm;
const PY_DYNAMIC = /(?:importlib\.import_module|__import__)\(\s*([^)]*)\)/g;

function extractPython(text: string): ExtractedImports {
  const out: ExtractedImports = { method: "regex", imports: [], unknowns: [] };
  for (const m of text.matchAll(PY_IMPORT)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name = part.trim().split(/\s+/)[0];
      if (name) out.imports.push({ spec: name, kind: "static" });
    }
  }
  for (const m of text.matchAll(PY_FROM)) {
    const mod = m[1] ?? "";
    if (/^\.+$/.test(mod)) {
      // from . import a, b: each name may be a module of the package.
      for (const part of (m[2] ?? m[3] ?? "").split(",")) {
        const name = part.trim().split(/\s+/)[0];
        if (name && name !== "*") out.imports.push({ spec: `${mod}${name}`, kind: "static" });
      }
      out.imports.push({ spec: mod, kind: "static" });
    } else if (mod) out.imports.push({ spec: mod, kind: "static" });
  }
  for (const m of text.matchAll(PY_DYNAMIC)) {
    const arg = (m[1] ?? "").trim();
    const lit = /^(['"])([\w.]+)\1$/.exec(arg);
    if (lit?.[2]) out.imports.push({ spec: lit[2], kind: "dynamic" });
    else out.unknowns.push({ code: "DYNAMIC_IMPORT", detail: "import_module/__import__ of a computed value" });
  }
  return out;
}

/** The imports of one file, or null when the file is not a language the extractor knows. */
export function extractImports(file: string, text: string): ExtractedImports | null {
  if (isPython(file)) return extractPython(text);
  if (!isJs(file)) return null;
  const out: ExtractedImports = { method: "ast", imports: [], unknowns: [] };
  const ts = /\.[cm]?tsx?$/i.test(file);
  try {
    const ast = parse(text, {
      sourceType: "unambiguous",
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      plugins: ts ? (/x$/i.test(file) ? ["typescript", "jsx"] : ["typescript"]) : ["jsx"],
    } as Parameters<typeof parse>[1]);
    walkJs(ast.program, out);
  } catch (error) {
    out.unknowns.push({ code: "UNPARSEABLE", detail: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
  }
  return out;
}

const JS_RESOLVE = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx", ".json"];
const BUILTINS = new Set(builtinModules);

export type Resolution =
  | { kind: "file"; path: string }
  | { kind: "package"; name: string }
  | { kind: "builtin" }
  | { kind: "unresolved"; candidate: string | null };

function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
}

function resolveJsRelative(from: string, spec: string, view: FileView): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  if (base.startsWith("../") || base === "..") return null;
  const candidates = [base];
  const ext = path.posix.extname(base);
  if (ext) {
    // TypeScript writes ./x.js for ./x.ts.
    const stem = base.slice(0, -ext.length);
    for (const e of JS_RESOLVE) candidates.push(stem + e);
  }
  for (const e of JS_RESOLVE) candidates.push(base + e);
  for (const e of JS_RESOLVE) candidates.push(`${base}/index${e}`);
  return candidates.find((c) => view.has(c)) ?? null;
}

function resolvePyModule(from: string, spec: string, view: FileView): string | null {
  const dots = /^\.*/.exec(spec)?.[0].length ?? 0;
  const rest = spec.slice(dots).replace(/\./g, "/");
  const roots: string[] = [];
  if (dots > 0) {
    let dir = path.posix.dirname(from);
    for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
    roots.push(dir === "." ? "" : dir);
  } else {
    roots.push("", "src");
    const top = from.split("/")[0];
    if (top && top !== from) roots.push(top);
  }
  for (const root of roots) {
    const base = [root, rest].filter((x) => x !== "").join("/");
    if (base === "") {
      if (view.has(path.posix.join(root, "__init__.py"))) return path.posix.join(root, "__init__.py");
      continue;
    }
    for (const c of [`${base}.py`, `${base}/__init__.py`]) if (view.has(c)) return c;
  }
  return null;
}

/** Where a specifier of `from` points in this view. */
export function resolveImport(from: string, spec: string, view: FileView): Resolution {
  if (isPython(from)) {
    const file = resolvePyModule(from, spec, view);
    if (file) return { kind: "file", path: file };
    if (spec.startsWith(".")) return { kind: "unresolved", candidate: null };
    return { kind: "package", name: spec.split(".")[0] ?? spec };
  }
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
    const file = resolveJsRelative(from, spec, view);
    if (file) return { kind: "file", path: file };
    return { kind: "unresolved", candidate: path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)) };
  }
  if (spec.startsWith("node:") || BUILTINS.has(spec) || BUILTINS.has(spec.split("/")[0] ?? "")) return { kind: "builtin" };
  // Path aliases (tsconfig paths, bundler aliases) and absolute paths are not resolved: an unknown, never a guess.
  if (spec.startsWith("/") || spec.startsWith("~/") || spec.startsWith("@/") || spec.startsWith("#")) return { kind: "unresolved", candidate: null };
  return { kind: "package", name: packageName(spec) };
}

export interface ImportGraph {
  /** from -> files it imports. */
  edges: Map<string, Set<string>>;
  /** to -> files importing it. */
  importers: Map<string, Set<string>>;
  /** from -> packages it imports. */
  packages: Map<string, Set<string>>;
  /** Package -> files importing it. */
  packageUsers: Map<string, Set<string>>;
  /** Specifiers that resolve to nothing in this view, with the path they would name (relative ones). */
  unresolved: Array<{ from: string; spec: string; candidate: string | null }>;
  unknowns: Array<{ code: UnknownCode; path: string; detail: string }>;
  methods: Map<string, "ast" | "regex">;
  parsed: number;
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

/** The import graph of every JS/TS/Python file of the view (bounded by size and count; what is skipped is an unknown). */
export function buildImportGraph(view: FileView): ImportGraph {
  const graph: ImportGraph = { edges: new Map(), importers: new Map(), packages: new Map(), packageUsers: new Map(), unresolved: [], unknowns: [], methods: new Map(), parsed: 0 };
  const code = view.files.filter((f) => isJs(f) || isPython(f));
  const parseable: string[] = [];
  for (const f of code) {
    const size = view.size(f) ?? 0;
    if (size > MAX_PARSE_BYTES) graph.unknowns.push({ code: "FILE_TOO_LARGE", path: f, detail: `${size} bytes` });
    else if (parseable.length >= MAX_GRAPH_FILES) graph.unknowns.push({ code: "GRAPH_LIMIT", path: f, detail: `more than ${MAX_GRAPH_FILES} files` });
    else parseable.push(f);
  }
  view.preload(parseable);
  for (const f of parseable) {
    const buf = view.read(f);
    if (!buf) continue;
    const found = extractImports(f, buf.toString("utf8"));
    if (!found) continue;
    graph.parsed++;
    graph.methods.set(f, found.method);
    for (const u of found.unknowns) graph.unknowns.push({ code: u.code, path: f, detail: u.detail });
    for (const imp of found.imports) {
      const r = resolveImport(f, imp.spec, view);
      if (r.kind === "file") {
        if (r.path === f) continue;
        add(graph.edges, f, r.path);
        add(graph.importers, r.path, f);
      } else if (r.kind === "package") {
        add(graph.packages, f, r.name);
        add(graph.packageUsers, r.name, f);
      } else if (r.kind === "unresolved") {
        graph.unresolved.push({ from: f, spec: imp.spec, candidate: r.candidate });
      }
    }
  }
  return graph;
}

/** What the extractor is and what it cannot see, for the preview. */
export function extractorInfo(graph: ImportGraph | null): ExtractorInfo {
  const languages: ExtractorInfo["languages"] = [];
  const methods = new Set(graph ? graph.methods.values() : []);
  if (!graph || methods.has("ast")) languages.push({ language: "javascript/typescript", method: "ast" });
  if (!graph || methods.has("regex")) languages.push({ language: "python", method: "regex" });
  return {
    id: "jgates-import-scan",
    languages,
    limitations: ["PYTHON_REGEX_SCAN", "ALIASES_AND_COMPUTED_IMPORTS", "OTHER_LANGUAGES_WITHOUT_RELATIONS", "INDIRECT_CALLS_NOT_TRACED"].map((code) => ({
      code,
      message: t(`scope_limitation_${code.toLowerCase()}`),
    })),
    exhaustive: false,
  };
}

/** Files reachable from `start` through imports, up to `depth` levels (start excluded), bounded by `limit`. */
export function importClosure(graph: ImportGraph, start: string, depth: number, limit = 200): string[] {
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const to of graph.edges.get(f) ?? []) {
        if (seen.has(to)) continue;
        seen.add(to);
        next.push(to);
        if (seen.size > limit) return [...seen].filter((x) => x !== start).sort();
      }
    }
    frontier = next;
  }
  seen.delete(start);
  return [...seen].sort();
}
