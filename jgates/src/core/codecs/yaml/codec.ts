import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments, parseDocument, stringify, visit, type Document, type Node as YamlNode, type YAMLSeq } from "yaml";
import {
  applyEditsToValue,
  CodecError,
  sameValue,
  type Codec,
  type CodecDiagnostic,
  type CodecDocument,
  type CodecOptions,
  type CodecPatchResult,
  type CodecWarning,
  type FieldEdit,
  type FieldInfo,
  type PathSegment,
  type ValueKind,
} from "../types.js";
import { patchYamlText, YamlPatchError } from "./index.js";

/**
 * YAML codec: the common Codec contract on top of the YAML text patcher (`patchYamlText`). Rules:
 *  - Schema core, YAML 1.2, no custom tags. Unresolved tags are reported as warnings and kept as they are.
 *  - Anchors and aliases are never expanded. Editing a value that other nodes reach through an alias (or a node
 *    inside one) changes every consumer; the patch is applied to the anchor and a SHARED_BY_ALIAS warning is returned.
 *    Setting a node that is itself an alias replaces the reference with a local value (ALIAS_OVERRIDDEN).
 *  - Merge keys (`<<`) are not interpreted: `<<` is an ordinary key whose alias value is preserved. Adding a key next
 *    to it is a local override (MERGE_OVERRIDE warning when the key is not local yet).
 *  - A path that goes through an alias is refused (UNSUPPORTED): edit the anchor instead.
 *  - Streams with several documents can be read (the first one is modelled, with a MULTI_DOCUMENT warning) but not
 *    edited: the textual editor is the fallback.
 *  - Block sequences are patched line by line (insert, delete, scalar replace); other shapes use the patcher's text
 *    splice, then the Document API as the last resort. Every step is checked by re-parsing.
 */

const PARSE_OPTIONS = { schema: "core", version: "1.2", uniqueKeys: true, merge: false, keepSourceTokens: true } as const;

type Range = [number, number, number];

function stripBom(input: string): { bom: string; text: string } {
  return input.charCodeAt(0) === 0xfeff ? { bom: "﻿", text: input.slice(1) } : { bom: "", text: input };
}

function kindOfValue(v: unknown): ValueKind {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v === "object" ? "object" : (typeof v as "string" | "number" | "boolean");
}

function countAliases(doc: Document): Map<string, number> {
  const counts = new Map<string, number>();
  visit(doc, {
    Alias(_key, node) {
      counts.set(node.source, (counts.get(node.source) ?? 0) + 1);
    },
  });
  return counts;
}

function collect(doc: Document, lc: LineCounter, counts: Map<string, number>): FieldInfo[] {
  const out: FieldInfo[] = [];
  const add = (node: YamlNode, path: PathSegment[]): void => {
    const range = node.range as Range | null | undefined;
    if (!range) return;
    const pos = lc.linePos(range[0]);
    const info: FieldInfo = { path, kind: "null", start: range[0], end: range[1], line: pos.line, column: pos.col };
    if (isAlias(node)) {
      info.aliasOf = node.source;
      info.kind = kindOfValue(node.resolve(doc)?.toJSON?.() ?? null);
    } else if (isMap(node)) info.kind = "object";
    else if (isSeq(node)) info.kind = "array";
    else if (isScalar(node)) info.kind = kindOfValue(node.value);
    if (!isAlias(node) && node.anchor) {
      info.anchor = node.anchor;
      info.aliases = counts.get(node.anchor) ?? 0;
    }
    out.push(info);
    if (isMap(node)) {
      for (const pair of node.items) {
        if (isScalar(pair.key) && pair.value && typeof pair.value === "object") add(pair.value as YamlNode, [...path, String(pair.key.value)]);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => {
        if (item && typeof item === "object") add(item as YamlNode, [...path, i]);
      });
    }
  };
  if (doc.contents) add(doc.contents as YamlNode, []);
  return out;
}

function read(input: string, _options?: CodecOptions): CodecDocument {
  const { text } = stripBom(input);
  const lc = new LineCounter();
  const docs = parseAllDocuments(text, { ...PARSE_OPTIONS, lineCounter: lc });
  const list = Array.isArray(docs) ? docs : [docs];
  const first = list[0];
  const diag = (e: { code: string; message: string; linePos?: [{ line: number; col: number }, unknown?] | undefined; pos?: [number, number] }): CodecDiagnostic => ({
    code: e.code,
    message: e.message.split("\n")[0] ?? e.code,
    ...(e.linePos?.[0] ? { line: e.linePos[0].line, column: e.linePos[0].col } : {}),
    ...(e.pos ? { offset: e.pos[0] } : {}),
  });
  const errors = list.flatMap((d) => d.errors.map(diag));
  const warnings = list.flatMap((d) => d.warnings.map(diag));
  if (list.length > 1) warnings.push({ code: "MULTI_DOCUMENT", message: `the stream has ${list.length} documents; only the first one is modelled and editing is disabled` });
  if (!first) return { ok: errors.length === 0, dialect: "yaml", value: null, fields: [], errors, warnings, documents: 0 };
  const counts = countAliases(first);
  return {
    ok: errors.length === 0,
    dialect: "yaml",
    value: errors.length === 0 ? first.toJS() : null,
    fields: errors.length === 0 ? collect(first, lc, counts) : [],
    errors,
    warnings,
    documents: list.length,
  };
}

/** Child of a collection node by path segment; undefined when missing or when the node is not a collection. */
function child(node: unknown, seg: PathSegment): unknown {
  if (isMap(node) && typeof seg === "string") return node.items.find((p) => isScalar(p.key) && String(p.key.value) === seg)?.value ?? undefined;
  if (isSeq(node) && typeof seg === "number") return node.items[seg];
  return undefined;
}

/** Looks at the path before the edit: shared values, aliases in the way, merge keys. Throws for paths through aliases. */
function analyze(doc: Document.Parsed, edit: FieldEdit, editIndex: number): CodecWarning[] {
  const counts = countAliases(doc);
  const warnings: CodecWarning[] = [];
  const at = (code: string, message: string): void => void warnings.push({ code, message, editIndex, path: edit.path });
  let node: unknown = doc.contents;
  const check = (n: unknown): void => {
    const anchor = (n as { anchor?: string } | null)?.anchor;
    if (anchor && (counts.get(anchor) ?? 0) > 0) {
      const aliases = counts.get(anchor) as number;
      at("SHARED_BY_ALIAS", `the value is shared by ${aliases} alias(es) of &${anchor}: the change reaches every consumer`);
    }
  };
  check(node);
  const walkLength = edit.path.length;
  for (let i = 0; i < walkLength; i++) {
    if (isAlias(node)) throw new CodecError("UNSUPPORTED", `the path goes through the alias *${node.source}; edit the anchor &${node.source} instead`, { path: edit.path });
    const seg = edit.path[i] as PathSegment;
    const next = child(node, seg);
    if (next === undefined) {
      if (isMap(node) && i === walkLength - 1 && edit.op === "set" && node.items.some((p) => isScalar(p.key) && p.key.value === "<<")) {
        at("MERGE_OVERRIDE", `"${String(seg)}" is not local to this map: a local key is added next to the merge key`);
      }
      return dedupe(warnings);
    }
    node = next;
    check(node);
  }
  if (isAlias(node) && edit.op === "set") at("ALIAS_OVERRIDDEN", `the value is the alias *${node.source}: the reference is replaced by a local value`);
  return dedupe(warnings);
}

function dedupe(list: CodecWarning[]): CodecWarning[] {
  const seen = new Set<string>();
  return list.filter((w) => (seen.has(w.code + w.message) ? false : (seen.add(w.code + w.message), true)));
}

function lineStartOf(text: string, offset: number): number {
  const i = text.lastIndexOf("\n", offset - 1);
  return i === -1 ? 0 : i + 1;
}

function endOfLine(text: string, offset: number): number {
  if (offset > 0 && text[offset - 1] === "\n") return offset;
  const i = text.indexOf("\n", offset);
  return i === -1 ? text.length : i + 1;
}

function blockLines(value: unknown): string[] {
  return stringify(value, { lineWidth: 0, indent: 2, schema: "core" }).replace(/\n$/, "").split("\n");
}

function isScalarValue(v: unknown): boolean {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** Column of the "-" of a block sequence item; undefined when the item does not start its own line. */
function dashColumn(text: string, item: { range?: Range | null }): number | undefined {
  if (!item.range) return undefined;
  const start = lineStartOf(text, item.range[0]);
  const lead = text.slice(start, item.range[0]);
  return /^[ ]*-[ ]+$/.test(lead) ? lead.indexOf("-") : undefined;
}

/** Line-based splice for block sequences; undefined when the shape needs another strategy. */
function seqSplice(text: string, doc: Document.Parsed, edit: FieldEdit, eol: string): string | undefined {
  const isInsert = edit.op === "insert";
  const parentPath = isInsert ? edit.path : edit.path.slice(0, -1);
  let seq: unknown = doc.contents;
  for (const seg of parentPath) seq = child(seq, seg);
  if (!isSeq(seq) || seq.flow || seq.items.length === 0) return undefined;
  const items = (seq as YAMLSeq).items as Array<{ range?: Range | null }>;
  const dash = dashColumn(text, items[0] as { range?: Range | null });
  if (dash === undefined) return undefined;
  const pad = " ".repeat(dash);

  if (isInsert) {
    const at = edit.index === undefined ? items.length : Math.min(Math.max(edit.index, 0), items.length);
    const lines = blockLines(edit.value).map((l, i) => (i === 0 ? `${pad}- ${l}` : `${pad}  ${l}`));
    if (at < items.length) {
      const target = items[at] as { range?: Range | null };
      if (!target.range) return undefined;
      const start = lineStartOf(text, target.range[0]);
      return text.slice(0, start) + lines.join(eol) + eol + text.slice(start);
    }
    const last = items[items.length - 1] as { range?: Range | null };
    if (!last.range) return undefined;
    const pos = endOfLine(text, last.range[1]);
    const needsBreak = pos > 0 && text[pos - 1] !== "\n";
    return text.slice(0, pos) + (needsBreak ? eol : "") + lines.join(eol) + eol + text.slice(pos);
  }

  const index = edit.path[edit.path.length - 1];
  if (typeof index !== "number") return undefined;
  const target = items[index];
  if (!target?.range) return undefined;
  if (edit.op === "delete") {
    if (items.length === 1) return undefined;
    const start = lineStartOf(text, target.range[0]);
    return text.slice(0, start) + text.slice(endOfLine(text, target.range[1]));
  }
  // set: only a plain scalar replaced by a plain scalar
  const node = items[index] as unknown;
  if (isScalar(node) && isScalarValue(edit.value) && node.type !== "BLOCK_FOLDED" && node.type !== "BLOCK_LITERAL") {
    const rendered = blockLines(edit.value);
    if (rendered.length !== 1) return undefined;
    return text.slice(0, target.range[0]) + (rendered[0] as string) + text.slice(target.range[1]);
  }
  return undefined;
}

/** Insert through the Document API: empty or flow sequences, missing arrays. */
function documentInsert(text: string, edit: FieldEdit, eol: string): string {
  const doc = parseDocument(text, PARSE_OPTIONS);
  const target = doc.getIn(edit.path, true);
  if (isSeq(target)) {
    const at = edit.index === undefined ? target.items.length : Math.min(Math.max(edit.index, 0), target.items.length);
    target.items.splice(at, 0, doc.createNode(edit.value));
  } else if (target === undefined || target === null) {
    doc.setIn(edit.path, [edit.value]);
  } else {
    throw new CodecError("BAD_EDIT", "insert needs an array at the path", { path: edit.path });
  }
  const out = doc.toString({ lineWidth: 0, indent: 2 });
  return eol === "\r\n" ? out.replace(/\r?\n/g, "\r\n") : out;
}

/** What the document holds after one edit when aliases keep pointing at their anchors (Document API semantics). */
function expectedWithAliases(text: string, edit: FieldEdit): unknown {
  const doc = parseDocument(text, PARSE_OPTIONS);
  if (edit.op === "set") doc.setIn(edit.path, edit.value);
  else if (edit.op === "delete") doc.deleteIn(edit.path);
  else {
    const target = doc.getIn(edit.path, true);
    if (isSeq(target)) target.items.splice(edit.index ?? target.items.length, 0, doc.createNode(edit.value));
    else doc.setIn(edit.path, [edit.value]);
  }
  return doc.toJS();
}

function parseValue(text: string): unknown {
  const doc = parseDocument(text, PARSE_OPTIONS);
  if (doc.errors.length > 0) throw new CodecError("PARSE", doc.errors[0]?.message.split("\n")[0] ?? "invalid YAML");
  return doc.toJS();
}

function apply(input: string, edits: readonly FieldEdit[], _options?: CodecOptions): CodecPatchResult {
  const { bom, text: original } = stripBom(input);
  if (edits.length === 0) return { text: input, changed: false, warnings: [] };
  const docs = parseAllDocuments(original, PARSE_OPTIONS);
  const list = Array.isArray(docs) ? docs : [docs];
  if (list.length > 1) throw new CodecError("MULTI_DOCUMENT", "the stream has several documents; edit it as text");
  const firstError = list[0]?.errors[0];
  if (firstError) throw new CodecError("PARSE", firstError.message.split("\n")[0] ?? "invalid YAML");

  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const warnings: CodecWarning[] = [];
  let text = original;
  edits.forEach((edit, editIndex) => {
    if (edit.path.length === 0) throw new CodecError("UNSUPPORTED", "the whole document cannot be replaced by a field edit");
    if (edit.op === "set" && edit.value === undefined) throw new CodecError("BAD_EDIT", "set needs a value (use delete to remove)");
    const doc = parseDocument(text, PARSE_OPTIONS);
    const found = analyze(doc, edit, editIndex);
    warnings.push(...found);
    const shared = found.some((w) => w.code === "SHARED_BY_ALIAS");
    const expected = shared ? expectedWithAliases(text, edit) : applyEditsToValue(doc.toJS(), [edit]);

    const viaSeq = seqSplice(text, doc, edit, eol);
    if (viaSeq !== undefined) {
      let ok = false;
      try {
        ok = sameValue(parseValue(viaSeq), expected);
      } catch {
        ok = false;
      }
      if (ok) {
        text = viaSeq;
        return;
      }
    }
    if (edit.op === "insert") {
      const out = documentInsert(text, edit, eol);
      if (!sameValue(parseValue(out), expected)) throw new CodecError("PATCH_FAILED", "the patch would not produce the expected document");
      text = out;
      return;
    }
    try {
      text = patchYamlText(text, [{ op: edit.op, path: edit.path, ...(edit.op === "set" ? { value: edit.value } : {}) }], { expected }).text;
    } catch (error) {
      if (error instanceof YamlPatchError) throw new CodecError(error.code === "YAML_PARSE" ? "PARSE" : "PATCH_FAILED", error.message);
      throw error;
    }
  });
  return { text: bom + text, changed: text !== original, warnings };
}

export const yamlCodec: Codec = { id: "yaml", dialects: ["yaml"], read, apply };
export { read as readYaml, apply as applyYamlEdits };
