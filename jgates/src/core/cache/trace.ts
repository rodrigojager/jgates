// Static trace of the files a JS/TS configuration imports:
// the relative files it imports or requires, transitively, are inputs of the steps that use it. A configuration
// whose dependencies are not identifiable (a dynamic import, a require of a computed path, the environment, the
// network) is reported as untraceable and the steps that depend on it are never served from the cache.
// The config is only parsed, never evaluated.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";

const CODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"]);
const RESOLVE_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".json", ".jsx", ".tsx"];
const MAX_FILES = 200;
const MAX_BYTES = 2 * 1024 * 1024;

export interface TracedFile {
  /** Relative to the analyzed folder, forward slashes. */
  path: string;
  /** sha256 of the content; null when the file is a relative import that does not exist. */
  sha256: string | null;
}

export type UntraceableCode = "DYNAMIC_IMPORT" | "COMPUTED_REQUIRE" | "ENVIRONMENT_DEPENDENT" | "NETWORK_DEPENDENT" | "UNPARSEABLE_CONFIG" | "TRACE_LIMIT";

export interface Untraceable {
  code: UntraceableCode;
  /** File that makes the dependencies unknown. */
  file: string;
}

export interface ConfigTrace {
  /** Every file read: the configurations themselves and what they import. */
  files: TracedFile[];
  untraceable: Untraceable[];
}

type Node = { type: string; [key: string]: unknown };

export const isCodeConfig = (file: string): boolean => CODE_EXTENSIONS.has(path.extname(file).toLowerCase());

const posix = (p: string): string => p.split(path.sep).join("/");

function sha(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function resolveRelative(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec);
  const candidates = [base];
  // TypeScript writes ./x.js for ./x.ts
  const ext = path.extname(base);
  if (ext) {
    const stem = base.slice(0, -ext.length);
    for (const e of RESOLVE_EXTENSIONS) candidates.push(stem + e);
  }
  for (const e of RESOLVE_EXTENSIONS) candidates.push(base + e);
  for (const e of RESOLVE_EXTENSIONS) candidates.push(path.join(base, "index" + e));
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

interface Found {
  specs: string[];
  untraceable: UntraceableCode[];
}

function literalString(node: Node | undefined): string | null {
  if (!node) return null;
  if (node.type === "StringLiteral") return node.value as string;
  if (node.type === "TemplateLiteral" && (node.expressions as unknown[]).length === 0) {
    const quasis = node.quasis as Array<{ value: { cooked?: string } }>;
    return quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function walk(node: unknown, found: Found): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, found);
    return;
  }
  const n = node as Node;
  if (typeof n.type === "string") {
    switch (n.type) {
      case "ImportDeclaration":
      case "ExportAllDeclaration":
      case "ExportNamedDeclaration": {
        const spec = literalString(n.source as Node | undefined);
        if (spec !== null) found.specs.push(spec);
        break;
      }
      case "ImportExpression": {
        const spec = literalString(n.source as Node);
        if (spec !== null) found.specs.push(spec);
        else found.untraceable.push("DYNAMIC_IMPORT");
        break;
      }
      case "CallExpression": {
        const callee = n.callee as Node;
        const args = n.arguments as Node[];
        if (callee.type === "Import") {
          const spec = literalString(args[0]);
          if (spec !== null) found.specs.push(spec);
          else found.untraceable.push("DYNAMIC_IMPORT");
        } else if (callee.type === "Identifier" && (callee.name === "require" || callee.name === "eval")) {
          if (callee.name === "eval") found.untraceable.push("DYNAMIC_IMPORT");
          else {
            const spec = literalString(args[0]);
            if (spec !== null) found.specs.push(spec);
            else found.untraceable.push("COMPUTED_REQUIRE");
          }
        } else if (callee.type === "Identifier" && callee.name === "fetch") {
          found.untraceable.push("NETWORK_DEPENDENT");
        } else if (callee.type === "MemberExpression") {
          const obj = callee.object as Node;
          const prop = callee.property as Node;
          if (obj.type === "Identifier" && obj.name === "require" && prop.name === "resolve") {
            /* require.resolve('x') names a path, not a dependency to read */
          }
        }
        break;
      }
      case "MemberExpression": {
        const obj = n.object as Node;
        const prop = n.property as Node;
        if (obj.type === "Identifier" && obj.name === "process" && prop.type === "Identifier" && (prop.name === "env" || prop.name === "argv")) {
          found.untraceable.push("ENVIRONMENT_DEPENDENT");
        }
        break;
      }
      default:
        break;
    }
  }
  for (const [key, value] of Object.entries(n)) {
    if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "comments") continue;
    if (value && typeof value === "object") walk(value, found);
  }
}

function isRelative(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..";
}

/**
 * Traces the configurations (workspace-relative paths) inside `root`: the file itself, its relative imports
 * transitively, and what makes the dependencies unknowable. Non-code files (JSON, YAML, TOML) have no imports.
 * Bare specifiers (packages) are not files of the workspace; they are covered by the lockfile in the input manifest.
 */
export function traceConfigs(root: string, configs: readonly string[]): ConfigTrace {
  const files = new Map<string, TracedFile>();
  const untraceable: Untraceable[] = [];
  const seenUntraceable = new Set<string>();
  const note = (code: UntraceableCode, file: string): void => {
    const key = `${code}\0${file}`;
    if (seenUntraceable.has(key)) return;
    seenUntraceable.add(key);
    untraceable.push({ code, file });
  };
  const rootAbs = path.resolve(root);
  const rel = (abs: string): string => posix(path.relative(rootAbs, abs));
  const queue = configs.map((c) => path.resolve(rootAbs, c));
  const visited = new Set<string>();
  while (queue.length > 0) {
    const abs = queue.shift() as string;
    if (visited.has(abs)) continue;
    visited.add(abs);
    const name = rel(abs);
    if (visited.size > MAX_FILES) {
      note("TRACE_LIMIT", name);
      break;
    }
    let buf: Buffer;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_BYTES) {
        if (st.isFile()) note("TRACE_LIMIT", name);
        continue;
      }
      buf = fs.readFileSync(abs);
    } catch {
      files.set(name, { path: name, sha256: null });
      continue;
    }
    files.set(name, { path: name, sha256: sha(buf) });
    if (!isCodeConfig(abs)) continue;
    let ast: unknown;
    try {
      ast = parse(buf.toString("utf8"), {
        sourceType: "unambiguous",
        errorRecovery: false,
        allowReturnOutsideFunction: true,
        plugins: [/\.[cm]?tsx?$/.test(abs) ? "typescript" : "jsx"],
      });
    } catch {
      note("UNPARSEABLE_CONFIG", name);
      continue;
    }
    const found: Found = { specs: [], untraceable: [] };
    walk((ast as { program: unknown }).program, found);
    for (const code of found.untraceable) note(code, name);
    for (const spec of found.specs) {
      if (!isRelative(spec)) continue;
      const target = resolveRelative(abs, spec);
      if (target === null) {
        const missing = rel(path.resolve(path.dirname(abs), spec));
        files.set(missing, { path: missing, sha256: null });
      } else if (!visited.has(target)) queue.push(target);
    }
  }
  return { files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), untraceable };
}
