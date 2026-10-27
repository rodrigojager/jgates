import { parse } from "@babel/parser";
import { translator } from "../../../i18n/index.js";
import {
  applyEditsToValue,
  CodecError,
  sameValue,
  type Codec,
  type CodecDiagnostic,
  type CodecDocument,
  type CodecOptions,
  type CodecPatchResult,
  type FieldEdit,
  type FieldInfo,
  type PathSegment,
  type ValueKind,
} from "../types.js";

/**
 * JS/TS/CJS/MJS configuration codec. The file is only ever parsed (@babel/parser): it is never
 * evaluated, required or imported, so opening a config can not run anything. The visual model covers a
 * limited static subset: the default export or `module.exports`, optionally wrapped in a known `defineConfig`-style
 * call, whose value is an object or array literal with static keys and literal values. Everything else (spreads,
 * functions, calls, references, imports, `process.env`, conditionals, computed keys) is reported as a warning and
 * makes the document partial; it stays in the file untouched. A visual write that would cross such a node is
 * refused with the reason (`UNSUPPORTED` + `details.reason`); the text editor is the fallback.
 *
 * Edits are text splices at the ranges the parser reports, so comments, quoting style, imports, functions and
 * everything the edit does not name stay byte for byte. Each patch is re-read and compared with the expected value.
 */

export type JsDialect = "javascript" | "typescript";
const DIALECTS: readonly JsDialect[] = ["javascript", "typescript"];

/** Marker that stands in `value` for a part of the file the static projection can not resolve. */
export const UNRESOLVED_KEY = "$unresolved";

/** Calls that only wrap the configuration object and do not change it. */
export const KNOWN_WRAPPERS: readonly string[] = ["defineConfig", "defineProject", "defineWorkspace", "defineFlatConfig"];

/** "typescript" for .ts/.mts/.cts/.tsx, "javascript" for everything else. */
export function dialectForFile(file: string): JsDialect {
  return /\.(ts|mts|cts|tsx)$/i.test(file) ? "typescript" : "javascript";
}

function resolveDialect(options: CodecOptions | undefined): JsDialect {
  const dialect = options?.dialect ?? "javascript";
  if (!DIALECTS.includes(dialect as JsDialect)) throw new CodecError("DIALECT", `unknown JS dialect "${dialect}"`);
  return dialect as JsDialect;
}

// ---------------------------------------------------------------------------------------------------------------------
// AST access (loosely typed on purpose: only the shapes below are used)

interface Pos {
  line: number;
  column: number;
}
interface N {
  type: string;
  start: number;
  end: number;
  loc: { start: Pos };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/** Why a node can not be projected. */
export type UnresolvedReason =
  | "SPREAD"
  | "FUNCTION"
  | "CALL"
  | "REQUIRE"
  | "IMPORT"
  | "ENV"
  | "REFERENCE"
  | "MEMBER"
  | "CONDITIONAL"
  | "TEMPLATE"
  | "EXPRESSION"
  | "COMPUTED_KEY"
  | "HOLE"
  | "MERGE"
  | "UNSUPPORTED";

const WRAPPER_TYPES = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "ParenthesizedExpression"]);

function unwrap(node: N): N {
  let cur = node;
  while (WRAPPER_TYPES.has(cur.type)) cur = cur.expression as N;
  return cur;
}

function calleeName(call: N): string | null {
  const callee = unwrap(call.callee as N);
  if (callee.type === "Identifier") return callee.name as string;
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") return callee.property.name as string;
  return null;
}

function isProcessEnv(node: N): boolean {
  let cur = node;
  while (cur.type === "MemberExpression" || cur.type === "OptionalMemberExpression") {
    const obj = unwrap(cur.object as N);
    if (obj.type === "Identifier" && obj.name === "process" && !cur.computed && cur.property.type === "Identifier" && cur.property.name === "env") return true;
    cur = obj;
  }
  return false;
}

interface ParsedFile {
  /** Text without the BOM. */
  src: string;
  bom: string;
  program: N;
  errors: CodecDiagnostic[];
  imports: Set<string>;
  consts: Map<string, N>;
  eol: string;
}

function lineColumn(text: string, offset: number): Pos {
  let line = 1;
  let last = -1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++;
    last = i;
  }
  return { line, column: offset - last };
}

function parseFile(text: string, dialect: JsDialect): ParsedFile {
  const bom = text.charCodeAt(0) === 0xfeff ? "﻿" : "";
  const src = bom ? text.slice(1) : text;
  const errors: CodecDiagnostic[] = [];
  let program: N = { type: "Program", start: 0, end: src.length, loc: { start: { line: 1, column: 0 } }, body: [] };
  try {
    const file = parse(src, {
      sourceType: "unambiguous",
      errorRecovery: true,
      plugins: dialect === "typescript" ? ["typescript"] : ["jsx"],
    }) as unknown as { program: N; errors?: Array<{ message: string; loc?: Pos; pos?: number }> };
    program = file.program;
    for (const e of file.errors ?? []) {
      const at = e.loc ? { line: e.loc.line, column: e.loc.column + 1 } : e.pos !== undefined ? lineColumn(src, e.pos) : undefined;
      errors.push({ code: "SYNTAX", message: e.message.replace(/\s*\(\d+:\d+\)$/, ""), ...(at ?? {}), ...(e.pos !== undefined ? { offset: e.pos } : {}) });
    }
  } catch (error) {
    const e = error as { message?: string; loc?: Pos; pos?: number };
    const at = e.loc ? { line: e.loc.line, column: e.loc.column + 1 } : undefined;
    errors.push({ code: "SYNTAX", message: String(e.message ?? error).replace(/\s*\(\d+:\d+\)$/, ""), ...(at ?? {}), ...(e.pos !== undefined ? { offset: e.pos } : {}) });
  }
  const imports = new Set<string>();
  const consts = new Map<string, N>();
  for (const stmt of (program.body ?? []) as N[]) {
    if (stmt.type === "ImportDeclaration") {
      for (const spec of (stmt.specifiers ?? []) as N[]) if (spec.local?.name) imports.add(spec.local.name as string);
    } else if (stmt.type === "VariableDeclaration") {
      for (const d of (stmt.declarations ?? []) as N[]) {
        if (d.id?.type === "Identifier" && d.init) {
          if (d.init.type === "CallExpression" && calleeName(d.init as N) === "require") imports.add(d.id.name as string);
          else if (stmt.kind === "const") consts.set(d.id.name as string, d.init as N);
        }
      }
    }
  }
  return { src, bom, program, errors, imports, consts, eol: src.includes("\r\n") ? "\r\n" : "\n" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Classification of what the projection can not read

function classify(node: N, file: ParsedFile): UnresolvedReason {
  const n = unwrap(node);
  switch (n.type) {
    case "SpreadElement":
      return "SPREAD";
    case "ArrowFunctionExpression":
    case "FunctionExpression":
    case "ObjectMethod":
    case "ClassMethod":
      return "FUNCTION";
    case "ImportExpression":
      return "IMPORT";
    case "CallExpression":
    case "OptionalCallExpression":
    case "NewExpression": {
      const name = n.type === "NewExpression" ? null : calleeName(n);
      if (name === "require") return "REQUIRE";
      if (name === "mergeConfig" || name === "merge") return "MERGE";
      return "CALL";
    }
    case "Identifier":
      return file.imports.has(n.name as string) ? "IMPORT" : "REFERENCE";
    case "MemberExpression":
    case "OptionalMemberExpression":
      return isProcessEnv(n) ? "ENV" : "MEMBER";
    case "ConditionalExpression":
    case "LogicalExpression":
      return "CONDITIONAL";
    case "TemplateLiteral":
      return "TEMPLATE";
    case "BinaryExpression":
    case "UnaryExpression":
    case "AwaitExpression":
    case "SequenceExpression":
    case "AssignmentExpression":
      return "EXPRESSION";
    default:
      return "UNSUPPORTED";
  }
}

const isSpread = (n: N | null) => n !== null && n.type === "SpreadElement";

/** Static key of an object member, or null for computed keys. */
function staticKey(prop: N): string | null {
  if (prop.type !== "ObjectProperty" && prop.type !== "ObjectMethod") return null;
  const key = prop.key as N;
  if (prop.computed) {
    if (key.type === "StringLiteral") return key.value as string;
    return null;
  }
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "StringLiteral") return key.value as string;
  if (key.type === "NumericLiteral") return String(key.value);
  return null;
}

/** The scalar a literal node holds, or `undefined` when the node is not a plain literal. */
function literalValue(node: N): { value: string | number | boolean | null; kind: ValueKind } | undefined {
  switch (node.type) {
    case "StringLiteral":
      return { value: node.value as string, kind: "string" };
    case "NumericLiteral":
      return { value: node.value as number, kind: "number" };
    case "BooleanLiteral":
      return { value: node.value as boolean, kind: "boolean" };
    case "NullLiteral":
      return { value: null, kind: "null" };
    case "TemplateLiteral":
      if ((node.expressions as N[]).length === 0) return { value: (node.quasis as N[]).map((q) => q.value.cooked as string).join(""), kind: "string" };
      return undefined;
    case "UnaryExpression":
      if ((node.operator === "-" || node.operator === "+") && (node.argument as N).type === "NumericLiteral") {
        const v = (node.argument as N).value as number;
        return { value: node.operator === "-" ? -v : v, kind: "number" };
      }
      return undefined;
    default:
      return undefined;
  }
}

/** True when the whole subtree is object/array/scalar literals with static keys (safe to replace or remove). */
function deepStatic(node: N): boolean {
  const n = unwrap(node);
  if (literalValue(n)) return true;
  if (n.type === "ObjectExpression") {
    return (n.properties as N[]).every((p) => p.type === "ObjectProperty" && !p.shorthand && staticKey(p) !== null && deepStatic(p.value as N));
  }
  if (n.type === "ArrayExpression") return (n.elements as Array<N | null>).every((e) => e !== null && !isSpread(e) && deepStatic(e));
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
// Root of the configuration

interface Root {
  node: N | null;
  /** Why the root can not be read, when it exists but is not a literal. */
  reason?: UnresolvedReason;
  at?: N;
}

function exportedExpression(program: N): N | null {
  let found: N | null = null;
  for (const stmt of (program.body ?? []) as N[]) {
    if (stmt.type === "ExportDefaultDeclaration") found = stmt.declaration as N;
    else if (stmt.type === "ExpressionStatement") {
      const e = stmt.expression as N;
      if (e.type === "AssignmentExpression" && e.operator === "=") {
        const left = e.left as N;
        if (left.type === "MemberExpression" && !left.computed && (left.object as N).type === "Identifier" && left.object.name === "module" && left.property.name === "exports") found = e.right as N;
      }
    }
  }
  return found;
}

function findRoot(file: ParsedFile): Root {
  const exp = exportedExpression(file.program);
  if (!exp) return { node: null };
  let cur = unwrap(exp);
  for (let depth = 0; depth < 6; depth++) {
    cur = unwrap(cur);
    if (cur.type === "ObjectExpression" || cur.type === "ArrayExpression") return { node: cur };
    if (cur.type === "CallExpression" && KNOWN_WRAPPERS.includes(calleeName(cur) ?? "")) {
      const args = cur.arguments as N[];
      if (args.length === 0) return { node: null, reason: "UNSUPPORTED", at: cur };
      cur = args[0] as N;
      continue;
    }
    if (cur.type === "Identifier" && file.consts.has(cur.name as string) && !file.imports.has(cur.name as string)) {
      cur = file.consts.get(cur.name as string) as N;
      continue;
    }
    return { node: null, reason: classify(cur, file), at: cur };
  }
  return { node: null, reason: "UNSUPPORTED", at: cur };
}

// ---------------------------------------------------------------------------------------------------------------------
// Read

const at = (n: N): Pos => ({ line: n.loc.start.line, column: n.loc.start.column + 1 });

function field(path: PathSegment[], kind: ValueKind, n: N): FieldInfo {
  return { path, kind, start: n.start, end: n.end, ...at(n) };
}

interface Projection {
  value: unknown;
  fields: FieldInfo[];
  warnings: CodecDiagnostic[];
}

function project(file: ParsedFile, root: Root): Projection {
  const t = translator("codecs-js");
  const fields: FieldInfo[] = [];
  const warnings: CodecDiagnostic[] = [];
  const warn = (reason: UnresolvedReason, n: N, path: PathSegment[]) => {
    warnings.push({ code: reason, message: t(`codecs_js_warn_${reason}`, { path: path.length ? path.join(".") : "(raiz)", line: n.loc.start.line }), ...at(n), offset: n.start });
  };
  const marker = (reason: UnresolvedReason) => ({ [UNRESOLVED_KEY]: reason });

  const walk = (raw: N, path: PathSegment[]): unknown => {
    const n = unwrap(raw);
    const lit = literalValue(n);
    if (lit) {
      fields.push(field(path, lit.kind, n));
      return lit.value;
    }
    if (n.type === "ObjectExpression") {
      fields.push(field(path, "object", n));
      const out: Record<string, unknown> = {};
      for (const p of n.properties as N[]) {
        if (isSpread(p)) {
          warn("SPREAD", p, path);
          continue;
        }
        const key = staticKey(p);
        if (key === null) {
          warn("COMPUTED_KEY", p, path);
          continue;
        }
        if (p.type === "ObjectMethod") {
          warn("FUNCTION", p, [...path, key]);
          out[key] = marker("FUNCTION");
          continue;
        }
        if (p.shorthand) {
          const reason = classify(p.value as N, file);
          warn(reason, p, [...path, key]);
          out[key] = marker(reason);
          continue;
        }
        out[key] = walk(p.value as N, [...path, key]);
      }
      return out;
    }
    if (n.type === "ArrayExpression") {
      fields.push(field(path, "array", n));
      return (n.elements as Array<N | null>).map((el, i) => {
        if (el === null) {
          warn("HOLE", n, [...path, i]);
          return marker("HOLE");
        }
        return walk(el, [...path, i]);
      });
    }
    const reason = classify(n, file);
    warn(reason, n, path);
    return marker(reason);
  };

  if (!root.node) {
    if (root.reason && root.at) warn(root.reason, root.at, []);
    else
      warnings.push({ code: "NO_CONFIG_ROOT", message: t("codecs_js_warn_NO_CONFIG_ROOT"), line: 1, column: 1 });
    return { value: root.reason ? marker(root.reason) : {}, fields, warnings };
  }
  const value = walk(root.node, []);
  return { value, fields, warnings };
}

export interface JsCodecDocument extends CodecDocument {
  /** True when part of the file could not be projected (the warnings say which). */
  partial: boolean;
}

export function readJs(text: string, options?: CodecOptions): JsCodecDocument {
  const dialect = resolveDialect(options);
  const file = parseFile(text, dialect);
  const root = findRoot(file);
  const projection = project(file, root);
  const ok = file.errors.length === 0;
  return {
    ok,
    dialect,
    value: projection.value,
    fields: ok ? projection.fields : [],
    errors: file.errors,
    warnings: projection.warnings,
    documents: 1,
    partial: !ok || projection.warnings.length > 0,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Edit planning

interface Splice {
  start: number;
  end: number;
  text: string;
}

function blocked(reason: UnresolvedReason | "NO_CONFIG_ROOT" | "NOT_STATIC", n: N | null, path: PathSegment[]): CodecError {
  const t = translator("codecs-js");
  const line = n ? n.loc.start.line : 1;
  const column = n ? n.loc.start.column + 1 : 1;
  return new CodecError("UNSUPPORTED", t(`codecs_js_blocked_${reason}`, { path: path.join(".") || "(raiz)", line }), { reason, line, column, path });
}

type Container = N;

function itemsOf(container: Container): Array<N | null> {
  return (container.type === "ObjectExpression" ? container.properties : container.elements) as Array<N | null>;
}

/** Throws when the container makes a write ambiguous (spread, computed keys, holes). `appending` relaxes arrays. */
function assertAddressable(container: Container, path: PathSegment[], appending: boolean) {
  const items = itemsOf(container);
  for (const item of items) {
    if (item === null) throw blocked("HOLE", container, path);
    if (isSpread(item)) {
      if (appending && container.type === "ArrayExpression") continue;
      throw blocked("SPREAD", item, path);
    }
    if (container.type === "ObjectExpression" && staticKey(item) === null) throw blocked("COMPUTED_KEY", item, path);
  }
}

interface Located {
  /** Deepest node reached through matched segments. */
  node: N;
  /** Number of path segments matched. */
  matched: number;
  /** The member (ObjectProperty) or element holding `node`; null for the root. */
  member: N | null;
  /** Container of `member`. */
  parent: Container | null;
}

function locate(root: N, path: PathSegment[], file: ParsedFile, stopBeforeLast: boolean): Located {
  let node = root;
  let member: N | null = null;
  let parent: Container | null = null;
  let matched = 0;
  const limit = stopBeforeLast ? path.length : path.length;
  while (matched < limit) {
    const cur = unwrap(node);
    const seg = path[matched] as PathSegment;
    const so_far = path.slice(0, matched);
    if (cur.type !== "ObjectExpression" && cur.type !== "ArrayExpression") throw blocked(classify(cur, file), cur, so_far);
    const appendingLast = cur.type === "ArrayExpression" && matched === path.length - 1 && typeof seg === "number" && seg >= itemsOf(cur).length;
    assertAddressable(cur, so_far, appendingLast);
    if (cur.type === "ObjectExpression") {
      if (typeof seg !== "string") throw new CodecError("BAD_EDIT", `path segment ${seg} is an index but the node is an object`, { path });
      const props = (cur.properties as N[]).filter((p) => staticKey(p) === seg);
      const prop = props[props.length - 1];
      if (!prop) break;
      if (prop.type === "ObjectMethod") throw blocked("FUNCTION", prop, [...so_far, seg]);
      parent = cur;
      member = prop;
      node = prop.shorthand ? (prop.value as N) : (prop.value as N);
      if (prop.shorthand) {
        if (matched + 1 < path.length) throw blocked(classify(prop.value as N, file), prop, [...so_far, seg]);
      }
    } else {
      if (typeof seg !== "number") throw new CodecError("BAD_EDIT", `path segment "${seg}" is a key but the node is an array`, { path });
      const el = (cur.elements as Array<N | null>)[seg];
      if (el === undefined || el === null) break;
      parent = cur;
      member = el;
      node = el;
    }
    matched++;
  }
  return { node, matched, member, parent };
}

function leadingWhitespace(src: string, lineStart: number, upTo: number): string | null {
  const slice = src.slice(lineStart, upTo);
  return /^[ \t]*$/.test(slice) ? slice : null;
}

function lineStartOf(src: string, offset: number): number {
  return src.lastIndexOf("\n", offset - 1) + 1;
}

function lineEndOf(src: string, offset: number): number {
  const i = src.indexOf("\n", offset);
  return i === -1 ? src.length : i;
}

function detectIndentUnit(src: string): string {
  let best: string | null = null;
  const lines = src.split("\n", 400);
  for (const l of lines) {
    const m = /^([ \t]+)\S/.exec(l);
    if (m && (best === null || m[1]!.length < best.length)) best = m[1]!;
  }
  return best ?? "  ";
}

function detectQuote(program: N, src: string): string {
  let quote = '"';
  const visit = (n: unknown): boolean => {
    if (!n || typeof n !== "object") return false;
    const node = n as N;
    if (node.type === "StringLiteral" && typeof node.start === "number") {
      const ch = src[node.start];
      if (ch === "'" || ch === '"') {
        quote = ch;
        return true;
      }
    }
    for (const k of Object.keys(node)) {
      if (k === "loc" || k === "tokens" || k === "comments") continue;
      const v = node[k];
      if (Array.isArray(v)) {
        for (const x of v) if (visit(x)) return true;
      } else if (v && typeof v === "object" && visit(v)) return true;
    }
    return false;
  };
  visit(program);
  return quote;
}

interface Style {
  quote: string;
  unit: string;
  eol: string;
}

function quoteString(value: string, quote: string): string {
  const body = JSON.stringify(value).slice(1, -1);
  if (quote === "'") return `'${body.replace(/\\"/g, '"').replace(/'/g, "\\'")}'`;
  return `"${body}"`;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function serialize(value: unknown, style: Style, indent: string, quote: string = style.quote): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return quoteString(value, quote);
    case "number":
      if (!Number.isFinite(value)) throw new CodecError("BAD_EDIT", "numbers must be finite");
      return String(value);
    case "boolean":
      return String(value);
    case "object": {
      if (Array.isArray(value)) {
        if (value.length === 0) return "[]";
        const flat = value.map((v) => serialize(v, style, indent, quote));
        const line = `[${flat.join(", ")}]`;
        if (line.length <= 80 && !line.includes("\n")) return line;
        const inner = indent + style.unit;
        return `[${style.eol}${value.map((v) => inner + serialize(v, style, inner, quote)).join(`,${style.eol}`)}${style.eol}${indent}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return "{}";
      const keyText = (k: string) => (IDENT.test(k) ? k : quoteString(k, quote));
      const flat = `{ ${entries.map(([k, v]) => `${keyText(k)}: ${serialize(v, style, indent, quote)}`).join(", ")} }`;
      if (flat.length <= 80 && !flat.includes("\n")) return flat;
      const inner = indent + style.unit;
      return `{${style.eol}${entries.map(([k, v]) => `${inner}${keyText(k)}: ${serialize(v, style, inner, quote)}`).join(`,${style.eol}`)}${style.eol}${indent}}`;
    }
    default:
      throw new CodecError("BAD_EDIT", `a ${typeof value} can not be written to a JS configuration`);
  }
}

/** Quote of a string-like node (`'`, `"` or backtick). */
function quoteOf(node: N, src: string): string | undefined {
  const ch = src[node.start];
  return node.type === "StringLiteral" || node.type === "TemplateLiteral" ? (ch === "'" || ch === '"' ? ch : undefined) : undefined;
}

function indentOfLine(src: string, offset: number): string {
  const start = lineStartOf(src, offset);
  return /^[ \t]*/.exec(src.slice(start, lineEndOf(src, start)))![0];
}

/** Splices that add `entryText` (already `key: value` or the array item) to a container. */
function insertInto(container: Container, entryText: string, index: number | undefined, file: ParsedFile, style: Style): Splice[] {
  const src = file.src;
  const items = itemsOf(container) as N[];
  const open = container.start;
  const close = container.end - 1;
  if (items.length === 0) {
    const inner = src.slice(open + 1, close);
    const baseIndent = indentOfLine(src, open);
    const commentFree = /^\s*$/.test(inner);
    if (commentFree && !inner.includes("\n")) {
      const pad = container.type === "ObjectExpression" ? " " : "";
      return [{ start: open + 1, end: close, text: `${pad}${entryText}${pad}` }];
    }
    const text = `${style.eol}${baseIndent}${style.unit}${entryText}${style.eol}${baseIndent}`;
    return commentFree ? [{ start: open + 1, end: close, text }] : [{ start: close, end: close, text: `${style.eol}${baseIndent}${style.unit}${entryText}${style.eol}${baseIndent}` }];
  }
  const first = items[0] as N;
  const lineIndent = leadingWhitespace(src, lineStartOf(src, first.start), first.start);
  const multiline = lineIndent !== null && src.slice(open, first.start).includes("\n");
  const at_ = index === undefined ? items.length : Math.min(Math.max(index, 0), items.length);
  if (at_ < items.length) {
    const next = items[at_] as N;
    if (multiline) {
      const ind = leadingWhitespace(src, lineStartOf(src, next.start), next.start) ?? lineIndent;
      const ls = lineStartOf(src, next.start);
      const onOwnLine = leadingWhitespace(src, ls, next.start) !== null;
      return onOwnLine ? [{ start: ls, end: ls, text: `${ind}${entryText},${style.eol}` }] : [{ start: next.start, end: next.start, text: `${entryText},${style.eol}${ind}` }];
    }
    return [{ start: next.start, end: next.start, text: `${entryText}, ` }];
  }
  const last = items[items.length - 1] as N;
  if (!multiline) return [{ start: last.end, end: last.end, text: `, ${entryText}` }];
  // Multi-line: add after the last item's line (past a trailing comma and a same-line comment), keeping comments with their items.
  let p = last.end;
  while (src[p] === " " || src[p] === "\t") p++;
  const hadComma = src[p] === ",";
  if (hadComma) p++;
  let q = p;
  while (src[q] === " " || src[q] === "\t") q++;
  let lineEnd = p;
  if (src.startsWith("//", q)) lineEnd = lineEndOf(src, q);
  else if (src.startsWith("/*", q)) {
    const c = src.indexOf("*/", q);
    if (c !== -1 && !src.slice(c, lineEndOf(src, c)).slice(2).trim()) lineEnd = c + 2;
  }
  if (lineEnd > p && src[lineEnd - 1] === "\r") lineEnd--;
  const out: Splice[] = [];
  if (!hadComma) out.push({ start: last.end, end: last.end, text: "," });
  out.push({ start: lineEnd, end: lineEnd, text: `${style.eol}${lineIndent}${entryText}${hadComma ? "," : ""}` });
  return out;
}

/** Splices that remove one member or element, with its comma and, when it owns its line, the line. */
function removeFrom(container: Container, member: N, file: ParsedFile): Splice[] {
  const src = file.src;
  const items = itemsOf(container) as N[];
  const idx = items.indexOf(member);
  const ls = lineStartOf(src, member.start);
  const ownLineStart = leadingWhitespace(src, ls, member.start) !== null;
  let p = member.end;
  while (src[p] === " " || src[p] === "\t") p++;
  const hasComma = src[p] === ",";
  const afterItem = hasComma ? p + 1 : member.end;
  let q = afterItem;
  while (src[q] === " " || src[q] === "\t") q++;
  let restEnd = q;
  if (src.startsWith("//", q)) restEnd = lineEndOf(src, q);
  const lineEnd = lineEndOf(src, restEnd);
  const restIsEmpty = /^[ \t\r]*$/.test(src.slice(restEnd, lineEnd));
  const wholeLine = ownLineStart && restIsEmpty && (src[q] === "\n" || src[q] === "\r" || q === src.length || restEnd > q);
  const lineRemoval = (): Splice => ({ start: ls, end: Math.min(lineEnd + 1, src.length), text: "" });
  const out: Splice[] = [];
  if (!hasComma && idx > 0) {
    const prev = items[idx - 1] as N;
    let c = prev.end;
    for (;;) {
      while (/\s/.test(src[c] ?? "")) c++;
      if (src.startsWith("//", c)) c = lineEndOf(src, c);
      else if (src.startsWith("/*", c)) c = src.indexOf("*/", c) + 2;
      else break;
    }
    if (src[c] === ",") out.push({ start: c, end: c + 1, text: "" });
  }
  if (wholeLine) out.push(lineRemoval());
  else {
    let s = member.start;
    if (!hasComma && idx > 0) while (s > 0 && (src[s - 1] === " " || src[s - 1] === "\t")) s--;
    let e = afterItem;
    if (hasComma) while (src[e] === " " || src[e] === "\t") e++;
    out.push({ start: s, end: e, text: "" });
  }
  return out;
}

function applySplices(src: string, splices: Splice[]): string {
  const sorted = [...splices].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = src;
  for (const s of sorted) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}

function nestedValue(rest: PathSegment[], value: unknown): unknown {
  let out = value;
  for (let i = rest.length - 1; i >= 0; i--) {
    const seg = rest[i] as PathSegment;
    if (typeof seg === "number") {
      if (seg !== 0) throw new CodecError("BAD_EDIT", "a new array can only be created with its first item at index 0", { path: rest });
      out = [out];
    } else out = { [seg]: out };
  }
  return out;
}

function planEdit(file: ParsedFile, root: Root, edit: FieldEdit): Splice[] {
  const t = translator("codecs-js");
  if (!root.node) {
    if (root.reason && root.at) throw blocked(root.reason, root.at, []);
    throw blocked("NO_CONFIG_ROOT", null, []);
  }
  if (!["set", "delete", "insert"].includes(edit.op)) throw new CodecError("BAD_EDIT", `unknown edit operation "${String(edit.op)}"`);
  const path = edit.path;
  const style: Style = { quote: detectQuote(file.program, file.src), unit: detectIndentUnit(file.src), eol: file.eol };
  const rootNode = root.node;

  if (path.length === 0) {
    if (edit.op !== "set") throw new CodecError("BAD_EDIT", "the root can only be replaced");
    if (!deepStatic(rootNode)) throw blocked("NOT_STATIC", rootNode, path);
    return [{ start: rootNode.start, end: rootNode.end, text: serialize(edit.value, style, indentOfLine(file.src, rootNode.start)) }];
  }

  const insertOp = edit.op === "insert";
  const lookupPath = insertOp ? path : path;
  const loc = locate(rootNode, lookupPath, file, false);
  const full = loc.matched === lookupPath.length;

  if (edit.op === "delete") {
    if (!full) return [];
    if (!loc.member || !loc.parent) throw new CodecError("BAD_EDIT", "the root can only be replaced");
    if (!deepStatic(loc.member.type === "ObjectProperty" ? (loc.member.value as N) : loc.member)) throw blocked("NOT_STATIC", loc.member, path);
    return removeFrom(loc.parent, loc.member, file);
  }

  if (insertOp) {
    if (full) {
      const arr = unwrap(loc.node);
      if (arr.type !== "ArrayExpression") throw blocked(arr.type === "ObjectExpression" ? "UNSUPPORTED" : classify(arr, file), arr, path);
      assertAddressable(arr, path, edit.index === undefined || edit.index >= itemsOf(arr).length);
      const parentIndent = indentOfLine(file.src, arr.start);
      const text = serialize(edit.value, style, parentIndent + style.unit, quoteOfFirst(arr, file) ?? style.quote);
      return insertInto(arr, text, edit.index, file, style);
    }
    // The array does not exist yet: create it with the item.
    return planSet(file, loc, path, [edit.value], style);
  }

  if (full) {
    const target = unwrap(loc.node);
    if (!deepStatic(target)) throw blocked("NOT_STATIC", target, path);
    const old = quoteOf(target, file.src);
    const text = serialize(edit.value, style, indentOfLine(file.src, target.start), old ?? style.quote);
    return [{ start: target.start, end: target.end, text }];
  }
  void t;
  return planSet(file, loc, path, edit.value, style);
}

function quoteOfFirst(arr: N, file: ParsedFile): string | undefined {
  for (const el of arr.elements as Array<N | null>) if (el && el.type === "StringLiteral") return quoteOf(el, file.src);
  return undefined;
}

/** `set` of a path whose tail does not exist: adds the missing key (or array item) to the deepest existing container. */
function planSet(file: ParsedFile, loc: Located, path: PathSegment[], value: unknown, style: Style): Splice[] {
  const container = unwrap(loc.node);
  const rest = path.slice(loc.matched);
  const seg = rest[0] as PathSegment;
  const indent = indentOfLine(file.src, container.start);
  const innerIndent = style.eol && container.type ? indent + style.unit : indent;
  const nested = nestedValue(rest.slice(1), value);
  const valueText = serialize(nested, style, innerIndent);
  if (container.type === "ObjectExpression") {
    const key = IDENT.test(String(seg)) ? String(seg) : quoteString(String(seg), style.quote);
    return insertInto(container, `${key}: ${valueText}`, undefined, file, style);
  }
  if (container.type === "ArrayExpression") {
    const length = itemsOf(container).length;
    if (typeof seg !== "number" || seg !== length) throw new CodecError("BAD_EDIT", `index ${String(seg)} is outside the array (length ${length}); use insert`, { path });
    return insertInto(container, valueText, undefined, file, style);
  }
  throw blocked(classify(container, file), container, path.slice(0, loc.matched));
}

// ---------------------------------------------------------------------------------------------------------------------
// Codec

function assertWritableValue(edit: FieldEdit) {
  if (edit.op === "delete") return;
  const check = (v: unknown, depth = 0) => {
    if (depth > 64) throw new CodecError("BAD_EDIT", "value nested too deeply");
    if (v === null || ["string", "boolean"].includes(typeof v)) return;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new CodecError("BAD_EDIT", "numbers must be finite");
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => check(x, depth + 1));
    if (typeof v === "object") return Object.values(v as object).forEach((x) => check(x, depth + 1));
    throw new CodecError("BAD_EDIT", `a ${typeof v} can not be written to a JS configuration`);
  };
  check(edit.value);
}

export interface EditCheck {
  ok: boolean;
  /** Reason code (`SPREAD`, `FUNCTION`, `NOT_STATIC`, ...) and message when the visual edit is refused. */
  reason?: string;
  message?: string;
  line?: number;
  column?: number;
}

/** Whether a visual edit would be accepted, without producing text. The text editor is always available. */
export function checkEdit(text: string, edit: FieldEdit, options?: CodecOptions): EditCheck {
  try {
    const file = parseFile(text, resolveDialect(options));
    if (file.errors.length) return { ok: false, reason: "SYNTAX", message: file.errors[0]!.message, ...(file.errors[0]!.line ? { line: file.errors[0]!.line } : {}) };
    assertWritableValue(edit);
    planEdit(file, findRoot(file), edit);
    return { ok: true };
  } catch (error) {
    if (error instanceof CodecError) {
      const d = error.details as { reason?: string; line?: number; column?: number };
      return { ok: false, reason: d.reason ?? error.code, message: error.message, ...(d.line ? { line: d.line } : {}), ...(d.column ? { column: d.column } : {}) };
    }
    throw error;
  }
}

export function patchJsText(text: string, edits: readonly FieldEdit[], options?: CodecOptions): CodecPatchResult {
  const dialect = resolveDialect(options);
  if (edits.length === 0) return { text, changed: false, warnings: [] };
  const t = translator("codecs-js");
  let current = text;
  for (const edit of edits) {
    assertWritableValue(edit);
    const file = parseFile(current, dialect);
    if (file.errors.length) throw new CodecError("PARSE", t("codecs_js_parse_failed", { reason: file.errors[0]!.message }), { errors: file.errors });
    const root = findRoot(file);
    const before = project(file, root).value;
    const splices = planEdit(file, root, edit);
    if (splices.length === 0) continue;
    const nextSrc = applySplices(file.src, splices);
    const next = file.bom + nextSrc;
    const after = parseFile(next, dialect);
    const expected = applyEditsToValue(before, [edit]);
    const reread = after.errors.length === 0 ? project(after, findRoot(after)).value : undefined;
    if (after.errors.length > 0 || !sameValue(reread, expected)) {
      throw new CodecError("PATCH_FAILED", t("codecs_js_patch_failed"), { edit, errors: after.errors });
    }
    current = next;
  }
  return { text: current, changed: current !== text, warnings: [] };
}

export const jsCodec: Codec = {
  id: "js",
  dialects: DIALECTS,
  read: readJs,
  apply: patchJsText,
};
