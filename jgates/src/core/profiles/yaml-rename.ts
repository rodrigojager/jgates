// Text-level renames in a YAML document: the characters of a key (or of a `tool:<id>` selector) are replaced at their
// source range, so the comments, the order and the formatting of the entry stay exactly as the person wrote them.
import { isMap, isScalar, parseDocument, visit, type Document } from "yaml";

const BOM = "﻿";

function split(input: string): { bom: string; text: string } {
  return input.startsWith(BOM) ? { bom: BOM, text: input.slice(1) } : { bom: "", text: input };
}

interface Splice {
  start: number;
  end: number;
  insert: string;
}

function apply(text: string, splices: Splice[]): string {
  let out = text;
  for (const s of [...splices].sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + s.insert + out.slice(s.end);
  return out;
}

/** The new source of a scalar whose text was `source`, keeping its quotes. */
function requote(source: string, value: string): string {
  const q = source[0];
  return q === '"' || q === "'" ? `${q}${value}${q}` : value;
}

/** Renames the key `from` of the map at `parentPath` (map keys only) to `to`; the value and everything around it stay. Undefined when the key is not there. */
export function renameKeyInText(input: string, parentPath: readonly string[], from: string, to: string): string | undefined {
  const { bom, text } = split(input);
  const doc = parseDocument(text, { keepSourceTokens: true });
  if (doc.errors.length > 0) return undefined;
  let node: unknown = doc.contents;
  for (const seg of parentPath) node = isMap(node) ? node.get(seg, true) : undefined;
  if (!isMap(node)) return undefined;
  const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === from);
  if (!pair || !isScalar(pair.key) || !pair.key.range) return undefined;
  const [start, end] = pair.key.range;
  return bom + apply(text, [{ start, end, insert: requote(text.slice(start, end), to) }]);
}

/** Renames every selector `tool:<from>` (also `tool:<from>[capability]`), as a key or as a value, to `tool:<to>`. */
export function renameToolSelectors(input: string, from: string, to: string): { text: string; count: number } {
  const { bom, text } = split(input);
  const doc: Document.Parsed = parseDocument(text, { keepSourceTokens: true });
  if (doc.errors.length > 0) return { text: input, count: 0 };
  const prefix = `tool:${from}`;
  const splices: Splice[] = [];
  visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value !== "string" || !node.range) return;
      const value = node.value;
      if (value !== prefix && !value.startsWith(`${prefix}[`)) return;
      const [start, end] = node.range;
      splices.push({ start, end, insert: requote(text.slice(start, end), `tool:${to}${value.slice(prefix.length)}`) });
    },
  });
  return { text: bom + apply(text, splices), count: splices.length };
}
