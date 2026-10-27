/**
 * Common contract of the document codecs (JSON/JSONC, YAML, TOML, JS). A codec never serialises a whole object back
 * to text: it reads the document into a model with source positions, and applies field edits as minimal patches on
 * the original text. Everything the edit does not name (comments, key order, unknown fields, quoting,
 * line endings, BOM) stays byte for byte.
 *
 * Contract every codec follows:
 *  - `read(text)` never throws. Syntax problems come back in `errors`; `value` is the best-effort parsed value.
 *  - `apply(text, [], ...)` returns the input text untouched (`changed: false`).
 *  - `apply` re-parses its own output and compares it with the expected value; a patch that would not produce the
 *    expected document throws `CodecError("PATCH_FAILED")` and nothing is returned.
 *  - Ambiguous or unsupported shapes throw `CodecError` with a stable `code` instead of guessing; the caller keeps
 *    the textual editor as the fallback.
 *  - Edits are applied in order, each one on the result of the previous.
 */

/** A path segment: an object key (string) or an array index (number). */
export type PathSegment = string | number;

/**
 * One field-level edit intention.
 *  - `set`: puts `value` at `path` (creates missing parents; replaces an existing value).
 *  - `delete`: removes the key or array item at `path` (a missing target is a no-op).
 *  - `insert`: `path` names an array; `value` becomes a new item at `index` (default: appended).
 */
export interface FieldEdit {
  op: "set" | "delete" | "insert";
  path: PathSegment[];
  value?: unknown;
  /** Only for `insert`. */
  index?: number;
}

export type ValueKind = "object" | "array" | "string" | "number" | "boolean" | "null";

/** One node of the document with its place in the source text (offsets are UTF-16 code units, BOM excluded). */
export interface FieldInfo {
  path: PathSegment[];
  kind: ValueKind;
  /** Range of the value in the text. */
  start: number;
  end: number;
  /** 1-based position of `start`. */
  line: number;
  column: number;
  /** YAML: the value is an anchor target used by aliases (`aliases` is how many), or is itself an alias. */
  anchor?: string;
  aliases?: number;
  aliasOf?: string;
}

export interface CodecDiagnostic {
  code: string;
  message: string;
  /** 1-based; absent when the codec cannot place it. */
  line?: number;
  column?: number;
  offset?: number;
}

export interface CodecDocument {
  /** True when the text parsed without errors. */
  ok: boolean;
  /** The dialect actually read (for example "json", "jsonc", "yaml"). */
  dialect: string;
  value: unknown;
  /** Flat list of nodes in document order, parents before children. */
  fields: FieldInfo[];
  errors: CodecDiagnostic[];
  warnings: CodecDiagnostic[];
  /** Number of documents in the text (YAML streams may hold several; others always 1). */
  documents: number;
}

export interface CodecWarning extends CodecDiagnostic {
  /** Index of the edit (in the `edits` array) that raised it. */
  editIndex: number;
  path: PathSegment[];
}

export interface CodecPatchResult {
  text: string;
  changed: boolean;
  /** Warnings that do not block the patch, such as editing a value shared by YAML aliases. */
  warnings: CodecWarning[];
}

export type CodecErrorCode =
  | "PARSE"
  | "PATCH_FAILED"
  | "UNSUPPORTED"
  | "MULTI_DOCUMENT"
  | "BAD_EDIT"
  | "DIALECT";

export class CodecError extends Error {
  constructor(
    readonly code: CodecErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CodecError";
  }
}

export interface CodecOptions {
  /** Dialect to read and write; each codec lists the ones it knows. JSON never turns into JSONC on its own. */
  dialect?: string;
}

export interface Codec {
  readonly id: string;
  readonly dialects: readonly string[];
  read(text: string, options?: CodecOptions): CodecDocument;
  apply(text: string, edits: readonly FieldEdit[], options?: CodecOptions): CodecPatchResult;
}

/** Structural equality used to check a patch against the expected value (key order is irrelevant). */
export function sameValue(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** Applies the edits to a plain value: the outcome a text patch is checked against. Throws BAD_EDIT. */
export function applyEditsToValue(root: unknown, edits: readonly FieldEdit[]): unknown {
  let clone: unknown = structuredClone(root ?? {});
  for (const edit of edits) {
    if (edit.path.length === 0) {
      if (edit.op === "set") {
        clone = structuredClone(edit.value);
        continue;
      }
      throw new CodecError("BAD_EDIT", "the root can only be replaced");
    }
    let node: unknown = clone;
    let missing = false;
    const parentLength = edit.op === "insert" ? edit.path.length : edit.path.length - 1;
    for (let i = 0; i < parentLength; i++) {
      const key = edit.path[i] as PathSegment;
      const holder = node as Record<string, unknown>;
      let next = holder[key as string];
      if (next === null || typeof next !== "object") {
        if (edit.op === "delete") {
          missing = true;
          break;
        }
        const following = edit.path[i + 1];
        next = edit.op === "insert" && i === parentLength - 1 ? [] : typeof following === "number" ? [] : {};
        holder[key as string] = next;
      }
      node = next;
    }
    if (missing) continue;
    if (edit.op === "insert") {
      if (!Array.isArray(node)) throw new CodecError("BAD_EDIT", "insert needs an array at the path");
      const at = edit.index === undefined ? node.length : Math.min(Math.max(edit.index, 0), node.length);
      node.splice(at, 0, structuredClone(edit.value));
      continue;
    }
    const last = edit.path[edit.path.length - 1] as PathSegment;
    if (edit.op === "set") (node as Record<string, unknown>)[last as string] = structuredClone(edit.value);
    else if (Array.isArray(node)) node.splice(Number(last), 1);
    else delete (node as Record<string, unknown>)[last as string];
  }
  return clone;
}
