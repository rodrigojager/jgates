import { applyEdits, modify, parse, parseTree, printParseErrorCode, type FormattingOptions, type Node, type ParseError, type ParseOptions } from "jsonc-parser";
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
 * JSON and JSONC codec on top of jsonc-parser. Edits are text splices at the ranges the parser reports, so comments,
 * key order, unknown fields and formatting stay as they were. The dialect is a decision of the caller: a "json"
 * document never accepts comments or trailing commas, and a patch of it never produces them (strict JSON never
 * turns into JSONC).
 */

export type JsonDialect = "json" | "jsonc";

const DIALECTS: readonly JsonDialect[] = ["json", "jsonc"];

/** "jsonc" for .jsonc files, "json" for everything else; callers that know better pass the dialect themselves. */
export function dialectForFile(file: string): JsonDialect {
  return /\.jsonc$/i.test(file) ? "jsonc" : "json";
}

function resolveDialect(options: CodecOptions | undefined): JsonDialect {
  const dialect = options?.dialect ?? "json";
  if (!DIALECTS.includes(dialect as JsonDialect)) throw new CodecError("DIALECT", `unknown JSON dialect "${dialect}"`);
  return dialect as JsonDialect;
}

function parseOptions(dialect: JsonDialect): ParseOptions {
  return dialect === "jsonc" ? { allowTrailingComma: true, disallowComments: false } : { allowTrailingComma: false, disallowComments: true };
}

function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++;
    last = i;
  }
  return { line, column: offset - last };
}

function diagnose(text: string, errors: ParseError[]): CodecDiagnostic[] {
  return errors.map((e) => ({ code: printParseErrorCode(e.error), message: printParseErrorCode(e.error), offset: e.offset, ...lineColumn(text, e.offset) }));
}

function kindOf(node: Node): ValueKind {
  switch (node.type) {
    case "object":
    case "array":
    case "string":
    case "number":
    case "boolean":
    case "null":
      return node.type;
    default:
      return "null";
  }
}

function collect(text: string, node: Node, path: PathSegment[], out: FieldInfo[]): void {
  out.push({ path, kind: kindOf(node), start: node.offset, end: node.offset + node.length, ...lineColumn(text, node.offset) });
  if (node.type === "object") {
    for (const prop of node.children ?? []) {
      const [key, value] = prop.children ?? [];
      if (key && value) collect(text, value, [...path, String(key.value)], out);
    }
  } else if (node.type === "array") {
    (node.children ?? []).forEach((child, i) => collect(text, child, [...path, i], out));
  }
}

function stripBom(input: string): { bom: string; text: string } {
  return input.charCodeAt(0) === 0xfeff ? { bom: "﻿", text: input.slice(1) } : { bom: "", text: input };
}

function read(input: string, options?: CodecOptions): CodecDocument {
  const dialect = resolveDialect(options);
  const { text } = stripBom(input);
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, parseOptions(dialect));
  const value = parse(text, [], parseOptions(dialect));
  const fields: FieldInfo[] = [];
  if (tree) collect(text, tree, [], fields);
  return { ok: errors.length === 0 && tree !== undefined, dialect, value, fields, errors: diagnose(text, errors), warnings: [], documents: 1 };
}

/** Indentation style of the file, so inserted text looks like the rest. */
function detectFormatting(text: string): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const match = /\n([ \t]+)\S/.exec(text);
  if (!match) return { insertSpaces: true, tabSize: 2, eol };
  const indent = match[1] as string;
  if (indent.startsWith("\t")) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: indent.length, eol };
}

function ensureValid(text: string, dialect: JsonDialect): unknown {
  const errors: ParseError[] = [];
  const value = parse(text, errors, parseOptions(dialect));
  if (errors.length > 0) {
    const first = diagnose(text, errors)[0] as CodecDiagnostic;
    throw new CodecError("PARSE", `invalid ${dialect}: ${first.message} at ${first.line}:${first.column}`, { line: first.line, column: first.column });
  }
  return value;
}

function nodeAt(root: Node | undefined, path: readonly PathSegment[]): Node | undefined {
  let node = root;
  for (const seg of path) {
    if (!node) return undefined;
    if (node.type === "object" && typeof seg === "string") {
      const prop = (node.children ?? []).find((p) => p.children?.[0]?.value === seg);
      node = prop?.children?.[1];
    } else if (node.type === "array" && typeof seg === "number") {
      node = node.children?.[seg];
    } else {
      return undefined;
    }
  }
  return node;
}

function checkEdit(edit: FieldEdit): void {
  if (edit.path.length === 0) throw new CodecError("UNSUPPORTED", "the whole document cannot be replaced by a field edit");
  if (edit.op === "set" && edit.value === undefined) throw new CodecError("BAD_EDIT", "set needs a value (use delete to remove)");
  if (edit.op === "insert" && edit.value === undefined) throw new CodecError("BAD_EDIT", "insert needs a value");
}

function apply(input: string, edits: readonly FieldEdit[], options?: CodecOptions): CodecPatchResult {
  const dialect = resolveDialect(options);
  const { bom, text: original } = stripBom(input);
  const before = ensureValid(original, dialect);
  if (edits.length === 0) return { text: input, changed: false, warnings: [] };

  const formattingOptions = detectFormatting(original);
  let text = original;
  for (const edit of edits) {
    checkEdit(edit);
    let changes;
    if (edit.op === "set") {
      changes = modify(text, edit.path, edit.value, { formattingOptions });
    } else if (edit.op === "delete") {
      if (!nodeAt(parseTree(text, [], parseOptions(dialect)), edit.path)) continue;
      changes = modify(text, edit.path, undefined, { formattingOptions });
    } else {
      const arrayNode = nodeAt(parseTree(text, [], parseOptions(dialect)), edit.path);
      if (!arrayNode) {
        changes = modify(text, edit.path, [edit.value], { formattingOptions });
      } else if (arrayNode.type !== "array") {
        throw new CodecError("BAD_EDIT", "insert needs an array at the path", { path: edit.path });
      } else {
        const length = arrayNode.children?.length ?? 0;
        const at = edit.index === undefined ? length : Math.min(Math.max(edit.index, 0), length);
        changes = modify(text, [...edit.path, at], edit.value, { formattingOptions, isArrayInsertion: true });
      }
    }
    text = applyEdits(text, changes);
  }

  const after = ensureValid(text, dialect);
  if (!sameValue(after, applyEditsToValue(before, edits))) {
    throw new CodecError("PATCH_FAILED", "the patch would not produce the expected document");
  }
  return { text: bom + text, changed: text !== original, warnings: [] };
}

export const jsonCodec: Codec = { id: "json", dialects: DIALECTS, read, apply };
export { read as readJson, apply as patchJsonText };
