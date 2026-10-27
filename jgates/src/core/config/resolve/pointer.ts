/** JSON Pointer (RFC 6901) helpers and the flattening of layer documents into leaf operations. */

export function encodeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function encodePointer(segments: readonly string[]): string {
  return segments.map((s) => `/${encodeSegment(s)}`).join("");
}

/** Decodes a pointer; undefined when it is not a valid JSON Pointer. "" is the whole document. */
export function decodePointer(pointer: string): string[] | undefined {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return undefined;
  const raw = pointer.slice(1).split("/");
  const out: string[] = [];
  for (const part of raw) {
    if (/~[^01]|~$/.test(part)) return undefined;
    out.push(part.replace(/~1/g, "/").replace(/~0/g, "~"));
  }
  return out;
}

export function isDescendant(pointer: string, ancestor: string): boolean {
  return pointer.length > ancestor.length && pointer.startsWith(`${ancestor}/`);
}

/** Dotted path inside a file, as the validator prints it: profiles.rapido.checks.capability:unit.enabled, templates[1].id. */
export function formatFilePath(segments: readonly string[]): string {
  let out = "";
  for (const s of segments) {
    if (/^\d+$/.test(s)) out += `[${s}]`;
    else out += out === "" ? s : `.${s}`;
  }
  return out;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface ListOp {
  add?: unknown[];
  remove?: unknown[];
  replace?: unknown[];
}

const LIST_OP_KEYS = new Set(["add", "remove", "replace"]);

/** An explicit list operation: a non-empty object whose keys are add/remove (or replace alone), each an array. */
export function isListOp(value: unknown): value is ListOp {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.every((k) => LIST_OP_KEYS.has(k))) return false;
  if (!keys.every((k) => Array.isArray(value[k]))) return false;
  return !(keys.includes("replace") && keys.length > 1);
}

/** One write of a layer: a leaf value, an explicit list operation, or "this object exists" for an empty object. */
export interface LayerOp {
  pointer: string;
  segments: string[];
  kind: "set" | "list" | "object";
  value: unknown;
  /** Where the value is written in its file (dotted path), or null for values that have no file. */
  path: string | null;
}

/** Subtrees whose value is replaced whole instead of merged: native tool configuration is never merged. */
export function isOpaque(segments: readonly string[]): boolean {
  return (segments.length === 3 && segments[0] === "tools" && segments[2] === "config") || (segments.length === 2 && segments[0] === "extensions");
}

/**
 * Flattens a value into leaf operations: objects merge by key, arrays and scalars (null included) are leaves,
 * list operations stay operations. `fileSegments` is the parallel path inside the file (null: no file).
 */
export function flatten(value: unknown, segments: string[], fileSegments: string[] | null, out: LayerOp[] = []): LayerOp[] {
  const pointer = encodePointer(segments);
  const path = fileSegments ? formatFilePath(fileSegments) : null;
  if (isOpaque(segments)) {
    out.push({ pointer, segments, kind: "set", value, path });
    return out;
  }
  if (isListOp(value)) {
    out.push({ pointer, segments, kind: "list", value, path });
    return out;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      out.push({ pointer, segments, kind: "object", value: {}, path });
      return out;
    }
    for (const key of keys) {
      if (value[key] === undefined) continue;
      flatten(value[key], [...segments, key], fileSegments ? [...fileSegments, key] : null, out);
    }
    return out;
  }
  out.push({ pointer, segments, kind: "set", value, path });
  return out;
}
