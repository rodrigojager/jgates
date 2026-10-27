import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Document, isMap, isScalar, isSeq, parseDocument, stringify, type Pair, type YAMLMap } from "yaml";

/**
 * Patch of YAML files that touches only the text it has to: comments, blank lines, quoting and ordering of
 * everything else stay byte for byte. The fast path edits the source text at the ranges the parser reports
 * (a CST-level splice); when the shape does not allow it (flow maps, a missing parent, an empty map) the document
 * is changed through the Document API instead. Either way the result is re-parsed and compared with the expected
 * value, so a wrong patch is never written. Files carry an optimistic revision: the sha256 of their bytes.
 */

export type PathSegment = string | number;

export interface YamlEdit {
  op: "set" | "delete";
  path: PathSegment[];
  /** The new value for "set". */
  value?: unknown;
}

export type PatchErrorCode = "YAML_CONFLICT" | "YAML_MISSING" | "YAML_EXISTS" | "YAML_PARSE" | "YAML_PATCH_FAILED" | "YAML_IO";

export class YamlPatchError extends Error {
  constructor(
    readonly code: PatchErrorCode,
    message: string,
    readonly details: { expectedHash?: string | null; currentHash?: string | null; file?: string } = {},
  ) {
    super(message);
    this.name = "YamlPatchError";
  }
}

/** Revision of a file: sha256 (hex) of its bytes. */
export function hashBytes(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export interface FileRevision {
  exists: boolean;
  text: string;
  /** null when the file does not exist. */
  hash: string | null;
}

export function readRevision(absolute: string): FileRevision {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, text: "", hash: null };
    throw new YamlPatchError("YAML_IO", (error as Error).message, { file: absolute });
  }
  return { exists: true, text: bytes.toString("utf8"), hash: hashBytes(bytes) };
}

const PARSE_OPTIONS = { schema: "core", version: "1.2", uniqueKeys: true, merge: false, keepSourceTokens: true } as const;

function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  return v !== null && typeof v === "object";
}

/** Applies the edits to a plain JS value (the expected outcome the text patch is checked against). */
function applyToValue(root: unknown, edits: readonly YamlEdit[]): unknown {
  const clone = structuredClone(root ?? {}) as unknown;
  for (const edit of edits) {
    if (edit.path.length === 0) throw new YamlPatchError("YAML_PATCH_FAILED", "empty path");
    let node: unknown = clone;
    for (let i = 0; i < edit.path.length - 1; i++) {
      const key = edit.path[i] as PathSegment;
      const holder = node as Record<string, unknown>;
      let next = holder[key as string];
      if (!isContainer(next)) {
        if (edit.op === "delete") {
          next = undefined;
          break;
        }
        next = typeof edit.path[i + 1] === "number" ? [] : {};
        holder[key as string] = next;
      }
      node = next;
    }
    if (!isContainer(node)) continue;
    const last = edit.path[edit.path.length - 1] as PathSegment;
    if (edit.op === "set") (node as Record<string, unknown>)[last as string] = structuredClone(edit.value);
    else if (Array.isArray(node)) node.splice(Number(last), 1);
    else delete (node as Record<string, unknown>)[last as string];
  }
  return clone;
}

function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Block YAML of `{ key: value }` as lines (no trailing newline). */
function entryLines(key: string, value: unknown): string[] {
  const out = stringify({ [key]: value }, { lineWidth: 0, indent: 2, schema: "core" });
  return out.replace(/\n$/, "").split("\n");
}

/** Block YAML of a value as lines (no trailing newline). */
function valueLines(value: unknown): string[] {
  return stringify(value, { lineWidth: 0, indent: 2, schema: "core" }).replace(/\n$/, "").split("\n");
}

function lineStartOf(text: string, offset: number): number {
  const i = text.lastIndexOf("\n", offset - 1);
  return i === -1 ? 0 : i + 1;
}

/** End of the line that holds `offset`, including its line break (or the end of the text). */
function endOfLine(text: string, offset: number): number {
  if (offset > 0 && text[offset - 1] === "\n") return offset;
  const i = text.indexOf("\n", offset);
  return i === -1 ? text.length : i + 1;
}

function isScalarValue(v: unknown): boolean {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** Walks to the map at `segments` (map keys and sequence indexes); undefined when anything on the way is not a block-or-flow map. */
function mapAt(doc: Document.Parsed, segments: readonly PathSegment[]): YAMLMap | undefined {
  let node: unknown = doc.contents;
  for (const seg of segments) {
    if (isSeq(node) && typeof seg === "number") node = node.items[seg];
    else if (isMap(node) && typeof seg === "string") node = node.get(seg, true);
    else return undefined;
  }
  return isMap(node) ? node : undefined;
}

function findPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((p) => isScalar(p.key) && String(p.key.value) === key) as Pair | undefined;
}

/** The block map's indentation (column of its first key); undefined for flow maps and empty maps. */
function blockIndent(text: string, map: YAMLMap): number | undefined {
  if (map.flow || map.items.length === 0) return undefined;
  const first = map.items[0]?.key;
  if (!isScalar(first) || !first.range) return undefined;
  const start = lineStartOf(text, first.range[0]);
  // The first key may follow the "- " of a sequence item; the other keys then align with it.
  if (!/^[ ]*(- +)*$/.test(text.slice(start, first.range[0]))) return undefined;
  return first.range[0] - start;
}

/** A set whose parents do not exist yet becomes a set of the first missing key, holding the nested value. */
function nestMissing(doc: Document.Parsed, edit: YamlEdit): YamlEdit {
  let node: unknown = doc.contents;
  const last = edit.path.length - 1;
  for (let i = 0; i <= last; i++) {
    if (!isMap(node)) return edit;
    const pair = findPair(node, edit.path[i] as string);
    if (!pair) {
      if (i === last) return edit;
      let nested: unknown = edit.value;
      for (let j = last; j > i; j--) nested = { [edit.path[j] as string]: nested };
      return { op: "set", path: edit.path.slice(0, i + 1), value: nested };
    }
    node = pair.value;
  }
  return edit;
}

type Splice ={ start: number; end: number; insert: string };

/** One edit as a splice of the source text, or undefined when the text path does not apply. */
function spliceFor(text: string, doc: Document.Parsed, original: YamlEdit, eol: string): Splice | undefined {
  if (typeof original.path[original.path.length - 1] !== "string") return undefined;
  const edit = original.op === "set" ? nestMissing(doc, original) : original;
  const parentPath = edit.path.slice(0, -1);
  const key = edit.path[edit.path.length - 1] as string;
  const parent = parentPath.length === 0 ? (isMap(doc.contents) ? doc.contents : undefined) : mapAt(doc, parentPath);
  if (!parent) return undefined;
  const indent = blockIndent(text, parent);
  if (indent === undefined) return undefined;
  const pad = " ".repeat(indent);
  const pair = findPair(parent, key);

  if (edit.op === "delete") {
    if (!pair) return { start: 0, end: 0, insert: "" };
    if (parent.items.length === 1) return undefined; // would leave an empty map: the Document path writes {}
    const keyNode = pair.key as { range?: [number, number, number] };
    if (!keyNode.range) return undefined;
    const start = lineStartOf(text, keyNode.range[0]);
    if (text.slice(start, keyNode.range[0]).trim() !== "") return undefined;
    const value = pair.value as { range?: [number, number, number] } | null;
    const endOffset = value?.range ? value.range[1] : keyNode.range[1];
    return { start, end: endOfLine(text, endOffset), insert: "" };
  }

  const value = edit.value;
  if (!pair) {
    const lines = entryLines(key, value).map((l) => pad + l);
    const lastPair = parent.items[parent.items.length - 1] as Pair;
    const lastValue = lastPair.value as { range?: [number, number, number] } | null;
    const lastKey = lastPair.key as { range?: [number, number, number] };
    const endOffset = lastValue?.range ? lastValue.range[1] : lastKey.range?.[1];
    if (endOffset === undefined) return undefined;
    const at = endOfLine(text, endOffset);
    const needsBreak = at > 0 && text[at - 1] !== "\n";
    return { start: at, end: at, insert: `${needsBreak ? eol : ""}${lines.join(eol)}${eol}` };
  }

  const old = pair.value as { range?: [number, number, number]; type?: string; flow?: boolean } | null;
  if (!old?.range) return undefined;
  if (isScalar(pair.value) && isScalarValue(value) && pair.value.type !== "BLOCK_FOLDED" && pair.value.type !== "BLOCK_LITERAL") {
    const rendered = valueLines(value);
    if (rendered.length !== 1) return undefined;
    return { start: old.range[0], end: old.range[1], insert: rendered[0] as string };
  }
  if (isMap(pair.value) && !pair.value.flow && isContainer(value) && !Array.isArray(value) && Object.keys(value).length > 0) {
    const valueIndent = blockIndent(text, pair.value);
    if (valueIndent === undefined) return undefined;
    const vpad = " ".repeat(valueIndent);
    const lines = valueLines(value).map((l, i) => (i === 0 ? l : vpad + l));
    return { start: old.range[0], end: old.range[1], insert: `${lines.join(eol)}${eol}` };
  }
  return undefined;
}

export interface PatchTextResult {
  text: string;
  changed: boolean;
  /** "text": spliced at source ranges; "document": rewritten through the Document API. */
  strategy: "text" | "document";
}

function parseStrict(text: string): { doc: Document.Parsed; value: unknown } {
  const doc = parseDocument(text, PARSE_OPTIONS);
  if (doc.errors.length > 0) throw new YamlPatchError("YAML_PARSE", doc.errors[0]?.message.split("\n")[0] ?? "invalid YAML");
  return { doc, value: doc.toJS() };
}

/** Applies the edits to YAML text, preserving everything it does not change. Throws YamlPatchError. */
export function patchYamlText(input: string, edits: readonly YamlEdit[], options: { expected?: unknown } = {}): PatchTextResult {
  const bom = input.charCodeAt(0) === 0xfeff ? "﻿" : "";
  const text = bom ? input.slice(1) : input;
  const eol = detectEol(text);
  const before = parseStrict(text);
  // `options.expected` lets a caller that knows better (a value shared by aliases changes every consumer) supply it.
  const expected = canonical("expected" in options ? options.expected : applyToValue(before.value, edits));

  // Text path: one splice at a time, re-parsing between edits so ranges stay valid.
  let current = text;
  let viaText = true;
  for (const edit of edits) {
    const { doc } = parseStrict(current);
    const splice = spliceFor(current, doc, edit, eol);
    if (!splice) {
      viaText = false;
      break;
    }
    current = current.slice(0, splice.start) + splice.insert + current.slice(splice.end);
  }
  if (viaText) {
    try {
      if (canonical(parseStrict(current).value) === expected) return { text: bom + current, changed: current !== text, strategy: "text" };
    } catch {
      // fall through to the Document path
    }
  }

  // Document path.
  const doc = parseDocument(text, PARSE_OPTIONS);
  for (const edit of edits) {
    if (edit.op === "set") doc.setIn(edit.path, edit.value);
    else doc.deleteIn(edit.path);
  }
  const out = doc.toString({ lineWidth: 0, indent: 2 });
  let ok = false;
  try {
    ok = canonical(parseStrict(out).value) === expected;
  } catch {
    ok = false;
  }
  if (!ok) throw new YamlPatchError("YAML_PATCH_FAILED", "the patch would not produce the expected document");
  return { text: bom + out, changed: out !== text, strategy: "document" };
}

export interface PatchFileOptions {
  /** Revision (sha256) the caller read; a different current revision is a conflict and nothing is written. */
  expectedHash?: string | null;
  /** Text to start from when the file does not exist; without it a missing file is an error. */
  createWith?: string;
}

export interface PatchFileResult {
  previousHash: string | null;
  hash: string;
  changed: boolean;
  strategy: "text" | "document";
}

/** Atomic write (temp file in the same folder, then rename), keeping the file mode. */
export function writeFileAtomic(absolute: string, text: string): void {
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  let mode = 0o644;
  try {
    mode = fs.statSync(absolute).mode & 0o777;
  } catch {
    // new file
  }
  const tmp = `${absolute}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.renameSync(tmp, absolute);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw new YamlPatchError("YAML_IO", (error as Error).message, { file: absolute });
  }
}

/** Patches a YAML file with an optimistic revision check. Writes nothing when the revision moved or the patch fails. */
export function patchYamlFile(absolute: string, edits: readonly YamlEdit[], options: PatchFileOptions = {}): PatchFileResult {
  const rev = readRevision(absolute);
  if (options.expectedHash !== undefined && options.expectedHash !== rev.hash) {
    throw new YamlPatchError("YAML_CONFLICT", "the file changed since it was read", { expectedHash: options.expectedHash, currentHash: rev.hash, file: absolute });
  }
  if (!rev.exists && options.createWith === undefined) throw new YamlPatchError("YAML_MISSING", "the file does not exist", { file: absolute });
  const base = rev.exists ? rev.text : (options.createWith as string);
  const result = patchYamlText(base, edits);
  if (!result.changed && rev.exists) return { previousHash: rev.hash, hash: rev.hash as string, changed: false, strategy: result.strategy };
  // Last look at the revision right before the rename.
  const again = readRevision(absolute);
  if (again.hash !== rev.hash) {
    throw new YamlPatchError("YAML_CONFLICT", "the file changed while it was patched", { expectedHash: rev.hash, currentHash: again.hash, file: absolute });
  }
  writeFileAtomic(absolute, result.text);
  return { previousHash: rev.hash, hash: hashBytes(Buffer.from(result.text, "utf8")), changed: true, strategy: result.strategy };
}
